import type {
  ChannelEvent,
  ChannelEventDefinition,
  ChannelEventDefinitions,
  ChannelEventSource,
  CompiledMonitor,
  DeclaredInboundChannel,
  JsonValue,
  ModelDecisionDefinition,
  ModelDecisionOptions,
  MonitorDecision,
  MonitorDefinition,
  MonitorLoopPrevention,
  MonitorRetention,
  StandardSchema,
} from "./types.js";
import {
  assertIdentifier,
  assertBoundedText,
  assertJsonValue,
  assertNonNegativeSafeInteger,
  assertNonEmpty,
  assertPositiveSafeInteger,
  durationMs,
} from "./util.js";

export const DEFAULT_EVENT_MAX_BYTES = 256_000;
export const DEFAULT_RETENTION: MonitorRetention = {
  payload: "24h",
  decisions: "30d",
  dedupe: "7d",
};
export const DEFAULT_LOOP_PREVENTION: MonitorLoopPrevention = {
  ignoreOwnAgentEvents: true,
  ignoreOwnMonitorEvents: true,
  maxInternalCausationDepth: 4,
};

export function defineChannelEvent<TData>(options: {
  readonly schema: StandardSchema<TData>;
  readonly version?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly chat?: boolean | undefined;
}): ChannelEventDefinition<TData> {
  const version = options.version ?? 1;
  const maxBytes = options.maxBytes ?? DEFAULT_EVENT_MAX_BYTES;
  assertPositiveSafeInteger(version, "channel event version");
  assertPositiveSafeInteger(maxBytes, "channel event maxBytes");
  assertStandardSchema(options.schema, "channel event schema");
  if (options.chat !== undefined && typeof options.chat !== "boolean") {
    throw new TypeError("channel event chat must be a boolean");
  }
  return Object.freeze({
    schema: options.schema,
    version,
    maxBytes,
    chat: options.chat ?? false,
  });
}

export function defineInboundChannel<
  const TInbound extends ChannelEventDefinitions,
  TReplyTarget extends JsonValue = JsonValue,
>(options: {
  readonly id: string;
  readonly inbound: TInbound;
  /** Optional runtime schema for the canonical reply target carried by events. */
  readonly replyTarget?: StandardSchema<TReplyTarget> | undefined;
}): DeclaredInboundChannel<TInbound, TReplyTarget> {
  assertIdentifier(options.id, "channel id");
  if (Object.keys(options.inbound).length === 0) {
    throw new TypeError("a channel must declare at least one inbound event");
  }
  for (const [type, definition] of Object.entries(options.inbound)) {
    assertIdentifier(type, `inbound event type ${JSON.stringify(type)}`);
    if (definition === undefined) throw new TypeError(`inbound event ${type} is undefined`);
    assertStandardSchema(definition.schema, `inbound event ${type} schema`);
    assertPositiveSafeInteger(definition.version, `inbound event ${type} version`);
    assertPositiveSafeInteger(definition.maxBytes, `inbound event ${type} maxBytes`);
    if (typeof definition.chat !== "boolean") {
      throw new TypeError(`inbound event ${type} chat must be a boolean`);
    }
  }
  if (options.replyTarget !== undefined) assertStandardSchema(options.replyTarget, "replyTarget schema");

  return Object.freeze({
    id: options.id,
    inbound: Object.freeze({ ...options.inbound }),
    ...(options.replyTarget === undefined ? {} : { replyTargetSchema: options.replyTarget }),
    event(type: string, sourceOptions?: { readonly phase?: "observed" | "undispatched" }) {
      const definition = options.inbound[type];
      if (definition === undefined) throw new TypeError(`channel ${options.id} has no ${type} event`);
      const phase = sourceOptions?.phase ?? (definition.chat ? "undispatched" : undefined);
      if (!definition.chat && phase !== undefined) {
        throw new TypeError(`non-chat event ${options.id}:${type} does not support phases`);
      }
      return Object.freeze({
        kind: "channel-event-source" as const,
        channelId: options.id,
        eventType: type,
        ...(phase === undefined ? {} : { phase }),
      });
    },
  }) as DeclaredInboundChannel<TInbound, TReplyTarget>;
}

export function ignore<TMetadata = undefined>(options: {
  readonly reason: string;
  readonly confidence?: number | undefined;
  readonly metadata?: TMetadata | undefined;
}): MonitorDecision<TMetadata, never> {
  return decision("ignore", options);
}

export function wake<TMetadata = undefined>(options: {
  readonly reason: string;
  readonly confidence?: number | undefined;
  readonly metadata?: TMetadata | undefined;
}): MonitorDecision<never, TMetadata> {
  return decision("wake", options);
}

function decision<TAction extends "ignore" | "wake", TMetadata>(
  action: TAction,
  options: {
    readonly reason: string;
    readonly confidence?: number | undefined;
    readonly metadata?: TMetadata | undefined;
  },
): Extract<MonitorDecision<TMetadata, TMetadata>, { action: TAction }> {
  assertNonEmpty(options.reason, `${action} reason`);
  if (options.reason.length > 2_000) throw new TypeError(`${action} reason must be at most 2,000 characters`);
  if (
    options.confidence !== undefined &&
    (!Number.isFinite(options.confidence) || options.confidence < 0 || options.confidence > 1)
  ) {
    throw new TypeError(`${action} confidence must be between 0 and 1`);
  }
  if (options.metadata !== undefined) assertJsonValue(options.metadata, `${action} metadata`);
  return Object.freeze({ action, ...options }) as Extract<
    MonitorDecision<TMetadata, TMetadata>,
    { action: TAction }
  >;
}

export function modelDecision<
  TEvent extends ChannelEvent,
  TIgnore = unknown,
  TWake = unknown,
>(
  options: ModelDecisionOptions<TEvent, TIgnore, TWake>,
): ModelDecisionDefinition<TEvent, TIgnore, TWake> {
  assertNonEmpty(options.model, "classifier model");
  assertBoundedText(options.model, "classifier model", 512);
  if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(options.reasoning)) {
    throw new TypeError("classifier reasoning setting is invalid");
  }
  assertNonEmpty(options.instructions, "classifier instructions");
  assertBoundedText(options.instructions, "classifier instructions", 65_536);
  durationMs(options.timeout, "classifier timeout");
  assertPositiveSafeInteger(options.maxInputTokens, "classifier maxInputTokens");
  assertPositiveSafeInteger(options.maxOutputTokens, "classifier maxOutputTokens");
  if (typeof options.input !== "function") throw new TypeError("classifier input must be a function");
  if (options.repairAttempts !== undefined && options.repairAttempts !== 0 && options.repairAttempts !== 1) {
    throw new TypeError("classifier repairAttempts must be 0 or 1");
  }
  if (options.metadata !== undefined) {
    assertStandardSchema(options.metadata.ignore, "classifier ignore metadata schema");
    assertStandardSchema(options.metadata.wake, "classifier wake metadata schema");
  }
  validateDecision(options.onError, "classifier onError");
  return Object.freeze({
    ...options,
    kind: "model-decision" as const,
    repairAttempts: options.repairAttempts ?? 1,
  });
}

export function defineMonitor<
  TEvent extends ChannelEvent,
  TIgnore = unknown,
  TWake = unknown,
>(
  definition: MonitorDefinition<TEvent, TIgnore, TWake>,
): MonitorDefinition<TEvent, TIgnore, TWake> {
  validateMonitorDefinition(definition);
  return Object.freeze(definition);
}

export function compileMonitor<TEvent extends ChannelEvent, TIgnore, TWake>(
  definition: MonitorDefinition<TEvent, TIgnore, TWake>,
  version: string,
  options: {
    readonly active?: boolean | undefined;
    readonly compatibleWith?: readonly string[] | undefined;
  } = {},
): CompiledMonitor {
  validateMonitorDefinition(definition);
  assertNonEmpty(version, "definition version");
  assertBoundedText(version, "definition version", 512);
  const seenCompatibleVersions = new Set<string>();
  for (const compatible of options.compatibleWith ?? []) {
    assertNonEmpty(compatible, "compatible definition version");
    assertBoundedText(compatible, "compatible definition version", 512);
    if (compatible === version) throw new TypeError("compatibleWith must not include the current version");
    if (seenCompatibleVersions.has(compatible)) {
      throw new TypeError(`compatibleWith contains duplicate version ${compatible}`);
    }
    seenCompatibleVersions.add(compatible);
  }
  return Object.freeze({
    definition,
    version,
    active: options.active ?? true,
    ...(options.compatibleWith === undefined
      ? {}
      : { compatibleWith: Object.freeze([...options.compatibleWith]) }),
  }) as unknown as CompiledMonitor;
}

export function validateMonitorDefinition<
  TEvent extends ChannelEvent,
  TIgnore,
  TWake,
>(
  definition: MonitorDefinition<TEvent, TIgnore, TWake>,
): void {
  assertIdentifier(definition.id, "monitor id");
  if (!["active", "shadow", "disabled"].includes(definition.mode ?? "active")) {
    throw new TypeError("monitor mode must be active, shadow, or disabled");
  }
  if (!Array.isArray(definition.sources) || definition.sources.length === 0) {
    throw new TypeError("monitor sources must not be empty");
  }
  if (definition.sources.length > 100) throw new TypeError("monitor sources must contain at most 100 entries");
  const sourceKeys = new Set<string>();
  for (const source of definition.sources) {
    if (source.kind !== "channel-event-source") {
      throw new TypeError("monitor sources must be declared channel event sources");
    }
    if (source.phase !== undefined && source.phase !== "observed" && source.phase !== "undispatched") {
      throw new TypeError("monitor source phase must be observed or undispatched");
    }
    const sourceKey = `${source.channelId}\0${source.eventType}\0${source.phase ?? "event"}`;
    if (sourceKeys.has(sourceKey)) throw new TypeError(`monitor contains duplicate source ${source.channelId}:${source.eventType}`);
    sourceKeys.add(sourceKey);
  }
  if (typeof definition.filter !== "undefined" && typeof definition.filter !== "function") {
    throw new TypeError("monitor filter must be a function");
  }
  if (typeof definition.correlate !== "undefined" && typeof definition.correlate !== "function") {
    throw new TypeError("monitor correlate must be a function");
  }
  if (typeof definition.task?.evidence !== "function") {
    throw new TypeError("monitor evidence projection must be a function");
  }
  if (typeof definition.route !== "function") throw new TypeError("monitor route must be a function");
  assertNonEmpty(definition.task.instructions, "task instructions");
  assertBoundedText(definition.task.instructions, "task instructions", 65_536);
  assertNonEmpty(definition.metadata.owner, "monitor metadata.owner");
  assertNonEmpty(definition.metadata.useCase, "monitor metadata.useCase");
  assertBoundedText(definition.metadata.owner, "monitor metadata.owner", 256);
  assertBoundedText(definition.metadata.useCase, "monitor metadata.useCase", 256);
  if (definition.buffer !== undefined && definition.buffer.mode !== "immediate" && definition.buffer.mode !== "debounce") {
    throw new TypeError("buffer mode must be immediate or debounce");
  }
  if (definition.buffer?.mode === "debounce") {
    const quiet = durationMs(definition.buffer.quietPeriod, "buffer quietPeriod");
    const maximum = durationMs(definition.buffer.maxWait, "buffer maxWait");
    if (quiet > maximum) throw new TypeError("buffer quietPeriod must not exceed maxWait");
    assertPositiveSafeInteger(definition.buffer.maxEvents, "buffer maxEvents");
    assertPositiveSafeInteger(definition.buffer.maxBytes, "buffer maxBytes");
  }
  if (
    (definition.buffer?.mode === "debounce" ||
      definition.cooldown !== undefined ||
      definition.session?.strategy === "correlation") &&
    definition.correlate === undefined
  ) {
    throw new TypeError(
      "correlate() is required for debounce, cooldown, and correlation session strategy",
    );
  }
  if (definition.cooldown !== undefined) {
    durationMs(definition.cooldown.afterWake, "cooldown afterWake");
    if (definition.cooldown.during !== "accumulate") {
      throw new TypeError('cooldown during must be "accumulate"');
    }
  }
  if (definition.session?.idleTimeout !== undefined) {
    durationMs(definition.session.idleTimeout, "session idleTimeout");
  }
  if (
    definition.session !== undefined &&
    definition.session.strategy !== "channel" &&
    definition.session.strategy !== "correlation"
  ) {
    throw new TypeError("session strategy must be channel or correlation");
  }
  validateLimits(definition);
  validateRetention(definition.retention ?? DEFAULT_RETENTION);
  validateLoopPrevention(definition.loopPrevention ?? DEFAULT_LOOP_PREVENTION);
  if (typeof definition.decision !== "function") {
    modelDecision(definition.decision);
  }
}

function validateLimits(
  definition: Pick<MonitorDefinition<ChannelEvent, unknown, unknown>, "limits">,
): void {
  const limits = definition.limits;
  if (limits === undefined) return;
  if (limits.overflow !== "buffer" && limits.overflow !== "drop") {
    throw new TypeError("limits overflow must be buffer or drop");
  }
  const entries = [
    ["limits.perMonitor.maxEventsPerMinute", limits.perMonitor?.maxEventsPerMinute],
    ["limits.perMonitor.maxModelCallsPerMinute", limits.perMonitor?.maxModelCallsPerMinute],
    ["limits.perMonitor.maxModelInputTokensPerHour", limits.perMonitor?.maxModelInputTokensPerHour],
    ["limits.perMonitor.maxWakesPerHour", limits.perMonitor?.maxWakesPerHour],
    ["limits.perKey.maxWakesPerHour", limits.perKey?.maxWakesPerHour],
  ] as const;
  for (const [name, value] of entries) {
    if (value !== undefined) assertPositiveSafeInteger(value, name);
  }
}

function validateRetention(retention: MonitorRetention): void {
  const payload = durationMs(retention.payload, "retention payload");
  durationMs(retention.decisions, "retention decisions");
  const dedupe = durationMs(retention.dedupe, "retention dedupe");
  if (dedupe < payload) throw new TypeError("retention dedupe must not be shorter than payload retention");
}

function validateLoopPrevention(loop: MonitorLoopPrevention): void {
  if (typeof loop.ignoreOwnAgentEvents !== "boolean" || typeof loop.ignoreOwnMonitorEvents !== "boolean") {
    throw new TypeError("loop prevention flags must be booleans");
  }
  assertNonNegativeSafeInteger(loop.maxInternalCausationDepth, "maxInternalCausationDepth");
}

export function validateDecision(decisionValue: MonitorDecision, name = "decision"): void {
  if (decisionValue.action !== "ignore" && decisionValue.action !== "wake") {
    throw new TypeError(`${name} action must be ignore or wake`);
  }
  decision(decisionValue.action, decisionValue);
}

export function sourceMatches(
  source: ChannelEventSource,
  input: { readonly channelId: string; readonly eventType: string; readonly phase?: string },
): boolean {
  return (
    source.channelId === input.channelId &&
    source.eventType === input.eventType &&
    (source.phase === undefined || source.phase === input.phase)
  );
}

function assertStandardSchema(schema: StandardSchema, name: string): void {
  if (
    schema?.["~standard"]?.version !== 1 ||
    typeof schema["~standard"].validate !== "function"
  ) {
    throw new TypeError(`${name} must implement Standard Schema v1`);
  }
}
