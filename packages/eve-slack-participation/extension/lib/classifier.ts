import { gateway, generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

import type {
  ClassifierResult,
  GroupRequestPolicy,
  ParticipationClassifier,
  SlackParticipationDecisionValue,
  SlackParticipationAddressee,
  SlackParticipationReason,
} from "./types.js";

export const participationDecisionSchema = z
  .object({
    decision: z.enum(["RESPOND", "SILENT"]),
    addressee: z.enum(["EVE", "HUMAN", "GROUP", "AMBIGUOUS"]),
    reason: z.enum([
      "QUESTION_OR_REQUEST_FOR_EVE",
      "FOLLOW_UP_TO_EVE",
      "ANSWER_TO_EVE",
      "GROUP_REQUEST",
      "HUMAN_TO_HUMAN",
      "ACKNOWLEDGEMENT_OR_AGREEMENT",
      "SOCIAL_CHATTER",
      "CONVERSATION_COMPLETE",
      "AMBIGUOUS",
    ]),
  })
  .strict();

const classifierSystemPrompt = `You are Eve's Slack participation gate.
Classify only whether Eve should respond to the latest message in the supplied transcript.
Use speaker labels and conversational structure, not names or guessed identity.
Respond to questions or requests addressed to Eve, follow-ups to Eve, and answers to Eve.
Stay silent for human-to-human messages, acknowledgements, social chatter, completed conversations, and ambiguity.
For GROUP_REQUEST, obey GROUP_REQUEST_POLICY from the input.
Return only the requested structured fields. Never include confidence, free-form rationale, or hidden reasoning.`;

export class ParticipationClassifierError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ParticipationClassifierError";
  }
}

export function participationModelId(model: string | LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

function expectedDecision(
  reason: SlackParticipationReason,
  groupRequests: GroupRequestPolicy,
): SlackParticipationDecisionValue {
  switch (reason) {
    case "QUESTION_OR_REQUEST_FOR_EVE":
    case "FOLLOW_UP_TO_EVE":
    case "ANSWER_TO_EVE":
      return "RESPOND";
    case "GROUP_REQUEST":
      return groupRequests === "respond" ? "RESPOND" : "SILENT";
    default:
      return "SILENT";
  }
}

function expectedAddressee(
  reason: SlackParticipationReason,
): SlackParticipationAddressee | undefined {
  switch (reason) {
    case "QUESTION_OR_REQUEST_FOR_EVE":
    case "FOLLOW_UP_TO_EVE":
    case "ANSWER_TO_EVE":
      return "EVE";
    case "GROUP_REQUEST":
      return "GROUP";
    case "HUMAN_TO_HUMAN":
      return "HUMAN";
    case "AMBIGUOUS":
      return "AMBIGUOUS";
    default:
      return undefined;
  }
}

export const classifyParticipation: ParticipationClassifier = async ({ config, context }) => {
  const model = typeof config.model === "string" ? gateway(config.model) : config.model;
  const startedAt = performance.now();
  const result = await generateText({
    model,
    system: classifierSystemPrompt,
    prompt: context.prompt,
    output: Output.object({ schema: participationDecisionSchema }),
    temperature: 0,
    maxOutputTokens: 96,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(config.timeoutMs),
  });
  const output = participationDecisionSchema.parse(result.output);
  const expected = expectedDecision(output.reason, config.groupRequests);
  const addressee = expectedAddressee(output.reason);
  if (output.decision !== expected || (addressee && output.addressee !== addressee)) {
    throw new ParticipationClassifierError("classifier_inconsistent_output");
  }

  return {
    ...output,
    modelId: participationModelId(config.model),
    latencyMs: Math.round(performance.now() - startedAt),
  } satisfies ClassifierResult;
};

export function classifierErrorCode(error: unknown): string {
  if (error instanceof ParticipationClassifierError) return error.code;
  if (error instanceof z.ZodError) return "classifier_invalid_output";
  if (isTimeoutError(error)) {
    return "classifier_timeout";
  }
  return "classifier_error";
}

function isTimeoutError(error: unknown, depth = 0): boolean {
  if (depth > 3 || typeof error !== "object" || error === null) return false;
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return true;
  }
  return isTimeoutError((error as { readonly cause?: unknown }).cause, depth + 1);
}
