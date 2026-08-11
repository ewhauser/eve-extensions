/** A JSON value that can be copied into durable records without custom codecs. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;
export type MonitorMode = "active" | "shadow" | "disabled";
export type MonitorAction = "ignore" | "wake";
export type MonitorPhase = "observed" | "undispatched";
export type MonitorReasoning =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface StandardSchema<TOutput = unknown> {
  readonly "~standard": {
    readonly version: number;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: TOutput; readonly issues?: undefined }
      | { readonly issues: readonly unknown[] }
      | Promise<
          | { readonly value: TOutput; readonly issues?: undefined }
          | { readonly issues: readonly unknown[] }
        >;
    readonly types?: { readonly output: TOutput } | undefined;
  };
}

export type SchemaOutput<TSchema> = TSchema extends StandardSchema<infer TOutput>
  ? TOutput
  : never;

export interface SubjectRef {
  readonly namespace: string;
  readonly key: string;
}

export interface ChannelEventActor {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly principalType: "user" | "service" | "app" | "unknown";
  readonly isBot?: boolean | undefined;
  readonly knownAgentPrincipal?: boolean | undefined;
}

export interface ChannelEventOrigin {
  readonly kind: "external" | "agent" | "monitor" | "schedule";
  readonly applicationId?: string | undefined;
  readonly id?: string | undefined;
  readonly causationId?: string | undefined;
  readonly depth: number;
}

export interface ChannelEvent<
  TType extends string = string,
  TData = unknown,
  TReplyTarget = JsonValue,
> {
  /** Eve-internal immutable reference. */
  readonly ref: string;
  /** Stable across provider retries within one channel installation. */
  readonly id: string;
  readonly type: TType;
  readonly version: number;
  readonly occurredAt?: string | undefined;
  readonly receivedAt: string;
  readonly data: TData;
  readonly source: {
    readonly channelId: string;
    readonly installationId: string;
    readonly tenantId: string;
    readonly phase?: MonitorPhase | undefined;
  };
  readonly actor?: ChannelEventActor | undefined;
  /** Opaque and never projected automatically. */
  readonly authRef?: string | undefined;
  readonly replyTarget?: TReplyTarget | undefined;
  readonly subjects?: readonly SubjectRef[] | undefined;
  readonly origin: ChannelEventOrigin;
  readonly trace: {
    readonly traceId: string;
    readonly spanId?: string | undefined;
  };
}

export interface ChannelEventDefinition<TData> {
  readonly schema: StandardSchema<TData>;
  readonly version: number;
  readonly maxBytes: number;
  /** Chat definitions support observed/undispatched subscriptions. */
  readonly chat: boolean;
}

export interface ChannelEventSource<TEvent extends ChannelEvent = ChannelEvent> {
  readonly kind: "channel-event-source";
  readonly channelId: string;
  readonly eventType: TEvent["type"];
  readonly phase?: MonitorPhase | undefined;
  /** Carries the event type invariantly for TypeScript; absent at runtime. */
  readonly __event?: TEvent | undefined;
}

export type ChannelEventDefinitions = Readonly<Record<string, ChannelEventDefinition<unknown>>>;

export type EventForDefinition<
  TType extends string,
  TDefinition,
  TReplyTarget,
> = TDefinition extends ChannelEventDefinition<infer TData>
  ? ChannelEvent<TType, TData, TReplyTarget>
  : never;

export interface DeclaredInboundChannel<
  TInbound extends ChannelEventDefinitions = ChannelEventDefinitions,
  TReplyTarget extends JsonValue = JsonValue,
> {
  readonly id: string;
  readonly inbound: TInbound;
  /** Runtime schema for the canonical reply target carried by inbound events. */
  readonly replyTargetSchema?: StandardSchema<TReplyTarget> | undefined;
  event<TType extends Extract<keyof TInbound, string>>(
    type: TType,
    options?: { readonly phase?: MonitorPhase | undefined },
  ): ChannelEventSource<EventForDefinition<TType, TInbound[TType], TReplyTarget>>;
}

export interface IgnoreDecision<TMetadata = unknown> {
  readonly action: "ignore";
  readonly reason: string;
  readonly confidence?: number | undefined;
  readonly metadata?: TMetadata | undefined;
}

export interface WakeDecision<TMetadata = unknown> {
  readonly action: "wake";
  readonly reason: string;
  readonly confidence?: number | undefined;
  readonly metadata?: TMetadata | undefined;
}

export type MonitorDecision<TIgnore = unknown, TWake = unknown> =
  | IgnoreDecision<TIgnore>
  | WakeDecision<TWake>;

export interface MonitorInstanceView {
  readonly correlationKeyHash: string;
  readonly lastDecision?: {
    readonly action: MonitorAction;
    readonly reasonClass?: string | undefined;
    readonly confidence?: number | undefined;
    readonly decidedAt: string;
  } | undefined;
  readonly lastWakeAt?: string | undefined;
  readonly cooldownUntil?: string | undefined;
  readonly consecutiveIgnores: number;
  readonly eventsSinceLastWake: number;
  readonly binding?: MonitorBindingView | undefined;
}

export interface MonitorBindingView {
  readonly bindingRef: string;
  readonly status: "active" | "idle" | "terminal";
  readonly agentHasParticipated: boolean;
  readonly lastAgentTurnAt?: string | undefined;
  readonly lastAgentOutputAt?: string | undefined;
  readonly lastHumanTurnAt?: string | undefined;
}

export type MonitorBatchClosedBy =
  | "immediate"
  | "quiet-period"
  | "max-wait"
  | "max-events"
  | "max-bytes"
  | "cooldown-expired";

export interface MonitorBatchView {
  readonly openedAt: string;
  readonly closedAt: string;
  readonly closedBy: MonitorBatchClosedBy;
  readonly eventCount: number;
  readonly bytes: number;
  readonly isPartial: boolean;
  readonly omittedEventCount: number;
  readonly omittedBytes: number;
}

export interface MonitorEventContext<TEvent extends ChannelEvent> {
  readonly event: Readonly<TEvent>;
}

export interface MonitorDecisionContext<TEvent extends ChannelEvent> {
  readonly events: readonly Readonly<TEvent>[];
  readonly instance: Readonly<MonitorInstanceView>;
  readonly batch: Readonly<MonitorBatchView>;
}

export interface MonitorWakeContext<
  TEvent extends ChannelEvent,
  TIgnore = unknown,
  TWake = unknown,
> extends MonitorDecisionContext<TEvent> {
  readonly decision: Readonly<MonitorDecision<TIgnore, TWake>>;
}

export type RuleDecision<
  TEvent extends ChannelEvent,
  TIgnore = unknown,
  TWake = unknown,
> = (
  context: MonitorDecisionContext<TEvent>,
) => MonitorDecision<TIgnore, TWake>;

export interface ModelDecisionMetadataSchemas<TIgnore = unknown, TWake = unknown> {
  readonly ignore: StandardSchema<TIgnore>;
  readonly wake: StandardSchema<TWake>;
}

export interface ModelDecisionDefinition<
  TEvent extends ChannelEvent,
  TIgnore = unknown,
  TWake = unknown,
> {
  readonly kind: "model-decision";
  readonly model: string;
  readonly reasoning: MonitorReasoning;
  readonly instructions: string;
  readonly input: (context: MonitorDecisionContext<TEvent>) => JsonValue;
  readonly metadata?: ModelDecisionMetadataSchemas<TIgnore, TWake> | undefined;
  readonly timeout: Duration;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly repairAttempts: 0 | 1;
  readonly onError: MonitorDecision<TIgnore, TWake>;
}

export type ModelDecisionOptions<
  TEvent extends ChannelEvent,
  TIgnore = unknown,
  TWake = unknown,
> = Omit<ModelDecisionDefinition<TEvent, TIgnore, TWake>, "kind" | "repairAttempts"> & {
  readonly repairAttempts?: 0 | 1 | undefined;
};

export interface MonitorModelRequest {
  readonly model: string;
  readonly reasoning: MonitorReasoning;
  readonly instructions: string;
  readonly input: JsonValue;
  readonly timeoutMs: number;
  /** Reserved per-attempt ceiling; invokers should enforce it when the provider permits. */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly repairAttempt: 0 | 1;
  readonly previousInvalidOutput?: unknown;
}

export interface MonitorModelResult {
  readonly output: unknown;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCost?: number | undefined;
  };
}

/** A deliberately tool-less structured model invocation boundary. */
export type MonitorModelInvoker = (request: MonitorModelRequest) => Promise<MonitorModelResult>;

export interface MonitorEvidenceSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly sourceEventRefs: readonly string[];
  readonly projectedEvidence: JsonValue;
  readonly decision: MonitorDecision;
  readonly completeness: MonitorBatchView;
  readonly projectionVersion: string;
}

export interface MonitorSessionTrigger {
  readonly kind: "monitor";
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly runId: string;
  readonly correlationKeyHash: string;
  readonly evidenceSnapshotId: string;
  readonly sourceTypes: readonly string[];
}

export interface MonitorDeliveryRequest<TTarget extends JsonValue = JsonValue> {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly idempotencyKey: string;
  readonly auth: "app";
  readonly target: TTarget;
  readonly bindingRef?: string | undefined;
  readonly session: {
    readonly strategy: "channel" | "correlation";
    readonly idleTimeoutMs?: number | undefined;
  };
  readonly correlationSubject?: SubjectRef | undefined;
  /** Trusted static definition text. */
  readonly taskInstructions: string;
  /** Untrusted structured evidence; adapters must preserve this boundary. */
  readonly evidence: MonitorEvidenceSnapshot;
  readonly trigger: MonitorSessionTrigger;
  readonly concurrency: "coalesce";
}

export interface MonitorDeliveryReceipt {
  readonly binding: MonitorBindingView;
  readonly sessionId: string;
  readonly turnId: string;
  readonly outcome: "accepted" | "coalesced";
}

export interface MonitorDeliveryChannel<TTarget extends JsonValue = JsonValue> {
  readonly id: string;
  deliver(request: MonitorDeliveryRequest<TTarget>): Promise<MonitorDeliveryReceipt>;
}

export interface MonitorRoute<TTarget extends JsonValue = JsonValue> {
  readonly channel: MonitorDeliveryChannel<TTarget>;
  readonly target: TTarget;
  readonly auth: "app";
}

export interface MonitorRetention {
  readonly payload: Duration;
  readonly decisions: Duration;
  readonly dedupe: Duration;
}

export interface MonitorLoopPrevention {
  readonly ignoreOwnAgentEvents: boolean;
  readonly ignoreOwnMonitorEvents: boolean;
  readonly maxInternalCausationDepth: number;
}

export interface MonitorOperationalMetadata {
  readonly owner: string;
  readonly useCase: string;
}

export interface MonitorDefinition<
  TEvent extends ChannelEvent,
  TIgnore = unknown,
  TWake = unknown,
> {
  readonly id: string;
  readonly mode?: MonitorMode | undefined;
  readonly sources: readonly ChannelEventSource<TEvent>[];
  readonly filter?: ((context: MonitorEventContext<TEvent>) => boolean) | undefined;
  readonly correlate?: ((context: MonitorEventContext<TEvent>) => string | null) | undefined;
  readonly buffer?:
    | { readonly mode: "immediate" }
    | {
        readonly mode: "debounce";
        readonly quietPeriod: Duration;
        readonly maxWait: Duration;
        readonly maxEvents: number;
        readonly maxBytes: number;
      }
    | undefined;
  readonly decision:
    | RuleDecision<TEvent, TIgnore, TWake>
    | ModelDecisionDefinition<TEvent, TIgnore, TWake>;
  readonly cooldown?: {
    readonly afterWake: Duration;
    readonly during: "accumulate";
  } | undefined;
  readonly task: {
    readonly instructions: string;
    readonly evidence: (
      context: MonitorWakeContext<TEvent, TIgnore, TWake>,
    ) => JsonValue;
  };
  readonly route: (
    context: MonitorWakeContext<TEvent, TIgnore, TWake>,
  ) => MonitorRoute | null;
  readonly session?: {
    readonly strategy: "channel" | "correlation";
    readonly idleTimeout?: Duration | undefined;
  } | undefined;
  readonly limits?: {
    readonly perMonitor?: {
      readonly maxEventsPerMinute?: number | undefined;
      readonly maxModelCallsPerMinute?: number | undefined;
      readonly maxModelInputTokensPerHour?: number | undefined;
      readonly maxWakesPerHour?: number | undefined;
    } | undefined;
    readonly perKey?: {
      readonly maxWakesPerHour?: number | undefined;
    } | undefined;
    readonly overflow: "buffer" | "drop";
  } | undefined;
  readonly retention?: MonitorRetention | undefined;
  readonly loopPrevention?: MonitorLoopPrevention | undefined;
  readonly metadata: MonitorOperationalMetadata;
}

export interface CompiledMonitor {
  readonly definition: MonitorDefinition<ChannelEvent, any, any>;
  /** Assigned by deployment and pinned into subscriptions and runs. */
  readonly version: string;
  /** One delivery version and additional shadow versions may be active for new subscriptions. */
  readonly active?: boolean | undefined;
  /** Older definition versions whose idle mailbox state may move into this version. */
  readonly compatibleWith?: readonly string[] | undefined;
}

export interface MonitorMigration {
  readonly from: string;
  readonly to: string;
  readonly mode: "move-state";
}

export interface MonitorRemoval {
  readonly id: string;
  readonly mode: "discard-state";
}

export interface MonitorDeployment {
  readonly monitors: readonly CompiledMonitor[];
  readonly monitorMigrations?: readonly MonitorMigration[] | undefined;
  readonly monitorRemovals?: readonly MonitorRemoval[] | undefined;
}

export interface PublishEventInput<TData, TReplyTarget extends JsonValue = JsonValue> {
  readonly tenantId: string;
  readonly installationId: string;
  readonly id: string;
  readonly data: TData;
  readonly occurredAt?: string | undefined;
  readonly actor?: ChannelEventActor | undefined;
  readonly authRef?: string | undefined;
  readonly replyTarget?: TReplyTarget | undefined;
  readonly subjects?: readonly SubjectRef[] | undefined;
  readonly origin: Omit<ChannelEventOrigin, "depth"> & { readonly depth?: number | undefined };
  readonly trace?: {
    readonly traceId?: string | undefined;
    readonly spanId?: string | undefined;
  } | undefined;
}

export type PublishResult =
  | { readonly status: "accepted"; readonly eventId: string; readonly traceId: string }
  | { readonly status: "duplicate"; readonly eventId: string; readonly traceId: string };

export interface DirectDispatchReceipt {
  /** Set only after a turn-creation command was durably accepted. */
  readonly turnId: string;
}

export type ChatPublishResult = PublishResult & {
  readonly directDispatch: "dispatched" | "undispatched" | "failed" | "pending";
};

export interface MonitorClock {
  now(): Date;
}

export interface MonitorLifecycleEvent {
  readonly name:
    | "monitor.event.accepted"
    | "monitor.event.deduplicated"
    | "monitor.event.rejected"
    | "monitor.subscription.filtered"
    | "monitor.subscription.uncorrelated"
    | "monitor.buffer.opened"
    | "monitor.buffer.updated"
    | "monitor.buffer.flushed"
    | "monitor.evaluation.started"
    | "monitor.evaluation.completed"
    | "monitor.evaluation.failed"
    | "monitor.wake.suppressed"
    | "monitor.evidence.materialized"
    | "monitor.delivery.started"
    | "monitor.delivery.completed"
    | "monitor.delivery.failed"
    | "monitor.binding.conflict"
    | "monitor.dead_lettered";
  readonly occurredAt: string;
  readonly tenantId?: string | undefined;
  readonly applicationId: string;
  readonly monitorId?: string | undefined;
  readonly definitionVersion?: string | undefined;
  readonly correlationKeyHash?: string | undefined;
  readonly eventRef?: string | undefined;
  readonly runId?: string | undefined;
  readonly attributes?: Readonly<Record<string, JsonPrimitive>> | undefined;
}

export interface MonitorObserver {
  emit(event: MonitorLifecycleEvent): void | Promise<void>;
}

export interface MonitorRetryPolicy {
  readonly lease: Duration;
  readonly initialBackoff: Duration;
  readonly maxBackoff: Duration;
  readonly maxAttempts: number;
}

export interface MonitorRuntimeLimits {
  readonly maxActiveKeysPerTenant: number;
  readonly maxDrainIterations: number;
  readonly subscriptionConcurrency: number;
  readonly evaluationConcurrency: number;
}

export interface MonitorBudgetCeilings {
  readonly maxEventsPerMinute?: number | undefined;
  readonly maxModelCallsPerMinute?: number | undefined;
  readonly maxModelInputTokensPerHour?: number | undefined;
  readonly maxWakesPerHour?: number | undefined;
}

export interface MonitorBudgetPolicy {
  /** Identifies the shared platform budget domain across applications. */
  readonly platformId: string;
  readonly platform?: MonitorBudgetCeilings | undefined;
  readonly application?: MonitorBudgetCeilings | undefined;
  readonly overflow?: "buffer" | "drop" | undefined;
  readonly tenant?:
    | Readonly<Record<string, MonitorBudgetCeilings>>
    | ((tenantId: string) => MonitorBudgetCeilings | undefined)
    | undefined;
}

export class TransientMonitorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientMonitorError";
  }
}

export class BindingConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BindingConflictError";
  }
}
