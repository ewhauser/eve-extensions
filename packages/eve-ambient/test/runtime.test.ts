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
    expect(delivery.deliveries).toHaveLength(0);
    expect((await runtime.listRuns())[0]?.status).toBe("ignored");
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
