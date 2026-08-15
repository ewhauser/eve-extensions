import type { LanguageModel } from "ai";
import type {
  SlackInboundMessageContext,
  SlackInboundResult,
  SlackMessage,
} from "eve/channels/slack";

export type SlackParticipationMode = "shadow" | "enforce";
export type SlackParticipationStrategy = "classifier" | "deterministic";
export type GroupRequestPolicy = "respond" | "silent";
export type ThreadParticipationMode = "dyadic" | "multi_party" | "unknown";

export type SlackParticipationDecisionValue = "RESPOND" | "SILENT";
export type SlackParticipationAddressee = "EVE" | "HUMAN" | "GROUP" | "AMBIGUOUS";
export type SlackParticipationReason =
  | "QUESTION_OR_REQUEST_FOR_EVE"
  | "FOLLOW_UP_TO_EVE"
  | "ANSWER_TO_EVE"
  | "GROUP_REQUEST"
  | "HUMAN_TO_HUMAN"
  | "ACKNOWLEDGEMENT_OR_AGREEMENT"
  | "SOCIAL_CHATTER"
  | "CONVERSATION_COMPLETE"
  | "AMBIGUOUS";

export type SlackParticipationSource =
  | "direct_message"
  | "explicit_mention"
  | "explicit_non_eve_addressee"
  | "not_subscribed"
  | "dyadic_rule"
  | "deterministic_multi_party"
  | "classifier"
  | "failure_fallback"
  | "snapshot_limit";

export interface SlackParticipationDecision {
  readonly decision: SlackParticipationDecisionValue;
  readonly addressee: SlackParticipationAddressee;
  readonly reason: SlackParticipationReason;
}

export interface SlackParticipationDecisionRecord {
  readonly teamId?: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly strategy: SlackParticipationStrategy;
  readonly mode: ThreadParticipationMode;
  readonly distinctHumans?: number;
  readonly decision: SlackParticipationDecisionValue;
  readonly source: SlackParticipationSource;
  readonly reason?: SlackParticipationReason;
  readonly addressee?: SlackParticipationAddressee;
  readonly modelId?: string;
  readonly latencyMs?: number;
  readonly contextMessages?: number;
  readonly contextCharacters?: number;
  readonly errorCode?: string;
  readonly shadow: boolean;
}

export type SlackParticipationDecisionCallback = (
  record: SlackParticipationDecisionRecord,
) => void | Promise<void>;

interface SlackParticipationConfigBase {
  readonly mode: SlackParticipationMode;
  readonly recentMessages: number;
  readonly maxContextCharacters: number;
  readonly timeoutMs: number;
  readonly groupRequests: GroupRequestPolicy;
  readonly onDecision?: SlackParticipationDecisionCallback | undefined;
}

export interface ClassifierSlackParticipationConfig extends SlackParticipationConfigBase {
  readonly strategy: "classifier";
  readonly model: string | LanguageModel;
}

export interface DeterministicSlackParticipationConfig extends SlackParticipationConfigBase {
  readonly strategy: "deterministic";
  readonly model?: string | LanguageModel | undefined;
}

export type SlackParticipationConfig =
  | ClassifierSlackParticipationConfig
  | DeterministicSlackParticipationConfig;

export type SlackParticipationAuth = NonNullable<SlackInboundResult>["auth"];

export type SlackParticipationAuthResolver = (
  message: SlackMessage,
  ctx: SlackInboundMessageContext,
) => SlackParticipationAuth | Promise<SlackParticipationAuth>;

export interface SlackParticipationHandlerOptions {
  readonly auth?: SlackParticipationAuthResolver;
}

export interface ClassifierContext {
  readonly prompt: string;
  readonly messageCount: number;
  readonly characterCount: number;
}

export interface ClassifierResult extends SlackParticipationDecision {
  readonly modelId: string;
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly uncachedInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
}

export type ParticipationClassifier = (input: {
  readonly config: ClassifierSlackParticipationConfig;
  readonly context: ClassifierContext;
}) => Promise<ClassifierResult>;
