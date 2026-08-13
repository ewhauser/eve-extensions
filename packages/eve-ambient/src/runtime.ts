import {
  DEFAULT_LOOP_PREVENTION,
  DEFAULT_RETENTION,
  sourceMatches,
  validateDecision,
  validateMonitorDefinition,
} from "./definition.js";
import { dispatchLifecycle } from "./instance-machine.js";
import {
  CELLD_DEFINITION_VERSION_MISMATCH,
  EvaluationAuthError,
  EvaluationRequestError,
  cellUrl,
  projectInstanceView,
  secretsMatch,
} from "./mailbox.js";
import type {
  CelldAppendOutcome,
  CelldAppendRequest,
  CelldAppendResponse,
  CelldErrorResponse,
  CelldMailboxOptions,
  EvaluationRequest,
  EvaluationResponse,
  EvaluationTerminalStatus,
  MailboxOptions,
} from "./mailbox.js";
import type {
  BufferedEventRef,
  MonitorStore,
  MonitorStoreTransaction,
  StoredEvent,
  StoredMonitorBatch,
  StoredMonitorInstance,
  StoredMonitorRun,
  StoredSubscription,
} from "./storage.js";
import { instanceStoreKey, scopedKey } from "./storage.js";
import {
  BindingConflictError,
  TransientMonitorError,
  type MonitorEvidenceSnapshot,
} from "./types.js";
import type {
  ChannelEvent,
  ChannelEventDefinitions,
  ChatPublishResult,
  CompiledMonitor,
  DeclaredInboundChannel,
  DirectDispatchReceipt,
  JsonPrimitive,
  JsonValue,
  MonitorBatchClosedBy,
  MonitorBatchView,
  MonitorBindingView,
  MonitorBudgetCeilings,
  MonitorBudgetPolicy,
  MonitorClock,
  MonitorDecision,
  MonitorDefinition,
  MonitorDeliveryChannel,
  MonitorDeployment,
  MonitorInstanceView,
  MonitorLifecycleEvent,
  MonitorModelInvoker,
  MonitorObserver,
  MonitorRetryPolicy,
  MonitorRuntimeLimits,
  MonitorWakeContext,
  PublishEventInput,
  PublishResult,
  SchemaOutput,
} from "./types.js";
import {
  addMs,
  assertBoundedText,
  assertIdentifier,
  assertJsonValue,
  assertNonEmpty,
  assertPositiveSafeInteger,
  canonicalJson,
  cloneJson,
  durationMs,
  errorMessage,
  estimateJsonTokens,
  freeze,
  isPromiseLike,
  iso,
  jsonBytes,
  minTimestamp,
  opaqueId,
  parseSchema,
  stableHash,
} from "./util.js";

const DEFAULT_RETRY_POLICY: MonitorRetryPolicy = {
  lease: "30s",
  initialBackoff: "1s",
  maxBackoff: "1m",
  maxAttempts: 8,
};

const DEFAULT_RUNTIME_LIMITS: MonitorRuntimeLimits = {
  maxActiveKeysPerTenant: 100_000,
  maxDrainIterations: 10_000,
  subscriptionConcurrency: 32,
  evaluationConcurrency: 16,
};

const SYSTEM_CLOCK: MonitorClock = { now: () => new Date() };
const DEFAULT_EVIDENCE_MAX_BYTES = 1_000_000;
const TARGET_MAX_BYTES = 65_536;

export interface MonitorRuntimeOptions {
  readonly applicationId: string;
  readonly deployment: MonitorDeployment;
  readonly channels: readonly DeclaredInboundChannel[];
  readonly deliveryChannels?: readonly MonitorDeliveryChannel[] | undefined;
  readonly store: MonitorStore;
  readonly modelInvoker?: MonitorModelInvoker | undefined;
  readonly clock?: MonitorClock | undefined;
  readonly observer?: MonitorObserver | undefined;
  readonly retry?: Partial<MonitorRetryPolicy> | undefined;
  readonly limits?: Partial<MonitorRuntimeLimits> | undefined;
  readonly budgets?: MonitorBudgetPolicy | undefined;
  readonly maxEvidenceBytes?: number | undefined;
  readonly idGenerator?: ((prefix: string) => string) | undefined;
  /**
   * Where the correlation mailbox lives. Defaults to `{ mode: "store" }`, the
   * store-backed buffer swept by `drain()`. See `./mailbox.js` and the celld
   * section of the README for the experimental cell-backed tier.
   */
  readonly mailbox?: MailboxOptions | undefined;
}

export interface DrainResult {
  readonly subscriptions: number;
  readonly evaluations: number;
  readonly runs: number;
  readonly remaining: boolean;
}

export interface ReplayOptions {
  readonly decision: "recorded" | "live";
  readonly shadow?: boolean | undefined;
  readonly canary?: {
    readonly channel: MonitorDeliveryChannel;
    readonly target: JsonValue;
  } | undefined;
}

export interface ReplayResult {
  readonly runId: string;
  readonly decision: MonitorDecision;
  readonly evidence: JsonValue;
  readonly route: { readonly channelId: string; readonly target: JsonValue } | null;
  readonly delivered: boolean;
}

/**
 * Durable monitor state machine. `publish()` commits only ingress and fan-out;
 * `drain()` performs preprocessing, timer claims, decisions, and delivery.
 */
export class MonitorRuntime {
  readonly #applicationId: string;
  readonly #store: MonitorStore;
  readonly #modelInvoker: MonitorModelInvoker | undefined;
  readonly #clock: MonitorClock;
  readonly #observer: MonitorObserver | undefined;
  readonly #retry: RequiredRetryPolicy;
  readonly #limits: MonitorRuntimeLimits;
  readonly #budgets: MonitorBudgetPolicy | undefined;
  readonly #maxEvidenceBytes: number;
  readonly #id: (prefix: string) => string;
  readonly #channels = new Map<string, object>();
  readonly #deliveryChannels = new Map<string, MonitorDeliveryChannel>();
  readonly #definitions = new Map<string, CompiledMonitor>();
  readonly #activeDefinitions = new Map<string, CompiledMonitor>();
  readonly #deliveryDefinitions = new Map<string, CompiledMonitor>();
  readonly #deployment: MonitorDeployment;
  readonly #mailbox: MailboxOptions;
  readonly #fetch: typeof fetch;
  readonly #recordedCelldDefinitionPins = new Set<string>();
  #initialized = false;

  constructor(options: MonitorRuntimeOptions) {
    assertNonEmpty(options.applicationId, "applicationId");
    this.#applicationId = options.applicationId;
    this.#store = options.store;
    this.#modelInvoker = options.modelInvoker;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#observer = options.observer;
    this.#id = options.idGenerator ?? opaqueId;
    this.#retry = prepareRetryPolicy(options.retry);
    this.#limits = prepareRuntimeLimits(options.limits);
    this.#budgets = options.budgets;
    this.#maxEvidenceBytes = options.maxEvidenceBytes ?? DEFAULT_EVIDENCE_MAX_BYTES;
    assertPositiveSafeInteger(this.#maxEvidenceBytes, "maxEvidenceBytes");
    if (this.#budgets !== undefined) {
      assertNonEmpty(this.#budgets.platformId, "budget platformId");
      validateBudgetCeilings(this.#budgets.platform, "budgets.platform");
      validateBudgetCeilings(this.#budgets.application, "budgets.application");
      if (typeof this.#budgets.tenant === "object") {
        for (const [tenant, ceilings] of Object.entries(this.#budgets.tenant)) {
          validateBudgetCeilings(ceilings, `budgets.tenant.${tenant}`);
        }
      }
    }
    validateDeploymentChanges(options.deployment);
    this.#deployment = options.deployment;
    this.#mailbox = options.mailbox ?? { mode: "store" };
    if (this.#mailbox.mode === "celld") {
      assertNonEmpty(this.#mailbox.fleetUrl, "mailbox fleetUrl");
      assertNonEmpty(this.#mailbox.evaluatorUrl, "mailbox evaluatorUrl");
      assertNonEmpty(this.#mailbox.secret, "mailbox secret");
      const injected = this.#mailbox.fetch;
      if (injected === undefined && typeof globalThis.fetch !== "function") {
        throw new TypeError("celld mailbox requires a global fetch or an injected one");
      }
      this.#fetch = injected ?? ((...args) => globalThis.fetch(...args));
    } else {
      this.#fetch = (...args) => globalThis.fetch(...args);
    }

    for (const channel of options.channels) {
      if (this.#channels.has(channel.id)) throw new TypeError(`duplicate channel id ${channel.id}`);
      this.#channels.set(channel.id, channel);
    }
    for (const channel of options.deliveryChannels ?? []) {
      if (this.#deliveryChannels.has(channel.id)) {
        throw new TypeError(`duplicate delivery channel id ${channel.id}`);
      }
      this.#deliveryChannels.set(channel.id, channel);
    }
    this.#prepareDefinitions(options.deployment.monitors);
  }

  get applicationId(): string {
    return this.#applicationId;
  }

  /** Validates durable identity changes and applies explicit moves/removals. */
  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const activeIds = [...new Set(
      [...this.#activeDefinitions.values()].map((monitor) => monitor.definition.id),
    )].sort();
    const activeVersions: Record<string, string[]> = {};
    for (const monitor of this.#activeDefinitions.values()) {
      (activeVersions[monitor.definition.id] ??= []).push(monitor.version);
    }
    for (const versions of Object.values(activeVersions)) versions.sort();
    const migrations = new Map(
      (this.#deployment.monitorMigrations ?? []).map((migration) => [migration.from, migration]),
    );
    const removals = new Set(
      (this.#deployment.monitorRemovals ?? []).map((removal) => removal.id),
    );
    if (this.#mailbox.mode === "celld") {
      if (migrations.size > 0 || removals.size > 0) {
        throw new Error(
          "celld mailbox does not support monitor migrations or removals; drain or migrate the fleet before changing durable identity",
        );
      }
      const compatible = this.#deployment.monitors.find(
        (monitor) => (monitor.compatibleWith?.length ?? 0) > 0,
      );
      if (compatible !== undefined) {
        throw new Error(
          `celld mailbox does not support compatibleWith migrations (${compatible.definition.id}@${compatible.version}); cells must be migrated explicitly`,
        );
      }
    }
    for (const migration of migrations.values()) {
      if (activeIds.includes(migration.from)) {
        throw new Error(`migration source ${migration.from} must not remain active`);
      }
    }
    for (const id of removals) {
      if (activeIds.includes(id)) throw new Error(`removed monitor ${id} must not remain active`);
    }

    const expectedDeployment = await this.#store.transaction(
      `deployment:${this.#applicationId}`,
      async (tx) => {
      const previous = await tx.getDeployment(this.#applicationId);
      if (previous !== null) {
        const previousMailboxMode = previous.mailboxMode ?? "store";
        if (previousMailboxMode !== this.#mailbox.mode) {
          throw new Error(
            `mailbox mode cannot change from ${previousMailboxMode} to ${this.#mailbox.mode} without an explicit durable-state migration`,
          );
        }
        for (const id of previous.activeMonitorIds) {
          if (!activeIds.includes(id) && !migrations.has(id) && !removals.has(id)) {
            throw new Error(
              `monitor ${id} disappeared; declare a move-state migration or discard-state removal`,
            );
          }
        }
      }
        return previous;
      },
    );

    for (const migration of migrations.values()) await this.#migrateMonitor(migration.from, migration.to);
    for (const id of removals) await this.#removeMonitorState(id);
    await this.#migrateCompatibleVersions();
    await this.#validatePinnedDefinitions();
    this.#validateCelldDefinitionPins(expectedDeployment?.celldDefinitionPins);
    for (const [monitorId, versions] of Object.entries(
      expectedDeployment?.celldDefinitionPins ?? {},
    )) {
      for (const version of versions) {
        this.#recordedCelldDefinitionPins.add(definitionKey(monitorId, version));
      }
    }

    await this.#store.transaction(`deployment:${this.#applicationId}`, async (tx) => {
      const current = await tx.getDeployment(this.#applicationId);
      if (canonicalJson(current) !== canonicalJson(expectedDeployment)) {
        throw new Error("monitor deployment changed concurrently; retry initialization");
      }
      await tx.putDeployment({
        applicationId: this.#applicationId,
        mailboxMode: this.#mailbox.mode,
        activeMonitorIds: activeIds,
        activeVersions,
        ...(expectedDeployment?.celldDefinitionPins === undefined
          ? {}
          : { celldDefinitionPins: expectedDeployment.celldDefinitionPins }),
        updatedAt: this.#now(),
      });
    });
    this.#initialized = true;
  }

  async publish<
    TInbound extends ChannelEventDefinitions,
    TReplyTarget extends JsonValue,
    TType extends Extract<keyof TInbound, string>,
  >(
    channel: DeclaredInboundChannel<TInbound, TReplyTarget>,
    type: TType,
    input: PublishEventInput<SchemaOutput<TInbound[TType]["schema"]>, TReplyTarget>,
  ): Promise<PublishResult> {
    const definition = channel.inbound[type];
    if (definition === undefined) throw new TypeError(`channel ${channel.id} has no ${type} event`);
    if (definition.chat) {
      throw new TypeError(`chat event ${channel.id}:${type} must use publishChat()`);
    }
    return this.#acceptEvent(channel, type, input, undefined);
  }

  async publishChat<
    TInbound extends ChannelEventDefinitions,
    TReplyTarget extends JsonValue,
    TType extends Extract<keyof TInbound, string>,
  >(
    channel: DeclaredInboundChannel<TInbound, TReplyTarget>,
    type: TType,
    input: PublishEventInput<SchemaOutput<TInbound[TType]["schema"]>, TReplyTarget>,
    directHandlers: readonly (() => Promise<DirectDispatchReceipt | null>)[],
  ): Promise<ChatPublishResult> {
    const definition = channel.inbound[type];
    if (definition === undefined || !definition.chat) {
      throw new TypeError(`channel ${channel.id}:${type} is not a chat event`);
    }
    const accepted = await this.#acceptEvent(channel, type, input, "observed");
    const directDispatch = await this.#runDirectDispatch(accepted.eventId, directHandlers);
    return { ...accepted, directDispatch };
  }

  async #runDirectDispatch(
    eventRef: string,
    directHandlers: readonly (() => Promise<DirectDispatchReceipt | null>)[],
  ): Promise<ChatPublishResult["directDispatch"]> {
    const claim = await this.#claimDirectDispatch(eventRef);
    if (claim.kind !== "claimed") return claim.outcome;
    try {
      const receipts = await Promise.all(directHandlers.map((handler) => handler()));
      const outcome = receipts.some((receipt) => receipt !== null)
        ? "dispatched" as const
        : "undispatched" as const;
      return this.#completeDirectDispatch(eventRef, claim.attempt, outcome);
    } catch (error) {
      return this.#failDirectDispatch(eventRef, claim.attempt, error);
    }
  }

  /**
   * Runs all currently due work. It never advances the supplied clock.
   *
   * Under the celld mailbox the ingress half is unchanged — subscriptions are
   * still preprocessed and appended here — but the evaluation half is not
   * swept: due batches are held by cells and evaluated when their alarms fire
   * and call {@link handleEvaluation}. Claiming them here would race the cell
   * for the same batch.
   */
  async drain(): Promise<DrainResult> {
    this.#assertInitialized();
    const sweepsEvaluations = this.#mailbox.mode !== "celld";
    let subscriptions = 0;
    let evaluations = 0;
    let runs = 0;
    let iterations = 0;
    let progressed = true;
    while (progressed && iterations < this.#limits.maxDrainIterations) {
      progressed = false;
      const subscriptionBatch = await this.#store.listSubscriptions({
        applicationId: this.#applicationId,
        statuses: ["pending", "processing"],
        availableBefore: this.#now(),
        limit: this.#limits.subscriptionConcurrency,
      });
      if (subscriptionBatch.length > 0) {
        await Promise.all(subscriptionBatch.map((subscription) => this.#processSubscription(subscription.id)));
        subscriptions += subscriptionBatch.length;
        progressed = true;
      }

      const readySubscriptions = await this.#store.listSubscriptions({
        applicationId: this.#applicationId,
        statuses: ["ready"],
        availableBefore: this.#now(),
        limit: this.#limits.subscriptionConcurrency,
      });
      if (readySubscriptions.length > 0) {
        const groups = groupSubscriptions(readySubscriptions);
        await Promise.all(
          groups.map(async (group) => {
            for (const subscription of group) await this.#appendReadySubscription(subscription.id);
          }),
        );
        subscriptions += readySubscriptions.length;
        progressed = true;
      }

      if (sweepsEvaluations) {
        const dueInstances = await this.#store.listDueInstances({
          applicationId: this.#applicationId,
          availableBefore: this.#now(),
          limit: this.#limits.evaluationConcurrency,
        });
        if (dueInstances.length > 0) {
          const claims = await Promise.all(dueInstances.map((instance) => this.#claimEvaluation(instance.id)));
          const claimed = claims.filter((value): value is string => value !== null);
          evaluations += claimed.length;
          progressed ||= claimed.length > 0;
        }

        const dueRuns = await this.#store.listDueRuns({
          applicationId: this.#applicationId,
          availableBefore: this.#now(),
          limit: this.#limits.evaluationConcurrency,
        });
        if (dueRuns.length > 0) {
          await Promise.all(dueRuns.map((run) => this.#processRun(run.id)));
          runs += dueRuns.length;
          progressed = true;
        }
      }
      iterations += 1;
    }

    const now = this.#now();
    const [pendingSubscriptions, pendingInstances, pendingRuns] = await Promise.all([
      this.#store.listSubscriptions({
        applicationId: this.#applicationId,
        statuses: ["pending", "processing", "ready"],
        availableBefore: now,
        limit: 1,
      }),
      sweepsEvaluations
        ? this.#store.listDueInstances({ applicationId: this.#applicationId, availableBefore: now, limit: 1 })
        : [],
      sweepsEvaluations
        ? this.#store.listDueRuns({ applicationId: this.#applicationId, availableBefore: now, limit: 1 })
        : [],
    ]);
    return {
      subscriptions,
      evaluations,
      runs,
      remaining:
        pendingSubscriptions.length > 0 || pendingInstances.length > 0 || pendingRuns.length > 0,
    };
  }

  async replay(runId: string, options: ReplayOptions): Promise<ReplayResult> {
    this.#assertInitialized();
    const run = await this.#store.getRun(runId);
    if (run === null || run.applicationId !== this.#applicationId) {
      throw new Error(`unknown monitor run ${runId}`);
    }
    if (run.replayExpiresAt <= this.#now()) {
      throw new Error(
        `monitor run ${runId} replay input expired at ${run.replayExpiresAt}; ` +
        `the decision record remains available until ${run.expiresAt}`,
      );
    }
    const monitor = this.#definition(run.monitorId, run.definitionVersion);
    const events = await this.#loadRunEvents(run);
    const contextBase = {
      events,
      instance: freeze(structuredClone(run.instanceView)),
      batch: freeze(batchView(run.batch)),
    };
    let decisionValue: MonitorDecision;
    if (options.decision === "recorded") {
      if (run.decision === undefined) throw new Error(`run ${runId} has no recorded decision`);
      decisionValue = structuredClone(run.decision);
    } else {
      const decisionDefinition = monitor.definition.decision;
      if (typeof decisionDefinition === "function") {
        decisionValue = this.#callPure("rule decision", () => decisionDefinition(contextBase));
      } else {
        decisionValue = await this.#invokeModelDecision(
          decisionDefinition,
          contextBase,
          { ...run, id: this.#id("replay"), mode: "shadow" },
        );
      }
    }
    validateDecision(decisionValue, "replay decision");
    const wakeContext = freeze({ ...contextBase, decision: decisionValue }) as MonitorWakeContext<ChannelEvent>;
    const evidence = this.#callPure("replay evidence projection", () =>
      monitor.definition.task.evidence(wakeContext),
    );
    assertSizedJson(evidence, "replay evidence", this.#maxEvidenceBytes);
    const route = this.#callPure("replay route", () => monitor.definition.route(wakeContext));
    if (route !== null) {
      if (route.auth !== "app") throw new TypeError('monitor routes must use auth: "app"');
      if (this.#deliveryChannels.get(route.channel.id) !== route.channel) {
        throw new TypeError(`route channel ${route.channel.id} is not registered with this runtime`);
      }
      assertSizedJson(route.target, "replay route target", TARGET_MAX_BYTES);
    }
    const projectedRoute =
      route === null ? null : { channelId: route.channel.id, target: cloneJson(route.target) };
    let delivered = false;
    if (decisionValue.action === "wake" && options.shadow === false && options.canary !== undefined) {
      const snapshot = this.#snapshot(run, decisionValue, evidence, contextBase.batch, `replay_${run.id}`);
      await options.canary.channel.deliver({
        tenantId: run.tenantId,
        applicationId: run.applicationId,
        idempotencyKey: `monitor-replay:${run.id}:${options.decision}`,
        auth: "app",
        target: options.canary.target,
        session: { strategy: monitor.definition.session?.strategy ?? "channel" },
        taskInstructions: monitor.definition.task.instructions,
        evidence: snapshot,
        trigger: this.#trigger(run, snapshot, events),
        concurrency: "coalesce",
      });
      delivered = true;
    }
    return { runId, decision: decisionValue, evidence, route: projectedRoute, delivered };
  }

  async listRuns(monitorId?: string): Promise<readonly StoredMonitorRun[]> {
    return this.#store.listRuns({ applicationId: this.#applicationId, monitorId });
  }

  async listDeadLetters(monitorId?: string) {
    return this.#store.listDeadLetters({ applicationId: this.#applicationId, monitorId });
  }

  async purgeExpired(): Promise<Awaited<ReturnType<MonitorStore["purgeExpired"]>>> {
    return this.#store.purgeExpired(this.#now());
  }

  async #acceptEvent<
    TInbound extends ChannelEventDefinitions,
    TReplyTarget extends JsonValue,
    TType extends Extract<keyof TInbound, string>,
  >(
    channel: DeclaredInboundChannel<TInbound, TReplyTarget>,
    type: TType,
    input: PublishEventInput<SchemaOutput<TInbound[TType]["schema"]>, TReplyTarget>,
    phase: "observed" | undefined,
  ): Promise<PublishResult> {
    this.#assertInitialized();
    const registered = this.#channels.get(channel.id);
    if (registered !== channel) throw new TypeError(`channel ${channel.id} is not registered with this runtime`);
    validatePublishEnvelope(input);
    const definition = channel.inbound[type];
    if (definition === undefined) throw new TypeError(`channel ${channel.id} has no ${String(type)} event`);
    const parsed = await parseSchema(definition.schema, input.data, "channel event data");
    assertJsonValue(parsed, "channel event data");
    const parsedReplyTarget =
      input.replyTarget === undefined
        ? undefined
        : channel.replyTargetSchema === undefined
          ? input.replyTarget
          : await parseSchema(channel.replyTargetSchema, input.replyTarget, "channel replyTarget");
    if (parsedReplyTarget !== undefined) assertJsonValue(parsedReplyTarget, "channel replyTarget");
    const bytes = jsonBytes(parsed);
    if (bytes > definition.maxBytes) {
      await this.#emit("monitor.event.rejected", {
        tenantId: input.tenantId,
        attributes: { outcome: "oversized", bytes, maxBytes: definition.maxBytes },
      });
      throw new TypeError(
        `channel event payload is ${bytes} bytes and exceeds ${definition.maxBytes} bytes`,
      );
    }
    const now = this.#now();
    const traceId = input.trace?.traceId ?? this.#id("trace");
    const dedupeKey = `dedupe:${stableHash(
      scopedKey(
        input.tenantId,
        this.#applicationId,
        channel.id,
        input.installationId,
        input.id,
      ),
    )}`;
    const matching = this.#matchingMonitors(channel.id, String(type), phase);
    const retentionMonitors = this.#retentionMonitors(channel.id, String(type));
    const retentionMs =
      retentionMonitors.length === 0
        ? durationMs(DEFAULT_RETENTION.payload)
        : retentionMonitors.reduce(
            (maximum, monitor) =>
              Math.max(
                maximum,
                durationMs((monitor.definition.retention ?? DEFAULT_RETENTION).payload),
              ),
            0,
          );
    const dedupeMs =
      retentionMonitors.length === 0
        ? durationMs(DEFAULT_RETENTION.dedupe)
        : retentionMonitors.reduce(
            (maximum, monitor) =>
              Math.max(
                maximum,
                durationMs((monitor.definition.retention ?? DEFAULT_RETENTION).dedupe),
              ),
            0,
          );
    const ref = this.#id("evt");
    const event: ChannelEvent<string, JsonValue, JsonValue> = {
      ref,
      id: input.id,
      type: String(type),
      version: definition.version,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      receivedAt: now,
      data: cloneJson(parsed),
      source: {
        channelId: channel.id,
        installationId: input.installationId,
        tenantId: input.tenantId,
        ...(phase === undefined ? {} : { phase }),
      },
      ...(input.actor === undefined
        ? {}
        : {
            actor: {
              id: input.actor.id,
              ...(input.actor.displayName === undefined ? {} : { displayName: input.actor.displayName }),
              principalType: input.actor.principalType,
              ...(input.actor.isBot === undefined ? {} : { isBot: input.actor.isBot }),
              ...(input.actor.knownAgentPrincipal === undefined
                ? {}
                : { knownAgentPrincipal: input.actor.knownAgentPrincipal }),
            },
          }),
      ...(input.authRef === undefined ? {} : { authRef: input.authRef }),
      ...(parsedReplyTarget === undefined ? {} : { replyTarget: cloneJson(parsedReplyTarget) }),
      ...(input.subjects === undefined
        ? {}
        : {
            subjects: input.subjects.map((subject) => ({
              namespace: subject.namespace,
              key: subject.key,
            })),
          }),
      origin: {
        kind: input.origin.kind,
        ...(input.origin.applicationId === undefined
          ? {}
          : { applicationId: input.origin.applicationId }),
        ...(input.origin.id === undefined ? {} : { id: input.origin.id }),
        ...(input.origin.causationId === undefined ? {} : { causationId: input.origin.causationId }),
        depth: input.origin.depth ?? 0,
      },
      trace: {
        traceId,
        ...(input.trace?.spanId === undefined ? {} : { spanId: input.trace.spanId }),
      },
    };
    const record: Omit<StoredEvent, "ingressSequence"> = {
      ref,
      dedupeKey,
      tenantId: input.tenantId,
      applicationId: this.#applicationId,
      channelId: channel.id,
      installationId: input.installationId,
      eventId: input.id,
      eventType: String(type),
      traceId,
      event,
      bytes,
      acceptedAt: now,
      payloadExpiresAt: addMs(now, retentionMs),
      dedupeExpiresAt: addMs(now, dedupeMs),
      ...(phase === undefined
        ? {}
        : {
            directDispatch: {
              status: "pending" as const,
              attempt: 0,
              availableAt: now,
              updatedAt: now,
            },
          }),
    };

    const result = await this.#store.transaction(`ingress:${dedupeKey}`, async (tx) => {
      const duplicate = await tx.getEventByDedupeKey(dedupeKey);
      if (duplicate !== null && duplicate.dedupeExpiresAt > now) {
        return { status: "duplicate" as const, eventId: duplicate.ref, traceId: duplicate.traceId };
      }
      if (duplicate !== null) {
        // Preserve the expired event tombstone for buffered refs while freeing
        // the provider dedupe key for this newly accepted delivery.
        await tx.releaseEventDedupe(duplicate.ref);
      }
      const ingressSequence = await tx.nextIngressSequence(
        scopedKey(input.tenantId, this.#applicationId),
      );
      const acceptedRecord: StoredEvent = { ...record, ingressSequence };
      await tx.putEvent(acceptedRecord);
      for (const monitor of matching) {
        await tx.putSubscription(this.#newSubscription(acceptedRecord, monitor, phase));
      }
      return { status: "accepted" as const, eventId: ref, traceId };
    });
    await this.#emit(
      result.status === "accepted" ? "monitor.event.accepted" : "monitor.event.deduplicated",
      { tenantId: input.tenantId, eventRef: result.eventId },
    );
    return result;
  }

  async #claimDirectDispatch(eventRef: string): Promise<DirectDispatchClaim> {
    return this.#store.transaction(`chat-dispatch:${eventRef}`, async (tx) => {
      const event = await tx.getEvent(eventRef);
      if (event === null) throw new Error(`accepted event ${eventRef} disappeared`);
      const now = this.#now();
      const state = event.directDispatch ?? {
        status: "pending" as const,
        attempt: 0,
        availableAt: now,
        updatedAt: now,
      };
      if (isSettledDirectDispatch(state.status)) {
        return { kind: "settled", outcome: state.status };
      }
      if (
        state.availableAt > now ||
        (state.status === "processing" &&
          state.leaseExpiresAt !== undefined &&
          state.leaseExpiresAt > now)
      ) {
        return { kind: "settled", outcome: "pending" };
      }
      if (state.attempt >= this.#retry.maxAttempts) {
        const reason = "maximum direct-dispatch retry attempts exceeded";
        await tx.putEvent({
          ...event,
          directDispatch: {
            ...state,
            status: "failed",
            leaseExpiresAt: undefined,
            error: reason,
            updatedAt: now,
          },
        });
        await tx.putDeadLetter(this.#directDispatchDeadLetter(event, reason, now));
        return { kind: "settled", outcome: "failed" };
      }
      const attempt = state.attempt + 1;
      await tx.putEvent({
        ...event,
        directDispatch: {
          status: "processing",
          attempt,
          availableAt: now,
          leaseExpiresAt: addMs(now, this.#retry.leaseMs),
          updatedAt: now,
        },
      });
      return { kind: "claimed", attempt };
    });
  }

  async #completeDirectDispatch(
    eventRef: string,
    attempt: number,
    outcome: "dispatched" | "undispatched",
  ): Promise<ChatPublishResult["directDispatch"]> {
    return this.#store.transaction(`chat-dispatch:${eventRef}`, async (tx) => {
      const event = await tx.getEvent(eventRef);
      if (event === null) throw new Error(`accepted event ${eventRef} disappeared`);
      const state = event.directDispatch;
      if (state !== undefined && isSettledDirectDispatch(state.status)) return state.status;
      if (state?.status !== "processing" || state.attempt !== attempt) return "pending";
      const now = this.#now();
      if (outcome === "undispatched") {
        const matching = this.#matchingMonitors(event.channelId, event.eventType, outcome);
        for (const monitor of matching) {
          const subscription = this.#newSubscription(event, monitor, outcome);
          if ((await tx.getSubscription(subscription.id)) === null) {
            await tx.putSubscription(subscription);
          }
        }
      }
      await tx.putEvent({
        ...event,
        directDispatch: {
          ...state,
          status: outcome,
          leaseExpiresAt: undefined,
          updatedAt: now,
        },
      });
      return outcome;
    });
  }

  async #failDirectDispatch(
    eventRef: string,
    attempt: number,
    error: unknown,
  ): Promise<ChatPublishResult["directDispatch"]> {
    const transient = error instanceof TransientMonitorError;
    return this.#store.transaction(`chat-dispatch:${eventRef}`, async (tx) => {
      const event = await tx.getEvent(eventRef);
      if (event === null) throw new Error(`accepted event ${eventRef} disappeared`);
      const state = event.directDispatch;
      if (state !== undefined && isSettledDirectDispatch(state.status)) return state.status;
      if (state?.status !== "processing" || state.attempt !== attempt) return "pending";
      const now = this.#now();
      const reason = boundedReason(
        `direct dispatch failed with unknown turn outcome: ${errorMessage(error)}`,
      );
      if (transient && attempt < this.#retry.maxAttempts) {
        const backoff = Math.min(
          this.#retry.maxBackoffMs,
          this.#retry.initialBackoffMs * 2 ** Math.max(0, attempt - 1),
        );
        await tx.putEvent({
          ...event,
          directDispatch: {
            ...state,
            status: "pending",
            availableAt: addMs(now, backoff),
            leaseExpiresAt: undefined,
            error: reason,
            updatedAt: now,
          },
        });
        return "pending";
      }
      await tx.putEvent({
        ...event,
        directDispatch: {
          ...state,
          status: "failed",
          leaseExpiresAt: undefined,
          error: reason,
          updatedAt: now,
        },
      });
      await tx.putDeadLetter(this.#directDispatchDeadLetter(event, reason, now));
      return "failed";
    });
  }

  #directDispatchDeadLetter(event: StoredEvent, reason: string, now: string) {
    return {
      id: this.#id("dlq"),
      tenantId: event.tenantId,
      applicationId: event.applicationId,
      eventRef: event.ref,
      stage: "direct-dispatch",
      reason,
      createdAt: now,
    };
  }

  #newSubscription(
    event: StoredEvent,
    monitor: CompiledMonitor,
    phase?: "observed" | "undispatched",
  ): StoredSubscription {
    const now = this.#now();
    const id = `sub_${stableHash(
      scopedKey(monitor.definition.id, monitor.version, event.ref, phase ?? "event"),
    )}`;
    return {
      id,
      eventRef: event.ref,
      tenantId: event.tenantId,
      applicationId: event.applicationId,
      monitorId: monitor.definition.id,
      definitionVersion: monitor.version,
      ingressSequence: event.ingressSequence,
      ...(phase === undefined ? {} : { phase }),
      status: "pending",
      attempt: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async #processSubscription(id: string): Promise<void> {
    const claimed = await this.#claimSubscription(id);
    if (claimed === null) return;
    const eventRecord = await this.#store.getEvent(claimed.eventRef);
    if (eventRecord === null || eventRecord.event === undefined || eventRecord.payloadExpiresAt <= this.#now()) {
      await this.#deadLetterSubscription(claimed, "ingress", "source payload expired before preprocessing");
      return;
    }
    const monitor = this.#definition(claimed.monitorId, claimed.definitionVersion);
    const event = freeze({
      ...structuredClone(eventRecord.event),
      source: {
        ...structuredClone(eventRecord.event.source),
        ...(claimed.phase === undefined ? {} : { phase: claimed.phase }),
      },
    }) as ChannelEvent;

    if (this.#isLoop(event, monitor.definition)) {
      await this.#finishSubscription(claimed, "filtered", "loop-prevention");
      return;
    }
    const eventLimit = monitor.definition.limits?.perMonitor?.maxEventsPerMinute;
    if (eventLimit !== undefined || this.#hasBudget("events", claimed.tenantId)) {
      const reservation = await this.#reserveBudget({
        id: `event:${claimed.id}`,
        metric: "events",
        amount: 1,
        windowMs: 60_000,
        input: claimed,
        definitionLimit: eventLimit,
      });
      if (!reservation.allowed) {
        await this.#emit("monitor.wake.suppressed", {
          ...this.#eventDetails(claimed),
          attributes: { cause: "monitor-event-limit", scope: reservation.scope },
        });
        if (this.#overflow(monitor.definition) === "buffer") {
          await this.#retrySubscription(claimed, reservation.retryAt, "monitor-event-limit");
        } else {
          await this.#finishSubscription(claimed, "suppressed", "monitor-event-limit");
        }
        return;
      }
    }
    let correlationKey: string | null;
    let filtered = false;
    try {
      if (
        monitor.definition.filter !== undefined &&
        !this.#callPure("filter", () => monitor.definition.filter!({ event }))
      ) {
        filtered = true;
        correlationKey = null;
      } else {
        correlationKey =
          monitor.definition.correlate === undefined
            ? event.ref
            : this.#callPure("correlate", () => monitor.definition.correlate!({ event }));
      }
      if (correlationKey !== null) {
        assertNonEmpty(correlationKey, "correlation key");
        if (Buffer.byteLength(correlationKey, "utf8") > 4_096) {
          throw new TypeError("correlation key must be at most 4,096 UTF-8 bytes");
        }
      }
    } catch (error) {
      await this.#deadLetterSubscription(claimed, "preprocess", errorMessage(error));
      return;
    }
    if (filtered) {
      await this.#finishSubscription(claimed, "filtered", "filter-false");
      return;
    }
    if (correlationKey === null) {
      await this.#finishSubscription(claimed, "uncorrelated", "null-key");
      return;
    }
    await this.#markSubscriptionReady(claimed, correlationKey);
  }

  async #markSubscriptionReady(
    subscription: StoredSubscription,
    correlationKey: string,
  ): Promise<void> {
    const correlationKeyHash = stableHash(correlationKey);
    await this.#store.transaction(`subscription:${subscription.id}`, async (tx) => {
      const current = await tx.getSubscription(subscription.id);
      if (current === null || current.status !== "processing") return;
      await tx.putSubscription({
        ...current,
        status: "ready",
        correlationKey,
        correlationKeyHash,
        leaseExpiresAt: undefined,
        availableAt: this.#now(),
        updatedAt: this.#now(),
      });
    });
  }

  async #appendReadySubscription(id: string): Promise<void> {
    const claimed = await this.#store.transaction(`subscription-append:${id}`, async (tx) => {
      const current = await tx.getSubscription(id);
      if (current === null || current.status !== "ready" || current.availableAt > this.#now()) {
        return null;
      }
      if (
        await tx.hasEarlierOpenSubscription({
          tenantId: current.tenantId,
          applicationId: current.applicationId,
          monitorId: current.monitorId,
          definitionVersion: current.definitionVersion,
          correlationKeyHash: current.correlationKeyHash!,
          ingressSequence: current.ingressSequence,
        })
      ) {
        await tx.putSubscription({
          ...current,
          availableAt: addMs(this.#now(), 10),
          updatedAt: this.#now(),
        });
        return null;
      }
      const processing: StoredSubscription = {
        ...current,
        status: "processing",
        attempt: current.attempt + 1,
        leaseExpiresAt: addMs(this.#now(), this.#retry.leaseMs),
        updatedAt: this.#now(),
      };
      await tx.putSubscription(processing);
      return processing;
    });
    if (claimed === null) return;
    const event = await this.#store.getEvent(claimed.eventRef);
    if (event === null || event.event === undefined || event.payloadExpiresAt <= this.#now()) {
      await this.#deadLetterSubscription(claimed, "buffer", "source payload expired before append");
      return;
    }
    const correlationKey = claimed.correlationKey;
    if (correlationKey === undefined) {
      await this.#deadLetterSubscription(claimed, "buffer", "preprocessed correlation key is missing");
      return;
    }
    const monitor = this.#definition(claimed.monitorId, claimed.definitionVersion);
    await this.#appendSubscription(claimed, event, monitor, correlationKey);
  }

  async #claimSubscription(id: string): Promise<StoredSubscription | null> {
    return this.#store.transaction(`subscription:${id}`, async (tx) => {
      const current = await tx.getSubscription(id);
      if (current === null || !["pending", "processing"].includes(current.status)) return null;
      const now = this.#now();
      if (current.availableAt > now) return null;
      if (current.status === "processing" && current.leaseExpiresAt !== undefined && current.leaseExpiresAt > now) {
        return null;
      }
      if (current.attempt >= this.#retry.maxAttempts) {
        const terminal: StoredSubscription = {
          ...current,
          status: "dead-lettered",
          outcome: "maximum retry attempts exceeded",
          leaseExpiresAt: undefined,
          updatedAt: now,
        };
        await tx.putSubscription(terminal);
        await tx.putDeadLetter({
          id: this.#id("dlq"),
          tenantId: current.tenantId,
          applicationId: current.applicationId,
          monitorId: current.monitorId,
          definitionVersion: current.definitionVersion,
          eventRef: current.eventRef,
          subscriptionId: current.id,
          stage: "retry",
          reason: "maximum retry attempts exceeded",
          createdAt: now,
        });
        return null;
      }
      const claimed: StoredSubscription = {
        ...current,
        status: "processing",
        attempt: current.attempt + 1,
        leaseExpiresAt: addMs(now, this.#retry.leaseMs),
        updatedAt: now,
      };
      await tx.putSubscription(claimed);
      return claimed;
    });
  }

  async #appendSubscription(
    subscription: StoredSubscription,
    event: StoredEvent,
    monitor: CompiledMonitor,
    correlationKey: string,
  ): Promise<void> {
    const keyHash = stableHash(correlationKey);
    const instanceId = instanceStoreKey({
      tenantId: subscription.tenantId,
      applicationId: subscription.applicationId,
      monitorId: subscription.monitorId,
      definitionVersion: subscription.definitionVersion,
      correlationKeyHash: keyHash,
    });
    const buffer = monitor.definition.buffer ?? { mode: "immediate" as const };
    if (buffer.mode === "debounce" && event.bytes > buffer.maxBytes) {
      await this.#deadLetterSubscription(
        subscription,
        "buffer",
        `event is ${event.bytes} bytes and exceeds monitor maxBytes ${buffer.maxBytes}`,
      );
      return;
    }
    if (this.#mailbox.mode === "celld") {
      await this.#appendSubscriptionToCell(
        subscription,
        event,
        monitor,
        correlationKey,
        keyHash,
        instanceId,
        this.#mailbox,
      );
      return;
    }
    const now = this.#now();
    let instanceExists = (await this.#store.getInstance(instanceId)) !== null;
    let outcome: "opened" | "updated" | "flushed";
    for (;;) {
      const appendLock = instanceExists
        ? `instance:${instanceId}`
        : `cardinality:${scopedKey(subscription.tenantId, subscription.applicationId)}`;
      let transactionOutcome: "opened" | "updated" | "flushed" | null;
      try {
        transactionOutcome = await this.#store.transaction(appendLock, async (tx) => {
          let instance = await tx.getInstance(instanceId);
          let nextOutcome: "opened" | "updated" | "flushed" = "updated";
          if (instance === null) {
            // The point-read instance can disappear during retention cleanup.
            // Retry under the tenant cardinality lock before recreating it.
            if (instanceExists) return null;
            const tenantCount = await tx.countInstances({
              tenantId: subscription.tenantId,
              applicationId: subscription.applicationId,
            });
            if (tenantCount >= this.#limits.maxActiveKeysPerTenant) {
              throw new CardinalityDenied(addMs(now, this.#retry.initialBackoffMs));
            }
            instance = this.#newInstance(instanceId, subscription, monitor, correlationKey, keyHash);
            nextOutcome = "opened";
          }
          const ref: BufferedEventRef = {
            ref: event.ref,
            bytes: event.bytes,
            acceptedAt: event.acceptedAt,
            ingressSequence: event.ingressSequence,
          };
          const append = dispatchLifecycle(instance, monitor.definition, {
            type: "APPEND",
            ref,
            now,
          });
          instance = {
            ...append.instance,
            expiresAt: addMs(
              now,
              durationMs((monitor.definition.retention ?? DEFAULT_RETENTION).decisions),
            ),
            updatedAt: now,
          };
          if (append.flushed) nextOutcome = "flushed";
          await tx.putInstance(instance);
          await tx.putSubscription({
            ...subscription,
            status: "buffered",
            correlationKeyHash: keyHash,
            outcome: "appended",
            leaseExpiresAt: undefined,
            updatedAt: now,
          });
          return nextOutcome;
        });
      } catch (error) {
        if (!(error instanceof CardinalityDenied)) throw error;
        await this.#emit("monitor.wake.suppressed", {
          ...this.#eventDetails(subscription),
          attributes: { cause: "correlation-cardinality", scope: "tenant" },
        });
        if (this.#overflow(monitor.definition) === "buffer") {
          await this.#retrySubscription(subscription, error.retryAt, "correlation-cardinality");
        } else {
          await this.#finishSubscription(subscription, "suppressed", "correlation-cardinality");
        }
        return;
      }
      if (transactionOutcome === null) {
        instanceExists = false;
        continue;
      }
      outcome = transactionOutcome;
      break;
    }
    await this.#emit(
      outcome === "opened"
        ? "monitor.buffer.opened"
        : outcome === "flushed"
          ? "monitor.buffer.flushed"
          : "monitor.buffer.updated",
      this.#eventDetails(subscription, { correlationKeyHash: keyHash }),
    );
  }

  /**
   * The celld-mode append: the buffered ref is forwarded to the cell named by
   * the instance key instead of being written into an instance row. The cell
   * holds the `StoredMonitorInstance`, runs the same statechart over it, and
   * arms its own durable alarm for `nextEvaluationAt`.
   *
   * Deliberately not enforced here: the per-tenant correlation-cardinality cap.
   * It is a `countInstances` under a tenant-wide lock, and celld mode has no
   * instance table to count. Event, model, and wake budgets are unaffected and
   * remain the rate controls. See the README's limitations box.
   */
  async #appendSubscriptionToCell(
    subscription: StoredSubscription,
    event: StoredEvent,
    monitor: CompiledMonitor,
    correlationKey: string,
    keyHash: string,
    instanceId: string,
    mailbox: CelldMailboxOptions,
  ): Promise<void> {
    const body: CelldAppendRequest = {
      monitorId: subscription.monitorId,
      definitionVersion: subscription.definitionVersion,
      config: {
        ...(monitor.definition.buffer === undefined ? {} : { buffer: monitor.definition.buffer }),
        ...(monitor.definition.cooldown === undefined
          ? {}
          : { cooldown: monitor.definition.cooldown }),
        retention: monitor.definition.retention ?? DEFAULT_RETENTION,
      },
      evaluatorUrl: mailbox.evaluatorUrl,
      tenantId: subscription.tenantId,
      applicationId: subscription.applicationId,
      correlationKey,
      correlationKeyHash: keyHash,
      subscriptionId: subscription.id,
      ref: event.ref,
      bytes: event.bytes,
      ingressSequence: event.ingressSequence,
      acceptedAt: event.acceptedAt,
    };
    let outcome: CelldAppendOutcome;
    try {
      outcome = await this.#postCellAppend(mailbox, instanceId, body);
      try {
        await this.#recordCelldDefinitionPin(subscription.monitorId, subscription.definitionVersion);
      } catch (error) {
        throw new TransientMonitorError(
          `could not record celld definition pin: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      if (error instanceof CelldAppendRejected) {
        await this.#deadLetterSubscription(subscription, "buffer", error.message);
        return;
      }
      if (!(error instanceof TransientMonitorError)) throw error;
      // The existing subscription retry ladder: back to `pending` behind a
      // backoff, and `#claimSubscription` dead-letters it once the attempt
      // budget is spent.
      const backoff = Math.min(
        this.#retry.maxBackoffMs,
        this.#retry.initialBackoffMs * 2 ** Math.max(0, subscription.attempt - 1),
      );
      await this.#retrySubscription(
        subscription,
        addMs(this.#now(), backoff),
        boundedReason(errorMessage(error)),
      );
      return;
    }
    const now = this.#now();
    await this.#store.transaction(`subscription:${subscription.id}`, async (tx) => {
      const current = await tx.getSubscription(subscription.id);
      if (current === null) return;
      await tx.putSubscription({
        ...current,
        status: "buffered",
        correlationKeyHash: keyHash,
        outcome: "appended",
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
    });
    await this.#emit(
      outcome === "opened"
        ? "monitor.buffer.opened"
        : outcome === "flushed"
          ? "monitor.buffer.flushed"
          : "monitor.buffer.updated",
      this.#eventDetails(subscription, { correlationKeyHash: keyHash }),
    );
  }

  async #postCellAppend(
    mailbox: CelldMailboxOptions,
    instanceId: string,
    body: CelldAppendRequest,
  ): Promise<CelldAppendOutcome> {
    let response: Response;
    try {
      response = await this.#fetch(cellUrl(mailbox.fleetUrl, instanceId, "append"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${mailbox.secret}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new TransientMonitorError(
        `celld append for ${instanceId} could not reach the fleet: ${errorMessage(error)}`,
      );
    }
    if (response.ok) {
      const parsed = (await response.json()) as CelldAppendResponse;
      return parsed.outcome ?? "updated";
    }
    const detail = await readCellError(response);
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new TransientMonitorError(
        `celld append for ${instanceId} returned ${response.status}: ${detail.error}`,
      );
    }
    if (detail.code === CELLD_DEFINITION_VERSION_MISMATCH) {
      throw new CelldAppendRejected(
        `celld cell for ${instanceId} is pinned to a different definition version: ${detail.error}`,
      );
    }
    throw new CelldAppendRejected(
      `celld append for ${instanceId} returned ${response.status}: ${detail.error}`,
    );
  }

  /**
   * Runs one cell-claimed batch through the decision pipeline and records it.
   *
   * Transport-agnostic — a plain object in, a plain object out. See
   * `createEvaluationFetchHandler` in `./celld.js` for the fetch wrapper.
   *
   * Idempotent by `runId`: a terminal run record short-circuits to its recorded
   * outcome, so a cell retrying after a lost response gets the same answer and
   * nothing is delivered twice. A non-terminal record resumes from its last
   * checkpoint exactly as `#processRun` does for a store-mode run.
   *
   * A retry scheduled by the durable run record is returned as a successful
   * `retry` answer. The cell moves its alarm to `retryAt`, so ordinary budget
   * and transient backoff do not consume celld's finite failure ladder.
   */
  async handleEvaluation(request: EvaluationRequest): Promise<EvaluationResponse> {
    this.#assertInitialized();
    const mailbox = this.#mailbox;
    if (mailbox.mode !== "celld") {
      throw new Error('handleEvaluation requires the runtime to run mailbox mode "celld"');
    }
    if (!secretsMatch(request?.secret ?? "", mailbox.secret)) throw new EvaluationAuthError();
    validateEvaluationRequest(request);
    if (request.applicationId !== this.#applicationId) {
      throw new EvaluationRequestError(
        `evaluation for application ${request.applicationId} reached the runtime for ${this.#applicationId}`,
        "wrong-application",
      );
    }
    let monitor: CompiledMonitor;
    try {
      monitor = this.#definition(request.monitorId, request.definitionVersion);
    } catch (error) {
      throw new EvaluationRequestError(errorMessage(error), "unknown-definition");
    }
    const now = this.#now();
    const existing = await this.#store.getRun(request.runId);
    if (existing !== null) {
      if (
        existing.applicationId !== this.#applicationId ||
        existing.instanceId !== request.instanceId ||
        existing.tenantId !== request.tenantId ||
        existing.monitorId !== request.monitorId ||
        existing.definitionVersion !== request.definitionVersion
      ) {
        throw new EvaluationRequestError(
          `run ${request.runId} is recorded against another monitor instance`,
          "run-conflict",
        );
      }
      if (isTerminalRunStatus(existing.status)) return recordedEvaluation(existing);
      const retryAt = evaluationUnavailableUntil(existing, now);
      if (retryAt !== null) return scheduledEvaluation(existing.id, retryAt);
    }
    const retention = monitor.definition.retention ?? DEFAULT_RETENTION;
    let run: StoredMonitorRun;
    if (existing === null) {
      const replayExpiries: string[] = [];
      for (const reference of request.batch.events) {
        const record = await this.#store.getEvent(reference.ref);
        if (record !== null) replayExpiries.push(record.payloadExpiresAt);
      }
      run = {
        id: request.runId,
        instanceId: request.instanceId,
        tenantId: request.tenantId,
        applicationId: request.applicationId,
        monitorId: request.monitorId,
        definitionVersion: request.definitionVersion,
        correlationKeyHash: request.correlationKeyHash,
        batch: structuredClone(request.batch),
        mode: monitor.definition.mode ?? "active",
        instanceView: structuredClone(request.instanceView),
        status: "processing",
        stage: "decision",
        attempt: 1,
        availableAt: now,
        leaseExpiresAt: addMs(now, this.#retry.leaseMs),
        replayExpiresAt: replayExpiries.sort()[0] ?? now,
        createdAt: now,
        updatedAt: now,
        expiresAt: addMs(now, durationMs(retention.decisions)),
      };
    } else if (existing.attempt >= this.#retry.maxAttempts) {
      await this.#store.transaction(`instance:${existing.instanceId}`, async (tx) => {
        const current = await tx.getRun(existing.id);
        if (current === null) return;
        await this.#deadLetterRunInTransaction(
          tx,
          current,
          null,
          "retry",
          "maximum retry attempts exceeded",
        );
      });
      await this.#emit("monitor.evaluation.failed", {
        ...this.#runDetails(existing),
        attributes: { error: "maximum retry attempts exceeded" },
      });
      return { runId: existing.id, status: "dead-lettered" };
    } else {
      run = {
        ...existing,
        status: "processing",
        attempt: existing.attempt + 1,
        leaseExpiresAt: addMs(now, this.#retry.leaseMs),
        updatedAt: now,
      };
    }
    const claimed = run;
    await this.#store.transaction(`instance:${claimed.instanceId}`, async (tx) => {
      await tx.putRun(claimed);
    });
    if (existing === null) await this.#emit("monitor.evaluation.started", this.#runDetails(run));

    const context: CelldEvaluationContext = {
      correlationKey: request.correlationKey,
      binding: request.instanceView.binding,
      outcome: undefined,
    };
    try {
      await this.#continueRun(run, context);
    } catch (error) {
      await this.#failRun(run, error, context);
    }
    if (context.outcome !== undefined) return context.outcome;
    const deferred = await this.#store.getRun(run.id);
    if (deferred !== null) {
      if (isTerminalRunStatus(deferred.status)) return recordedEvaluation(deferred);
      const retryAt = evaluationUnavailableUntil(deferred, this.#now());
      if (retryAt !== null) return scheduledEvaluation(deferred.id, retryAt);
    }
    throw new TransientMonitorError(
      `monitor run ${run.id} has not reached a terminal outcome; retry the evaluation`,
    );
  }

  #newInstance(
    id: string,
    subscription: StoredSubscription,
    monitor: CompiledMonitor,
    correlationKey: string,
    correlationKeyHash: string,
  ): StoredMonitorInstance {
    const now = this.#now();
    const retention = monitor.definition.retention ?? DEFAULT_RETENTION;
    return {
      id,
      tenantId: subscription.tenantId,
      applicationId: subscription.applicationId,
      monitorId: subscription.monitorId,
      definitionVersion: subscription.definitionVersion,
      correlationKey,
      correlationKeyHash,
      sealedBatches: [],
      evaluationGeneration: 0,
      consecutiveIgnores: 0,
      eventsSinceLastWake: 0,
      expiresAt: addMs(now, durationMs(retention.decisions)),
      createdAt: now,
      updatedAt: now,
    };
  }

  async #claimEvaluation(instanceId: string): Promise<string | null> {
    const run = await this.#store.transaction(`instance:${instanceId}`, async (tx) => {
      const instance = await tx.getInstance(instanceId);
      const now = this.#now();
      if (
        instance === null ||
        instance.activeRunId !== undefined ||
        instance.nextEvaluationAt === undefined ||
        instance.nextEvaluationAt > now
      ) {
        return null;
      }
      const monitor = this.#definition(instance.monitorId, instance.definitionVersion);
      const generation = instance.evaluationGeneration + 1;
      const runId = `run_${stableHash(scopedKey(instance.id, String(generation)))}`;
      const claim = dispatchLifecycle(instance, monitor.definition, {
        type: "CLAIM",
        runId,
        now,
      });
      if (claim.claimedBatch === undefined) {
        await tx.putInstance({ ...claim.instance, updatedAt: now });
        return null;
      }
      const replayExpiries: string[] = [];
      for (const reference of claim.claimedBatch.events) {
        const event = await tx.getEvent(reference.ref);
        if (event !== null) replayExpiries.push(event.payloadExpiresAt);
      }
      const replayExpiresAt = replayExpiries.sort()[0] ?? now;
      const nextInstance: StoredMonitorInstance = {
        ...claim.instance,
        updatedAt: now,
      };
      const run: StoredMonitorRun = {
        id: runId,
        instanceId,
        tenantId: instance.tenantId,
        applicationId: instance.applicationId,
        monitorId: instance.monitorId,
        definitionVersion: instance.definitionVersion,
        correlationKeyHash: instance.correlationKeyHash,
        batch: claim.claimedBatch,
        mode: monitor.definition.mode ?? "active",
        instanceView: instanceView(instance),
        status: "pending",
        stage: "decision",
        attempt: 0,
        availableAt: now,
        replayExpiresAt,
        createdAt: now,
        updatedAt: now,
        expiresAt: addMs(now, durationMs((monitor.definition.retention ?? DEFAULT_RETENTION).decisions)),
      };
      await tx.putInstance(nextInstance);
      await tx.putRun(run);
      return run;
    });
    if (run === null) return null;
    await this.#emit("monitor.evaluation.started", this.#runDetails(run));
    return run.id;
  }

  async #processRun(id: string): Promise<void> {
    const run = await this.#claimRun(id);
    if (run === null) return;
    try {
      await this.#continueRun(run);
    } catch (error) {
      await this.#failRun(run, error);
    }
  }

  async #claimRun(id: string): Promise<StoredMonitorRun | null> {
    const observed = await this.#store.getRun(id);
    if (observed === null) return null;
    return this.#store.transaction(`instance:${observed.instanceId}`, async (tx) => {
      const current = await tx.getRun(id);
      const instance = await tx.getInstance(observed.instanceId);
      const now = this.#now();
      if (
        current === null ||
        instance?.activeRunId !== id ||
        !["pending", "retry", "processing"].includes(current.status) ||
        current.availableAt > now ||
        (current.status === "processing" && current.leaseExpiresAt !== undefined && current.leaseExpiresAt > now)
      ) {
        return null;
      }
      if (current.attempt >= this.#retry.maxAttempts) {
        await this.#deadLetterRunInTransaction(tx, current, instance, "retry", "maximum retry attempts exceeded");
        return null;
      }
      const claimed: StoredMonitorRun = {
        ...current,
        status: "processing",
        attempt: current.attempt + 1,
        leaseExpiresAt: addMs(now, this.#retry.leaseMs),
        updatedAt: now,
      };
      await tx.putRun(claimed);
      return claimed;
    });
  }

  /**
   * The decision → evidence → route → delivery pipeline for one claimed batch,
   * checkpointed at every stage so an interrupted run resumes instead of
   * repeating work.
   *
   * `context` is present exactly for celld-mode evaluations. It supplies the
   * instance facts the store-mode path reads from the instance row (the
   * correlation key and the current binding, both of which live in the cell)
   * and collects the terminal outcome for the cell's `RUN_COMPLETED` dispatch.
   * The pipeline itself is identical in both modes.
   */
  async #continueRun(initial: StoredMonitorRun, context?: CelldEvaluationContext): Promise<void> {
    let run = initial;
    const monitor = this.#definition(run.monitorId, run.definitionVersion);
    const events = await this.#loadRunEvents(run);
    const base = freeze({
      events,
      instance: structuredClone(run.instanceView),
      batch: batchView(run.batch),
    });

    if (run.decision === undefined) {
      if (typeof monitor.definition.decision === "function") {
        const rule = monitor.definition.decision;
        const value = this.#callPure("rule decision", () => rule(base));
        validateDecision(value);
        assertJsonValue(value, "rule decision");
        run = await this.#checkpointRun(run, { decision: value, decisionSource: "rule", stage: "policy" });
      } else {
        const model = monitor.definition.decision;
        const input = this.#callPure("model input projection", () => model.input(base));
        assertJsonValue(input, "model input");
        const estimatedInputTokens = estimateJsonTokens(input);
        if (estimatedInputTokens > model.maxInputTokens) {
          const inputError = `model input estimated at ${estimatedInputTokens} tokens; limit is ${model.maxInputTokens}`;
          const fallback = await this.#parseModelOutput(model, model.onError);
          run = await this.#checkpointRun(run, {
            decision: fallback,
            decisionSource: "fallback",
            error: inputError,
            stage: "policy",
          });
          await this.#emit("monitor.evaluation.failed", {
            ...this.#runDetails(run),
            attributes: { stage: "classifier", fallback: true, error: inputError },
          });
        } else {
          const invocation = await this.#invokeModelDecisionWithUsage(
            model,
            input,
            run,
            monitor.definition,
          );
          if (invocation.initialLimit !== undefined) {
            const limited = invocation.initialLimit;
            await this.#handleLimit(run, limited.cause, limited.scope, limited.retryAt, context);
            return;
          }
          run = await this.#checkpointRun(run, {
            decision: invocation.decision,
            decisionSource: invocation.source,
            modelUsage: invocation.usage,
            ...(invocation.error === undefined ? {} : { error: invocation.error }),
            stage: "policy",
          });
          if (invocation.error !== undefined) {
            await this.#emit("monitor.evaluation.failed", {
              ...this.#runDetails(run),
              attributes: {
                stage: "classifier",
                fallback: true,
                error: invocation.error.slice(0, 500),
              },
            });
          }
        }
      }
    }

    const decisionValue = run.decision!;
    if (decisionValue.action === "ignore") {
      await this.#completeRun(run, "ignored", undefined, context);
      return;
    }

    const wakeLimit = await this.#reserveWakeLimits(run, monitor.definition);
    if (!wakeLimit.allowed) {
      await this.#handleLimit(run, wakeLimit.cause, wakeLimit.scope, wakeLimit.retryAt, context);
      return;
    }

    const wakeContext = freeze({ ...base, decision: structuredClone(decisionValue) }) as MonitorWakeContext<ChannelEvent>;
    if (run.snapshot === undefined) {
      if (run.stage !== "evidence") run = await this.#checkpointRun(run, { stage: "evidence" });
      const evidence = this.#callPure("evidence projection", () => monitor.definition.task.evidence(wakeContext));
      assertSizedJson(evidence, "projected evidence", this.#maxEvidenceBytes);
      const snapshot = this.#snapshot(run, decisionValue, evidence, base.batch);
      run = await this.#checkpointRun(run, { snapshot, stage: "route" });
      await this.#emit("monitor.evidence.materialized", this.#runDetails(run));
    }
    if (run.route === undefined) {
      const route = this.#callPure("route", () => monitor.definition.route(wakeContext));
      if (route === null) {
        await this.#completeRun(run, "unroutable", undefined, context);
        return;
      }
      if (route.auth !== "app") throw new TypeError('monitor routes must use auth: "app"');
      const registered = this.#deliveryChannels.get(route.channel.id);
      if (registered !== route.channel) {
        throw new TypeError(`route channel ${route.channel.id} is not registered with this runtime`);
      }
      assertSizedJson(route.target, "route target", TARGET_MAX_BYTES);
      run = await this.#checkpointRun(run, {
        route: { channelId: route.channel.id, target: cloneJson(route.target) },
        stage: "delivery",
      });
    }

    if (run.mode === "shadow") {
      await this.#completeRun(run, "shadowed", undefined, context);
      return;
    }
    if (run.mode === "disabled") {
      await this.#completeRun(run, "suppressed", { cause: "disabled", scope: "monitor" }, context);
      return;
    }
    let delivery: {
      readonly correlationKey: string;
      readonly binding: MonitorBindingView | undefined;
    };
    if (context === undefined) {
      const instance = await this.#store.getInstance(run.instanceId);
      if (instance === null || instance.applicationId !== run.applicationId) {
        throw new Error(`monitor instance ${run.instanceId} disappeared`);
      }
      delivery = { correlationKey: instance.correlationKey, binding: instance.binding };
    } else {
      delivery = { correlationKey: context.correlationKey, binding: context.binding };
    }
    const channel = this.#deliveryChannels.get(run.route!.channelId)!;
    await this.#emit("monitor.delivery.started", this.#runDetails(run));
    const idleTimeout = monitor.definition.session?.idleTimeout;
    const receipt = await channel.deliver({
      tenantId: run.tenantId,
      applicationId: run.applicationId,
      idempotencyKey: `monitor:${run.id}:0`,
      auth: "app",
      target: run.route!.target,
      ...(delivery.binding?.bindingRef === undefined
        ? {}
        : { bindingRef: delivery.binding.bindingRef }),
      session: {
        strategy: monitor.definition.session?.strategy ?? "channel",
        ...(idleTimeout === undefined ? {} : { idleTimeoutMs: durationMs(idleTimeout) }),
      },
      ...(monitor.definition.session?.strategy === "correlation"
        ? { correlationSubject: { namespace: "monitor", key: delivery.correlationKey } }
        : {}),
      taskInstructions: monitor.definition.task.instructions,
      evidence: run.snapshot!,
      trigger: this.#trigger(run, run.snapshot!, events),
      concurrency: "coalesce",
    });
    run = await this.#checkpointRun(run, { receipt, stage: "complete" });
    await this.#completeRun(run, "delivered", undefined, context);
    await this.#emit("monitor.delivery.completed", {
      ...this.#runDetails(run),
      attributes: { outcome: receipt.outcome },
    });
  }

  async #invokeModelDecision(
    definition: Exclude<MonitorDefinition<ChannelEvent>["decision"], Function>,
    context: { readonly events: readonly ChannelEvent[]; readonly instance: MonitorInstanceView; readonly batch: MonitorBatchView },
    budgetRun: StoredMonitorRun,
  ): Promise<MonitorDecision> {
    const input = this.#callPure("model input projection", () => definition.input(context));
    assertJsonValue(input, "model input");
    const estimatedInputTokens = estimateJsonTokens(input);
    if (estimatedInputTokens > definition.maxInputTokens) {
      return this.#parseModelOutput(definition, definition.onError);
    }
    const invocation = await this.#invokeModelDecisionWithUsage(
      definition,
      input,
      budgetRun,
      this.#definition(budgetRun.monitorId, budgetRun.definitionVersion).definition,
    );
    if (invocation.initialLimit !== undefined) {
      const limited = invocation.initialLimit;
      throw new Error(
        `live replay denied by ${limited.scope} ${limited.cause} until ${limited.retryAt}`,
      );
    }
    return invocation.decision;
  }

  async #invokeModelDecisionWithUsage(
    definition: Exclude<MonitorDefinition<ChannelEvent>["decision"], Function>,
    input: JsonValue,
    budgetRun: StoredMonitorRun,
    monitorDefinition: MonitorDefinition<ChannelEvent>,
  ): Promise<{
    readonly decision: MonitorDecision;
    readonly source: "model" | "fallback";
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCost?: number };
    readonly error?: string;
    readonly initialLimit?: Exclude<LimitResult, { readonly allowed: true }>;
  }> {
    if (this.#modelInvoker === undefined) {
      return {
        decision: await this.#parseModelOutput(definition, definition.onError),
        source: "fallback",
        usage: { inputTokens: 0, outputTokens: 0 },
        error: "no model invoker configured",
      };
    }
    let prior: unknown;
    let usage = { inputTokens: 0, outputTokens: 0 } as {
      inputTokens: number;
      outputTokens: number;
      estimatedCost?: number;
    };
    let lastError: unknown;
    for (let repairAttempt: 0 | 1 = 0; repairAttempt <= definition.repairAttempts; repairAttempt = 1) {
      const limited = await this.#reserveModelLimits(
        budgetRun,
        monitorDefinition,
        definition.maxInputTokens,
        repairAttempt,
      );
      if (!limited.allowed) {
        if (repairAttempt === 0) {
          return {
            decision: await this.#parseModelOutput(definition, definition.onError),
            source: "fallback",
            usage,
            initialLimit: limited,
          };
        }
        lastError = new Error(
          `classifier repair denied by ${limited.scope} ${limited.cause} until ${limited.retryAt}`,
        );
        break;
      }
      let result: Awaited<ReturnType<MonitorModelInvoker>>;
      try {
        result = await this.#modelInvoker({
          model: definition.model,
          reasoning: definition.reasoning,
          instructions: definition.instructions,
          input,
          timeoutMs: durationMs(definition.timeout),
          maxInputTokens: definition.maxInputTokens,
          maxOutputTokens: definition.maxOutputTokens,
          repairAttempt,
          ...(prior === undefined ? {} : { previousInvalidOutput: prior }),
        });
        validateModelUsage(result.usage);
      } catch (error) {
        lastError = error;
        break;
      }
      usage = {
        inputTokens: usage.inputTokens + result.usage.inputTokens,
        outputTokens: usage.outputTokens + result.usage.outputTokens,
        ...((usage.estimatedCost ?? 0) + (result.usage.estimatedCost ?? 0) === 0
          ? {}
          : { estimatedCost: (usage.estimatedCost ?? 0) + (result.usage.estimatedCost ?? 0) }),
      };
      if (result.usage.inputTokens > definition.maxInputTokens) {
        lastError = new TypeError(
          `classifier used ${result.usage.inputTokens} input tokens; limit is ${definition.maxInputTokens}`,
        );
        break;
      }
      try {
        const parsed = await this.#parseModelOutput(definition, result.output);
        return { decision: parsed, source: "model", usage };
      } catch (error) {
        lastError = error;
        prior = result.output;
      }
      if (repairAttempt === definition.repairAttempts) break;
    }
    return {
      decision: await this.#parseModelOutput(definition, definition.onError),
      source: "fallback",
      usage,
      error: errorMessage(lastError),
    };
  }

  async #parseModelOutput(
    definition: Exclude<MonitorDefinition<ChannelEvent>["decision"], Function>,
    output: unknown,
  ): Promise<MonitorDecision> {
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
      throw new TypeError("classifier output must be an object");
    }
    const candidate = output as Record<string, unknown>;
    const decisionValue: MonitorDecision = {
      action: candidate.action as "ignore" | "wake",
      reason: candidate.reason as string,
      ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence as number }),
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
    };
    validateDecision(decisionValue, "classifier output");
    if (definition.metadata !== undefined) {
      const schema =
        decisionValue.action === "ignore" ? definition.metadata.ignore : definition.metadata.wake;
      const metadata = await parseSchema(schema, decisionValue.metadata, "classifier metadata");
      assertJsonValue(metadata, "classifier metadata");
      return { ...decisionValue, metadata };
    }
    assertJsonValue(decisionValue, "classifier decision");
    return decisionValue;
  }

  async #reserveModelLimits(
    run: StoredMonitorRun,
    definition: MonitorDefinition<ChannelEvent>,
    inputTokens: number,
    repairAttempt: 0 | 1,
  ): Promise<LimitResult> {
    const calls = definition.limits?.perMonitor?.maxModelCallsPerMinute;
    if (calls !== undefined || this.#hasBudget("model-calls", run.tenantId)) {
      const result = await this.#reserveBudget({
        id: `model-call:${run.id}:${repairAttempt}`,
        metric: "model-calls",
        amount: 1,
        windowMs: 60_000,
        input: run,
        definitionLimit: calls,
      });
      if (!result.allowed) return { ...result, cause: "model-call-limit" };
    }
    const tokens = definition.limits?.perMonitor?.maxModelInputTokensPerHour;
    if (tokens !== undefined || this.#hasBudget("model-input-tokens", run.tenantId)) {
      const result = await this.#reserveBudget({
        id: `model-input:${run.id}:${repairAttempt}`,
        metric: "model-input-tokens",
        amount: inputTokens,
        windowMs: 3_600_000,
        input: run,
        definitionLimit: tokens,
      });
      if (!result.allowed) return { ...result, cause: "model-input-token-limit" };
    }
    return { allowed: true };
  }

  async #reserveWakeLimits(
    run: StoredMonitorRun,
    definition: MonitorDefinition<ChannelEvent>,
  ): Promise<LimitResult> {
    const monitorLimit = definition.limits?.perMonitor?.maxWakesPerHour;
    if (monitorLimit !== undefined || this.#hasBudget("wakes", run.tenantId)) {
      const result = await this.#reserveBudget({
        id: `monitor-wake:${run.id}`,
        metric: "wakes",
        amount: 1,
        windowMs: 3_600_000,
        input: run,
        definitionLimit: monitorLimit,
        ...(run.mode === "shadow" ? { namespace: `shadow:${run.definitionVersion}` } : {}),
      });
      if (!result.allowed) return { ...result, cause: "wake-limit" };
    }
    const keyLimit = definition.limits?.perKey?.maxWakesPerHour;
    if (keyLimit !== undefined) {
      const result = await this.#reserve({
        id: `key-wake:${run.id}`,
        scope: scopedKey(
          this.#monitorScope(run),
          run.correlationKeyHash,
          ...(run.mode === "shadow" ? ["shadow", run.definitionVersion] : []),
        ),
        metric: "wakes",
        amount: 1,
        limit: keyLimit,
        windowMs: 3_600_000,
      });
      if (!result.allowed) return { ...result, cause: "wake-limit", scope: "key" };
    }
    return { allowed: true };
  }

  async #reserve(input: {
    readonly id: string;
    readonly scope: string;
    readonly metric: string;
    readonly amount: number;
    readonly limit: number;
    readonly windowMs: number;
  }) {
    return this.#store.transaction(`usage:${input.scope}:${input.metric}`, (tx) =>
      tx.reserveUsage({ ...input, now: this.#now() }),
    );
  }

  async #reserveBudget(input: {
    readonly id: string;
    readonly metric: BudgetMetric;
    readonly amount: number;
    readonly windowMs: number;
    readonly input: { readonly tenantId: string; readonly applicationId: string; readonly monitorId: string };
    readonly definitionLimit?: number | undefined;
    readonly namespace?: string | undefined;
  }): Promise<
    | { readonly allowed: true }
    | { readonly allowed: false; readonly retryAt: string; readonly scope: string }
  > {
    const reservations: Array<{ scope: string; scopeName: string; limit: number }> = [];
    const policy = this.#budgets;
    if (policy !== undefined) {
      const key = budgetProperty(input.metric);
      const tenantPolicy =
        typeof policy.tenant === "function"
          ? policy.tenant(input.input.tenantId)
          : policy.tenant?.[input.input.tenantId];
      const scoped = [
        {
          scope: scopedKey("platform", policy.platformId),
          scopeName: "platform",
          limit: policy.platform?.[key],
        },
        {
          scope: scopedKey("tenant", policy.platformId, input.input.tenantId),
          scopeName: "tenant",
          limit: tenantPolicy?.[key],
        },
        {
          scope: scopedKey(
            "application",
            policy.platformId,
            input.input.tenantId,
            input.input.applicationId,
          ),
          scopeName: "application",
          limit: policy.application?.[key],
        },
      ];
      for (const entry of scoped) {
        if (entry.limit !== undefined) {
          reservations.push({
            scope:
              input.namespace === undefined
                ? entry.scope
                : scopedKey(entry.scope, input.namespace),
            scopeName: entry.scopeName,
            limit: entry.limit,
          });
        }
      }
    }
    if (input.definitionLimit !== undefined) {
      reservations.push({
        scope:
          input.namespace === undefined
            ? this.#monitorScope(input.input)
            : scopedKey(this.#monitorScope(input.input), input.namespace),
        scopeName: "monitor",
        limit: input.definitionLimit,
      });
    }
    if (reservations.length === 0) return { allowed: true };
    const lock = scopedKey(...reservations.map((entry) => entry.scope).sort());
    try {
      return await this.#store.transaction(`budget:${input.metric}:${lock}`, async (tx) => {
        for (const reservation of reservations) {
          const result = await tx.reserveUsage({
            id: scopedKey(input.id, reservation.scope),
            scope: reservation.scope,
            metric: input.metric,
            amount: input.amount,
            limit: reservation.limit,
            windowMs: input.windowMs,
            now: this.#now(),
          });
          if (!result.allowed) throw new BudgetDenied(result.retryAt, reservation.scopeName);
        }
        return { allowed: true } as const;
      });
    } catch (error) {
      if (error instanceof BudgetDenied) {
        return { allowed: false, retryAt: error.retryAt, scope: error.scope };
      }
      throw error;
    }
  }

  #hasBudget(metric: BudgetMetric, tenantId: string): boolean {
    const policy = this.#budgets;
    if (policy === undefined) return false;
    const key = budgetProperty(metric);
    const tenantPolicy =
      typeof policy.tenant === "function" ? policy.tenant(tenantId) : policy.tenant?.[tenantId];
    return (
      policy.platform?.[key] !== undefined ||
      policy.application?.[key] !== undefined ||
      tenantPolicy?.[key] !== undefined
    );
  }

  #overflow(definition: MonitorDefinition<ChannelEvent>): "buffer" | "drop" {
    return definition.limits?.overflow ?? this.#budgets?.overflow ?? "buffer";
  }

  async #handleLimit(
    run: StoredMonitorRun,
    cause: string,
    scope: string,
    retryAt: string,
    context?: CelldEvaluationContext,
  ): Promise<void> {
    const definition = this.#definition(run.monitorId, run.definitionVersion).definition;
    await this.#emit("monitor.wake.suppressed", {
      ...this.#runDetails(run),
      attributes: { cause, scope },
    });
    if (this.#overflow(definition) === "buffer") {
      // In celld mode this leaves the run non-terminal on purpose: the caller
      // answers 5xx and the cell's alarm ladder brings the same runId back,
      // which is the cell's equivalent of the store tier's `availableAt`.
      await this.#retryRun(run, retryAt, cause);
    } else {
      await this.#completeRun(run, "suppressed", { cause, scope }, context);
    }
  }

  async #checkpointRun(
    run: StoredMonitorRun,
    patch: Partial<StoredMonitorRun>,
  ): Promise<StoredMonitorRun> {
    return this.#store.transaction(`instance:${run.instanceId}`, async (tx) => {
      const current = await tx.getRun(run.id);
      if (current === null) throw new Error(`run ${run.id} disappeared`);
      const next: StoredMonitorRun = {
        ...current,
        ...patch,
        status: "processing",
        updatedAt: this.#now(),
      };
      await tx.putRun(next);
      return next;
    });
  }

  async #completeRun(
    run: StoredMonitorRun,
    status: "ignored" | "shadowed" | "suppressed" | "delivered" | "unroutable",
    suppression?: { readonly cause: string; readonly scope: string },
    context?: CelldEvaluationContext,
  ): Promise<void> {
    const monitor = this.#definition(run.monitorId, run.definitionVersion);
    const now = this.#now();
    if (context !== undefined) {
      // celld mode: the instance lives in the cell, so the terminal
      // `RUN_COMPLETED` transition is dispatched there, from the outcome this
      // records and returns. The run record is written identically either way,
      // which is what keeps `replay()` mode-independent.
      const completed = await this.#store.transaction(
        `instance:${run.instanceId}`,
        async (tx) => {
          const currentRun = await tx.getRun(run.id);
          if (currentRun === null) return null;
          const next: StoredMonitorRun = {
            ...currentRun,
            status,
            stage: "complete",
            leaseExpiresAt: undefined,
            ...(suppression === undefined ? {} : { suppression }),
            updatedAt: now,
          };
          await tx.putRun(next);
          return next;
        },
      );
      if (completed !== null) context.outcome = recordedEvaluation(completed);
      await this.#emitCompletion(run, status);
      return;
    }
    await this.#store.transaction(`instance:${run.instanceId}`, async (tx) => {
      const currentRun = await tx.getRun(run.id);
      const instance = await tx.getInstance(run.instanceId);
      if (currentRun === null || instance === null || instance.activeRunId !== run.id) return;
      const decisionValue = currentRun.decision;
      const completion = dispatchLifecycle(instance, monitor.definition, {
        type: "RUN_COMPLETED",
        status,
        ...(decisionValue === undefined
          ? {}
          : {
              decision: {
                action: decisionValue.action,
                ...(decisionValue.confidence === undefined
                  ? {}
                  : { confidence: decisionValue.confidence }),
                reasonClass: reasonClass(decisionValue.reason),
              },
            }),
        ...(currentRun.receipt === undefined ? {} : { binding: currentRun.receipt.binding }),
        now,
      });
      const nextInstance: StoredMonitorInstance = {
        ...completion.instance,
        expiresAt: addMs(
          now,
          durationMs((monitor.definition.retention ?? DEFAULT_RETENTION).decisions),
        ),
        updatedAt: now,
      };
      await tx.putInstance(nextInstance);
      await tx.putRun({
        ...currentRun,
        status,
        stage: "complete",
        leaseExpiresAt: undefined,
        ...(suppression === undefined ? {} : { suppression }),
        updatedAt: now,
      });
    });
    await this.#emitCompletion(run, status);
  }

  async #emitCompletion(run: StoredMonitorRun, status: string): Promise<void> {
    await this.#emit("monitor.evaluation.completed", {
      ...this.#runDetails(run),
      attributes: {
        outcome: status,
        ...(run.decision === undefined ? {} : { action: run.decision.action }),
        ...(run.modelUsage === undefined
          ? {}
          : {
              modelInputTokens: run.modelUsage.inputTokens,
              modelOutputTokens: run.modelUsage.outputTokens,
              ...(run.modelUsage.estimatedCost === undefined
                ? {}
                : { modelEstimatedCost: run.modelUsage.estimatedCost }),
            }),
      },
    });
  }

  async #retryRun(run: StoredMonitorRun, availableAt: string, reason: string): Promise<void> {
    await this.#store.transaction(`instance:${run.instanceId}`, async (tx) => {
      const current = await tx.getRun(run.id);
      if (current === null) return;
      await tx.putRun({
        ...current,
        status: "retry",
        availableAt,
        leaseExpiresAt: undefined,
        error: boundedReason(reason),
        updatedAt: this.#now(),
      });
    });
  }

  async #failRun(
    run: StoredMonitorRun,
    error: unknown,
    context?: CelldEvaluationContext,
  ): Promise<void> {
    const transient = error instanceof TransientMonitorError;
    const bindingConflict = error instanceof BindingConflictError;
    if (transient && run.attempt < this.#retry.maxAttempts) {
      const backoff = Math.min(
        this.#retry.maxBackoffMs,
        this.#retry.initialBackoffMs * 2 ** Math.max(0, run.attempt - 1),
      );
      await this.#retryRun(run, addMs(this.#now(), backoff), errorMessage(error));
      const current = await this.#store.getRun(run.id);
      const name = current?.stage === "delivery" || current?.stage === "complete"
        ? "monitor.delivery.failed"
        : "monitor.evaluation.failed";
      await this.#emit(name, {
        ...this.#runDetails(run),
        attributes: { transient: true, attempt: run.attempt, stage: current?.stage ?? run.stage },
      });
      return;
    }
    const observed = await this.#store.getRun(run.id);
    if (observed === null) return;
    await this.#store.transaction(`instance:${run.instanceId}`, async (tx) => {
      const current = await tx.getRun(run.id);
      // celld mode holds the instance in the cell; the cell dispatches
      // `RUN_FAILED` itself when this evaluation answers `dead-lettered`.
      const instance = context === undefined ? await tx.getInstance(run.instanceId) : null;
      if (current === null || (context === undefined && instance === null)) return;
      await this.#deadLetterRunInTransaction(
        tx,
        current,
        instance,
        bindingConflict ? "binding" : current.stage,
        errorMessage(error),
      );
    });
    if (context !== undefined) context.outcome = { runId: run.id, status: "dead-lettered" };
    await this.#emit(bindingConflict ? "monitor.binding.conflict" : "monitor.evaluation.failed", {
      ...this.#runDetails(run),
      attributes: { error: errorMessage(error).slice(0, 500) },
    });
  }

  /**
   * `instance` is null exactly for celld-mode runs, where the record lives in
   * the cell: the run row and the dead letter are written here, and the cell
   * applies the matching `RUN_FAILED` transition when it sees the outcome.
   */
  async #deadLetterRunInTransaction(
    tx: MonitorStoreTransaction,
    run: StoredMonitorRun,
    instance: StoredMonitorInstance | null,
    stage: string,
    reason: string,
  ): Promise<void> {
    const now = this.#now();
    reason = boundedReason(reason);
    await tx.putRun({
      ...run,
      status: "dead-lettered",
      stage: "complete",
      leaseExpiresAt: undefined,
      error: reason,
      updatedAt: now,
    });
    if (instance !== null) {
      const failure = dispatchLifecycle(
        instance,
        this.#definition(run.monitorId, run.definitionVersion).definition,
        { type: "RUN_FAILED", now },
      );
      const nextInstance: StoredMonitorInstance = {
        ...failure.instance,
        updatedAt: now,
      };
      await tx.putInstance(nextInstance);
    }
    await tx.putDeadLetter({
      id: this.#id("dlq"),
      tenantId: run.tenantId,
      applicationId: run.applicationId,
      monitorId: run.monitorId,
      definitionVersion: run.definitionVersion,
      instanceId: run.instanceId,
      runId: run.id,
      stage,
      reason,
      createdAt: now,
    });
  }

  async #loadRunEvents(run: StoredMonitorRun): Promise<readonly ChannelEvent[]> {
    const events: ChannelEvent[] = [];
    for (const reference of run.batch.events) {
      const record = await this.#store.getEvent(reference.ref);
      if (record === null || record.event === undefined || record.payloadExpiresAt <= this.#now()) {
        throw new Error(`source event ${reference.ref} is unavailable`);
      }
      events.push(freeze(structuredClone(record.event)));
    }
    return events;
  }

  async #finishSubscription(
    subscription: StoredSubscription,
    status: "filtered" | "uncorrelated" | "suppressed",
    outcome: string,
  ): Promise<void> {
    await this.#store.transaction(`subscription:${subscription.id}`, async (tx) => {
      const current = await tx.getSubscription(subscription.id);
      if (current === null) return;
      await tx.putSubscription({
        ...current,
        status,
        outcome,
        leaseExpiresAt: undefined,
        updatedAt: this.#now(),
      });
    });
    if (status !== "suppressed") {
      await this.#emit(
        status === "filtered" ? "monitor.subscription.filtered" : "monitor.subscription.uncorrelated",
        this.#eventDetails(subscription, { attributes: { outcome } }),
      );
    }
  }

  async #retrySubscription(
    subscription: StoredSubscription,
    availableAt: string,
    outcome: string,
  ): Promise<void> {
    await this.#store.transaction(`subscription:${subscription.id}`, async (tx) => {
      const current = await tx.getSubscription(subscription.id);
      if (current === null) return;
      await tx.putSubscription({
        ...current,
        status: "pending",
        availableAt,
        leaseExpiresAt: undefined,
        outcome,
        updatedAt: this.#now(),
      });
    });
  }

  async #deadLetterSubscription(
    subscription: StoredSubscription,
    stage: string,
    reason: string,
  ): Promise<void> {
    reason = boundedReason(reason);
    await this.#store.transaction(`subscription:${subscription.id}`, async (tx) => {
      const current = await tx.getSubscription(subscription.id);
      if (current === null) return;
      const now = this.#now();
      await tx.putSubscription({
        ...current,
        status: "dead-lettered",
        outcome: reason,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      await tx.putDeadLetter({
        id: this.#id("dlq"),
        tenantId: subscription.tenantId,
        applicationId: subscription.applicationId,
        monitorId: subscription.monitorId,
        definitionVersion: subscription.definitionVersion,
        eventRef: subscription.eventRef,
        subscriptionId: subscription.id,
        stage,
        reason,
        createdAt: now,
      });
    });
    await this.#emit("monitor.dead_lettered", {
      ...this.#eventDetails(subscription),
      attributes: { stage, reason: reason.slice(0, 500) },
    });
  }

  #snapshot(
    run: StoredMonitorRun,
    decisionValue: MonitorDecision,
    evidence: JsonValue,
    completeness: MonitorBatchView,
    id = this.#id("evidence"),
  ) {
    return freeze({
      id,
      runId: run.id,
      createdAt: this.#now(),
      sourceEventRefs: run.batch.events.map((event) => event.ref),
      projectedEvidence: cloneJson(evidence),
      decision: structuredClone(decisionValue),
      completeness: structuredClone(completeness),
      projectionVersion: run.definitionVersion,
    });
  }

  #trigger(
    run: StoredMonitorRun,
    snapshot: MonitorEvidenceSnapshot,
    events: readonly ChannelEvent[],
  ) {
    return {
      kind: "monitor" as const,
      monitorId: run.monitorId,
      definitionVersion: run.definitionVersion,
      runId: run.id,
      correlationKeyHash: run.correlationKeyHash,
      evidenceSnapshotId: snapshot.id,
      sourceTypes: [...new Set(events.map((event) => event.type))],
    };
  }

  #prepareDefinitions(monitors: readonly CompiledMonitor[]): void {
    for (const monitor of monitors) {
      validateMonitorDefinition(monitor.definition);
      assertNonEmpty(monitor.version, `definition version for ${monitor.definition.id}`);
      assertBoundedText(monitor.version, `definition version for ${monitor.definition.id}`, 512);
      if (monitor.active !== undefined && typeof monitor.active !== "boolean") {
        throw new TypeError(`definition active flag for ${monitor.definition.id} must be a boolean`);
      }
      const compatible = new Set<string>();
      for (const version of monitor.compatibleWith ?? []) {
        assertBoundedText(version, `compatible version for ${monitor.definition.id}`, 512);
        if (version === monitor.version) {
          throw new TypeError(`definition ${monitor.definition.id}@${monitor.version} cannot be compatible with itself`);
        }
        if (compatible.has(version)) {
          throw new TypeError(`definition ${monitor.definition.id}@${monitor.version} repeats compatible version ${version}`);
        }
        compatible.add(version);
      }
      const key = definitionKey(monitor.definition.id, monitor.version);
      if (this.#definitions.has(key)) throw new TypeError(`duplicate monitor version ${key}`);
      this.#definitions.set(key, monitor);
      if (monitor.active ?? true) {
        this.#activeDefinitions.set(key, monitor);
        if ((monitor.definition.mode ?? "active") === "active") {
          if (this.#deliveryDefinitions.has(monitor.definition.id)) {
            throw new TypeError(
              `multiple delivery-active versions for monitor ${monitor.definition.id}`,
            );
          }
          this.#deliveryDefinitions.set(monitor.definition.id, monitor);
        }
      }
      for (const source of monitor.definition.sources) {
        const channel = this.#channels.get(source.channelId) as
          | { readonly inbound: Readonly<Record<string, { readonly chat: boolean }>> }
          | undefined;
        const event = channel?.inbound[source.eventType];
        if (event === undefined) {
          throw new TypeError(
            `monitor ${monitor.definition.id} references undeclared source ${source.channelId}:${source.eventType}`,
          );
        }
        if (source.phase !== undefined && !event.chat) {
          throw new TypeError(
            `monitor ${monitor.definition.id} applies chat phase ${source.phase} to non-chat source ${source.channelId}:${source.eventType}`,
          );
        }
        if (source.phase === undefined && event.chat) {
          throw new TypeError(
            `monitor ${monitor.definition.id} must select observed or undispatched for chat source ${source.channelId}:${source.eventType}`,
          );
        }
      }
    }
    if (this.#activeDefinitions.size === 0 && monitors.length > 0) {
      throw new TypeError("deployment has no active monitor versions");
    }
  }

  #matchingMonitors(channelId: string, eventType: string, phase?: "observed" | "undispatched") {
    return [...this.#activeDefinitions.values()].filter(
      (monitor) =>
        (monitor.definition.mode ?? "active") !== "disabled" &&
        monitor.definition.sources.some((source) =>
          sourceMatches(source, { channelId, eventType, ...(phase === undefined ? {} : { phase }) }),
        ),
    );
  }

  #retentionMonitors(channelId: string, eventType: string): CompiledMonitor[] {
    return [...this.#activeDefinitions.values()].filter(
      (monitor) =>
        (monitor.definition.mode ?? "active") !== "disabled" &&
        monitor.definition.sources.some(
          (source) => source.channelId === channelId && source.eventType === eventType,
        ),
    );
  }

  #definition(id: string, version: string): CompiledMonitor {
    const monitor = this.#definitions.get(definitionKey(id, version));
    if (monitor === undefined) {
      throw new Error(`definition ${id}@${version} is unavailable; retain pinned versions until work completes`);
    }
    return monitor;
  }

  #isLoop(event: ChannelEvent, definition: MonitorDefinition<ChannelEvent>): boolean {
    const loop = definition.loopPrevention ?? DEFAULT_LOOP_PREVENTION;
    if (event.origin.depth > loop.maxInternalCausationDepth) return true;
    if (event.origin.applicationId !== this.#applicationId) return false;
    return (
      (loop.ignoreOwnAgentEvents && event.origin.kind === "agent") ||
      (loop.ignoreOwnMonitorEvents && event.origin.kind === "monitor")
    );
  }

  #callPure<T>(name: string, callback: () => T): T {
    const result = callback();
    if (isPromiseLike(result)) throw new TypeError(`${name} must be synchronous and pure`);
    return result;
  }

  async #migrateMonitor(from: string, to: string): Promise<void> {
    const target = this.#deliveryDefinitions.get(to);
    if (target === undefined) throw new Error(`migration target ${to} is not delivery-active`);
    const [subscriptions, instances, targetInstances] = await Promise.all([
      this.#store.listSubscriptionsForMonitor({
        applicationId: this.#applicationId,
        monitorId: from,
      }),
      this.#store.listInstances({ applicationId: this.#applicationId, monitorId: from }),
      this.#store.listInstances({ applicationId: this.#applicationId, monitorId: to }),
    ]);
    for (const subscription of subscriptions) {
      if (subscription.status === "processing") {
        throw new Error(`cannot migrate ${from}; subscription ${subscription.id} is processing`);
      }
    }
    const targetInstanceIds = new Set(targetInstances.map((instance) => instance.id));
    for (const instance of instances) {
      if (instance.activeRunId !== undefined) {
        throw new Error(`cannot migrate ${from}; instance ${instance.id} has an active pinned run`);
      }
      const nextId = instanceStoreKey({
        tenantId: instance.tenantId,
        applicationId: instance.applicationId,
        monitorId: to,
        definitionVersion: target.version,
        correlationKeyHash: instance.correlationKeyHash,
      });
      if (targetInstanceIds.has(nextId)) {
        throw new Error(`cannot migrate ${from} to ${to}; correlation state collision at ${nextId}`);
      }
      targetInstanceIds.add(nextId);
    }
    for (const subscription of subscriptions) {
      if (["pending", "ready"].includes(subscription.status)) {
        await this.#store.transaction(`subscription:${subscription.id}`, async (tx) => {
          const current = await tx.getSubscription(subscription.id);
          if (current === null || current.status === "processing") return;
          await tx.putSubscription({
            ...current,
            monitorId: to,
            definitionVersion: target.version,
            updatedAt: this.#now(),
          });
        });
      }
    }
    for (const instance of instances) {
      const nextId = instanceStoreKey({
        tenantId: instance.tenantId,
        applicationId: instance.applicationId,
        monitorId: to,
        definitionVersion: target.version,
        correlationKeyHash: instance.correlationKeyHash,
      });
      await this.#store.transaction(`instance-migration:${instance.id}:${nextId}`, async (tx) => {
        const current = await tx.getInstance(instance.id);
        if (current === null) return;
        if ((await tx.getInstance(nextId)) !== null) {
          throw new Error(`cannot migrate ${from} to ${to}; correlation state collision at ${nextId}`);
        }
        await tx.deleteInstance(instance.id);
        await tx.putInstance({
          ...current,
          id: nextId,
          monitorId: to,
          definitionVersion: target.version,
          updatedAt: this.#now(),
        });
      });
    }
  }

  async #removeMonitorState(id: string): Promise<void> {
    const [subscriptions, instances] = await Promise.all([
      this.#store.listSubscriptionsForMonitor({
        applicationId: this.#applicationId,
        monitorId: id,
      }),
      this.#store.listInstances({ applicationId: this.#applicationId, monitorId: id }),
    ]);
    for (const subscription of subscriptions) {
      if (subscription.status === "processing") {
        throw new Error(`cannot discard ${id}; subscription ${subscription.id} is processing`);
      }
    }
    for (const instance of instances) {
      if (instance.activeRunId !== undefined) {
        throw new Error(`cannot discard ${id}; instance ${instance.id} has an active pinned run`);
      }
    }
    for (const subscription of subscriptions) {
      await this.#store.transaction(`subscription:${subscription.id}`, async (tx) => {
        await tx.deleteSubscription(subscription.id);
      });
    }
    for (const instance of instances) {
      await this.#store.transaction(`instance:${instance.id}`, async (tx) => {
        await tx.deleteInstance(instance.id);
      });
    }
  }

  async #migrateCompatibleVersions(): Promise<void> {
    for (const target of this.#deliveryDefinitions.values()) {
      const compatible = new Set(target.compatibleWith ?? []);
      if (compatible.size === 0) continue;
      const instances = await this.#store.listInstances({
        applicationId: this.#applicationId,
        monitorId: target.definition.id,
      });
      for (const instance of instances) {
        if (instance.definitionVersion === target.version || !compatible.has(instance.definitionVersion)) continue;
        if (instance.activeRunId !== undefined) continue;
        const nextId = instanceStoreKey({
          tenantId: instance.tenantId,
          applicationId: instance.applicationId,
          monitorId: instance.monitorId,
          definitionVersion: target.version,
          correlationKeyHash: instance.correlationKeyHash,
        });
        await this.#store.transaction(`instance-version:${instance.id}:${nextId}`, async (tx) => {
          const current = await tx.getInstance(instance.id);
          if (current === null || current.activeRunId !== undefined) return;
          const existing = await tx.getInstance(nextId);
          if (existing !== null) {
            throw new Error(
              `compatible version migration for ${instance.monitorId} collides at ${instance.correlationKeyHash}`,
            );
          }
          await tx.deleteInstance(current.id);
          await tx.putInstance({
            ...current,
            id: nextId,
            definitionVersion: target.version,
            updatedAt: this.#now(),
          });
        });
      }
    }
  }

  async #validatePinnedDefinitions(): Promise<void> {
    const pins = await this.#store.listDefinitionPins(this.#applicationId);
    for (const pin of pins) {
      if (!this.#definitions.has(definitionKey(pin.monitorId, pin.definitionVersion))) {
        throw new Error(
          `durable ${pin.kind} ${pin.id} requires pinned definition ${pin.monitorId}@${pin.definitionVersion}; retain it as inactive, declare compatibility, migrate the ID, or discard the monitor`,
        );
      }
    }
  }

  #validateCelldDefinitionPins(
    pins: Readonly<Record<string, readonly string[]>> | undefined,
  ): void {
    for (const [monitorId, versions] of Object.entries(pins ?? {})) {
      for (const version of versions) {
        if (!this.#definitions.has(definitionKey(monitorId, version))) {
          throw new Error(
            `durable celld mailbox requires pinned definition ${monitorId}@${version}; retain it as inactive until the fleet state is explicitly migrated or discarded`,
          );
        }
      }
    }
  }

  async #recordCelldDefinitionPin(monitorId: string, version: string): Promise<void> {
    const definition = definitionKey(monitorId, version);
    if (this.#recordedCelldDefinitionPins.has(definition)) return;
    await this.#store.transaction(`deployment:${this.#applicationId}`, async (tx) => {
      const deployment = await tx.getDeployment(this.#applicationId);
      if (deployment === null || (deployment.mailboxMode ?? "store") !== "celld") {
        throw new Error("celld deployment record disappeared while appending to a cell");
      }
      const pins: Record<string, readonly string[]> = {
        ...(deployment.celldDefinitionPins ?? {}),
      };
      const versions = new Set(pins[monitorId] ?? []);
      if (versions.has(version)) return;
      versions.add(version);
      pins[monitorId] = [...versions].sort();
      await tx.putDeployment({ ...deployment, celldDefinitionPins: pins, updatedAt: this.#now() });
    });
    this.#recordedCelldDefinitionPins.add(definition);
  }

  #monitorScope(input: { readonly tenantId: string; readonly applicationId: string; readonly monitorId: string }) {
    return scopedKey(input.tenantId, input.applicationId, input.monitorId);
  }

  #eventDetails(
    subscription: StoredSubscription,
    extra: Partial<MonitorLifecycleEvent> = {},
  ): Omit<MonitorLifecycleEvent, "name" | "occurredAt"> {
    return {
      tenantId: subscription.tenantId,
      applicationId: subscription.applicationId,
      monitorId: subscription.monitorId,
      definitionVersion: subscription.definitionVersion,
      eventRef: subscription.eventRef,
      ...extra,
    };
  }

  #runDetails(run: StoredMonitorRun): Omit<MonitorLifecycleEvent, "name" | "occurredAt"> {
    return {
      tenantId: run.tenantId,
      applicationId: run.applicationId,
      monitorId: run.monitorId,
      definitionVersion: run.definitionVersion,
      correlationKeyHash: run.correlationKeyHash,
      runId: run.id,
    };
  }

  async #emit(
    name: MonitorLifecycleEvent["name"],
    details: Partial<Omit<MonitorLifecycleEvent, "name" | "occurredAt" | "applicationId">> & {
      readonly applicationId?: string;
    },
  ): Promise<void> {
    try {
      await this.#observer?.emit({
        name,
        occurredAt: this.#now(),
        applicationId: details.applicationId ?? this.#applicationId,
        ...details,
      });
    } catch {
      // Telemetry must never change monitor durability or delivery behavior.
    }
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("MonitorRuntime.initialize() must complete before use");
  }
}

interface RequiredRetryPolicy {
  readonly leaseMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxAttempts: number;
}

type LimitResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly retryAt: string;
      readonly cause: string;
      readonly scope: string;
    };

type DirectDispatchClaim =
  | { readonly kind: "claimed"; readonly attempt: number }
  | {
      readonly kind: "settled";
      readonly outcome: ChatPublishResult["directDispatch"];
    };

type BudgetMetric = "events" | "model-calls" | "model-input-tokens" | "wakes";

class BudgetDenied extends Error {
  readonly retryAt: string;
  readonly scope: string;

  constructor(retryAt: string, scope: string) {
    super("monitor budget denied");
    this.retryAt = retryAt;
    this.scope = scope;
  }
}

class CardinalityDenied extends Error {
  readonly retryAt: string;

  constructor(retryAt: string) {
    super("correlation cardinality limit reached");
    this.retryAt = retryAt;
  }
}

/** A cell refused an append for a reason retrying cannot fix. */
class CelldAppendRejected extends Error {}

/**
 * The instance facts a celld-mode evaluation needs but cannot read from the
 * store, plus the terminal outcome it must report back to the cell.
 */
interface CelldEvaluationContext {
  readonly correlationKey: string;
  readonly binding: MonitorBindingView | undefined;
  outcome: EvaluationResponse | undefined;
}

async function readCellError(response: Response): Promise<{ code: string; error: string }> {
  try {
    const body = (await response.json()) as Partial<CelldErrorResponse>;
    return {
      code: typeof body.code === "string" ? body.code : "",
      error: typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
    };
  } catch {
    return { code: "", error: `HTTP ${response.status}` };
  }
}

function isTerminalRunStatus(status: StoredMonitorRun["status"]): boolean {
  return (
    status === "ignored" ||
    status === "shadowed" ||
    status === "suppressed" ||
    status === "delivered" ||
    status === "unroutable" ||
    status === "dead-lettered"
  );
}

function evaluationUnavailableUntil(run: StoredMonitorRun, now: string): string | null {
  if (run.availableAt > now) return run.availableAt;
  if (
    run.status === "processing" &&
    run.leaseExpiresAt !== undefined &&
    run.leaseExpiresAt > now
  ) {
    return run.leaseExpiresAt;
  }
  return null;
}

function scheduledEvaluation(runId: string, retryAt: string): EvaluationResponse {
  return { runId, status: "retry", retryAt };
}

/** Projects a recorded run into the answer a cell needs to close its run. */
function recordedEvaluation(run: StoredMonitorRun): EvaluationResponse {
  return {
    runId: run.id,
    status: run.status as EvaluationTerminalStatus,
    ...(run.decision === undefined
      ? {}
      : {
          decision: {
            action: run.decision.action,
            ...(run.decision.confidence === undefined
              ? {}
              : { confidence: run.decision.confidence }),
            reasonClass: reasonClass(run.decision.reason),
          },
        }),
    ...(run.receipt === undefined
      ? {}
      : { receipt: run.receipt, binding: run.receipt.binding }),
    ...(run.suppression === undefined
      ? {}
      : { suppression: { cause: run.suppression.cause, scope: run.suppression.scope } }),
  };
}

function validateEvaluationRequest(request: EvaluationRequest): void {
  if (request === null || typeof request !== "object") {
    throw new EvaluationRequestError("evaluation request must be an object");
  }
  const required: readonly (readonly [string, unknown])[] = [
    ["runId", request.runId],
    ["instanceId", request.instanceId],
    ["tenantId", request.tenantId],
    ["applicationId", request.applicationId],
    ["monitorId", request.monitorId],
    ["definitionVersion", request.definitionVersion],
    ["correlationKey", request.correlationKey],
    ["correlationKeyHash", request.correlationKeyHash],
  ];
  for (const [name, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new EvaluationRequestError(`evaluation ${name} must be a non-empty string`);
    }
  }
  const batch = request.batch as StoredMonitorBatch | undefined;
  if (batch === undefined || batch === null || !Array.isArray(batch.events)) {
    throw new EvaluationRequestError("evaluation batch must carry an event list");
  }
  if (batch.events.length === 0) {
    throw new EvaluationRequestError("evaluation batch must not be empty");
  }
  if (request.instanceView === null || typeof request.instanceView !== "object") {
    throw new EvaluationRequestError("evaluation instanceView must be an object");
  }
}

function validateModelUsage(usage: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost?: number | undefined;
}): void {
  for (const [name, value] of [
    ["inputTokens", usage.inputTokens],
    ["outputTokens", usage.outputTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`classifier usage ${name} must be a non-negative safe integer`);
    }
  }
  if (
    usage.estimatedCost !== undefined &&
    (!Number.isFinite(usage.estimatedCost) || usage.estimatedCost < 0)
  ) {
    throw new TypeError("classifier usage estimatedCost must be a non-negative finite number");
  }
}

function isSettledDirectDispatch(
  status: NonNullable<StoredEvent["directDispatch"]>["status"],
): status is "dispatched" | "undispatched" | "failed" {
  return status === "dispatched" || status === "undispatched" || status === "failed";
}

function budgetProperty(metric: BudgetMetric): keyof MonitorBudgetCeilings {
  switch (metric) {
    case "events":
      return "maxEventsPerMinute";
    case "model-calls":
      return "maxModelCallsPerMinute";
    case "model-input-tokens":
      return "maxModelInputTokensPerHour";
    case "wakes":
      return "maxWakesPerHour";
  }
}

function validateBudgetCeilings(
  ceilings: MonitorBudgetCeilings | undefined,
  name: string,
): void {
  if (ceilings === undefined) return;
  for (const [key, value] of Object.entries(ceilings)) {
    if (value !== undefined) assertPositiveSafeInteger(value, `${name}.${key}`);
  }
}

function validateDeploymentChanges(deployment: MonitorDeployment): void {
  const migrations = new Set<string>();
  for (const migration of deployment.monitorMigrations ?? []) {
    assertIdentifier(migration.from, "monitor migration source");
    assertIdentifier(migration.to, "monitor migration target");
    if (migration.mode !== "move-state") throw new TypeError('monitor migration mode must be "move-state"');
    if (migration.from === migration.to) throw new TypeError("monitor migration must change the monitor ID");
    if (migrations.has(migration.from)) {
      throw new TypeError(`monitor ${migration.from} has multiple migration declarations`);
    }
    migrations.add(migration.from);
  }
  const removals = new Set<string>();
  for (const removal of deployment.monitorRemovals ?? []) {
    assertIdentifier(removal.id, "monitor removal ID");
    if (removal.mode !== "discard-state") throw new TypeError('monitor removal mode must be "discard-state"');
    if (removals.has(removal.id)) {
      throw new TypeError(`monitor ${removal.id} has multiple removal declarations`);
    }
    if (migrations.has(removal.id)) {
      throw new TypeError(`monitor ${removal.id} cannot be both migrated and removed`);
    }
    removals.add(removal.id);
  }
}

function prepareRetryPolicy(input: Partial<MonitorRetryPolicy> | undefined): RequiredRetryPolicy {
  const value = { ...DEFAULT_RETRY_POLICY, ...input };
  const leaseMs = durationMs(value.lease, "retry lease");
  const initialBackoffMs = durationMs(value.initialBackoff, "retry initialBackoff");
  const maxBackoffMs = durationMs(value.maxBackoff, "retry maxBackoff");
  assertPositiveSafeInteger(value.maxAttempts, "retry maxAttempts");
  if (initialBackoffMs > maxBackoffMs) {
    throw new TypeError("retry initialBackoff must not exceed maxBackoff");
  }
  return { leaseMs, initialBackoffMs, maxBackoffMs, maxAttempts: value.maxAttempts };
}

function prepareRuntimeLimits(input: Partial<MonitorRuntimeLimits> | undefined): MonitorRuntimeLimits {
  const value = { ...DEFAULT_RUNTIME_LIMITS, ...input };
  for (const [name, amount] of Object.entries(value)) assertPositiveSafeInteger(amount, name);
  return value;
}

function validatePublishEnvelope(input: PublishEventInput<unknown, JsonValue>): void {
  assertBoundedText(input.tenantId, "tenantId", 256);
  assertBoundedText(input.installationId, "installationId", 512);
  assertBoundedText(input.id, "event id", 1_024);
  if (input.occurredAt !== undefined && !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new TypeError("occurredAt must be an ISO-compatible timestamp");
  }
  if (!input.origin || !["external", "agent", "monitor", "schedule"].includes(input.origin.kind)) {
    throw new TypeError("origin.kind must be external, agent, monitor, or schedule");
  }
  if (!Number.isSafeInteger(input.origin.depth ?? 0) || (input.origin.depth ?? 0) < 0) {
    throw new TypeError("origin.depth must be a non-negative safe integer");
  }
  if (input.origin.applicationId !== undefined) {
    assertBoundedText(input.origin.applicationId, "origin.applicationId", 256);
  }
  if (input.origin.id !== undefined) assertBoundedText(input.origin.id, "origin.id", 1_024);
  if (input.origin.causationId !== undefined) {
    assertBoundedText(input.origin.causationId, "origin.causationId", 1_024);
  }
  if (input.actor !== undefined) {
    assertBoundedText(input.actor.id, "actor.id", 1_024);
    if (input.actor.displayName !== undefined) {
      assertBoundedText(input.actor.displayName, "actor.displayName", 1_024);
    }
    if (!input.actor || !["user", "service", "app", "unknown"].includes(input.actor.principalType)) {
      throw new TypeError("actor.principalType must be user, service, app, or unknown");
    }
    if (input.actor.isBot !== undefined && typeof input.actor.isBot !== "boolean") {
      throw new TypeError("actor.isBot must be a boolean");
    }
    if (
      input.actor.knownAgentPrincipal !== undefined &&
      typeof input.actor.knownAgentPrincipal !== "boolean"
    ) {
      throw new TypeError("actor.knownAgentPrincipal must be a boolean");
    }
  }
  if (input.authRef !== undefined) assertBoundedText(input.authRef, "authRef", 2_048);
  if (input.trace?.traceId !== undefined) assertBoundedText(input.trace.traceId, "traceId", 256);
  if (input.trace?.spanId !== undefined) assertBoundedText(input.trace.spanId, "spanId", 256);
  if ((input.subjects?.length ?? 0) > 100) throw new TypeError("subjects must contain at most 100 entries");
  const subjects = new Set<string>();
  for (const [index, subject] of (input.subjects ?? []).entries()) {
    assertBoundedText(subject.namespace, `subjects[${index}].namespace`, 128);
    assertBoundedText(subject.key, `subjects[${index}].key`, 1_024);
    const identity = scopedKey(subject.namespace, subject.key);
    if (subjects.has(identity)) throw new TypeError("subjects must not contain duplicate exact keys");
    subjects.add(identity);
  }
  if (input.replyTarget !== undefined) {
    assertJsonValue(input.replyTarget, "replyTarget");
    if (jsonBytes(input.replyTarget) > TARGET_MAX_BYTES) {
      throw new TypeError("replyTarget must be at most 65,536 UTF-8 bytes");
    }
  }
}

function assertSizedJson(value: unknown, name: string, maxBytes: number): asserts value is JsonValue {
  assertJsonValue(value, name);
  const bytes = jsonBytes(value, name);
  if (bytes > maxBytes) {
    throw new TypeError(`${name} must be at most ${maxBytes.toLocaleString("en-US")} UTF-8 bytes`);
  }
}






function batchView(batch: StoredMonitorBatch): MonitorBatchView {
  return freeze({
    openedAt: batch.openedAt,
    closedAt: batch.closedAt,
    closedBy: batch.closedBy,
    eventCount: batch.events.length,
    bytes: batch.bytes,
    isPartial: false,
    omittedEventCount: 0,
    omittedBytes: 0,
  });
}

function instanceView(instance: StoredMonitorInstance): MonitorInstanceView {
  // The projection itself lives in `./mailbox.js` so the cell worker computes
  // exactly the same view for the runs it hands back to the evaluator.
  return freeze(projectInstanceView(instance));
}

function reasonClass(reason: string): string {
  return reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unspecified";
}

function boundedReason(reason: string): string {
  return Buffer.byteLength(reason, "utf8") <= 4_096
    ? reason
    : `${Buffer.from(reason).subarray(0, 4_093).toString("utf8").replace(/\uFFFD+$/u, "")}...`;
}

function groupSubscriptions(
  subscriptions: readonly StoredSubscription[],
): readonly (readonly StoredSubscription[])[] {
  const groups = new Map<string, StoredSubscription[]>();
  for (const subscription of subscriptions) {
    const key = scopedKey(
      subscription.tenantId,
      subscription.applicationId,
      subscription.monitorId,
      subscription.definitionVersion,
    );
    const group = groups.get(key) ?? [];
    group.push(subscription);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => compareIngressSequence(left.ingressSequence, right.ingressSequence));
  }
  return [...groups.values()];
}

function compareIngressSequence(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function definitionKey(id: string, version: string): string {
  return scopedKey(id, version);
}
