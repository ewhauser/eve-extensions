/**
 * The runtime in celld mode, end to end, against an in-process fleet whose
 * cells are the real worker class (see `./celld-harness.ts`).
 *
 * publish -> drain (ingress, filter, correlate, append to a cell) -> the cell's
 * alarm -> the evaluator -> delivery -> RUN_COMPLETED back into the cell.
 * Nothing here is a mock of eve-ambient's own behaviour; the only fakes are the
 * fleet's router, cell placement, and alarm dispatch.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileMonitor,
  defineChannelEvent,
  defineInboundChannel,
  defineMonitor,
  ignore,
  MonitorRuntime,
  wake,
  type ChannelEvent,
  type CompiledMonitor,
} from "../src/index.js";
import { createEvaluationFetchHandler } from "../src/celld.js";
import { MemoryMonitorStore } from "../src/memory.js";
import {
  MemoryConversationChannel,
  RecordingMonitorObserver,
  VirtualMonitorClock,
} from "../src/testing.js";
import { CELLD_DEFINITION_VERSION_MISMATCH } from "../src/mailbox.js";
import type { EvaluationRequest } from "../src/mailbox.js";
import { FakeCelldFleet, jsonResponse, type EvaluatorHandler } from "./celld-harness.js";
import { compareCellState, type PublishedEvent } from "./celld-oracle.js";

const SECRET = "fleet-shared-secret";
const EVALUATOR_URL = "http://app.test/monitor-evaluations";

const messageSchema = z.object({ channelId: z.string(), text: z.string() });

const slack = defineInboundChannel({
  id: "slack",
  replyTarget: z.object({ channel: z.string() }),
  inbound: { message: defineChannelEvent({ schema: messageSchema }) },
});

type MessageEvent = ChannelEvent<
  "message",
  z.infer<typeof messageSchema>,
  { channel: string }
>;

interface World {
  readonly runtime: MonitorRuntime;
  readonly store: MemoryMonitorStore;
  readonly fleet: FakeCelldFleet;
  readonly clock: VirtualMonitorClock;
  readonly delivery: MemoryConversationChannel<{ channel: string }>;
  readonly observer: RecordingMonitorObserver;
  readonly evaluator: EvaluatorHandler;
}

function ambientMonitor(delivery: MemoryConversationChannel<{ channel: string }>) {
  return defineMonitor<MessageEvent>({
    id: "ambient",
    sources: [slack.event("message")],
    correlate: ({ event }) => event.data.channelId,
    buffer: {
      mode: "debounce",
      quietPeriod: "1s",
      maxWait: "5s",
      maxEvents: 5,
      maxBytes: 10_000,
    },
    cooldown: { afterWake: "3s", during: "accumulate" },
    decision: ({ events }) =>
      events.some((event) => event.data.text.includes("wake"))
        ? wake({ reason: "useful" })
        : ignore({ reason: "quiet" }),
    task: {
      instructions: "Review the evidence.",
      evidence: ({ events }) => ({ texts: events.map((event) => event.data.text) }),
    },
    route: ({ events }) => ({
      channel: delivery,
      target: { channel: events.at(-1)!.data.channelId },
      auth: "app" as const,
    }),
    metadata: { owner: "test", useCase: "celld-mailbox" },
  });
}

async function createWorld(
  options: { readonly compile?: (delivery: MemoryConversationChannel<{ channel: string }>) => CompiledMonitor } = {},
): Promise<World> {
  const clock = new VirtualMonitorClock();
  const store = new MemoryMonitorStore();
  const delivery = new MemoryConversationChannel<{ channel: string }>({
    id: "slack-delivery",
    clock,
  });
  const observer = new RecordingMonitorObserver();
  // The fleet's evaluator is the runtime's own handler, so the cycle is closed
  // through a holder that is filled once both halves exist.
  let handler: EvaluatorHandler = async () => jsonResponse({ error: "unwired" }, 503);
  const fleet = new FakeCelldFleet({
    secret: SECRET,
    clock,
    evaluator: (request) => handler(request),
  });
  const compiled =
    options.compile?.(delivery) ?? compileMonitor(ambientMonitor(delivery), "v1");
  const runtime = new MonitorRuntime({
    applicationId: "app-a",
    deployment: { monitors: [compiled] },
    channels: [slack],
    deliveryChannels: [delivery],
    store,
    clock,
    observer,
    mailbox: {
      mode: "celld",
      fleetUrl: fleet.baseUrl,
      evaluatorUrl: EVALUATOR_URL,
      secret: SECRET,
      fetch: fleet.fetch,
    },
  });
  await runtime.initialize();
  const evaluator = createEvaluationFetchHandler(runtime, { secret: SECRET });
  handler = evaluator;
  return { runtime, store, fleet, clock, delivery, observer, evaluator };
}

function publishInput(id: string, text: string, channelId = "C1") {
  return {
    tenantId: "tenant-a",
    installationId: "workspace-a",
    id,
    data: { channelId, text },
    replyTarget: { channel: channelId },
    actor: { id: "U1", principalType: "user" as const },
    origin: { kind: "external" as const },
  };
}

async function cellState(world: World, cellName: string): Promise<Record<string, any>> {
  const response = await world.fleet.fetch(
    `${world.fleet.baseUrl}/cells/${encodeURIComponent(cellName)}/state`,
    { headers: { authorization: `Bearer ${SECRET}` } },
  );
  return (await response.json()) as Record<string, any>;
}

/**
 * Replays the cell's own observed timeline through `dispatchLifecycle` and
 * diffs the result against what the cell stored — the Phase 2 oracle, run
 * against the shipped worker.
 */
async function oracleVerdict(world: World) {
  const cellName = world.fleet.cellNames[0]!;
  const state = await cellState(world, cellName);
  const published = new Map<string, PublishedEvent>();
  for (const entry of state.log as { kind: string; ref?: string }[]) {
    if (entry.kind !== "append" || entry.ref === undefined) continue;
    const record = (await world.store.getEvent(entry.ref))!;
    published.set(entry.ref, {
      bytes: record.bytes,
      acceptedAt: record.acceptedAt,
      ingressSequence: record.ingressSequence,
    });
  }
  return compareCellState(state as never, { ...state.pin, cellName, published });
}

describe("MonitorRuntime with the celld mailbox", () => {
  let world: World;

  beforeEach(async () => {
    world = await createWorld();
  });

  it("routes appends to cells and never opens a store instance", async () => {
    await world.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await world.runtime.publish(slack, "message", publishInput("2", "more context"));

    const result = await world.runtime.drain();

    expect(result.subscriptions).toBeGreaterThan(0);
    expect(result.evaluations).toBe(0);
    expect(result.runs).toBe(0);
    expect(result.remaining).toBe(false);
    expect(await world.store.listInstances({ applicationId: "app-a" })).toHaveLength(0);
    expect(world.fleet.cellNames).toHaveLength(1);
    // The cell name is the instance key, and it carries the pinned identity.
    expect(world.fleet.cellNames[0]).toContain("ambient");
    expect(world.fleet.cellNames[0]).toContain("app-a");
    expect(
      world.observer.named("monitor.buffer.opened").length +
        world.observer.named("monitor.buffer.updated").length,
    ).toBe(2);
  });

  it("delivers a batch the cell's alarm claims and records the run", async () => {
    await world.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await world.runtime.publish(slack, "message", publishInput("2", "more context"));
    await world.runtime.drain();

    world.clock.advance(1_000);
    const fired = await world.fleet.fireDueAlarms();

    expect(fired).toHaveLength(1);
    expect(fired[0]!.error).toBeNull();
    expect(world.delivery.deliveries).toHaveLength(1);
    const request = world.delivery.deliveries[0]!;
    expect(request.evidence.projectedEvidence).toEqual({
      texts: ["please wake me", "more context"],
    });
    expect(request.target).toEqual({ channel: "C1" });

    const runs = await world.runtime.listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("delivered");
    expect(run.stage).toBe("complete");
    expect(run.decision).toMatchObject({ action: "wake", reason: "useful" });
    expect(run.batch.events.map((event) => event.ref)).toHaveLength(2);
    expect(request.idempotencyKey).toBe(`monitor:${run.id}:0`);

    // The cell applied RUN_COMPLETED from the response and entered cooldown.
    const state = await cellState(world, world.fleet.cellNames[0]!);
    expect(state.state).toBe("cooldown");
    expect(state.instance.lastDecision).toMatchObject({
      action: "wake",
      reasonClass: "useful",
    });
    expect(state.instance.binding).toBeDefined();
  });

  it("stays conformant with the lifecycle machine across a cooldown cycle", async () => {
    await world.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await world.runtime.drain();
    world.clock.advance(1_000);
    await world.fleet.fireDueAlarms();

    // Accumulated behind the cooldown, then claimed when it expires.
    await world.runtime.publish(slack, "message", publishInput("2", "quiet chatter"));
    await world.runtime.drain();
    world.clock.advance(3_000);
    await world.fleet.fireDueAlarms();

    const runs = await world.runtime.listRuns();
    expect(runs.map((run) => run.status).sort()).toEqual(["delivered", "ignored"]);
    expect(runs.find((run) => run.status === "ignored")!.batch.closedBy).toBe("cooldown-expired");

    const verdict = await oracleVerdict(world);
    expect(verdict.mismatches).toEqual([]);
    expect(verdict.differences).toEqual([]);
    expect(verdict.instance.consecutiveIgnores).toBe(1);
  });

  it("replays a celld-recorded run exactly like a store-recorded one", async () => {
    await world.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await world.runtime.drain();
    world.clock.advance(1_000);
    await world.fleet.fireDueAlarms();
    const run = (await world.runtime.listRuns())[0]!;

    const replayed = await world.runtime.replay(run.id, { decision: "recorded" });

    expect(replayed.decision).toMatchObject({ action: "wake", reason: "useful" });
    expect(replayed.evidence).toEqual({ texts: ["please wake me"] });
    expect(replayed.route).toEqual({ channelId: "slack-delivery", target: { channel: "C1" } });
    expect(replayed.delivered).toBe(false);
  });

  it("is idempotent by runId: a replayed evaluation delivers nothing twice", async () => {
    await world.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await world.runtime.drain();
    world.clock.advance(1_000);
    await world.fleet.fireDueAlarms();
    const sent = world.fleet.evaluations[0]!;

    const first = (await world.runtime.listRuns())[0]!;
    const repeat = await world.runtime.handleEvaluation({
      ...sent,
      secret: SECRET,
    } as unknown as EvaluationRequest);

    expect(repeat.runId).toBe(first.id);
    expect(repeat.status).toBe("delivered");
    expect(repeat.decision).toMatchObject({ action: "wake", reasonClass: "useful" });
    expect(repeat.binding).toBeDefined();
    expect(world.delivery.deliveries).toHaveLength(1);
    expect(await world.runtime.listRuns()).toHaveLength(1);
  });

  it("rejects an evaluation presenting the wrong secret", async () => {
    await world.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await world.runtime.drain();
    world.clock.advance(1_000);
    await world.fleet.fireDueAlarms();
    const sent = world.fleet.evaluations[0]!;

    await expect(
      world.runtime.handleEvaluation({
        ...sent,
        secret: "wrong",
      } as unknown as EvaluationRequest),
    ).rejects.toThrow(/invalid secret/);
    const response = await world.evaluator(
      new Request(EVALUATOR_URL, {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: JSON.stringify(sent),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rides the cell's alarm ladder through an evaluator outage", async () => {
    let failures = 0;
    const flaky: EvaluatorHandler = async (request) => {
      if (failures === 0) {
        failures += 1;
        return jsonResponse({ error: "evaluator restarting" }, 503);
      }
      return world.evaluator(request);
    };
    world.fleet.evaluator = flaky;

    await world.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await world.runtime.drain();
    world.clock.advance(1_000);

    const firstPass = await world.fleet.fireDueAlarms();
    expect(firstPass[0]!.error).toBeInstanceOf(Error);
    expect(world.delivery.deliveries).toHaveLength(0);

    const secondPass = await world.fleet.fireDueAlarms();
    expect(secondPass[0]!.error).toBeNull();

    expect(world.delivery.deliveries).toHaveLength(1);
    const runs = await world.runtime.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("delivered");
    // Same runId across the retry, so the outage cost one attempt, not one run.
    expect((world.fleet.evaluations[0] as { runId: string }).runId).toBe(
      (world.fleet.evaluations[1] as { runId: string }).runId,
    );
  });

  it("suppresses delivery for a shadow-mode monitor but still starts its cooldown", async () => {
    const shadow = await createWorld({
      compile: (delivery) =>
        compileMonitor({ ...ambientMonitor(delivery), mode: "shadow" }, "v1"),
    });
    await shadow.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await shadow.runtime.drain();
    shadow.clock.advance(1_000);

    await shadow.fleet.fireDueAlarms();

    expect(shadow.delivery.deliveries).toHaveLength(0);
    const runs = await shadow.runtime.listRuns();
    expect(runs[0]!.status).toBe("shadowed");
    expect(runs[0]!.mode).toBe("shadow");
    const cell = shadow.fleet.state(shadow.fleet.cellNames[0]!)!;
    const instance = JSON.parse(cell.map.get("instance") as string) as Record<string, unknown>;
    expect(instance.cooldownUntil).toBe(
      new Date(shadow.clock.now().getTime() + 3_000).toISOString(),
    );
  });

  it("dead-letters a subscription a cell refuses on its pinned version", async () => {
    const rejecting = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          code: CELLD_DEFINITION_VERSION_MISMATCH,
          error: "cell is pinned to ambient@v0",
        },
        409,
      ),
    );
    const stubbed = await createWorldWithFetch(rejecting as never);

    await stubbed.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await stubbed.runtime.drain();

    const deadLetters = await stubbed.runtime.listDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.stage).toBe("buffer");
    expect(deadLetters[0]!.reason).toContain("pinned to a different definition version");
    expect(stubbed.observer.named("monitor.dead_lettered")).toHaveLength(1);
  });

  it("returns a subscription to the retry ladder when the fleet is unreachable", async () => {
    const outage = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const stubbed = await createWorldWithFetch(outage as never);

    await stubbed.runtime.publish(slack, "message", publishInput("1", "please wake me"));
    await stubbed.runtime.drain();

    expect(await stubbed.runtime.listDeadLetters()).toHaveLength(0);
    const pending = await stubbed.store.listSubscriptions({
      applicationId: "app-a",
      statuses: ["pending"],
      availableBefore: "9999-01-01T00:00:00.000Z",
      limit: 10,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.outcome).toContain("ECONNREFUSED");
    expect(pending[0]!.availableAt > stubbed.clock.now().toISOString()).toBe(true);
  });
});

/** A world whose fleet is a bare fetch stub, for append-failure mapping. */
async function createWorldWithFetch(fetchImpl: typeof fetch): Promise<{
  readonly runtime: MonitorRuntime;
  readonly store: MemoryMonitorStore;
  readonly clock: VirtualMonitorClock;
  readonly observer: RecordingMonitorObserver;
}> {
  const clock = new VirtualMonitorClock();
  const store = new MemoryMonitorStore();
  const delivery = new MemoryConversationChannel<{ channel: string }>({
    id: "slack-delivery",
    clock,
  });
  const observer = new RecordingMonitorObserver();
  const runtime = new MonitorRuntime({
    applicationId: "app-a",
    deployment: { monitors: [compileMonitor(ambientMonitor(delivery), "v1")] },
    channels: [slack],
    deliveryChannels: [delivery],
    store,
    clock,
    observer,
    mailbox: {
      mode: "celld",
      fleetUrl: "http://fleet.test",
      evaluatorUrl: EVALUATOR_URL,
      secret: SECRET,
      fetch: fetchImpl,
    },
  });
  await runtime.initialize();
  return { runtime, store, clock, observer };
}
