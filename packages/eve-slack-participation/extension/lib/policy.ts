import type {
  SlackParticipationDecisionValue,
  SlackParticipationSource,
  SlackParticipationStrategy,
  ThreadParticipationMode,
} from "./types.js";

export interface RoutingPolicyInput {
  readonly directMessage: boolean;
  readonly explicitlyMentioned: boolean;
  readonly explicitlyAddressedNonEve?: boolean;
  readonly strategy?: SlackParticipationStrategy;
  readonly subscribed?: boolean;
  readonly participantIds?: readonly string[];
  readonly recentMessageCount: number;
}

export interface RoutingPolicyResult {
  readonly action: "dispatch" | "drop" | "classify";
  readonly decision?: SlackParticipationDecisionValue;
  readonly source: SlackParticipationSource;
  readonly mode: ThreadParticipationMode;
  readonly distinctHumans?: number;
}

export function evaluateRoutingPolicy(input: RoutingPolicyInput): RoutingPolicyResult {
  if (input.directMessage) {
    return {
      action: "dispatch",
      decision: "RESPOND",
      source: "direct_message",
      mode: "unknown",
    };
  }

  if (input.explicitlyMentioned) {
    return {
      action: "dispatch",
      decision: "RESPOND",
      source: "explicit_mention",
      mode: "unknown",
    };
  }

  if (input.subscribed === false) {
    return {
      action: "drop",
      decision: "SILENT",
      source: "not_subscribed",
      mode: "unknown",
    };
  }

  if (input.explicitlyAddressedNonEve) {
    return {
      action: "drop",
      decision: "SILENT",
      source: "explicit_non_eve_addressee",
      mode: "unknown",
    };
  }

  const participants = input.participantIds;
  if (participants === undefined || participants.length === 0) {
    return {
      action: "drop",
      decision: "SILENT",
      source: "failure_fallback",
      mode: "unknown",
    };
  }

  if (input.recentMessageCount >= 50 && participants.length < 2) {
    return {
      action: "drop",
      decision: "SILENT",
      source: "snapshot_limit",
      mode: "unknown",
      distinctHumans: participants.length,
    };
  }

  if (participants.length === 1) {
    return {
      action: "dispatch",
      decision: "RESPOND",
      source: "dyadic_rule",
      mode: "dyadic",
      distinctHumans: 1,
    };
  }

  if (input.strategy === "deterministic") {
    return {
      action: "drop",
      decision: "SILENT",
      source: "deterministic_multi_party",
      mode: "multi_party",
      distinctHumans: participants.length,
    };
  }

  return {
    action: "classify",
    source: "classifier",
    mode: "multi_party",
    distinctHumans: participants.length,
  };
}
