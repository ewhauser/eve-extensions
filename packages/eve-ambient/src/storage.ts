import type {
  ChannelEvent,
  JsonValue,
  MonitorBatchClosedBy,
  MonitorBindingView,
  MonitorDecision,
  MonitorDeliveryReceipt,
  MonitorEvidenceSnapshot,
  MonitorMode,
  MonitorInstanceView,
  MonitorPhase,
} from "./types.js";

export interface StoredEvent {
  readonly ref: string;
  readonly dedupeKey: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly channelId: string;
  readonly installationId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly traceId: string;
  /** Monotonic within one tenant/application acceptance domain. */
  readonly ingressSequence: string;
  /** Removed at payload expiry while the source-dedupe tombstone remains. */
  readonly event?: ChannelEvent<string, JsonValue, JsonValue> | undefined;
  readonly bytes: number;
  readonly acceptedAt: string;
  readonly payloadExpiresAt: string;
  readonly dedupeExpiresAt: string;
  /** Durable coordination for chat direct-dispatch completion. */
  readonly directDispatch?: StoredDirectDispatch | undefined;
}

export interface StoredDirectDispatch {
  readonly status: "pending" | "processing" | "dispatched" | "undispatched" | "failed";
  readonly attempt: number;
  readonly availableAt: string;
  readonly leaseExpiresAt?: string | undefined;
  readonly error?: string | undefined;
  readonly updatedAt: string;
}

export type SubscriptionStatus =
  | "pending"
  | "processing"
  | "ready"
  | "buffered"
  | "filtered"
  | "uncorrelated"
  | "suppressed"
  | "dead-lettered";

export interface StoredSubscription {
  readonly id: string;
  readonly eventRef: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly ingressSequence: string;
  readonly phase?: MonitorPhase | undefined;
  readonly status: SubscriptionStatus;
  readonly attempt: number;
  readonly availableAt: string;
  readonly leaseExpiresAt?: string | undefined;
  readonly correlationKeyHash?: string | undefined;
  readonly correlationKey?: string | undefined;
  readonly outcome?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BufferedEventRef {
  readonly ref: string;
  readonly bytes: number;
  readonly acceptedAt: string;
  readonly ingressSequence: string;
}

export interface OpenMonitorBatch {
  readonly events: readonly BufferedEventRef[];
  readonly bytes: number;
  readonly openedAt: string;
  readonly updatedAt: string;
}

export interface StoredMonitorBatch {
  readonly events: readonly BufferedEventRef[];
  readonly bytes: number;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly closedBy: MonitorBatchClosedBy;
}

export interface StoredLastDecision {
  readonly action: "ignore" | "wake";
  readonly reasonClass?: string | undefined;
  readonly confidence?: number | undefined;
  readonly decidedAt: string;
}

export interface StoredMonitorInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly correlationKey: string;
  readonly correlationKeyHash: string;
  readonly openBatch?: OpenMonitorBatch | undefined;
  readonly sealedBatches: readonly StoredMonitorBatch[];
  readonly activeRunId?: string | undefined;
  readonly nextEvaluationAt?: string | undefined;
  readonly evaluationGeneration: number;
  readonly lastDecision?: StoredLastDecision | undefined;
  readonly lastWakeAt?: string | undefined;
  readonly cooldownUntil?: string | undefined;
  readonly consecutiveIgnores: number;
  readonly eventsSinceLastWake: number;
  readonly binding?: MonitorBindingView | undefined;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MonitorRunStatus =
  | "pending"
  | "processing"
  | "retry"
  | "ignored"
  | "shadowed"
  | "suppressed"
  | "delivered"
  | "unroutable"
  | "dead-lettered";

export type MonitorRunStage =
  | "decision"
  | "policy"
  | "evidence"
  | "route"
  | "delivery"
  | "complete";

export interface StoredMonitorRun {
  readonly id: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly correlationKeyHash: string;
  readonly batch: StoredMonitorBatch;
  readonly mode: MonitorMode;
  readonly instanceView: MonitorInstanceView;
  readonly status: MonitorRunStatus;
  readonly stage: MonitorRunStage;
  readonly attempt: number;
  readonly availableAt: string;
  readonly leaseExpiresAt?: string | undefined;
  readonly decision?: MonitorDecision | undefined;
  readonly decisionSource?: "rule" | "model" | "fallback" | undefined;
  readonly modelUsage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCost?: number | undefined;
  } | undefined;
  readonly snapshot?: MonitorEvidenceSnapshot | undefined;
  readonly route?: {
    readonly channelId: string;
    readonly target: JsonValue;
  } | undefined;
  readonly receipt?: MonitorDeliveryReceipt | undefined;
  readonly suppression?: {
    readonly cause: string;
    readonly scope: string;
    readonly retryAt?: string | undefined;
  } | undefined;
  readonly error?: string | undefined;
  /** The earliest raw event expiry; live/downstream replay requires this input. */
  readonly replayExpiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

export interface StoredDeadLetter {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly monitorId?: string | undefined;
  readonly definitionVersion?: string | undefined;
  readonly eventRef?: string | undefined;
  readonly subscriptionId?: string | undefined;
  readonly instanceId?: string | undefined;
  readonly runId?: string | undefined;
  readonly stage: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface StoredDeployment {
  readonly applicationId: string;
  /** Mailbox ownership is durable; changing it without migration strands work. */
  readonly mailboxMode?: "store" | "celld" | undefined;
  readonly activeMonitorIds: readonly string[];
  readonly activeVersions: Readonly<Record<string, readonly string[]>>;
  /** Definition versions pinned by cells, which are not visible in store tables. */
  readonly celldDefinitionPins?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly updatedAt: string;
}

export interface StoredDefinitionPin {
  readonly kind: "subscription" | "instance" | "run";
  readonly id: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
}

export interface UsageReservation {
  readonly id: string;
  readonly scope: string;
  readonly metric: string;
  readonly amount: number;
  readonly occurredAt: string;
  readonly expiresAt: string;
}

export interface MonitorStoreTransaction {
  getEventByDedupeKey(key: string): Promise<StoredEvent | null>;
  getEvent(ref: string): Promise<StoredEvent | null>;
  releaseEventDedupe(ref: string): Promise<void>;
  putEvent(event: StoredEvent): Promise<void>;

  getSubscription(id: string): Promise<StoredSubscription | null>;
  putSubscription(subscription: StoredSubscription): Promise<void>;
  deleteSubscription(id: string): Promise<void>;

  getInstance(id: string): Promise<StoredMonitorInstance | null>;
  countInstances(input: {
    readonly tenantId: string;
    readonly applicationId: string;
  }): Promise<number>;
  putInstance(instance: StoredMonitorInstance): Promise<void>;
  deleteInstance(id: string): Promise<void>;

  getRun(id: string): Promise<StoredMonitorRun | null>;
  putRun(run: StoredMonitorRun): Promise<void>;

  putDeadLetter(deadLetter: StoredDeadLetter): Promise<void>;

  getDeployment(applicationId: string): Promise<StoredDeployment | null>;
  putDeployment(deployment: StoredDeployment): Promise<void>;

  nextIngressSequence(scope: string): Promise<string>;
  hasEarlierOpenSubscription(input: {
    readonly tenantId: string;
    readonly applicationId: string;
    readonly monitorId: string;
    readonly definitionVersion: string;
    readonly correlationKeyHash: string;
    readonly ingressSequence: string;
  }): Promise<boolean>;

  /** Atomically reserves a rolling-window budget and returns its next opening. */
  reserveUsage(input: {
    readonly id: string;
    readonly scope: string;
    readonly metric: string;
    readonly amount: number;
    readonly limit: number;
    readonly windowMs: number;
    readonly now: string;
  }): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly retryAt: string }>;
}

export interface MonitorStore {
  /** The callback runs in a transaction protected by a stable cross-process lock key. */
  transaction<T>(lockKey: string, callback: (tx: MonitorStoreTransaction) => Promise<T>): Promise<T>;

  listSubscriptions(input: {
    readonly applicationId: string;
    readonly statuses: readonly SubscriptionStatus[];
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredSubscription[]>;
  listSubscriptionsForMonitor(input: {
    readonly applicationId: string;
    readonly monitorId: string;
  }): Promise<readonly StoredSubscription[]>;
  listDueInstances(input: {
    readonly applicationId: string;
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredMonitorInstance[]>;
  listDueRuns(input: {
    readonly applicationId: string;
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredMonitorRun[]>;
  listInstances(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
  }): Promise<readonly StoredMonitorInstance[]>;
  listRuns(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly StoredMonitorRun[]>;
  listDeadLetters(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly StoredDeadLetter[]>;
  listDefinitionPins(applicationId: string): Promise<readonly StoredDefinitionPin[]>;
  getRun(id: string): Promise<StoredMonitorRun | null>;
  getEvent(ref: string): Promise<StoredEvent | null>;
  getInstance(id: string): Promise<StoredMonitorInstance | null>;
  purgeExpired(now: string): Promise<{
    readonly events: number;
    readonly runs: number;
    readonly instances: number;
    readonly usage: number;
  }>;
}

export function instanceStoreKey(input: {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly correlationKeyHash: string;
}): string {
  return scopedKey(
    input.tenantId,
    input.applicationId,
    input.monitorId,
    input.definitionVersion,
    input.correlationKeyHash,
  );
}

const UTF8 = new TextEncoder();

/**
 * Collision-free encoding for durable compound key and lock components.
 *
 * `TextEncoder` rather than `Buffer.byteLength(part, "utf8")` — identical byte
 * counts, but no Node built-in, so this module stays bundleable for non-Node
 * hosts alongside the lifecycle statechart.
 */
export function scopedKey(...parts: readonly string[]): string {
  return parts.map((part) => `${UTF8.encode(part).length}:${part}`).join("|");
}
