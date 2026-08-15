import {
  defaultSlackAuth,
  type SlackInboundMessageContext,
  type SlackInboundResult,
  type SlackMessage,
} from "eve/channels/slack";

import { getSlackParticipationConfig } from "../extension.js";
import {
  classifierErrorCode,
  classifyParticipation,
  participationModelId,
} from "./classifier.js";
import { buildClassifierContext } from "./context.js";
import { evaluateRoutingPolicy, type RoutingPolicyResult } from "./policy.js";
import { emitParticipationDecision } from "./telemetry.js";
import type {
  ParticipationClassifier,
  SlackParticipationAuth,
  SlackParticipationAuthResolver,
  SlackParticipationConfig,
  SlackParticipationDecisionRecord,
  SlackParticipationHandlerOptions,
} from "./types.js";

interface HandlerDependencies {
  readonly getConfig: () => SlackParticipationConfig;
  readonly classify: ParticipationClassifier;
}

const defaultDependencies: HandlerDependencies = {
  getConfig: getSlackParticipationConfig,
  classify: classifyParticipation,
};

function isDirectMessage(message: SlackMessage): boolean {
  return message.raw.channel_type === "im";
}

function participantIds(
  snapshot: readonly string[],
  latestHumanId: string,
): readonly string[] {
  if (snapshot.length === 0 || snapshot.includes(latestHumanId)) return snapshot;
  return [...snapshot, latestHumanId];
}

function baseRecord(
  message: SlackMessage,
  config: SlackParticipationConfig,
  route: RoutingPolicyResult,
): SlackParticipationDecisionRecord {
  return {
    ...(message.teamId ? { teamId: message.teamId } : {}),
    channelId: message.channelId,
    threadTs: message.threadTs,
    messageTs: message.ts,
    mode: route.mode,
    ...(route.distinctHumans !== undefined
      ? { distinctHumans: route.distinctHumans }
      : {}),
    decision: route.decision ?? "SILENT",
    source: route.source,
    shadow: config.mode === "shadow",
  };
}

async function subscriptionState(
  ctx: SlackInboundMessageContext,
): Promise<{ readonly subscribed?: boolean; readonly errorCode?: string }> {
  try {
    return { subscribed: await ctx.isSubscribed() };
  } catch {
    return { errorCode: "subscription_check_failed" };
  }
}

async function cancelActiveTurn(ctx: SlackInboundMessageContext): Promise<string | undefined> {
  try {
    await ctx.cancel();
    return undefined;
  } catch {
    return "cancel_failed";
  }
}

async function resolveDispatch(
  input: {
    readonly ctx: SlackInboundMessageContext;
    readonly message: SlackMessage;
    readonly subscribed: boolean | undefined;
    readonly auth: SlackParticipationAuthResolver;
    readonly config: SlackParticipationConfig;
    readonly record: SlackParticipationDecisionRecord;
  },
): Promise<SlackInboundResult> {
  let auth: SlackParticipationAuth;
  try {
    auth = await input.auth(input.message, input.ctx);
  } catch {
    await emitParticipationDecision(input.config.onDecision, {
      ...input.record,
      errorCode: "auth_resolver_failed",
    });
    return null;
  }
  const cancelError = input.subscribed
    ? await cancelActiveTurn(input.ctx)
    : undefined;
  await emitParticipationDecision(input.config.onDecision, {
    ...input.record,
    ...(cancelError ? { errorCode: cancelError } : {}),
  });
  return { auth };
}

export function createSlackParticipationHandlerWithDependencies(
  options: SlackParticipationHandlerOptions = {},
  dependencies: HandlerDependencies = defaultDependencies,
): (ctx: SlackInboundMessageContext, message: SlackMessage) => Promise<SlackInboundResult> {
  const auth = options.auth ?? defaultSlackAuth;

  return async (ctx, message) => {
    if (!message.author || message.author.isBot || message.author.isMe) return null;

    const config = dependencies.getConfig();
    const directMessage = isDirectMessage(message);
    const explicitlyMentioned = ctx.isBotMentioned();

    if (directMessage || explicitlyMentioned) {
      const subscription = await subscriptionState(ctx);
      const route = evaluateRoutingPolicy({
        directMessage,
        explicitlyMentioned,
        ...(subscription.subscribed !== undefined
          ? { subscribed: subscription.subscribed }
          : {}),
        recentMessageCount: ctx.thread.recentMessages.length,
      });
      const record = {
        ...baseRecord(message, config, route),
        ...(subscription.errorCode ? { errorCode: subscription.errorCode } : {}),
      };
      return resolveDispatch({
        ctx,
        message,
        subscribed: subscription.subscribed,
        auth,
        config,
        record,
      });
    }

    const subscription = await subscriptionState(ctx);
    if (subscription.subscribed !== true) {
      const route = subscription.subscribed === false
        ? evaluateRoutingPolicy({
            directMessage: false,
            explicitlyMentioned: false,
            subscribed: false,
            recentMessageCount: ctx.thread.recentMessages.length,
          })
        : {
            action: "drop" as const,
            decision: "SILENT" as const,
            source: "failure_fallback" as const,
            mode: "unknown" as const,
          };
      await emitParticipationDecision(config.onDecision, {
        ...baseRecord(message, config, route),
        ...(subscription.errorCode ? { errorCode: subscription.errorCode } : {}),
      });
      return null;
    }

    let snapshot: readonly string[];
    try {
      snapshot = await ctx.thread.listParticipants();
    } catch {
      const route: RoutingPolicyResult = {
        action: "drop",
        decision: "SILENT",
        source: "failure_fallback",
        mode: "unknown",
      };
      const record = {
        ...baseRecord(message, config, route),
        errorCode: "participant_snapshot_failed",
      };
      if (config.mode === "shadow") {
        return resolveDispatch({
          ctx,
          message,
          subscribed: true,
          auth,
          config,
          record,
        });
      }
      await emitParticipationDecision(config.onDecision, record);
      return null;
    }

    const participants = participantIds(snapshot, message.author.userId);
    const route = evaluateRoutingPolicy({
      directMessage: false,
      explicitlyMentioned: false,
      subscribed: true,
      participantIds: participants,
      recentMessageCount: ctx.thread.recentMessages.length,
    });

    let record = baseRecord(message, config, route);
    if (route.action === "classify") {
      const context = buildClassifierContext({
        message,
        recentMessages: ctx.thread.recentMessages,
        participantIds: participants,
        maxMessages: config.recentMessages,
        maxCharacters: config.maxContextCharacters,
        groupRequests: config.groupRequests,
      });
      const startedAt = performance.now();
      try {
        const classified = await dependencies.classify({ config, context });
        record = {
          ...record,
          decision: classified.decision,
          reason: classified.reason,
          addressee: classified.addressee,
          modelId: classified.modelId,
          latencyMs: classified.latencyMs,
          contextMessages: context.messageCount,
          contextCharacters: context.characterCount,
        };
      } catch (error) {
        record = {
          ...record,
          decision: "SILENT",
          source: "failure_fallback",
          modelId: participationModelId(config.model),
          latencyMs: Math.round(performance.now() - startedAt),
          contextMessages: context.messageCount,
          contextCharacters: context.characterCount,
          errorCode: classifierErrorCode(error),
        };
      }
    }

    const shouldDispatch = record.decision === "RESPOND" || config.mode === "shadow";
    if (shouldDispatch) {
      return resolveDispatch({
        ctx,
        message,
        subscribed: true,
        auth,
        config,
        record,
      });
    }

    await emitParticipationDecision(config.onDecision, record);
    return null;
  };
}

export function createSlackParticipationHandler(
  options: SlackParticipationHandlerOptions = {},
): (ctx: SlackInboundMessageContext, message: SlackMessage) => Promise<SlackInboundResult> {
  return createSlackParticipationHandlerWithDependencies(options);
}
