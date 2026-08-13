import { describe, expect, it, vi, type Mock } from "vitest";
import { MonitorInstance } from "../src/celld-worker.js";
import {
  CELLD_DEFINITION_VERSION_MISMATCH,
  CELLD_MALFORMED_APPEND,
} from "../src/mailbox.js";
import type { CelldAppendRequest, EvaluationResponse } from "../src/mailbox.js";
import type { StoredMonitorInstance } from "../src/storage.js";
import { VirtualMonitorClock } from "../src/testing.js";
import {
  createFakeDurableObjectState,
  jsonResponse,
  type FakeDurableObjectState,
} from "./celld-harness.js";

type EvaluatorMock = Mock<(input: string, init: RequestInit) => Promise<Response>>;

const CELL = "instance-key-alpha";

const DEBOUNCE_CONFIG = {
  buffer: {
    mode: "debounce" as const,
    quietPeriod: "1s" as const,
    maxWait: "5s" as const,
    maxEvents: 5,
    maxBytes: 10_000,
  },
  cooldown: { afterWake: "3s" as const, during: "accumulate" as const },
};

interface Harness {
  readonly cell: MonitorInstance;
  readonly state: FakeDurableObjectState;
  readonly clock: VirtualMonitorClock;
  readonly evaluator: EvaluatorMock;
  append(ref: string, overrides?: Partial<CelldAppendRequest>): Promise<Response>;
  route(action: string, method?: string): Promise<Response>;
  fireAlarm(retryCount?: number): Promise<unknown>;
  instance(): Promise<StoredMonitorInstance>;
}

function wake(status: EvaluationResponse["status"] = "delivered"): EvaluationResponse {
  return {
    runId: "ignored-by-cell",
    status,
    decision: { action: "wake", reasonClass: "useful" },
  };
}

/** Leaves a claimed run checkpointed mid-evaluation, the way an outage does. */
function unreachableEvaluator(): EvaluatorMock {
  return vi.fn(async () => jsonResponse({ error: "evaluator unreachable" }, 503));
}

function makeHarness(options: { evaluator?: EvaluatorMock } = {}): Harness {
  const clock = new VirtualMonitorClock();
  const state = createFakeDurableObjectState(CELL);
  const evaluator: EvaluatorMock =
    options.evaluator ?? vi.fn(async () => jsonResponse(wake(), 200));
  const cell = new MonitorInstance(state, {
    EVALUATOR_SECRET: "s3cret",
    clock,
    fetch: (input: string, init: RequestInit) => evaluator(input, init),
  });
  return {
    cell,
    state,
    clock,
    evaluator,
    async append(ref, overrides = {}) {
      const body: CelldAppendRequest = {
        monitorId: "ambient",
        definitionVersion: "v1",
        config: DEBOUNCE_CONFIG,
        evaluatorUrl: "http://app.test/monitor-evaluations",
        tenantId: "tenant-a",
        applicationId: "app-a",
        correlationKey: "C1",
        correlationKeyHash: "hash-C1",
        ref,
        bytes: 32,
        ingressSequence: "1",
        acceptedAt: clock.now().toISOString(),
        payload: { text: `payload for ${ref}` },
        ...overrides,
      };
      return cell.fetch(
        new Request("http://cell/append", {
          method: "POST",
          headers: { "content-type": "application/json", "x-cell-name": CELL },
          body: JSON.stringify(body),
        }),
      );
    },
    async route(action, method = "GET") {
      return cell.fetch(
        new Request(`http://cell/${action}`, {
          method,
          headers: { "x-cell-name": CELL },
        }),
      );
    },
    async fireAlarm(retryCount = 0) {
      try {
        await cell.alarm({ retryCount });
        return null;
      } catch (error) {
        return error;
      }
    },
    async instance() {
      return JSON.parse(state.map.get("instance") as string) as StoredMonitorInstance;
    },
  };
}

describe("celld mailbox cell", () => {
  it("appends, claims on the quiet period, evaluates, and enters cooldown", async () => {
    const harness = makeHarness();

    const first = await harness.append("evt-1");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody.outcome).toBe("opened");
    expect(firstBody.state).toBe("collecting");

    const second = await harness.append("evt-2");
    expect(((await second.json()) as Record<string, unknown>).outcome).toBe("updated");

    // The quiet period is the alarm: nothing is due until it elapses.
    expect(harness.state.alarmAt).toBe(harness.clock.now().getTime() + 1_000);
    harness.clock.advance(1_000);
    expect(await harness.fireAlarm()).toBeNull();

    expect(harness.evaluator).toHaveBeenCalledOnce();
    const request = harness.evaluator.mock.calls[0]![1];
    const sent = JSON.parse(String(request.body)) as Record<string, any>;
    expect(sent.batch.events.map((event: { ref: string }) => event.ref)).toEqual([
      "evt-1",
      "evt-2",
    ]);
    expect(sent.batch.closedBy).toBe("quiet-period");
    expect(sent.instanceId).toBe(CELL);
    expect(sent.correlationKey).toBe("C1");
    // Refs, never payloads: the evaluator reads the event store.
    expect(JSON.stringify(sent)).not.toContain("payload for evt-1");
    expect((request.headers as Record<string, string>).authorization).toBe("Bearer s3cret");

    const instance = await harness.instance();
    expect(instance.activeRunId).toBeUndefined();
    expect(instance.lastDecision).toMatchObject({ action: "wake", reasonClass: "useful" });
    expect(instance.cooldownUntil).toBe(
      new Date(harness.clock.now().getTime() + 3_000).toISOString(),
    );
    expect(instance.eventsSinceLastWake).toBe(0);
    // No buffered work and no run: the timer is gone.
    expect(harness.state.alarmAt).toBeNull();
    expect(harness.state.map.has("evt:evt-1")).toBe(false);
    expect(harness.state.map.has("run")).toBe(false);
    expect(harness.state.blockedSections).toBe(1);
  });

  it("runs the evaluation inside blockConcurrencyWhile and rethrows its failure", async () => {
    const evaluator = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    const harness = makeHarness({ evaluator });
    await harness.append("evt-1");
    harness.clock.advance(1_000);

    const error = await harness.fireAlarm();

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("returned 500");
    // The critical section itself must resolve: a rejected one resets the actor.
    expect(harness.state.blockedSections).toBe(1);
  });

  it("pins its monitor and configuration on the first append", async () => {
    const harness = makeHarness();
    await harness.append("evt-1");

    // A later append carrying a different configuration does not repin it.
    await harness.append("evt-2", {
      config: { buffer: { mode: "immediate" } },
    });

    const state = (await (await harness.route("state")).json()) as Record<string, any>;
    expect(state.pin.monitorId).toBe("ambient");
    expect(state.pin.definitionVersion).toBe("v1");
    expect(state.pin.config).toEqual(DEBOUNCE_CONFIG);
    // Still debounced, so the second append did not flush.
    expect(state.instance.openBatch.events).toHaveLength(2);
  });

  it("rejects an append whose definition version disagrees with the pin", async () => {
    const harness = makeHarness();
    await harness.append("evt-1");

    const response = await harness.append("evt-2", { definitionVersion: "v2" });

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe(CELLD_DEFINITION_VERSION_MISMATCH);
    expect(body.error).toContain("pinned to ambient@v1");
    const instance = await harness.instance();
    expect(instance.openBatch?.events).toHaveLength(1);
  });

  it("rejects a malformed append without touching the instance", async () => {
    const harness = makeHarness();

    const response = await harness.cell.fetch(
      new Request("http://cell/append", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cell-name": CELL },
        body: JSON.stringify({ ref: "evt-1" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).code).toBe(
      CELLD_MALFORMED_APPEND,
    );
    expect(harness.state.map.has("instance")).toBe(false);
  });

  it("resumes an interrupted evaluation on the same run instead of re-claiming", async () => {
    let attempts = 0;
    const evaluator: EvaluatorMock = vi.fn(async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ error: "down" }, 503) : jsonResponse(wake(), 200);
    });
    const harness = makeHarness({ evaluator });
    await harness.append("evt-1");
    harness.clock.advance(1_000);

    expect(await harness.fireAlarm()).toBeInstanceOf(Error);
    const midRun = await harness.instance();
    const claimedRunId = midRun.activeRunId!;
    expect(claimedRunId).toBeDefined();
    expect(midRun.evaluationGeneration).toBe(1);
    const checkpoint = JSON.parse(harness.state.map.get("run") as string) as Record<string, any>;
    expect(checkpoint.stage).toBe("evaluating");
    expect(checkpoint.outcome).toBeUndefined();

    expect(await harness.fireAlarm(1)).toBeNull();

    expect(evaluator).toHaveBeenCalledTimes(2);
    const retried = JSON.parse(String(evaluator.mock.calls[1]![1].body)) as Record<string, any>;
    // Same runId both times: the evaluator's idempotency key never moves.
    expect(retried.runId).toBe(claimedRunId);
    const done = await harness.instance();
    expect(done.evaluationGeneration).toBe(1);
    expect(done.activeRunId).toBeUndefined();
    expect(done.lastDecision?.action).toBe("wake");
  });

  it("completes from a checkpointed outcome without calling the evaluator again", async () => {
    const harness = makeHarness({ evaluator: unreachableEvaluator() });
    await harness.append("evt-1");
    harness.clock.advance(1_000);
    expect(await harness.fireAlarm()).toBeInstanceOf(Error);
    harness.evaluator.mockClear();

    // The crash window between recording the outcome and applying it.
    const checkpoint = JSON.parse(harness.state.map.get("run") as string) as Record<string, any>;
    harness.state.map.set(
      "run",
      JSON.stringify({ ...checkpoint, stage: "complete", outcome: wake("ignored") }),
    );
    harness.state.alarmAt = harness.clock.now().getTime();

    expect(await harness.fireAlarm(1)).toBeNull();

    expect(harness.evaluator).not.toHaveBeenCalled();
    const instance = await harness.instance();
    expect(instance.activeRunId).toBeUndefined();
    expect(instance.consecutiveIgnores).toBe(0);
    // A wake decision recorded as `ignored` never starts a cooldown.
    expect(instance.cooldownUntil).toBeUndefined();
    expect(instance.lastDecision?.action).toBe("wake");
  });

  it("fails an active run whose checkpoint is gone", async () => {
    const harness = makeHarness({ evaluator: unreachableEvaluator() });
    await harness.append("evt-1");
    harness.clock.advance(1_000);
    expect(await harness.fireAlarm()).toBeInstanceOf(Error);

    harness.state.map.delete("run");
    expect(await harness.fireAlarm(1)).toBeNull();

    const instance = await harness.instance();
    expect(instance.activeRunId).toBeUndefined();
    expect(instance.lastDecision).toBeUndefined();
    const state = (await (await harness.route("state")).json()) as Record<string, any>;
    expect(state.log.at(-1).kind).toBe("run-failed-orphan");
  });

  it("re-arms without claiming when a cooldown still gates the batch", async () => {
    const harness = makeHarness();
    await harness.append("evt-1");
    harness.clock.advance(1_000);
    await harness.fireAlarm();
    const cooldownUntil = (await harness.instance()).cooldownUntil!;

    await harness.append("evt-2");
    // A spurious wake: the alarm is due but the cooldown has not expired.
    harness.state.alarmAt = harness.clock.now().getTime();
    harness.evaluator.mockClear();
    expect(await harness.fireAlarm()).toBeNull();

    expect(harness.evaluator).not.toHaveBeenCalled();
    expect(harness.state.alarmAt).toBe(Date.parse(cooldownUntil));
    const state = (await (await harness.route("state")).json()) as Record<string, any>;
    expect(state.log.at(-1).kind).toBe("claim-empty");
  });

  it("rearm recomputes the due time after celld abandons an alarm", async () => {
    const harness = makeHarness();
    await harness.append("evt-1");
    const due = harness.state.alarmAt!;

    // Six counted failures and celld stops re-dispatching: buffered work, no timer.
    harness.state.alarmAt = null;
    const response = await harness.route("rearm", "POST");

    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({ ok: true, rearmed: true, mode: "recompute" });
    expect(harness.state.alarmAt).toBe(due);
    expect(Date.parse(body.nextEvaluationAt)).toBe(due);
    expect((await harness.instance()).nextEvaluationAt).toBe(body.nextEvaluationAt);
  });

  it("rearm resumes an in-flight run immediately", async () => {
    const harness = makeHarness({ evaluator: unreachableEvaluator() });
    await harness.append("evt-1");
    harness.clock.advance(1_000);
    expect(await harness.fireAlarm()).toBeInstanceOf(Error);
    // celld gave up on the alarm mid-run; the claimed batch has no timer left.
    harness.state.alarmAt = null;
    harness.evaluator.mockClear();
    harness.evaluator.mockImplementation(async () => jsonResponse(wake(), 200));

    const body = (await (await harness.route("rearm", "POST")).json()) as Record<string, any>;

    expect(body).toMatchObject({ ok: true, rearmed: true, mode: "resume-run" });
    expect(harness.state.alarmAt).toBe(harness.clock.now().getTime());
    expect(await harness.fireAlarm(1)).toBeNull();
    expect(harness.evaluator).toHaveBeenCalledOnce();
    expect((await harness.instance()).activeRunId).toBeUndefined();
  });

  it("rearm on an unpinned cell reports the cell is not in use", async () => {
    const harness = makeHarness();
    const response = await harness.route("rearm", "POST");
    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("unpinned-cell");
  });
});
