import {
  DEFAULT_LOOP_PREVENTION,
  DEFAULT_RETENTION,
  sourceMatches,
  validateDecision,
  validateMonitorDefinition,
} from "./definition.js";
import type {
  BufferedEventRef,
  MonitorStore,
  MonitorStoreTransaction,
  OpenMonitorBatch,
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

    await this.#store.transaction(`deployment:${this.#applicationId}`, async (tx) => {
      const current = await tx.getDeployment(this.#applicationId);
      if (canonicalJson(current) !== canonicalJson(expectedDeployment)) {
        throw new Error("monitor deployment changed concurrently; retry initialization");
      }
      await tx.putDeployment({
        applicationId: this.#applicationId,
        activeMonitorIds: activeIds,
        activeVersions,
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
    if (accepted.status === "duplicate") {
      return { ...accepted, directDispatch: "duplicate" };
    }
    try {
      const receipts = await Promise.all(directHandlers.map((handler) => handler()));
      if (receipts.some((receipt) => receipt !== null)) {
        return { ...accepted, directDispatch: "dispatched" };
      }
      await this.#addPhaseSubscriptions(accepted.eventId, "undispatched");
      return { ...accepted, directDispatch: "undispatched" };
    } catch (error) {
      await this.#deadLetter({
        eventRef: accepted.eventId,
        stage: "direct-dispatch",
        reason: `direct dispatch failed with unknown turn outcome: ${errorMessage(error)}`,
      });
      return { ...accepted, directDispatch: "failed" };
    }
  }

  /** Runs all currently due work. It never advances the supplied clock. */
  async drain(): Promise<DrainResult> {
    this.#assertInitialized();
    let subscriptions = 0;
    let evaluations = 0;
    let runs = 0;
    let iterations = 0;
    let progressed = true;
    while (progressed && iterations < this.#limits.maxDrainIterations) {
      progressed = false;
      const subscriptionBatch = await this.#store.listSubscriptions({
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

      const dueInstances = await this.#store.listDueInstances({
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
        availableBefore: this.#now(),
        limit: this.#limits.evaluationConcurrency,
      });
      if (dueRuns.length > 0) {
        await Promise.all(dueRuns.map((run) => this.#processRun(run.id)));
        runs += dueRuns.length;
        progressed = true;
      }
      iterations += 1;
    }

    const now = this.#now();
    const [pendingSubscriptions, pendingInstances, pendingRuns] = await Promise.all([
      this.#store.listSubscriptions({ statuses: ["pending", "processing", "ready"], availableBefore: now, limit: 1 }),
      this.#store.listDueInstances({ availableBefore: now, limit: 1 }),
      this.#store.listDueRuns({ availableBefore: now, limit: 1 }),
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
    };

    const result = await this.#store.transaction(`ingress:${dedupeKey}`, async (tx) => {
      const duplicate = await tx.getEventByDedupeKey(dedupeKey);
      if (duplicate !== null && duplicate.dedupeExpiresAt > now) {
        return { status: "duplicate" as const, eventId: duplicate.ref, traceId: duplicate.traceId };
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

  async #addPhaseSubscriptions(eventRef: string, phase: "undispatched"): Promise<void> {
    const event = await this.#store.getEvent(eventRef);
    if (event === null) throw new Error(`accepted event ${eventRef} disappeared`);
    const matching = this.#matchingMonitors(event.channelId, event.eventType, phase);
    await this.#store.transaction(`event-phase:${eventRef}:${phase}`, async (tx) => {
      for (const monitor of matching) {
        const subscription = this.#newSubscription(event, monitor, phase);
        if ((await tx.getSubscription(subscription.id)) === null) await tx.putSubscription(subscription);
      }
    });
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
    const now = this.#now();
    const observedInstances = await this.#store.listInstances({
      applicationId: subscription.applicationId,
      monitorId: subscription.monitorId,
    });
    const instanceExists = observedInstances.some((value) => value.id === instanceId);
    const appendLock = instanceExists
      ? `instance:${instanceId}`
      : `cardinality:${scopedKey(subscription.tenantId, subscription.applicationId)}`;
    let outcome: "opened" | "updated" | "flushed";
    try {
      outcome = await this.#store.transaction(appendLock, async (tx) => {
      let instance = await tx.getInstance(instanceId);
      let transactionOutcome: "opened" | "updated" | "flushed" = "updated";
      if (instance === null) {
        const existing = await this.#store.listInstances({ applicationId: subscription.applicationId });
        const tenantCount = existing.filter((value) => value.tenantId === subscription.tenantId).length;
        if (tenantCount >= this.#limits.maxActiveKeysPerTenant) {
          throw new CardinalityDenied(addMs(now, this.#retry.initialBackoffMs));
        }
        instance = this.#newInstance(instanceId, subscription, monitor, correlationKey, keyHash);
        transactionOutcome = "opened";
      }
      const ref: BufferedEventRef = {
        ref: event.ref,
        bytes: event.bytes,
        acceptedAt: event.acceptedAt,
        ingressSequence: event.ingressSequence,
      };
      const append = appendEvent(instance, ref, buffer, now);
      instance = {
        ...append.instance,
        nextEvaluationAt: nextEvaluationAt(append.instance, monitor.definition, now),
        expiresAt: addMs(
          now,
          durationMs((monitor.definition.retention ?? DEFAULT_RETENTION).decisions),
        ),
        updatedAt: now,
      };
      if (append.flushed) transactionOutcome = "flushed";
      await tx.putInstance(instance);
      await tx.putSubscription({
        ...subscription,
        status: "buffered",
        correlationKeyHash: keyHash,
        outcome: "appended",
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      return transactionOutcome;
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
    await this.#emit(
      outcome === "opened"
        ? "monitor.buffer.opened"
        : outcome === "flushed"
          ? "monitor.buffer.flushed"
          : "monitor.buffer.updated",
      this.#eventDetails(subscription, { correlationKeyHash: keyHash }),
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
      const selected = takeDueBatch(instance, monitor.definition, now);
      if (selected === null) {
        await tx.putInstance({
          ...instance,
          nextEvaluationAt: nextEvaluationAt(instance, monitor.definition, now),
          updatedAt: now,
        });
        return null;
      }
      const generation = instance.evaluationGeneration + 1;
      const runId = `run_${stableHash(scopedKey(instance.id, String(generation)))}`;
      const nextInstance: StoredMonitorInstance = {
        ...selected.instance,
        activeRunId: runId,
        nextEvaluationAt: undefined,
        evaluationGeneration: generation,
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
        batch: selected.batch,
        mode: monitor.definition.mode ?? "active",
        instanceView: instanceView(instance),
        status: "pending",
        stage: "decision",
        attempt: 0,
        availableAt: now,
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

  async #continueRun(initial: StoredMonitorRun): Promise<void> {
    let run = initial;
    const monitor = this.#definition(run.monitorId, run.definitionVersion);
    const events = await this.#loadRunEvents(run);
    const base = freeze({
      events,
      instance: structuredClone(run.instanceView),
      batch: batchView(run.batch),
    });

    if (run.decision === undefined) {
      if (run.batch.recordedDecision !== undefined) {
        run = await this.#checkpointRun(run, {
          decision: run.batch.recordedDecision,
          decisionSource: "recorded",
          stage: "policy",
        });
      } else if (typeof monitor.definition.decision === "function") {
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
          const limited = await this.#reserveModelLimits(run, monitor.definition, estimatedInputTokens);
          if (!limited.allowed) {
            await this.#handleLimit(run, limited.cause, limited.scope, limited.retryAt);
            return;
          }
          const invocation = await this.#invokeModelDecisionWithUsage(model, base, input);
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
      await this.#completeRun(run, "ignored");
      return;
    }

    const wakeLimit = await this.#reserveWakeLimits(run, monitor.definition);
    if (!wakeLimit.allowed) {
      await this.#handleLimit(run, wakeLimit.cause, wakeLimit.scope, wakeLimit.retryAt);
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
        await this.#completeRun(run, "unroutable");
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
      await this.#completeRun(run, "shadowed");
      return;
    }
    if (run.mode === "disabled") {
      await this.#completeRun(run, "suppressed", { cause: "disabled", scope: "monitor" });
      return;
    }
    const instance = await this.#store.listInstances({
      applicationId: run.applicationId,
      monitorId: run.monitorId,
    }).then((values) => values.find((value) => value.id === run.instanceId));
    if (instance === undefined) throw new Error(`monitor instance ${run.instanceId} disappeared`);
    const channel = this.#deliveryChannels.get(run.route!.channelId)!;
    await this.#emit("monitor.delivery.started", this.#runDetails(run));
    const idleTimeout = monitor.definition.session?.idleTimeout;
    const receipt = await channel.deliver({
      tenantId: run.tenantId,
      applicationId: run.applicationId,
      idempotencyKey: `monitor:${run.id}:0`,
      auth: "app",
      target: run.route!.target,
      ...(instance.binding?.bindingRef === undefined ? {} : { bindingRef: instance.binding.bindingRef }),
      session: {
        strategy: monitor.definition.session?.strategy ?? "channel",
        ...(idleTimeout === undefined ? {} : { idleTimeoutMs: durationMs(idleTimeout) }),
      },
      ...(monitor.definition.session?.strategy === "correlation"
        ? { correlationSubject: { namespace: "monitor", key: instance.correlationKey } }
        : {}),
      taskInstructions: monitor.definition.task.instructions,
      evidence: run.snapshot!,
      trigger: this.#trigger(run, run.snapshot!, events),
      concurrency: "coalesce",
    });
    run = await this.#checkpointRun(run, { receipt, stage: "complete" });
    await this.#completeRun(run, "delivered");
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
    const limited = await this.#reserveModelLimits(budgetRun, this.#definition(
      budgetRun.monitorId,
      budgetRun.definitionVersion,
    ).definition, estimatedInputTokens);
    if (!limited.allowed) {
      throw new Error(
        `live replay denied by ${limited.scope} ${limited.cause} until ${limited.retryAt}`,
      );
    }
    return (await this.#invokeModelDecisionWithUsage(definition, context, input)).decision;
  }

  async #invokeModelDecisionWithUsage(
    definition: Exclude<MonitorDefinition<ChannelEvent>["decision"], Function>,
    _context: unknown,
    input: JsonValue,
  ): Promise<{
    readonly decision: MonitorDecision;
    readonly source: "model" | "fallback";
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCost?: number };
    readonly error?: string;
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
      try {
        const result = await this.#modelInvoker({
          model: definition.model,
          reasoning: definition.reasoning,
          instructions: definition.instructions,
          input,
          timeoutMs: durationMs(definition.timeout),
          maxOutputTokens: definition.maxOutputTokens,
          repairAttempt,
          ...(prior === undefined ? {} : { previousInvalidOutput: prior }),
        });
        validateModelUsage(result.usage);
        usage = {
          inputTokens: usage.inputTokens + result.usage.inputTokens,
          outputTokens: usage.outputTokens + result.usage.outputTokens,
          ...((usage.estimatedCost ?? 0) + (result.usage.estimatedCost ?? 0) === 0
            ? {}
            : { estimatedCost: (usage.estimatedCost ?? 0) + (result.usage.estimatedCost ?? 0) }),
        };
        try {
          const parsed = await this.#parseModelOutput(definition, result.output);
          return { decision: parsed, source: "model", usage };
        } catch (error) {
          lastError = error;
          prior = result.output;
        }
      } catch (error) {
        lastError = error;
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
  ): Promise<LimitResult> {
    const calls = definition.limits?.perMonitor?.maxModelCallsPerMinute;
    if (calls !== undefined || this.#hasBudget("model-calls", run.tenantId)) {
      const result = await this.#reserveBudget({
        id: `model-call:${run.id}`,
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
        id: `model-input:${run.id}`,
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
  ): Promise<void> {
    const definition = this.#definition(run.monitorId, run.definitionVersion).definition;
    await this.#emit("monitor.wake.suppressed", {
      ...this.#runDetails(run),
      attributes: { cause, scope },
    });
    if (this.#overflow(definition) === "buffer") {
      await this.#retryRun(run, retryAt, cause);
    } else {
      await this.#completeRun(run, "suppressed", { cause, scope });
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
  ): Promise<void> {
    const monitor = this.#definition(run.monitorId, run.definitionVersion);
    const now = this.#now();
    await this.#store.transaction(`instance:${run.instanceId}`, async (tx) => {
      const currentRun = await tx.getRun(run.id);
      const instance = await tx.getInstance(run.instanceId);
      if (currentRun === null || instance === null || instance.activeRunId !== run.id) return;
      const decisionValue = currentRun.decision;
      let nextInstance: StoredMonitorInstance = {
        ...instance,
        activeRunId: undefined,
        lastDecision:
          decisionValue === undefined
            ? instance.lastDecision
            : {
                action: decisionValue.action,
                ...(decisionValue.confidence === undefined ? {} : { confidence: decisionValue.confidence }),
                reasonClass: reasonClass(decisionValue.reason),
                decidedAt: now,
              },
        consecutiveIgnores:
          decisionValue?.action === "ignore" ? instance.consecutiveIgnores + 1 : instance.consecutiveIgnores,
        ...(currentRun.receipt === undefined ? {} : { binding: currentRun.receipt.binding }),
        expiresAt: addMs(
          now,
          durationMs((monitor.definition.retention ?? DEFAULT_RETENTION).decisions),
        ),
        updatedAt: now,
      };
      if (decisionValue?.action === "wake" && (status === "delivered" || status === "shadowed")) {
        nextInstance = {
          ...nextInstance,
          lastWakeAt: now,
          eventsSinceLastWake: 0,
          consecutiveIgnores: 0,
          ...(monitor.definition.cooldown === undefined
            ? { cooldownUntil: undefined }
            : { cooldownUntil: addMs(now, durationMs(monitor.definition.cooldown.afterWake)) }),
        };
      }
      if (
        (monitor.definition.buffer ?? { mode: "immediate" }).mode === "immediate" &&
        nextInstance.cooldownUntil !== undefined &&
        nextInstance.sealedBatches.length > 0
      ) {
        nextInstance = consolidateImmediateCooldown(nextInstance, now);
      }
      nextInstance = {
        ...nextInstance,
        nextEvaluationAt: nextEvaluationAt(nextInstance, monitor.definition, now),
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

  async #failRun(run: StoredMonitorRun, error: unknown): Promise<void> {
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
      const instance = await tx.getInstance(run.instanceId);
      if (current === null || instance === null) return;
      await this.#deadLetterRunInTransaction(
        tx,
        current,
        instance,
        bindingConflict ? "binding" : current.stage,
        errorMessage(error),
      );
    });
    await this.#emit(bindingConflict ? "monitor.binding.conflict" : "monitor.evaluation.failed", {
      ...this.#runDetails(run),
      attributes: { error: errorMessage(error).slice(0, 500) },
    });
  }

  async #deadLetterRunInTransaction(
    tx: MonitorStoreTransaction,
    run: StoredMonitorRun,
    instance: StoredMonitorInstance,
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
    const nextInstance: StoredMonitorInstance = {
      ...instance,
      activeRunId: undefined,
      nextEvaluationAt: nextEvaluationAt(
        { ...instance, activeRunId: undefined },
        this.#definition(run.monitorId, run.definitionVersion).definition,
        now,
      ),
      updatedAt: now,
    };
    await tx.putInstance(nextInstance);
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

  async #deadLetter(input: { readonly eventRef?: string; readonly stage: string; readonly reason: string }) {
    const reason = boundedReason(input.reason);
    const event = input.eventRef === undefined ? null : await this.#store.getEvent(input.eventRef);
    await this.#store.transaction(`dead-letter:${input.eventRef ?? this.#id("event")}`, async (tx) => {
      await tx.putDeadLetter({
        id: this.#id("dlq"),
        tenantId: event?.tenantId ?? "unknown",
        applicationId: this.#applicationId,
        ...(input.eventRef === undefined ? {} : { eventRef: input.eventRef }),
        stage: input.stage,
        reason,
        createdAt: this.#now(),
      });
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

function appendEvent(
  instance: StoredMonitorInstance,
  event: BufferedEventRef,
  buffer: NonNullable<MonitorDefinition<ChannelEvent>["buffer"]>,
  now: string,
): { readonly instance: StoredMonitorInstance; readonly flushed: boolean } {
  if (buffer.mode === "immediate") {
    if (instance.cooldownUntil !== undefined && instance.cooldownUntil > now) {
      const open = instance.openBatch;
      return {
        instance: {
          ...instance,
          openBatch:
            open === undefined
              ? { events: [event], bytes: event.bytes, openedAt: now, updatedAt: now }
              : {
                  ...open,
                  events: [...open.events, event],
                  bytes: open.bytes + event.bytes,
                  updatedAt: now,
                },
          eventsSinceLastWake: instance.eventsSinceLastWake + 1,
        },
        flushed: false,
      };
    }
    const batch: StoredMonitorBatch = {
      events: [event],
      bytes: event.bytes,
      openedAt: now,
      closedAt: now,
      closedBy: "immediate",
    };
    return {
      instance: {
        ...instance,
        sealedBatches: [...instance.sealedBatches, batch],
        eventsSinceLastWake: instance.eventsSinceLastWake + 1,
      },
      flushed: true,
    };
  }
  let open = instance.openBatch;
  let sealed = [...instance.sealedBatches];
  let flushed = false;
  if (
    open !== undefined &&
    (open.events.length + 1 > buffer.maxEvents || open.bytes + event.bytes > buffer.maxBytes)
  ) {
    const closedBy: MonitorBatchClosedBy =
      open.events.length + 1 > buffer.maxEvents ? "max-events" : "max-bytes";
    sealed.push(closeBatch(open, now, closedBy));
    open = undefined;
    flushed = true;
  }
  if (open === undefined) {
    open = { events: [event], bytes: event.bytes, openedAt: now, updatedAt: now };
  } else {
    open = {
      ...open,
      events: [...open.events, event],
      bytes: open.bytes + event.bytes,
      updatedAt: now,
    };
  }
  return {
    instance: {
      ...instance,
      openBatch: open,
      sealedBatches: sealed,
      eventsSinceLastWake: instance.eventsSinceLastWake + 1,
    },
    flushed,
  };
}

function consolidateImmediateCooldown(
  instance: StoredMonitorInstance,
  now: string,
): StoredMonitorInstance {
  const events = [
    ...instance.sealedBatches.flatMap((batch) => batch.events),
    ...(instance.openBatch?.events ?? []),
  ];
  if (events.length === 0) return instance;
  const openedAt = [
    ...instance.sealedBatches.map((batch) => batch.openedAt),
    ...(instance.openBatch === undefined ? [] : [instance.openBatch.openedAt]),
  ].sort()[0]!;
  return {
    ...instance,
    sealedBatches: [],
    openBatch: {
      events,
      bytes: events.reduce((sum, event) => sum + event.bytes, 0),
      openedAt,
      updatedAt: now,
    },
  };
}

function nextEvaluationAt(
  instance: StoredMonitorInstance,
  definition: MonitorDefinition<ChannelEvent>,
  now: string,
): string | undefined {
  if (instance.activeRunId !== undefined) return undefined;
  const hasEvents = instance.sealedBatches.length > 0 || instance.openBatch !== undefined;
  if (!hasEvents) return undefined;
  if (instance.cooldownUntil !== undefined && instance.cooldownUntil > now) return instance.cooldownUntil;
  const retry = instance.sealedBatches[0]?.retryAt;
  if (instance.sealedBatches.length > 0) return retry ?? now;
  const open = instance.openBatch!;
  const buffer = definition.buffer ?? { mode: "immediate" as const };
  if (buffer.mode === "immediate") return now;
  return minTimestamp(
    addMs(open.updatedAt, durationMs(buffer.quietPeriod)),
    addMs(open.openedAt, durationMs(buffer.maxWait)),
  );
}

function takeDueBatch(
  instance: StoredMonitorInstance,
  definition: MonitorDefinition<ChannelEvent>,
  now: string,
): { readonly instance: StoredMonitorInstance; readonly batch: StoredMonitorBatch } | null {
  if (instance.cooldownUntil !== undefined && instance.cooldownUntil > now) return null;
  const first = instance.sealedBatches[0];
  if (first !== undefined && (first.retryAt === undefined || first.retryAt <= now)) {
    return { instance: { ...instance, sealedBatches: instance.sealedBatches.slice(1) }, batch: first };
  }
  const open = instance.openBatch;
  if (open === undefined) return null;
  const buffer = definition.buffer ?? { mode: "immediate" as const };
  let closedBy: MonitorBatchClosedBy;
  if (instance.cooldownUntil !== undefined && instance.cooldownUntil <= now) {
    closedBy = "cooldown-expired";
  } else if (buffer.mode === "immediate") {
    closedBy = "immediate";
  } else {
    const quiet = addMs(open.updatedAt, durationMs(buffer.quietPeriod));
    const maximum = addMs(open.openedAt, durationMs(buffer.maxWait));
    if (quiet > now && maximum > now) return null;
    closedBy = maximum <= quiet ? "max-wait" : "quiet-period";
  }
  return { instance: { ...instance, openBatch: undefined }, batch: closeBatch(open, now, closedBy) };
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
  return freeze({
    correlationKeyHash: instance.correlationKeyHash,
    ...(instance.lastDecision === undefined ? {} : { lastDecision: structuredClone(instance.lastDecision) }),
    ...(instance.lastWakeAt === undefined ? {} : { lastWakeAt: instance.lastWakeAt }),
    ...(instance.cooldownUntil === undefined ? {} : { cooldownUntil: instance.cooldownUntil }),
    consecutiveIgnores: instance.consecutiveIgnores,
    eventsSinceLastWake: instance.eventsSinceLastWake,
    ...(instance.binding === undefined ? {} : { binding: structuredClone(instance.binding) }),
  });
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
