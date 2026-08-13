/**
 * The mailbox tier contract.
 *
 * The correlation mailbox — the per-key buffer that accumulates post-filter
 * events and decides when a batch is due — has two implementations:
 *
 *   - `store`: the instance row in the {@link MonitorStore}, swept by
 *     `drain()`. The default, and the only tier in a single-process or
 *     PostgreSQL-only deployment.
 *   - `celld`: one celld cell per correlation instance, holding the same
 *     `StoredMonitorInstance` record and running the same lifecycle statechart,
 *     with the cell's durable alarm replacing the due-scan. Runs are driven by
 *     the cell calling back into {@link MonitorRuntime.handleEvaluation}.
 *
 * This module carries only the wire contract shared by the runtime and the
 * cell worker. It imports nothing outside the standard library — the worker
 * bundle must stay free of Node built-ins, exactly like `./time.js` and the
 * lifecycle statechart it sits next to.
 */

import type { StoredMonitorBatch, StoredMonitorInstance } from "./storage.js";
import type {
  ChannelEvent,
  MonitorBindingView,
  MonitorDefinition,
  MonitorDeliveryReceipt,
  MonitorInstanceView,
  MonitorRetention,
} from "./types.js";

export interface StoreMailboxOptions {
  readonly mode: "store";
}

export interface CelldMailboxOptions {
  readonly mode: "celld";
  /** Base URL of any node's public listener; celld proxies to the cell owner. */
  readonly fleetUrl: string;
  /** Where cells call back to run the decision pipeline. Pinned per cell. */
  readonly evaluatorUrl: string;
  /** Shared secret presented by cells as `authorization: Bearer <secret>`. */
  readonly secret: string;
  /** Injectable for tests and for hosts with a non-global fetch. */
  readonly fetch?: typeof fetch | undefined;
}

export type MailboxOptions = StoreMailboxOptions | CelldMailboxOptions;

/**
 * The slice of a monitor definition the lifecycle statechart reads. It is the
 * only configuration a cell needs, and the only configuration it is given: a
 * cell learns it from its first append and pins it with the definition version.
 */
export type CelldCellConfig = Pick<MonitorDefinition<ChannelEvent>, "buffer" | "cooldown"> & {
  /** Effective retention, made explicit so the cell matches the runtime. */
  readonly retention: MonitorRetention;
};

export interface CelldAppendRequest {
  readonly monitorId: string;
  readonly definitionVersion: string;
  /** Pinned on the first append; later appends must match the pinned version. */
  readonly config: CelldCellConfig;
  /** Overridden by the fleet's own `EVALUATOR_URL` var when one is set. */
  readonly evaluatorUrl: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly correlationKey: string;
  readonly correlationKeyHash: string;
  /** Durable idempotency key for the store-to-cell append handoff. */
  readonly subscriptionId: string;
  readonly ref: string;
  readonly bytes: number;
  readonly ingressSequence: string;
  readonly acceptedAt: string;
}

export type CelldAppendOutcome = "opened" | "updated" | "flushed";

export interface CelldAppendResponse {
  readonly ok: true;
  readonly cellName: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly outcome: CelldAppendOutcome;
  readonly flushed: boolean;
  readonly state: string;
  readonly nextEvaluationAt: string | null;
  readonly alarmAt: number | null;
  readonly evaluationGeneration: number;
  readonly now: string;
}

export interface CelldErrorResponse {
  readonly ok: false;
  readonly code: string;
  readonly error: string;
}

/**
 * A cell is pinned to one `monitorId@definitionVersion` by its first append.
 * The instance key already carries both, so a mismatch means durable state was
 * moved across versions (a `compatibleWith` migration or a monitor-ID move)
 * without the fleet following. The runtime dead-letters such appends rather
 * than silently running one version's events through another's configuration.
 */
export const CELLD_DEFINITION_VERSION_MISMATCH = "definition-version-mismatch";
export const CELLD_MALFORMED_APPEND = "malformed-append";
export const CELLD_UNPINNED_CELL = "unpinned-cell";

/** Terminal run outcomes an evaluation can report back to a cell. */
export type EvaluationTerminalStatus =
  | "ignored"
  | "shadowed"
  | "suppressed"
  | "delivered"
  | "unroutable"
  | "dead-lettered";

/** A terminal answer closes the claimed batch in the cell. */
export interface EvaluationTerminalResponse {
  readonly runId: string;
  readonly status: EvaluationTerminalStatus;
  /** Shaped for the cell's `RUN_COMPLETED` dispatch. */
  readonly decision?:
    | {
        readonly action: "ignore" | "wake";
        readonly confidence?: number | undefined;
        readonly reasonClass: string;
      }
    | undefined;
  readonly binding?: MonitorBindingView | undefined;
  readonly receipt?: MonitorDeliveryReceipt | undefined;
  readonly suppression?:
    | { readonly cause: string; readonly scope: string }
    | undefined;
}

/** A durable evaluator retry does not close the cell's claimed batch. */
export interface EvaluationRetryResponse {
  readonly runId: string;
  readonly status: "retry";
  readonly retryAt: string;
}

export type EvaluationResponse = EvaluationTerminalResponse | EvaluationRetryResponse;
export type EvaluationStatus = EvaluationResponse["status"];

export interface EvaluationRequest {
  /** The bearer secret; compared in constant time against the runtime's. */
  readonly secret: string;
  /** Deterministic in (cell, evaluation generation): the idempotency key. */
  readonly runId: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly correlationKey: string;
  readonly correlationKeyHash: string;
  readonly batch: StoredMonitorBatch;
  readonly instanceView: MonitorInstanceView;
  readonly claimedAt: string;
}

/** The evaluator rejected the presented secret. Transports map this to 401. */
export class EvaluationAuthError extends Error {
  constructor(message = "evaluation request presented an invalid secret") {
    super(message);
    this.name = "EvaluationAuthError";
  }
}

/** The evaluation request is not addressed to this runtime, or is malformed. */
export class EvaluationRequestError extends Error {
  readonly code: string;

  constructor(message: string, code = "invalid-request") {
    super(message);
    this.name = "EvaluationRequestError";
    this.code = code;
  }
}

/**
 * Length-independent, content-constant-time string comparison.
 *
 * `node:crypto.timingSafeEqual` is unavailable in a Worker bundle and would
 * throw on unequal lengths anyway; this compares every character of the longer
 * input and folds the length difference into the same accumulator.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const length = Math.max(presented.length, expected.length);
  let difference = presented.length ^ expected.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (presented.charCodeAt(index) | 0) ^ (expected.charCodeAt(index) | 0);
  }
  return difference === 0;
}

/** The instance projection handed to decision, evidence, and route callbacks. */
export function projectInstanceView(instance: StoredMonitorInstance): MonitorInstanceView {
  return {
    correlationKeyHash: instance.correlationKeyHash,
    ...(instance.lastDecision === undefined
      ? {}
      : { lastDecision: structuredClone(instance.lastDecision) }),
    ...(instance.lastWakeAt === undefined ? {} : { lastWakeAt: instance.lastWakeAt }),
    ...(instance.cooldownUntil === undefined ? {} : { cooldownUntil: instance.cooldownUntil }),
    consecutiveIgnores: instance.consecutiveIgnores,
    eventsSinceLastWake: instance.eventsSinceLastWake,
    ...(instance.binding === undefined ? {} : { binding: structuredClone(instance.binding) }),
  };
}

/** The cell URL for one instance key, on any node's public listener. */
export function cellUrl(fleetUrl: string, instanceKey: string, action: string): string {
  const base = fleetUrl.endsWith("/") ? fleetUrl.slice(0, -1) : fleetUrl;
  return `${base}/cells/${encodeURIComponent(instanceKey)}/${action}`;
}
