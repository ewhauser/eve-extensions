import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  compileMonitor,
  defineChannelEvent,
  defineInboundChannel,
  defineMonitor,
  ignore,
  MonitorRuntime,
  TransientMonitorError,
  wake,
  type ChannelEvent,
  type MonitorDeliveryChannel,
  type MonitorDeliveryRequest,
  type MonitorDefinition,
} from "../src/index.js";
import { MemoryMonitorStore } from "../src/memory.js";
import {
  MemoryConversationChannel,
  RecordingMonitorObserver,
  VirtualMonitorClock,
} from "../src/testing.js";

const schema = z.object({ key: z.string(), text: z.string() });
const targetSchema = z.object({ room: z.string(), thread: z.string() });
const channel = defineInboundChannel({
  id: "chat",
  replyTarget: targetSchema,
  inbound: { message: defineChannelEvent({ schema, chat: true }) },
});
type TestEvent = ChannelEvent<"message", z.infer<typeof schema>, z.infer<typeof targetSchema>>;

function input(id: string, key = "one", text = "hello", tenantId = "tenant-a") {
  return {
    tenantId,
    installationId: "install-a",
    id,
    data: { key, text },
    replyTarget: { room: "R1", thread: key },
    actor: { id: "U1", principalType: "user" as const },
    origin: { kind: "external" as const },
  };
}

describe("buffering, cooldown, quotas, and failures", () => {
  it("force-flushes before count overflow and preserves the overflowing event", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const monitor = baseMonitor(delivery, {
      id: "threshold",
      correlate: () => "same",
      buffer: { mode: "debounce", quietPeriod: "10s", maxWait: "1m", maxEvents: 2, maxBytes: 10_000 },
    });
    const runtime = await createRuntime(clock, delivery, monitor);

    for (let index = 0; index < 3; index += 1) {
      await runtime.publishChat(channel, "message", input(String(index)), []);
    }
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0]?.evidence.completeness.closedBy).toBe("max-events");
    expect(delivery.deliveries[0]?.evidence.sourceEventRefs).toHaveLength(2);

    clock.advance(10_000);
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(2);
    expect(delivery.deliveries[1]?.evidence.sourceEventRefs).toHaveLength(1);
  });

  it("dead-letters an individually oversized monitor event without blocking another key", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const observer = new RecordingMonitorObserver();
    const monitor = baseMonitor(delivery, {
      id: "oversized",
      correlate: ({ event }) => event.data.key,
      buffer: { mode: "debounce", quietPeriod: "1s", maxWait: "2s", maxEvents: 10, maxBytes: 30 },
    });
    const runtime = await createRuntime(clock, delivery, monitor, { observer });
    await runtime.publishChat(channel, "message", input("large", "large", "x".repeat(100)), []);
    await runtime.publishChat(channel, "message", input("small", "small", "x"), []);
    await runtime.drain();
    clock.advance(1_000);
    await runtime.drain();

    expect(observer.named("monitor.dead_lettered")).toHaveLength(1);
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0]?.evidence.projectedEvidence).toEqual({ keys: ["small"] });
  });

  it("accumulates during cooldown and evaluates at expiry without another event", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const decision = vi.fn(() => wake({ reason: "useful" }));
    const monitor = baseMonitor(delivery, {
      id: "cooldown",
      correlate: () => "same",
      cooldown: { afterWake: "10s", during: "accumulate" },
      decision,
    });
    const runtime = await createRuntime(clock, delivery, monitor);

    await runtime.publishChat(channel, "message", input("one"), []);
    await runtime.drain();
    await runtime.publishChat(channel, "message", input("two"), []);
    await runtime.publishChat(channel, "message", input("three"), []);
    await runtime.drain();
    expect(decision).toHaveBeenCalledTimes(1);

    clock.advance(9_999);
    await runtime.drain();
    expect(decision).toHaveBeenCalledTimes(1);
    clock.advance(1);
    await runtime.drain();
    expect(decision).toHaveBeenCalledTimes(2);
    expect(delivery.deliveries).toHaveLength(2);
    expect(delivery.deliveries[1]?.evidence.sourceEventRefs).toHaveLength(2);
    expect(delivery.deliveries[1]?.evidence.completeness.closedBy).toBe("cooldown-expired");
  });

  it("buffers a wake suppressed by a per-key quota and retains its in-flight decision", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const decision = vi.fn(() => wake({ reason: "useful" }));
    const monitor = baseMonitor(delivery, {
      id: "quota",
      correlate: () => "same",
      decision,
      limits: { perKey: { maxWakesPerHour: 1 }, overflow: "buffer" },
    });
    const runtime = await createRuntime(clock, delivery, monitor);
    await runtime.publishChat(channel, "message", input("one"), []);
    await runtime.drain();
    await runtime.publishChat(channel, "message", input("two"), []);
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect(decision).toHaveBeenCalledTimes(2);

    clock.advance(3_600_000);
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(2);
    expect(decision).toHaveBeenCalledTimes(2);
  });

  it("retries transient delivery under one idempotency key", async () => {
    const clock = new VirtualMonitorClock();
    const delegate = new MemoryConversationChannel({ id: "flaky", clock });
    const keys: string[] = [];
    let attempts = 0;
    const flaky: MonitorDeliveryChannel = {
      id: "flaky",
      async deliver(request) {
        attempts += 1;
        keys.push(request.idempotencyKey);
        if (attempts === 1) throw new TransientMonitorError("temporary outage");
        return delegate.deliver(request);
      },
    };
    const monitor = baseMonitor(flaky, { id: "retry" });
    const runtime = await createRuntime(clock, flaky, monitor);
    await runtime.publishChat(channel, "message", input("one"), []);
    await runtime.drain();
    expect(attempts).toBe(1);
    clock.advance(1_000);
    await runtime.drain();
    expect(attempts).toBe(2);
    expect(new Set(keys).size).toBe(1);
    expect(delegate.deliveries).toHaveLength(1);
  });

  it("runs shadow policy, evidence, and route without delivery", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const evidence = vi.fn(({ events }: { events: readonly TestEvent[] }) => ({ count: events.length }));
    const route = vi.fn(() => ({ channel: delivery, target: { room: "R1", thread: "T1" }, auth: "app" as const }));
    const monitor = defineMonitor<TestEvent>({
      ...baseMonitor(delivery, { id: "shadow" }),
      mode: "shadow",
      task: { instructions: "Review.", evidence },
      route,
    });
    const runtime = await createRuntime(clock, delivery, monitor);
    await runtime.publishChat(channel, "message", input("one"), []);
    await runtime.drain();
    expect(evidence).toHaveBeenCalledOnce();
    expect(route).toHaveBeenCalledOnce();
    expect(delivery.deliveries).toHaveLength(0);
    expect((await runtime.listRuns())[0]?.status).toBe("shadowed");
  });

  it("fans out one monitor ID to one delivery-active and one shadow definition version", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const active = baseMonitor(delivery, { id: "blue-green" });
    const shadow = defineMonitor<TestEvent>({
      ...baseMonitor(delivery, { id: "blue-green" }),
      mode: "shadow",
    });
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: {
        monitors: [compileMonitor(active, "v1"), compileMonitor(shadow, "v2")],
      },
      channels: [channel],
      deliveryChannels: [delivery],
      store: new MemoryMonitorStore(),
      clock,
    });
    await runtime.initialize();
    await runtime.publishChat(channel, "message", input("one"), []);
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect(new Set((await runtime.listRuns()).map((run) => run.status))).toEqual(
      new Set(["delivered", "shadowed"]),
    );
  });

  it("keeps mailbox order when later pure preprocessing completes first", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const store = new MemoryMonitorStore();
    const getEvent = store.getEvent.bind(store);
    vi.spyOn(store, "getEvent").mockImplementation(async (ref) => {
      const value = await getEvent(ref);
      if (value?.eventId === "first") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return value;
    });
    const monitor = baseMonitor(delivery, { id: "ordered", correlate: () => "same" });
    const runtime = await createRuntime(clock, delivery, monitor, { store });
    await runtime.publishChat(channel, "message", input("first", "same", "first"), []);
    await runtime.publishChat(channel, "message", input("second", "same", "second"), []);
    await runtime.drain();
    expect(delivery.deliveries.map((request) => request.evidence.projectedEvidence)).toEqual([
      { keys: ["same"] },
      { keys: ["same"] },
    ]);
    expect(delivery.deliveries.map((request) => request.evidence.sourceEventRefs[0])).toEqual([
      expect.stringContaining("evt_"),
      expect.stringContaining("evt_"),
    ]);
    const accepted = delivery.deliveries.map((request) => request.evidence.sourceEventRefs[0]);
    expect((await store.getEvent(accepted[0]!))?.eventId).toBe("first");
    expect((await store.getEvent(accepted[1]!))?.eventId).toBe("second");
  });

  it("does not let a cardinality-blocked key stall an existing mailbox", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const monitor = baseMonitor(delivery, {
      id: "cross-key-ordering",
      correlate: ({ event }) => event.data.key,
      limits: { overflow: "buffer" },
    });
    const runtime = await createRuntime(clock, delivery, monitor, {
      limits: { maxActiveKeysPerTenant: 1 },
    });
    await runtime.publishChat(channel, "message", input("existing-1", "existing"), []);
    await runtime.drain();

    await runtime.publishChat(channel, "message", input("blocked", "new-key"), []);
    await runtime.publishChat(channel, "message", input("existing-2", "existing"), []);
    await runtime.drain();

    expect(delivery.deliveries).toHaveLength(2);
    expect(delivery.deliveries[1]?.evidence.projectedEvidence).toEqual({ keys: ["existing"] });
  });

  it("does not scan every application instance while appending or delivering", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const store = new MemoryMonitorStore();
    const runtime = await createRuntime(clock, delivery, baseMonitor(delivery, { id: "point-reads" }), {
      store,
    });
    const listInstances = vi.spyOn(store, "listInstances");

    await runtime.publishChat(channel, "message", input("point-read"), []);
    await runtime.drain();

    expect(delivery.deliveries).toHaveLength(1);
    expect(listInstances).not.toHaveBeenCalled();
  });

  it("isolates poison callbacks by key and applies same-application loop prevention", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const monitor = baseMonitor(delivery, {
      id: "poison",
      correlate: ({ event }) => {
        if (event.data.key === "bad") throw new Error("bad key");
        return event.data.key;
      },
    });
    const runtime = await createRuntime(clock, delivery, monitor);
    await runtime.publishChat(channel, "message", input("bad", "bad"), []);
    await runtime.publishChat(channel, "message", input("good", "good"), []);
    await runtime.publishChat(channel, "message", {
      ...input("loop", "loop"),
      origin: { kind: "agent", applicationId: "app-a", depth: 1 },
    }, []);
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect(await runtime.listDeadLetters()).toHaveLength(1);
  });

  it("dead-letters oversized evidence without blocking another correlation key", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const monitor = defineMonitor<TestEvent>({
      ...defaultDefinition(delivery),
      id: "evidence-size",
      task: {
        instructions: "Review.",
        evidence: ({ events }) =>
          events[0]!.data.key === "bad" ? { text: "x".repeat(500) } : { ok: true },
      },
    });
    const runtime = await createRuntime(clock, delivery, monitor, { maxEvidenceBytes: 100 });
    await runtime.publishChat(channel, "message", input("bad", "bad"), []);
    await runtime.publishChat(channel, "message", input("good", "good"), []);
    await runtime.drain();

    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0]?.evidence.projectedEvidence).toEqual({ ok: true });
    expect((await runtime.listDeadLetters())[0]?.stage).toBe("evidence");
  });

  it("uses platform, tenant, and application budgets in addition to definition limits", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const observer = new RecordingMonitorObserver();
    const monitor = baseMonitor(delivery, { id: "budget" });
    const runtime = await createRuntime(clock, delivery, monitor, {
      budgets: {
        platformId: "test",
        platform: { maxWakesPerHour: 10 },
        tenant: { "tenant-a": { maxWakesPerHour: 1 } },
        application: { maxWakesPerHour: 5 },
        overflow: "buffer",
      },
      observer,
    });
    await runtime.publishChat(channel, "message", input("one", "one"), []);
    await runtime.publishChat(channel, "message", input("two", "two"), []);
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect(observer.named("monitor.wake.suppressed")[0]?.attributes?.scope).toBe("tenant");
    clock.advance(3_600_000);
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(2);
  });

  it("applies correlation cardinality overflow without blocking another tenant", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const observer = new RecordingMonitorObserver();
    const monitor = baseMonitor(delivery, {
      id: "cardinality",
      limits: { overflow: "drop" },
    });
    const runtime = await createRuntime(clock, delivery, monitor, {
      limits: { maxActiveKeysPerTenant: 1 },
      observer,
    });
    await runtime.publishChat(channel, "message", input("one", "one"), []);
    await runtime.publishChat(channel, "message", input("two", "two"), []);
    await runtime.publishChat(channel, "message", input("other", "other", "hello", "tenant-b"), []);
    await runtime.drain();

    expect(delivery.deliveries).toHaveLength(2);
    expect(
      new Set(delivery.deliveries.map((request) => request.evidence.projectedEvidence)),
    ).toEqual(new Set([{ keys: ["one"] }, { keys: ["other"] }]));
    expect(observer.named("monitor.wake.suppressed")).toHaveLength(1);
  });
});

describe("chat dispatch and binding conformance", () => {
  it("emits undispatched only after all direct handlers finish with no receipt", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const ambient = baseMonitor(delivery, { id: "undispatched" });
    const observed = defineMonitor<TestEvent>({
      ...baseMonitor(delivery, { id: "observed" }),
      sources: [channel.event("message", { phase: "observed" })],
    });
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(ambient, "v1"), compileMonitor(observed, "v1")] },
      channels: [channel],
      deliveryChannels: [delivery],
      store: new MemoryMonitorStore(),
      clock,
    });
    await runtime.initialize();
    const result = await runtime.publishChat(channel, "message", input("one"), [
      async () => ({ turnId: "direct-turn" }),
    ]);
    await runtime.drain();
    expect(result.directDispatch).toBe("dispatched");
    expect(delivery.deliveries).toHaveLength(1);
    expect((await runtime.listRuns()).map((run) => run.monitorId)).toEqual(["observed"]);
  });

  it("coalesces monitor evidence but never merges a queued human turn", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const request = deliveryRequest("one");
    const first = await delivery.deliver(request);
    const second = await delivery.deliver({ ...deliveryRequest("two"), bindingRef: first.binding.bindingRef });
    const third = await delivery.deliver({ ...deliveryRequest("three"), bindingRef: first.binding.bindingRef });
    const humanTurn = delivery.acceptHumanTurn(first.binding.bindingRef);
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("coalesced");
    expect(third).toMatchObject({ outcome: "coalesced", turnId: second.turnId });
    expect(delivery.completeActiveTurn(first.binding.bindingRef)).toBe(humanTurn);
    expect(delivery.completeActiveTurn(first.binding.bindingRef)).toBe(second.turnId);
  });

  it("marks an idle binding active when a new monitor turn resumes it", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const first = await delivery.deliver(deliveryRequest("one"));
    expect(delivery.completeActiveTurn(first.binding.bindingRef)).toBeNull();
    expect(delivery.getBinding(first.binding.bindingRef)?.status).toBe("idle");

    const resumed = await delivery.deliver({
      ...deliveryRequest("two"),
      bindingRef: first.binding.bindingRef,
    });
    expect(resumed.binding.status).toBe("active");
  });

  it("keeps canonical target bindings isolated across compound-key collisions", async () => {
    const delivery = new MemoryConversationChannel({ id: "delivery" });
    const first = await delivery.deliver({
      ...deliveryRequest("one"),
      tenantId: "a:b",
      applicationId: "c",
    });
    const second = await delivery.deliver({
      ...deliveryRequest("two"),
      tenantId: "a",
      applicationId: "b:c",
    });

    expect(second.binding.bindingRef).not.toBe(first.binding.bindingRef);
  });

  it("rejects active binding conflicts and refreshes terminal generations", async () => {
    const delivery = new MemoryConversationChannel({ id: "delivery" });
    const first = await delivery.deliver(deliveryRequest("one"));
    await delivery.deliver({ ...deliveryRequest("other"), target: { room: "R2", thread: "T2" } });

    await expect(
      delivery.deliver({
        ...deliveryRequest("conflict"),
        bindingRef: first.binding.bindingRef,
        target: { room: "R2", thread: "T2" },
      }),
    ).rejects.toThrow("different active sessions");

    delivery.terminate(first.binding.bindingRef);
    const refreshed = await delivery.deliver({
      ...deliveryRequest("refreshed"),
      bindingRef: first.binding.bindingRef,
    });
    expect(refreshed.binding.bindingRef).not.toBe(first.binding.bindingRef);
    expect(refreshed.binding.status).toBe("active");
  });
});

function baseMonitor(
  delivery: MonitorDeliveryChannel,
  overrides: Partial<MonitorDefinition<TestEvent, any, any>> & { id: string },
) {
  return defineMonitor<TestEvent>({
    ...defaultDefinition(delivery),
    ...overrides,
  } as MonitorDefinition<TestEvent>);
}

function defaultDefinition(delivery: MonitorDeliveryChannel) {
  return {
    id: "base",
    sources: [channel.event("message")],
    correlate: ({ event }: { event: TestEvent }) => event.data.key,
    decision: () => wake({ reason: "useful" }),
    task: {
      instructions: "Review evidence.",
      evidence: ({ events }: { events: readonly TestEvent[] }) => ({ keys: events.map((event) => event.data.key) }),
    },
    route: ({ events }: { events: readonly TestEvent[] }) => ({
      channel: delivery,
      target: events.at(-1)!.replyTarget!,
      auth: "app" as const,
    }),
    metadata: { owner: "test", useCase: "conformance" },
  };
}

async function createRuntime(
  clock: VirtualMonitorClock,
  delivery: MonitorDeliveryChannel,
  monitor: ReturnType<typeof baseMonitor>,
  options: Partial<ConstructorParameters<typeof MonitorRuntime>[0]> = {},
) {
  const runtime = new MonitorRuntime({
    applicationId: "app-a",
    deployment: { monitors: [compileMonitor(monitor, "v1")] },
    channels: [channel],
    deliveryChannels: [delivery],
    store: new MemoryMonitorStore(),
    clock,
    ...options,
  });
  await runtime.initialize();
  return runtime;
}

function deliveryRequest(id: string): MonitorDeliveryRequest<{ room: string; thread: string }> {
  return {
    tenantId: "tenant-a",
    applicationId: "app-a",
    idempotencyKey: id,
    auth: "app",
    target: { room: "R1", thread: "T1" },
    session: { strategy: "channel" },
    taskInstructions: "Review.",
    evidence: {
      id: `evidence-${id}`,
      runId: id,
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceEventRefs: [id],
      projectedEvidence: { id },
      decision: { action: "wake", reason: "useful" },
      completeness: {
        openedAt: "2026-01-01T00:00:00.000Z",
        closedAt: "2026-01-01T00:00:00.000Z",
        closedBy: "immediate",
        eventCount: 1,
        bytes: 1,
        isPartial: false,
        omittedEventCount: 0,
        omittedBytes: 0,
      },
      projectionVersion: "v1",
    },
    trigger: {
      kind: "monitor",
      monitorId: "test",
      definitionVersion: "v1",
      runId: id,
      correlationKeyHash: "hash",
      evidenceSnapshotId: `evidence-${id}`,
      sourceTypes: ["message"],
    },
    concurrency: "coalesce",
  };
}
