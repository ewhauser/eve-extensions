import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  compileMonitor,
  defineChannelEvent,
  defineInboundChannel,
  defineMonitor,
  MonitorRuntime,
  wake,
  type ChannelEvent,
  type MonitorDefinition,
} from "../src/index.js";
import { MemoryMonitorStore } from "../src/memory.js";
import { MemoryConversationChannel, VirtualMonitorClock } from "../src/testing.js";

const source = defineInboundChannel({
  id: "events",
  replyTarget: z.object({ id: z.string() }),
  inbound: { changed: defineChannelEvent({ schema: z.object({ key: z.string(), value: z.string() }) }) },
});
type Event = ChannelEvent<"changed", { key: string; value: string }, { id: string }>;

function monitor(
  id: string,
  delivery: MemoryConversationChannel,
  overrides: Partial<MonitorDefinition<Event>> = {},
) {
  return defineMonitor<Event>({
    id,
    sources: [source.event("changed")],
    correlate: ({ event }) => event.data.key,
    decision: () => wake({ reason: "changed" }),
    task: {
      instructions: "Review the change.",
      evidence: ({ events }) => ({ values: events.map((event) => event.data.value) }),
    },
    route: ({ events }) => ({ channel: delivery, target: events.at(-1)!.replyTarget!, auth: "app" }),
    metadata: { owner: "test", useCase: "deployment" },
    ...overrides,
  });
}

function event(id: string, value = "v1") {
  return {
    tenantId: "tenant",
    installationId: "installation",
    id,
    data: { key: "key", value },
    replyTarget: { id: "target" },
    origin: { kind: "external" as const },
  };
}

describe("deployment identity, replay, and retention", () => {
  it("requires an explicit migration or destructive removal for a missing monitor ID", async () => {
    const clock = new VirtualMonitorClock();
    const store = new MemoryMonitorStore();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const first = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(monitor("old", delivery), "v1")] },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await first.initialize();
    await first.publish(source, "changed", event("queued-before-rename", "queued"));

    const missing = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(monitor("new", delivery), "v1")] },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await expect(missing.initialize()).rejects.toThrow("monitor old disappeared");

    const migrated = new MonitorRuntime({
      applicationId: "app",
      deployment: {
        monitors: [compileMonitor(monitor("new", delivery), "v1")],
        monitorMigrations: [{ from: "old", to: "new", mode: "move-state" }],
      },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await migrated.initialize();
    await migrated.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect((await migrated.listRuns())[0]).toMatchObject({ monitorId: "new", definitionVersion: "v1" });
  });

  it("destructive removal discards queued subscriptions", async () => {
    const clock = new VirtualMonitorClock();
    const store = new MemoryMonitorStore();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const first = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(monitor("removed", delivery), "v1")] },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await first.initialize();
    await first.publish(source, "changed", event("discard-me"));

    const removed = new MonitorRuntime({
      applicationId: "app",
      deployment: {
        monitors: [],
        monitorRemovals: [{ id: "removed", mode: "discard-state" }],
      },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await removed.initialize();
    await removed.drain();
    expect(delivery.deliveries).toHaveLength(0);
    expect(await store.listDefinitionPins("app")).toHaveLength(0);
  });

  it("moves idle mailbox state only across explicitly compatible versions", async () => {
    const clock = new VirtualMonitorClock();
    const store = new MemoryMonitorStore();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const v1Definition = monitor("stable", delivery, {
      buffer: { mode: "debounce", quietPeriod: "10s", maxWait: "20s", maxEvents: 10, maxBytes: 1_000 },
    });
    const v1 = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(v1Definition, "v1")] },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await v1.initialize();
    await v1.publish(source, "changed", event("one"));
    await v1.drain();

    const v2 = new MonitorRuntime({
      applicationId: "app",
      deployment: {
        monitors: [
          compileMonitor(v1Definition, "v1", { active: false }),
          compileMonitor(monitor("stable", delivery, {
            buffer: { mode: "debounce", quietPeriod: "10s", maxWait: "20s", maxEvents: 10, maxBytes: 1_000 },
          }), "v2", { compatibleWith: ["v1"] }),
        ],
      },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await v2.initialize();
    clock.advance(10_000);
    await v2.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect((await v2.listRuns())[0]?.definitionVersion).toBe("v2");
  });

  it("requires queued subscriptions to retain their pinned definition version", async () => {
    const clock = new VirtualMonitorClock();
    const store = new MemoryMonitorStore();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const v1Definition = monitor("queued", delivery);
    const v1 = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(v1Definition, "v1")] },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await v1.initialize();
    await v1.publish(source, "changed", event("queued"));

    const missing = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(monitor("queued", delivery), "v2")] },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await expect(missing.initialize()).rejects.toThrow("requires pinned definition queued@v1");

    const retained = new MonitorRuntime({
      applicationId: "app",
      deployment: {
        monitors: [
          compileMonitor(v1Definition, "v1", { active: false }),
          compileMonitor(monitor("queued", delivery), "v2"),
        ],
      },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await retained.initialize();
    await retained.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect((await retained.listRuns())[0]?.definitionVersion).toBe("v1");
  });

  it("replays recorded downstream behavior only to an explicit canary", async () => {
    const clock = new VirtualMonitorClock();
    const store = new MemoryMonitorStore();
    const production = new MemoryConversationChannel({ id: "production", clock });
    const canary = new MemoryConversationChannel({ id: "canary", clock });
    const definition = monitor("replayable", production);
    const runtime = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(definition, "v1")] },
      channels: [source],
      deliveryChannels: [production],
      store,
      clock,
    });
    await runtime.initialize();
    await runtime.publish(source, "changed", event("one", "original"));
    await runtime.drain();
    const run = (await runtime.listRuns())[0]!;

    const shadow = await runtime.replay(run.id, { decision: "recorded" });
    expect(shadow.delivered).toBe(false);
    expect(production.deliveries).toHaveLength(1);
    const active = await runtime.replay(run.id, {
      decision: "recorded",
      shadow: false,
      canary: { channel: canary, target: { id: "canary-target" } },
    });
    expect(active.delivered).toBe(true);
    expect(canary.deliveries).toHaveLength(1);
    expect(active.evidence).toEqual({ values: ["original"] });
  });

  it("redacts payload before dedupe expiry and retains delivered immutable evidence", async () => {
    const clock = new VirtualMonitorClock();
    const store = new MemoryMonitorStore();
    const delivery = new MemoryConversationChannel({ id: "delivery", clock });
    const definition = monitor("retention", delivery, {
      retention: { payload: "1s", decisions: "1h", dedupe: "2s" },
    });
    const runtime = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(definition, "v1")] },
      channels: [source],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await runtime.initialize();
    const accepted = await runtime.publish(source, "changed", event("one", "secret"));
    await runtime.drain();
    clock.advance(1_000);
    await runtime.purgeExpired();
    expect((await store.getEvent(accepted.eventId))?.event).toBeUndefined();
    expect(delivery.deliveries[0]?.evidence.projectedEvidence).toEqual({ values: ["secret"] });
    const run = (await runtime.listRuns())[0]!;
    expect(run.replayExpiresAt).toBe("2026-01-01T00:00:01.000Z");
    await expect(runtime.replay(run.id, { decision: "recorded" })).rejects.toThrow(
      "replay input expired at 2026-01-01T00:00:01.000Z",
    );
    expect((await runtime.publish(source, "changed", event("one"))).status).toBe("duplicate");
    clock.advance(1_000);
    await runtime.purgeExpired();
    expect((await runtime.publish(source, "changed", event("one", "new"))).status).toBe("accepted");
  });
});
