import type { LanguageModel } from "ai";
import { defineExtension } from "eve/extension";
import { z } from "zod";

import type {
  SlackParticipationConfig,
  SlackParticipationDecisionCallback,
} from "./lib/types.js";

function isLanguageModel(value: unknown): value is LanguageModel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.provider === "string" && candidate.provider.trim().length > 0 &&
    typeof candidate.modelId === "string" && candidate.modelId.trim().length > 0 &&
    typeof candidate.doGenerate === "function" &&
    typeof candidate.doStream === "function"
  );
}

const model = z.union([
  z.string().trim().min(1),
  z.custom<LanguageModel>(isLanguageModel, {
    message: "model must be an AI SDK LanguageModel or a non-empty gateway model id.",
  }),
]);

const onDecision = z.custom<SlackParticipationDecisionCallback>(
  (value) => typeof value === "function",
  { message: "onDecision must be a function." },
);

export const slackParticipationConfigSchema = z.object({
  model,
  mode: z.enum(["shadow", "enforce"]).default("shadow"),
  recentMessages: z.number().int().min(2).max(50).default(12),
  maxContextCharacters: z.number().int().min(1_000).max(100_000).default(12_000),
  timeoutMs: z.number().int().min(100).max(30_000).default(2_000),
  groupRequests: z.enum(["respond", "silent"]).default("silent"),
  onDecision: onDecision.optional(),
});

export type ConfiguredSlackParticipation = z.output<typeof slackParticipationConfigSchema>;

// Distribution entry points can be evaluated in separate authored-module
// graphs. Pin the namespace so every handle resolves through Eve's shared,
// scoped configuration registry.
const extension = defineExtension(
  { config: slackParticipationConfigSchema },
  "eve-slack-participation",
);

export function getSlackParticipationConfig(): SlackParticipationConfig {
  return extension.config;
}

export default extension;
