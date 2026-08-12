import { createActor, setup, assign } from "xstate";
import type {
  BufferedEventRef,
  OpenMonitorBatch,
  StoredLastDecision,
  StoredMonitorBatch,
  StoredMonitorInstance,
} from "./storage.js";
import type {
  ChannelEvent,
  MonitorBatchClosedBy,
  MonitorBindingView,
  MonitorDefinition,
} from "./types.js";
import { addMs, durationMs, minTimestamp } from "./util.js";

/**
 * The correlation-instance mailbox lifecycle from RFC §10, expressed as an
 * explicit statechart. The runtime persists only `StoredMonitorInstance`
 * fields; the state value is derived from those fields at hydration, so the
 * machine is a pure transition table over durable context and every event
 * carries its own clock reading.
 */

export type LifecycleStateValue = "idle" | "collecting" | "evaluating" | "cooldown";

export interface LifecycleBufferConfig {
  readonly mode: "immediate" | "debounce";
  readonly quietPeriodMs?: number | undefined;
  readonly maxWaitMs?: number | undefined;
  readonly maxEvents?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export interface LifecycleConfig {
  readonly buffer: LifecycleBufferConfig;
  readonly cooldownAfterWakeMs?: number | undefined;
}

export interface LifecycleContext {
  readonly config: LifecycleConfig;
  readonly openBatch: OpenMonitorBatch | undefined;
  readonly sealedBatches: readonly StoredMonitorBatch[];
  readonly activeRunId: string | undefined;
  readonly evaluationGeneration: number;
  readonly lastDecision: StoredLastDecision | undefined;
  readonly lastWakeAt: string | undefined;
  readonly cooldownUntil: string | undefined;
  readonly consecutiveIgnores: number;
  readonly eventsSinceLastWake: number;
  readonly binding: MonitorBindingView | undefined;
  /** Transient dispatch outputs; stripped before persistence. */
  readonly lastAppendFlushed: boolean;
  readonly claimedBatch: StoredMonitorBatch | undefined;
}

export type LifecycleRunStatus =
  | "ignored"
  | "shadowed"
  | "suppressed"
  | "delivered"
  | "unroutable";

export type LifecycleEvent =
  | { readonly type: "APPEND"; readonly ref: BufferedEventRef; readonly now: string }
  | { readonly type: "CLAIM"; readonly runId: string; readonly now: string }
  | {
      readonly type: "RUN_COMPLETED";
      readonly status: LifecycleRunStatus;
      readonly decision?:
        | {
            readonly action: "ignore" | "wake";
            readonly confidence?: number | undefined;
            readonly reasonClass: string;
          }
        | undefined;
      readonly binding?: MonitorBindingView | undefined;
      readonly now: string;
    }
  | { readonly type: "RUN_FAILED"; readonly now: string };

/** Reproduces the historical due-batch selection, including closedBy causes. */
function selectDueBatch(
  context: LifecycleContext,
  now: string,
):
  | { readonly kind: "sealed"; readonly batch: StoredMonitorBatch }
  | { readonly kind: "open"; readonly closedBy: MonitorBatchClosedBy }
  | null {
  if (context.cooldownUntil !== undefined && context.cooldownUntil > now) return null;
  const first = context.sealedBatches[0];
  if (first !== undefined) return { kind: "sealed", batch: first };
  const open = context.openBatch;
  if (open === undefined) return null;
  if (context.cooldownUntil !== undefined && context.cooldownUntil <= now) {
    return { kind: "open", closedBy: "cooldown-expired" };
  }
  if (context.config.buffer.mode === "immediate") return { kind: "open", closedBy: "immediate" };
  const quiet = addMs(open.updatedAt, context.config.buffer.quietPeriodMs!);
  const maximum = addMs(open.openedAt, context.config.buffer.maxWaitMs!);
  if (quiet > now && maximum > now) return null;
  return { kind: "open", closedBy: maximum <= quiet ? "max-wait" : "quiet-period" };
}

function closeBatch(
  open: OpenMonitorBatch,
  now: string,
  closedBy: MonitorBatchClosedBy,
): StoredMonitorBatch {
  return {
    events: open.events,
    bytes: open.bytes,
    openedAt: open.openedAt,
    closedAt: now,
    closedBy,
  };
}

function appendRef(context: LifecycleContext, ref: BufferedEventRef, now: string): Partial<LifecycleContext> {
  const buffer = context.config.buffer;
  if (buffer.mode === "immediate") {
    if (context.cooldownUntil !== undefined && context.cooldownUntil > now) {
      const open = context.openBatch;
      return {
        openBatch:
          open === undefined
            ? { events: [ref], bytes: ref.bytes, openedAt: now, updatedAt: now }
            : {
                ...open,
                events: [...open.events, ref],
                bytes: open.bytes + ref.bytes,
                updatedAt: now,
              },
        eventsSinceLastWake: context.eventsSinceLastWake + 1,
        lastAppendFlushed: false,
      };
    }
    return {
      sealedBatches: [
        ...context.sealedBatches,
        { events: [ref], bytes: ref.bytes, openedAt: now, closedAt: now, closedBy: "immediate" },
      ],
      eventsSinceLastWake: context.eventsSinceLastWake + 1,
      lastAppendFlushed: true,
    };
  }
  let open = context.openBatch;
  const sealed = [...context.sealedBatches];
  let flushed = false;
  if (
    open !== undefined &&
    (open.events.length + 1 > buffer.maxEvents! || open.bytes + ref.bytes > buffer.maxBytes!)
  ) {
    const closedBy: MonitorBatchClosedBy =
      open.events.length + 1 > buffer.maxEvents! ? "max-events" : "max-bytes";
    sealed.push(closeBatch(open, now, closedBy));
    open = undefined;
    flushed = true;
  }
  open =
    open === undefined
      ? { events: [ref], bytes: ref.bytes, openedAt: now, updatedAt: now }
      : {
          ...open,
          events: [...open.events, ref],
          bytes: open.bytes + ref.bytes,
          updatedAt: now,
        };
  return {
    openBatch: open,
    sealedBatches: sealed,
    eventsSinceLastWake: context.eventsSinceLastWake + 1,
    lastAppendFlushed: flushed,
  };
}

function completeRun(
  context: LifecycleContext,
  event: Extract<LifecycleEvent, { type: "RUN_COMPLETED" }>,
): Partial<LifecycleContext> {
  let next: LifecycleContext = {
    ...context,
    activeRunId: undefined,
    claimedBatch: undefined,
    lastDecision:
      event.decision === undefined
        ? context.lastDecision
        : {
            action: event.decision.action,
            ...(event.decision.confidence === undefined
              ? {}
              : { confidence: event.decision.confidence }),
            reasonClass: event.decision.reasonClass,
            decidedAt: event.now,
          },
    consecutiveIgnores:
      event.decision?.action === "ignore"
        ? context.consecutiveIgnores + 1
        : context.consecutiveIgnores,
    binding: event.binding ?? context.binding,
  };
  if (
    event.decision?.action === "wake" &&
    (event.status === "delivered" || event.status === "shadowed")
  ) {
    next = {
      ...next,
      lastWakeAt: event.now,
      eventsSinceLastWake: 0,
      consecutiveIgnores: 0,
      cooldownUntil:
        context.config.cooldownAfterWakeMs === undefined
          ? undefined
          : addMs(event.now, context.config.cooldownAfterWakeMs),
    };
  }
  if (
    next.cooldownUntil !== undefined &&
    next.cooldownUntil <= event.now &&
    next.openBatch === undefined
  ) {
    // Preserve an expired cooldown while its accumulated open batch is still
    // waiting behind older sealed work. The claim that closes that open batch
    // consumes the marker and records the cooldown-expired closure cause.
    next = { ...next, cooldownUntil: undefined };
  }
  if (
    context.config.buffer.mode === "immediate" &&
    next.cooldownUntil !== undefined &&
    next.cooldownUntil > event.now &&
    next.sealedBatches.length > 0
  ) {
    next = consolidateBatches(next, event.now);
  }
  return next;
}

function consolidateBatches(context: LifecycleContext, now: string): LifecycleContext {
  const events = [
    ...context.sealedBatches.flatMap((batch) => batch.events),
    ...(context.openBatch?.events ?? []),
  ];
  if (events.length === 0) return context;
  const openedAt = [
    ...context.sealedBatches.map((batch) => batch.openedAt),
    ...(context.openBatch === undefined ? [] : [context.openBatch.openedAt]),
  ].sort()[0]!;
  return {
    ...context,
    sealedBatches: [],
    openBatch: {
      events,
      bytes: events.reduce((sum, event) => sum + event.bytes, 0),
      openedAt,
      updatedAt: now,
    },
  };
}

export const instanceLifecycleMachine = setup({
  types: {
    context: {} as LifecycleContext,
    events: {} as LifecycleEvent,
    input: {} as { readonly config: LifecycleConfig },
  },
  guards: {
    batchDue: ({ context, event }) =>
      event.type === "CLAIM" && selectDueBatch(context, event.now) !== null,
    wakeStartsCooldown: ({ context, event }) =>
      event.type === "RUN_COMPLETED" &&
      event.decision?.action === "wake" &&
      (event.status === "delivered" || event.status === "shadowed") &&
      context.config.cooldownAfterWakeMs !== undefined,
    hasBufferedWork: ({ context }) =>
      context.openBatch !== undefined || context.sealedBatches.length > 0,
  },
  actions: {
    append: assign(({ context, event }) => {
      if (event.type !== "APPEND") return {};
      return appendRef(context, event.ref, event.now);
    }),
    claim: assign(({ context, event }) => {
      if (event.type !== "CLAIM") return {};
      const due = selectDueBatch(context, event.now);
      if (due === null) return {};
      const batch =
        due.kind === "sealed" ? due.batch : closeBatch(context.openBatch!, event.now, due.closedBy);
      return {
        sealedBatches: due.kind === "sealed" ? context.sealedBatches.slice(1) : context.sealedBatches,
        openBatch: due.kind === "sealed" ? context.openBatch : undefined,
        activeRunId: event.runId,
        evaluationGeneration: context.evaluationGeneration + 1,
        claimedBatch: batch,
        // An expired cooldown is consumed only by the claim that closes its
        // accumulated open batch. A sealed batch may be selected first; keep
        // the marker in that case so the gated batch retains its closure cause.
        ...(context.cooldownUntil !== undefined &&
          context.cooldownUntil <= event.now &&
          (due.kind === "open" || context.openBatch === undefined)
          ? { cooldownUntil: undefined }
          : {}),
      };
    }),
    complete: assign(({ context, event }) => {
      if (event.type !== "RUN_COMPLETED") return {};
      return completeRun(context, event);
    }),
    clearRun: assign(() => ({ activeRunId: undefined, claimedBatch: undefined })),
  },
}).createMachine({
  id: "monitorInstance",
  context: ({ input }) => ({
    config: input.config,
    openBatch: undefined,
    sealedBatches: [],
    activeRunId: undefined,
    evaluationGeneration: 0,
    lastDecision: undefined,
    lastWakeAt: undefined,
    cooldownUntil: undefined,
    consecutiveIgnores: 0,
    eventsSinceLastWake: 0,
    binding: undefined,
    lastAppendFlushed: false,
    claimedBatch: undefined,
  }),
  initial: "idle",
  states: {
    idle: {
      on: {
        APPEND: { target: "collecting", actions: "append" },
      },
    },
    collecting: {
      on: {
        APPEND: { actions: "append" },
        CLAIM: { guard: "batchDue", target: "evaluating", actions: "claim" },
      },
    },
    evaluating: {
      on: {
        APPEND: { actions: "append" },
        RUN_COMPLETED: [
          { guard: "wakeStartsCooldown", target: "cooldown", actions: "complete" },
          { guard: "hasBufferedWork", target: "collecting", actions: "complete" },
          { target: "idle", actions: "complete" },
        ],
        RUN_FAILED: [
          { guard: "hasBufferedWork", target: "collecting", actions: "clearRun" },
          { target: "idle", actions: "clearRun" },
        ],
      },
    },
    cooldown: {
      on: {
        APPEND: { actions: "append" },
        CLAIM: { guard: "batchDue", target: "evaluating", actions: "claim" },
      },
    },
  },
});

export function lifecycleConfig(definition: MonitorDefinition<ChannelEvent>): LifecycleConfig {
  const buffer = definition.buffer ?? { mode: "immediate" as const };
  return {
    buffer:
      buffer.mode === "immediate"
        ? { mode: "immediate" }
        : {
            mode: "debounce",
            quietPeriodMs: durationMs(buffer.quietPeriod),
            maxWaitMs: durationMs(buffer.maxWait),
            maxEvents: buffer.maxEvents,
            maxBytes: buffer.maxBytes,
          },
    ...(definition.cooldown === undefined
      ? {}
      : { cooldownAfterWakeMs: durationMs(definition.cooldown.afterWake) }),
  };
}

/** Derives the statechart value from durable instance fields at hydration. */
export function deriveLifecycleValue(
  instance: Pick<
    StoredMonitorInstance,
    "activeRunId" | "cooldownUntil" | "openBatch" | "sealedBatches"
  >,
  now: string,
): LifecycleStateValue {
  if (instance.activeRunId !== undefined) return "evaluating";
  if (instance.cooldownUntil !== undefined && instance.cooldownUntil > now) return "cooldown";
  if (instance.openBatch !== undefined || instance.sealedBatches.length > 0) return "collecting";
  return "idle";
}

/** The store's due-scan timer, derived from machine context. */
export function computeNextEvaluationAt(
  context: Pick<
    LifecycleContext,
    "config" | "activeRunId" | "cooldownUntil" | "openBatch" | "sealedBatches"
  >,
  now: string,
): string | undefined {
  if (context.activeRunId !== undefined) return undefined;
  const hasEvents = context.sealedBatches.length > 0 || context.openBatch !== undefined;
  if (!hasEvents) return undefined;
  if (context.cooldownUntil !== undefined) {
    if (context.cooldownUntil > now) return context.cooldownUntil;
    // A retained expired cooldown means an open batch is still waiting behind
    // sealed work. Reschedule it immediately rather than applying debounce.
    if (context.openBatch !== undefined) return now;
  }
  if (context.sealedBatches.length > 0) return now;
  const open = context.openBatch!;
  if (context.config.buffer.mode === "immediate") return now;
  return minTimestamp(
    addMs(open.updatedAt, context.config.buffer.quietPeriodMs!),
    addMs(open.openedAt, context.config.buffer.maxWaitMs!),
  );
}

export interface LifecycleDispatchResult {
  readonly instance: StoredMonitorInstance;
  readonly flushed: boolean;
  readonly claimedBatch: StoredMonitorBatch | undefined;
}

/**
 * Hydrates the machine from a stored instance, applies one event, and maps
 * the resulting context back onto the stored record, including the derived
 * `nextEvaluationAt`. Timestamp maintenance (`updatedAt`, `expiresAt`) stays
 * with the caller.
 */
export function dispatchLifecycle(
  instance: StoredMonitorInstance,
  definition: MonitorDefinition<ChannelEvent>,
  event: LifecycleEvent,
): LifecycleDispatchResult {
  const config = lifecycleConfig(definition);
  const context: LifecycleContext = {
    config,
    openBatch: instance.openBatch,
    sealedBatches: instance.sealedBatches,
    activeRunId: instance.activeRunId,
    evaluationGeneration: instance.evaluationGeneration,
    lastDecision: instance.lastDecision,
    lastWakeAt: instance.lastWakeAt,
    cooldownUntil: instance.cooldownUntil,
    consecutiveIgnores: instance.consecutiveIgnores,
    eventsSinceLastWake: instance.eventsSinceLastWake,
    binding: instance.binding,
    lastAppendFlushed: false,
    claimedBatch: undefined,
  };
  const snapshot = instanceLifecycleMachine.resolveState({
    value: deriveLifecycleValue(instance, event.now),
    context,
  });
  // `input` is unused when restoring from a snapshot but required by the types.
  const actor = createActor(instanceLifecycleMachine, { snapshot, input: { config } });
  actor.start();
  actor.send(event);
  const next = actor.getSnapshot().context;
  actor.stop();
  return {
    instance: {
      ...instance,
      ...(next.openBatch === undefined ? { openBatch: undefined } : { openBatch: next.openBatch }),
      sealedBatches: next.sealedBatches,
      ...(next.activeRunId === undefined
        ? { activeRunId: undefined }
        : { activeRunId: next.activeRunId }),
      evaluationGeneration: next.evaluationGeneration,
      ...(next.lastDecision === undefined ? {} : { lastDecision: next.lastDecision }),
      ...(next.lastWakeAt === undefined ? {} : { lastWakeAt: next.lastWakeAt }),
      ...(next.cooldownUntil === undefined
        ? { cooldownUntil: undefined }
        : { cooldownUntil: next.cooldownUntil }),
      consecutiveIgnores: next.consecutiveIgnores,
      eventsSinceLastWake: next.eventsSinceLastWake,
      ...(next.binding === undefined ? {} : { binding: next.binding }),
      nextEvaluationAt: computeNextEvaluationAt(next, event.now),
    },
    flushed: next.lastAppendFlushed,
    claimedBatch: next.claimedBatch,
  };
}
