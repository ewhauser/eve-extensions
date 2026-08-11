import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  compileMonitor,
  defineChannelEvent,
  defineInboundChannel,
  defineMonitor,
  ignore,
  modelDecision,
  MonitorRuntime,
  TransientMonitorError,
  wake,
  type ChannelEvent,
  type MonitorModelInvoker,
} from "../src/index.js";
import { MemoryMonitorStore } from "../src/memory.js";
import {
  MemoryConversationChannel,
  RecordingMonitorObserver,
  VirtualMonitorClock,
} from "../src/testing.js";

const messageSchema = z.object({
  channelId: z.string(),
  ts: z.string(),
  threadTs: z.string().optional(),
  text: z.string(),
});

const slack = defineInboundChannel({
  id: "slack",
  replyTarget: z.object({ channel: z.string(), thread: z.string() }),
  inbound: {
    message: defineChannelEvent({ schema: messageSchema, chat: true }),
  },
});

type MessageEvent = ChannelEvent<"message", z.infer<typeof messageSchema>, { channel: string; thread: string }>;

function eventInput(id: string, text = "please investigate") {
  return {
    tenantId: "tenant-a",
    installationId: "workspace-a",
    id,
    data: { channelId: "C1", ts: id, text },
    replyTarget: { channel: "C1", thread: id },
    actor: { id: "U1", principalType: "user" as const },
    origin: { kind: "external" as const },
  };
}

describe("MonitorRuntime", () => {
  it("deduplicates ingress and creates no delivery for ignores", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "slack-delivery", clock });
    const monitor = defineMonitor<MessageEvent>({
      id: "ambient-engineering",
      sources: [slack.event("message", { phase: "undispatched" })],
      correlate: ({ event }) => `${event.source.installationId}:${event.data.channelId}`,
      decision: () => ignore({ reason: "not-useful" }),
      task: { instructions: "Review evidence.", evidence: ({ events }) => ({ count: events.length }) },
      route: ({ events }) => ({ channel: delivery, target: events.at(-1)!.replyTarget!, auth: "app" }),
      metadata: { owner: "test", useCase: "ambient-slack" },
    });
    const store = new MemoryMonitorStore();
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await runtime.initialize();

    const first = await runtime.publishChat(slack, "message", eventInput("1"), []);
    const duplicate = await runtime.publishChat(slack, "message", eventInput("1"), []);
    await runtime.drain();

    expect(first.status).toBe("accepted");
    expect(first.directDispatch).toBe("undispatched");
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.directDispatch).toBe("undispatched");
    expect(delivery.deliveries).toHaveLength(0);
    expect((await runtime.listRuns())[0]?.status).toBe("ignored");
  });

  it("resumes transient direct dispatch from its durable duplicate state", async () => {
    const clock = new VirtualMonitorClock();
    const monitor = defineMonitor<MessageEvent>({
      id: "durable-direct-dispatch",
      sources: [slack.event("message")],
      decision: () => ignore({ reason: "not-useful" }),
      task: { instructions: "Review.", evidence: () => ({}) },
      route: () => null,
      metadata: { owner: "test", useCase: "direct-dispatch" },
    });
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      store: new MemoryMonitorStore(),
      clock,
    });
    await runtime.initialize();
    const handler = vi.fn()
      .mockRejectedValueOnce(new TransientMonitorError("temporary dispatch outage"))
      .mockResolvedValueOnce({ turnId: "durable-turn" });

    const first = await runtime.publishChat(slack, "message", eventInput("dispatch-retry"), [handler]);
    const earlyDuplicate = await runtime.publishChat(
      slack,
      "message",
      eventInput("dispatch-retry"),
      [handler],
    );
    clock.advance(1_000);
    const resumed = await runtime.publishChat(
      slack,
      "message",
      eventInput("dispatch-retry"),
      [handler],
    );

    expect(first.directDispatch).toBe("pending");
    expect(earlyDuplicate.directDispatch).toBe("pending");
    expect(resumed).toMatchObject({ status: "duplicate", directDispatch: "dispatched" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("recovers an expired direct-dispatch lease without accepting a stale outcome", async () => {
    const clock = new VirtualMonitorClock();
    const monitor = defineMonitor<MessageEvent>({
      id: "leased-direct-dispatch",
      sources: [slack.event("message")],
      decision: () => ignore({ reason: "not-useful" }),
      task: { instructions: "Review.", evidence: () => ({}) },
      route: () => null,
      metadata: { owner: "test", useCase: "direct-dispatch-lease" },
    });
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      store: new MemoryMonitorStore(),
      clock,
    });
    await runtime.initialize();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseStale!: (receipt: { turnId: string } | null) => void;
    const staleHandler = vi.fn(() => {
      markStarted();
      return new Promise<{ turnId: string } | null>((resolve) => { releaseStale = resolve; });
    });
    const first = runtime.publishChat(slack, "message", eventInput("dispatch-lease"), [staleHandler]);
    await started;
    clock.advance(30_000);

    const recovered = await runtime.publishChat(
      slack,
      "message",
      eventInput("dispatch-lease"),
      [async () => ({ turnId: "recovered-turn" })],
    );
    releaseStale(null);

    expect(recovered).toMatchObject({ status: "duplicate", directDispatch: "dispatched" });
    await expect(first).resolves.toMatchObject({ directDispatch: "dispatched" });
    expect(staleHandler).toHaveBeenCalledOnce();
  });

  it("never drains another application's work from a shared store", async () => {
    const clock = new VirtualMonitorClock();
    const store = new MemoryMonitorStore();
    const definition = (id: string) => defineMonitor<MessageEvent>({
      id,
      sources: [slack.event("message")],
      decision: () => ignore({ reason: "not-useful" }),
      task: { instructions: "Review.", evidence: () => ({}) },
      route: () => null,
      metadata: { owner: "test", useCase: "application-isolation" },
    });
    const appA = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(definition("monitor-a"), "v1")] },
      channels: [slack],
      store,
      clock,
    });
    const appB = new MonitorRuntime({
      applicationId: "app-b",
      deployment: { monitors: [compileMonitor(definition("monitor-b"), "v1")] },
      channels: [slack],
      store,
      clock,
    });
    await appA.initialize();
    await appB.initialize();
    await appB.publishChat(slack, "message", eventInput("owned-by-b"), []);

    await expect(appA.drain()).resolves.toMatchObject({
      subscriptions: 0,
      evaluations: 0,
      runs: 0,
      remaining: false,
    });
    expect(await appA.listRuns()).toHaveLength(0);
    await appB.drain();
    expect(await appB.listRuns()).toHaveLength(1);
  });

  it("validates canonical reply targets before durable acceptance", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "slack-delivery", clock });
    const monitor = defineMonitor<MessageEvent>({
      id: "target-validation",
      sources: [slack.event("message")],
      decision: () => ignore({ reason: "not-useful" }),
      task: { instructions: "Review.", evidence: () => ({}) },
      route: () => null,
      metadata: { owner: "test", useCase: "target-validation" },
    });
    const store = new MemoryMonitorStore();
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      deliveryChannels: [delivery],
      store,
      clock,
    });
    await runtime.initialize();

    await expect(
      runtime.publishChat(
        slack,
        "message",
        { ...eventInput("invalid-target"), replyTarget: { channel: "C1" } } as never,
        [],
      ),
    ).rejects.toThrow("channel replyTarget failed schema validation");
    expect(await runtime.listRuns()).toHaveLength(0);
  });

  it("flushes a continuous debounce stream at maxWait", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "slack-delivery", clock });
    const monitor = defineMonitor<MessageEvent>({
      id: "debounced",
      sources: [slack.event("message")],
      correlate: () => "thread:one",
      buffer: { mode: "debounce", quietPeriod: "2s", maxWait: "5s", maxEvents: 20, maxBytes: 10_000 },
      decision: () => wake({ reason: "useful" }),
      task: { instructions: "Review evidence.", evidence: ({ events, batch }) => ({ count: events.length, closedBy: batch.closedBy }) },
      route: () => ({ channel: delivery, target: { channel: "C1", thread: "T1" }, auth: "app" }),
      metadata: { owner: "test", useCase: "debounce" },
    });
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      deliveryChannels: [delivery],
      store: new MemoryMonitorStore(),
      clock,
    });
    await runtime.initialize();
    for (let index = 0; index < 6; index += 1) {
      await runtime.publishChat(slack, "message", eventInput(String(index)), []);
      await runtime.drain();
      if (index < 5) clock.advance(1_000);
    }
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0]?.evidence.completeness.closedBy).toBe("max-wait");
    expect(delivery.deliveries[0]?.evidence.sourceEventRefs).toHaveLength(6);
  });

  it("uses explicit model settings, repairs once, and validates action metadata", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "slack-delivery", clock });
    const invoker = vi.fn<MonitorModelInvoker>()
      .mockResolvedValueOnce({ output: { action: "invented" }, usage: { inputTokens: 4, outputTokens: 2 } })
      .mockResolvedValueOnce({
        output: { action: "wake", reason: "helpful", metadata: { priority: "high" } },
        usage: { inputTokens: 5, outputTokens: 3 },
      });
    const monitor = defineMonitor<MessageEvent, Record<string, never>, { priority: "high" | "low" }>({
      id: "model-backed",
      sources: [slack.event("message")],
      decision: modelDecision({
        model: "openai/gpt-5-nano",
        reasoning: "none",
        instructions: "Classify relevance.",
        input: ({ events }) => ({ text: events[0]!.data.text }),
        metadata: {
          ignore: z.object({}),
          wake: z.object({ priority: z.enum(["high", "low"]) }),
        },
        timeout: "8s",
        maxInputTokens: 100,
        maxOutputTokens: 50,
        onError: ignore({ reason: "classifier-unavailable", metadata: {} }),
      }),
      task: {
        instructions: "Review evidence.",
        evidence: ({ decision }) => ({ action: decision.action, reason: decision.reason }),
      },
      route: () => ({ channel: delivery, target: { channel: "C1", thread: "T1" }, auth: "app" }),
      metadata: { owner: "test", useCase: "classifier" },
    });
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      deliveryChannels: [delivery],
      store: new MemoryMonitorStore(),
      modelInvoker: invoker,
      clock,
    });
    await runtime.initialize();
    await runtime.publishChat(slack, "message", eventInput("1"), []);
    await runtime.drain();

    expect(invoker).toHaveBeenCalledTimes(2);
    expect(invoker.mock.calls[0]?.[0]).toMatchObject({
      model: "openai/gpt-5-nano",
      reasoning: "none",
      timeoutMs: 8_000,
      maxOutputTokens: 50,
      repairAttempt: 0,
    });
    expect(invoker.mock.calls[1]?.[0].repairAttempt).toBe(1);
    expect(delivery.deliveries).toHaveLength(1);
  });

  it.each([
    ["call", { maxModelCallsPerMinute: 1 }],
    ["input-token", { maxModelInputTokensPerHour: 10 }],
  ] as const)("charges every classifier repair against the %s budget", async (_name, limits) => {
    const clock = new VirtualMonitorClock();
    const invoker = vi.fn<MonitorModelInvoker>().mockResolvedValue({
      output: { action: "invalid" },
      usage: { inputTokens: 5, outputTokens: 1 },
    });
    const monitor = defineMonitor<MessageEvent>({
      id: `repair-${_name}`,
      sources: [slack.event("message")],
      decision: modelDecision({
        model: "openai/gpt-5-nano",
        reasoning: "none",
        instructions: "Classify.",
        input: () => ({ text: "small" }),
        timeout: "1s",
        maxInputTokens: 10,
        maxOutputTokens: 10,
        repairAttempts: 1,
        onError: ignore({ reason: "repair-budget-exhausted" }),
      }),
      task: { instructions: "Review.", evidence: () => ({}) },
      route: () => null,
      limits: { perMonitor: limits, overflow: "drop" },
      metadata: { owner: "test", useCase: "repair-budget" },
    });
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      store: new MemoryMonitorStore(),
      modelInvoker: invoker,
      clock,
    });
    await runtime.initialize();
    await runtime.publishChat(slack, "message", eventInput(`repair-${_name}`), []);
    await runtime.drain();

    expect(invoker).toHaveBeenCalledTimes(1);
    expect((await runtime.listRuns())[0]).toMatchObject({
      status: "ignored",
      decisionSource: "fallback",
      decision: { action: "ignore", reason: "repair-budget-exhausted" },
    });
  });

  it("does not let a failing telemetry observer change durable outcomes", async () => {
    const clock = new VirtualMonitorClock();
    const delivery = new MemoryConversationChannel({ id: "slack-delivery", clock });
    const monitor = defineMonitor<MessageEvent>({
      id: "telemetry-safe",
      sources: [slack.event("message")],
      decision: () => wake({ reason: "useful" }),
      task: { instructions: "Review.", evidence: () => ({ ok: true }) },
      route: () => ({ channel: delivery, target: { channel: "C1", thread: "T1" }, auth: "app" }),
      metadata: { owner: "test", useCase: "telemetry" },
    });
    const runtime = new MonitorRuntime({
      applicationId: "app-a",
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      deliveryChannels: [delivery],
      store: new MemoryMonitorStore(),
      clock,
      observer: { emit: () => { throw new Error("telemetry unavailable"); } },
    });
    await runtime.initialize();
    await runtime.publishChat(slack, "message", eventInput("telemetry"), []);
    await runtime.drain();
    expect(delivery.deliveries).toHaveLength(1);
  });
});
