/**
 * The eve-ambient correlation mailbox as a celld cell.
 *
 * One Durable Object class, `MonitorInstance`. One cell per correlation
 * instance; the cell name *is* the instance key (`instanceStoreKey(...)`).
 * The cell reimplements no lifecycle logic: every state transition goes
 * through `dispatchLifecycle` from the package's own statechart, bundled from
 * `../src`. What the cell supplies is the two things the store-backed runtime
 * gets from its database and its sweeper — durable storage for the
 * `StoredMonitorInstance` record, and a timer for `nextEvaluationAt`.
 *
 * The cell carries no monitor configuration of its own. It learns
 * `monitorId`, `definitionVersion`, and the buffer/cooldown configuration from
 * its first append and pins them; an append that disagrees with the pin is
 * rejected with `definition-version-mismatch`, which the runtime dead-letters.
 *
 * The cell never calls a model and holds no provider credentials. On claim it
 * POSTs an evaluation request to the runtime's evaluator, which runs the
 * decision/budget/evidence/route/delivery pipeline and records the run.
 *
 * Routes (through any node's public listener; celld proxies to the owner):
 *
 *   GET  /health
 *   POST /cells/<name>/append   CelldAppendRequest
 *   GET  /cells/<name>/state    stored instance + alarm + transition log
 *   POST /cells/<name>/rearm    recompute nextEvaluationAt and re-arm the alarm
 *   GET  /cells/<name>/whoami   DO id (for ownership tracing)
 *
 * Everything under /cells requires `authorization: Bearer $EVALUATOR_SECRET`
 * when that var is set.
 */

import {
  computeNextEvaluationAt,
  deriveLifecycleValue,
  dispatchLifecycle,
  lifecycleConfig,
} from "../src/instance-machine.js";
import {
  CELLD_DEFINITION_VERSION_MISMATCH,
  CELLD_MALFORMED_APPEND,
  CELLD_UNPINNED_CELL,
  projectInstanceView,
  secretsMatch,
} from "../src/mailbox.js";
import type {
  CelldAppendOutcome,
  CelldAppendRequest,
  CelldCellConfig,
  EvaluationRequest,
  EvaluationResponse,
} from "../src/mailbox.js";
import { scopedKey } from "../src/storage.js";
import type {
  StoredMonitorBatch,
  StoredMonitorInstance,
} from "../src/storage.js";
import { addMs, durationMs } from "../src/time.js";
import type {
  ChannelEvent,
  MonitorDefinition,
  MonitorInstanceView,
} from "../src/types.js";

/** `DEFAULT_RETENTION.decisions`, the value the runtime refreshes by. */
const RETENTION_MS = durationMs("30d");
const LOG_LIMIT = 60;

/** What the first append pins into the cell, and nothing else ever changes. */
interface CellPin {
  readonly cellName: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly config: CelldCellConfig;
  readonly evaluatorUrl: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly correlationKey: string;
  readonly correlationKeyHash: string;
  readonly pinnedAt: string;
}

/**
 * The in-flight run, checkpointed before every irreversible step so an alarm
 * retry after partial progress resumes instead of redoing. This is the cell's
 * stand-in for `StoredMonitorRun.stage`; the authoritative run record, with
 * its own finer-grained stages, is written by the evaluator.
 */
interface RunCheckpoint {
  readonly runId: string;
  readonly stage: "evaluating" | "complete";
  readonly batch: StoredMonitorBatch;
  readonly instanceView: MonitorInstanceView;
  readonly claimedAt: string;
  readonly outcome?: EvaluationResponse | undefined;
}

interface LogEntry {
  readonly at: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

type Storage = any;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Deterministic in (instance key, evaluation generation) — and identical to
 * the id the store-backed runtime derives for the same claim, so a run is the
 * same run whichever tier produced it. It is also the evaluator's idempotency
 * key, which is what makes a retried alarm safe.
 */
async function deterministicRunId(cellName: string, generation: number): Promise<string> {
  const data = new TextEncoder().encode(scopedKey(cellName, String(generation)));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `run_${hex}`;
}

export class MonitorInstance {
  readonly state: any;
  readonly env: any;

  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
  }

  get #storage(): Storage {
    return this.state.storage;
  }

  /**
   * Test seams. A deployed fleet passes `vars`, which are strings, so neither
   * is ever present in production.
   */
  #now(): string {
    const clock = this.env?.clock;
    return typeof clock?.now === "function"
      ? (clock.now() as Date).toISOString()
      : new Date().toISOString();
  }

  #nowMs(): number {
    return Date.parse(this.#now());
  }

  #fetch(input: string, init: RequestInit): Promise<Response> {
    const injected = this.env?.fetch;
    return typeof injected === "function"
      ? (injected(input, init) as Promise<Response>)
      : fetch(input, init);
  }

  // --- durable accessors -------------------------------------------------
  //
  // Everything is stored as a JSON *string*, not as a structured-cloned
  // object. That deliberately reproduces the store tier, which persists
  // `JSON.stringify(instance)` into a jsonb column: keys whose value is
  // `undefined` disappear on the round trip. `dispatchLifecycle` reads every
  // optional field with `!== undefined`, so an absent key and an explicit
  // `undefined` are indistinguishable to it — which is why the two tiers'
  // conformance runs agree.

  async #readJson<T>(key: string): Promise<T | undefined> {
    const raw = await this.#storage.get(key);
    return raw === undefined || raw === null ? undefined : (JSON.parse(raw as string) as T);
  }

  async #writeJson(key: string, value: unknown): Promise<void> {
    await this.#storage.put(key, JSON.stringify(value));
  }

  async #log(entry: LogEntry): Promise<void> {
    const log = (await this.#readJson<LogEntry[]>("log")) ?? [];
    log.push(entry);
    await this.#writeJson("log", log.slice(-LOG_LIMIT));
  }

  #definition(config: CelldCellConfig): MonitorDefinition<ChannelEvent> {
    // `lifecycleConfig()` reads exactly `buffer` and `cooldown`; everything
    // else on a definition belongs to the evaluator's pipeline.
    return config as unknown as MonitorDefinition<ChannelEvent>;
  }

  /**
   * Mirrors the runtime's `#newInstance`. The cell has no subscription record
   * to copy tenancy from, so those fields come off the pinned append.
   */
  #newInstance(pin: CellPin, now: string): StoredMonitorInstance {
    return {
      id: pin.cellName,
      tenantId: pin.tenantId,
      applicationId: pin.applicationId,
      monitorId: pin.monitorId,
      definitionVersion: pin.definitionVersion,
      correlationKey: pin.correlationKey,
      correlationKeyHash: pin.correlationKeyHash,
      sealedBatches: [],
      evaluationGeneration: 0,
      consecutiveIgnores: 0,
      eventsSinceLastWake: 0,
      expiresAt: addMs(now, RETENTION_MS),
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * The instance's `nextEvaluationAt` is the alarm. Three cases:
   *   - a due time              -> setAlarm (clamped to not-in-the-past)
   *   - no due time, run active -> leave the alarm alone; it is either the
   *     alarm currently executing or celld's pending retry of it. Deleting it
   *     would strand the claimed batch.
   *   - no due time, no run     -> deleteAlarm
   */
  async #arm(instance: StoredMonitorInstance): Promise<number | null> {
    if (instance.nextEvaluationAt !== undefined) {
      const at = Math.max(Date.parse(instance.nextEvaluationAt), this.#nowMs());
      await this.#storage.setAlarm(at);
      return at;
    }
    if (instance.activeRunId !== undefined) {
      return (await this.#storage.getAlarm()) ?? null;
    }
    await this.#storage.deleteAlarm();
    return null;
  }

  async #cellName(request?: Request): Promise<string> {
    const header = request?.headers.get("x-cell-name");
    if (header !== null && header !== undefined && header.length > 0) return header;
    const stored = await this.#storage.get("cellName");
    if (typeof stored === "string") return stored;
    return this.state.id?.name ?? String(this.state.id);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const action = parts[parts.length - 1] ?? "state";

    if (action === "whoami") {
      return json({ ok: true, id: String(this.state.id), name: this.state.id?.name ?? null });
    }
    if (action === "append") return await this.#append(request);
    if (action === "rearm") return await this.#rearm(request);
    if (action === "state") return await this.#state(request);
    return json({ ok: false, code: "unknown-action", error: `unknown cell action ${action}` }, 404);
  }

  async #append(request: Request): Promise<Response> {
    let body: CelldAppendRequest;
    try {
      body = (await request.json()) as CelldAppendRequest;
    } catch (error) {
      return json({ ok: false, code: CELLD_MALFORMED_APPEND, error: String(error) }, 400);
    }
    if (
      typeof body?.monitorId !== "string" ||
      typeof body?.definitionVersion !== "string" ||
      typeof body?.ref !== "string" ||
      typeof body?.config !== "object" ||
      body.config === null
    ) {
      return json(
        {
          ok: false,
          code: CELLD_MALFORMED_APPEND,
          error: "append requires monitorId, definitionVersion, ref, and config",
        },
        400,
      );
    }
    const now = this.#now();
    const name = await this.#cellName(request);
    await this.#storage.put("cellName", name);

    let pin = await this.#readJson<CellPin>("cell");
    if (pin === undefined) {
      // A cell learns its monitor, version, and configuration from the first
      // append and keeps them for its lifetime.
      pin = {
        cellName: name,
        monitorId: body.monitorId,
        definitionVersion: body.definitionVersion,
        config: body.config,
        evaluatorUrl: body.evaluatorUrl,
        tenantId: body.tenantId,
        applicationId: body.applicationId,
        correlationKey: body.correlationKey,
        correlationKeyHash: body.correlationKeyHash,
        pinnedAt: now,
      };
      await this.#writeJson("cell", pin);
    } else if (
      pin.monitorId !== body.monitorId ||
      pin.definitionVersion !== body.definitionVersion
    ) {
      // The instance key already carries both, so a mismatch means durable
      // state was moved across versions without the fleet following. Running
      // one version's events through another's buffer configuration would be
      // silent corruption; refuse, and let the runtime dead-letter it.
      return json(
        {
          ok: false,
          code: CELLD_DEFINITION_VERSION_MISMATCH,
          error:
            `cell ${name} is pinned to ${pin.monitorId}@${pin.definitionVersion}; ` +
            `append carried ${body.monitorId}@${body.definitionVersion}`,
        },
        409,
      );
    }
    const definition = this.#definition(pin.config);

    const existing = await this.#readJson<StoredMonitorInstance>("instance");
    let instance = existing ?? this.#newInstance(pin, now);

    const bytes = typeof body.bytes === "number" ? body.bytes : 0;
    const acceptedAt = body.acceptedAt ?? now;

    // A copy of the ingress payload, for this cell's own inspection surface.
    // The evaluator reads authoritative payloads from the event store.
    await this.#writeJson(`evt:${body.ref}`, {
      ref: body.ref,
      bytes,
      acceptedAt,
      ingressSequence: body.ingressSequence,
      payload: body.payload ?? null,
      storedAt: now,
    });

    const result = dispatchLifecycle(instance, definition, {
      type: "APPEND",
      ref: { ref: body.ref, bytes, acceptedAt, ingressSequence: body.ingressSequence },
      now,
    });
    instance = { ...result.instance, expiresAt: addMs(now, RETENTION_MS), updatedAt: now };
    await this.#writeJson("instance", instance);
    const alarmAt = await this.#arm(instance);

    const outcome: CelldAppendOutcome =
      existing === undefined ? "opened" : result.flushed ? "flushed" : "updated";
    await this.#log({
      at: now,
      kind: "append",
      ref: body.ref,
      flushed: result.flushed,
      outcome,
      state: deriveLifecycleValue(instance, now),
      nextEvaluationAt: instance.nextEvaluationAt ?? null,
      alarmAt,
    });

    return json({
      ok: true,
      cellName: name,
      monitorId: pin.monitorId,
      definitionVersion: pin.definitionVersion,
      outcome,
      flushed: result.flushed,
      state: deriveLifecycleValue(instance, now),
      openBatchSize: instance.openBatch?.events.length ?? 0,
      sealedBatches: instance.sealedBatches.length,
      cooldownUntil: instance.cooldownUntil ?? null,
      nextEvaluationAt: instance.nextEvaluationAt ?? null,
      alarmAt,
      evaluationGeneration: instance.evaluationGeneration,
      now,
    });
  }

  async #state(request: Request): Promise<Response> {
    const now = this.#now();
    const instance = await this.#readJson<StoredMonitorInstance>("instance");
    const buffered: string[] = [];
    const listed = await this.#storage.list({ prefix: "evt:" });
    for (const key of listed.keys()) buffered.push(String(key).slice(4));
    return json({
      ok: true,
      cellName: await this.#cellName(request),
      pin: (await this.#readJson<CellPin>("cell")) ?? null,
      doId: String(this.state.id),
      instance: instance ?? null,
      state: instance === undefined ? null : deriveLifecycleValue(instance, now),
      pendingAlarm: (await this.#storage.getAlarm()) ?? null,
      activeRun: (await this.#readJson<RunCheckpoint>("run")) ?? null,
      bufferedEventRefs: buffered.sort(),
      log: (await this.#readJson<LogEntry[]>("log")) ?? [],
      now,
    });
  }

  /**
   * Recomputes `nextEvaluationAt` from the stored record and re-arms the
   * alarm — the documented mitigation for celld abandoning an alarm after six
   * counted handler failures, which otherwise leaves a cell with buffered work
   * and no timer to evaluate it.
   *
   * No transition semantics live here: `computeNextEvaluationAt` is the same
   * derivation `dispatchLifecycle` applies, over the same record. A cell with
   * an active run is re-armed for *now* instead, because the timer that would
   * have retried its evaluation is exactly the one that was abandoned.
   */
  async #rearm(request: Request): Promise<Response> {
    const now = this.#now();
    const pin = await this.#readJson<CellPin>("cell");
    if (pin === undefined) {
      return json({ ok: false, code: CELLD_UNPINNED_CELL, error: "cell has no pinned monitor" }, 409);
    }
    const instance = await this.#readJson<StoredMonitorInstance>("instance");
    if (instance === undefined) {
      return json({ ok: true, rearmed: false, reason: "no instance record", now });
    }
    if (instance.activeRunId !== undefined) {
      const at = this.#nowMs();
      await this.#storage.setAlarm(at);
      await this.#log({ at: now, kind: "rearm", mode: "resume-run", runId: instance.activeRunId, alarmAt: at });
      return json({
        ok: true,
        rearmed: true,
        mode: "resume-run",
        cellName: await this.#cellName(request),
        activeRunId: instance.activeRunId,
        alarmAt: at,
        now,
      });
    }
    const config = lifecycleConfig(this.#definition(pin.config));
    const nextEvaluationAt = computeNextEvaluationAt(
      {
        config,
        activeRunId: undefined,
        cooldownUntil: instance.cooldownUntil,
        openBatch: instance.openBatch,
        sealedBatches: instance.sealedBatches,
      },
      now,
    );
    const next: StoredMonitorInstance = {
      ...instance,
      ...(nextEvaluationAt === undefined
        ? { nextEvaluationAt: undefined }
        : { nextEvaluationAt }),
      updatedAt: now,
    };
    await this.#writeJson("instance", next);
    const alarmAt = await this.#arm(next);
    await this.#log({
      at: now,
      kind: "rearm",
      mode: "recompute",
      nextEvaluationAt: nextEvaluationAt ?? null,
      alarmAt,
    });
    return json({
      ok: true,
      rearmed: true,
      mode: "recompute",
      cellName: await this.#cellName(request),
      state: deriveLifecycleValue(next, now),
      nextEvaluationAt: nextEvaluationAt ?? null,
      alarmAt,
      now,
    });
  }

  /**
   * The evaluation tick: the store tier's due-instance sweep collapsed into a
   * timer. Claim, evaluate, complete — each step checkpointed, and any failure
   * thrown so celld's native alarm retry (2s doubling, six counted failures)
   * is the retry ladder.
   *
   * celld re-dispatches a due alarm while its handler is still running (the
   * `_cf_ALARM` row is deleted in `finish_alarm_handler`, i.e. only once the
   * handler ends), so a handler that awaits an outbound fetch reliably gets a
   * second, *concurrent* invocation. Cloudflare's Durable Objects never
   * overlap alarm handlers. `blockConcurrencyWhile` shuts the cell's input
   * gate, which restores that guarantee: the second dispatch queues, and by
   * the time it runs the run is complete and the alarm cleared.
   *
   * See https://github.com/denoland/celld/issues/144. The cost of the
   * workaround is that appends queue behind an in-flight evaluation.
   *
   * The block must not reject — a failed critical section resets the actor —
   * so failures are carried out of the block and rethrown here, where celld's
   * alarm retry ladder sees them.
   */
  async alarm(info?: { retryCount?: number }): Promise<void> {
    const attempt = async (): Promise<unknown> => {
      try {
        await this.#evaluate(info);
        return null;
      } catch (error) {
        return error;
      }
    };
    const failure =
      typeof this.state.blockConcurrencyWhile === "function"
        ? await this.state.blockConcurrencyWhile(attempt)
        : await attempt();
    if (failure !== null) throw failure;
  }

  async #evaluate(info?: { retryCount?: number }): Promise<void> {
    const retryCount = info?.retryCount ?? 0;
    // Tags every log line so concurrent invocations of the same alarm are
    // distinguishable after the fact.
    const invocation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let now = this.#now();
    let instance = await this.#readJson<StoredMonitorInstance>("instance");
    if (instance === undefined) return;
    const pin = await this.#readJson<CellPin>("cell");
    if (pin === undefined) return;
    const definition = this.#definition(pin.config);

    let run = await this.#readJson<RunCheckpoint>("run");

    if (instance.activeRunId !== undefined && run?.runId === instance.activeRunId) {
      // Resuming a run whose alarm failed part-way. Skip the claim entirely:
      // the batch is already out of the buffer and recorded in the checkpoint.
      await this.#log({
        inv: invocation,
        at: now,
        kind: "resume",
        runId: run.runId,
        stage: run.stage,
        retryCount,
      });
    } else if (instance.activeRunId !== undefined) {
      // A run is active but its checkpoint is gone. Nothing can be replayed,
      // so fail the run the way the runtime's dead-letter path does.
      const failed = dispatchLifecycle(instance, definition, { type: "RUN_FAILED", now });
      instance = { ...failed.instance, updatedAt: now };
      await this.#storage.delete("run");
      await this.#writeJson("instance", instance);
      await this.#log({ inv: invocation, at: now, kind: "run-failed-orphan", retryCount });
      await this.#arm(instance);
      return;
    } else {
      const generation = instance.evaluationGeneration + 1;
      const runId = await deterministicRunId(pin.cellName, generation);
      const instanceView = projectInstanceView(instance);
      const claim = dispatchLifecycle(instance, definition, { type: "CLAIM", runId, now });
      if (claim.claimedBatch === undefined) {
        // A spurious wake is normal: an alarm can fire while a cooldown still
        // gates the batch. Persist the refreshed record and re-arm.
        instance = { ...claim.instance, updatedAt: now };
        await this.#writeJson("instance", instance);
        const alarmAt = await this.#arm(instance);
        await this.#log({
          inv: invocation,
          at: now,
          kind: "claim-empty",
          state: deriveLifecycleValue(instance, now),
          nextEvaluationAt: instance.nextEvaluationAt ?? null,
          alarmAt,
          retryCount,
        });
        return;
      }
      instance = { ...claim.instance, updatedAt: now };
      run = {
        runId,
        stage: "evaluating",
        batch: claim.claimedBatch,
        instanceView,
        claimedAt: now,
      };
      // Checkpoint first: after this pair of writes an interrupted alarm
      // resumes rather than re-claims.
      await this.#writeJson("run", run);
      await this.#writeJson("instance", instance);
      await this.#log({
        inv: invocation,
        at: now,
        kind: "claim",
        runId,
        closedBy: claim.claimedBatch.closedBy,
        refs: claim.claimedBatch.events.map((event) => event.ref),
        retryCount,
      });
    }

    // --- evaluation stage ------------------------------------------------
    const claimed = run!;
    let outcome = claimed.outcome;
    if (outcome === undefined) {
      outcome = await this.#callEvaluator(pin, claimed, retryCount, invocation);
      run = { ...claimed, outcome, stage: "complete" };
      await this.#writeJson("run", run);
    }

    // --- completion ------------------------------------------------------
    now = this.#now();
    const completion =
      outcome.status === "dead-lettered"
        ? dispatchLifecycle(instance, definition, { type: "RUN_FAILED", now })
        : dispatchLifecycle(instance, definition, {
            type: "RUN_COMPLETED",
            status: outcome.status,
            ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
            ...(outcome.binding === undefined ? {} : { binding: outcome.binding }),
            now,
          });
    instance = { ...completion.instance, expiresAt: addMs(now, RETENTION_MS), updatedAt: now };
    for (const reference of claimed.batch.events) {
      await this.#storage.delete(`evt:${reference.ref}`);
    }
    // Instance before checkpoint delete: a crash between the two leaves a
    // stale checkpoint with activeRunId already cleared, which the next claim
    // harmlessly overwrites. The reverse order left activeRunId pointing at a
    // vanished checkpoint, and the orphan path then RUN_FAILED away the
    // completed wake's cooldown and counters.
    await this.#writeJson("instance", instance);
    await this.#storage.delete("run");
    const alarmAt = await this.#arm(instance);
    await this.#log({
      inv: invocation,
      at: now,
      kind: outcome.status === "dead-lettered" ? "dead-lettered" : "completed",
      runId: claimed.runId,
      status: outcome.status,
      decision: outcome.decision ?? null,
      closedBy: claimed.batch.closedBy,
      refs: claimed.batch.events.map((event) => event.ref),
      state: deriveLifecycleValue(instance, now),
      cooldownUntil: instance.cooldownUntil ?? null,
      nextEvaluationAt: instance.nextEvaluationAt ?? null,
      alarmAt,
      retryCount,
    });
  }

  /**
   * Hands the claimed batch to the runtime's evaluator. Refs, never payloads:
   * the events were persisted at ingress and the evaluator reads the
   * authoritative copies from the event store.
   *
   * A throw here rides celld's alarm-retry ladder, and the run is idempotent
   * by `runId`, so a retry after a lost response returns the recorded outcome
   * rather than delivering twice.
   */
  async #callEvaluator(
    pin: CellPin,
    run: RunCheckpoint,
    retryCount: number,
    invocation: string,
  ): Promise<EvaluationResponse> {
    const target = String(this.env.EVALUATOR_URL ?? pin.evaluatorUrl);
    const secret = String(this.env.EVALUATOR_SECRET ?? "");
    const body: Omit<EvaluationRequest, "secret"> = {
      runId: run.runId,
      instanceId: pin.cellName,
      tenantId: pin.tenantId,
      applicationId: pin.applicationId,
      monitorId: pin.monitorId,
      definitionVersion: pin.definitionVersion,
      correlationKey: pin.correlationKey,
      correlationKeyHash: pin.correlationKeyHash,
      batch: run.batch,
      instanceView: run.instanceView,
      claimedAt: run.claimedAt,
    };
    let response: Response;
    try {
      response = await this.#fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      await this.#log({
        inv: invocation,
        at: this.#now(),
        kind: "evaluation-error",
        runId: run.runId,
        retryCount,
        error: String(error),
      });
      throw new Error(`evaluation of ${run.runId} could not reach ${target}: ${String(error)}`);
    }
    if (!response.ok) {
      await this.#log({
        inv: invocation,
        at: this.#now(),
        kind: "evaluation-rejected",
        runId: run.runId,
        status: response.status,
        retryCount,
      });
      throw new Error(`evaluation of ${run.runId} returned ${response.status}`);
    }
    const parsed = (await response.json()) as EvaluationResponse;
    if (parsed === null || typeof parsed !== "object" || typeof parsed.status !== "string") {
      throw new Error(`evaluation of ${run.runId} returned a malformed response`);
    }
    return parsed;
  }
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "health") return json({ ok: true, app: "eve-ambient-mailbox" });
    if (parts[0] !== "cells" || parts.length < 2) {
      return json(
        { ok: false, error: "use /cells/<instanceKey>/<append|state|rearm|whoami>" },
        404,
      );
    }
    const secret = env?.EVALUATOR_SECRET;
    if (typeof secret === "string" && secret.length > 0) {
      const header = request.headers.get("authorization") ?? "";
      const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
      if (!secretsMatch(match?.[1] ?? "", secret)) {
        return json({ ok: false, code: "unauthorized", error: "unauthorized" }, 401);
      }
    }
    const name = decodeURIComponent(parts[1]!);
    const action = parts[2] ?? "state";

    const id = env.MONITOR.idFromName(name);
    const stub = env.MONITOR.get(id);
    const inner = new URL(url);
    inner.pathname = `/${action}`;
    // The cell needs its own name inside alarm(), where there is no request.
    // Pass it explicitly rather than relying on `state.id.name` surviving a
    // restore on another node.
    const forwarded = new Request(inner.toString(), request);
    forwarded.headers.set("x-cell-name", name);
    const response = await stub.fetch(forwarded);
    const out = new Response(response.body, response);
    out.headers.set("x-cell-name", name);
    return out;
  },
};
