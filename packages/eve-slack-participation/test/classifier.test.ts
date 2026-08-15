import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  classifierErrorCode,
  classifyParticipation,
  ParticipationClassifierError,
} from "../extension/lib/classifier.js";
import type { ClassifierSlackParticipationConfig } from "../extension/lib/types.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 8, text: 8, reasoning: 0 },
};

function model(output: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "participation-test",
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    },
  });
}

function config(
  languageModel: MockLanguageModelV4,
  groupRequests: "respond" | "silent" = "silent",
): ClassifierSlackParticipationConfig {
  return {
    strategy: "classifier",
    model: languageModel,
    mode: "enforce",
    recentMessages: 12,
    maxContextCharacters: 12_000,
    timeoutMs: 2_000,
    groupRequests,
  };
}

describe("participation classifier", () => {
  it("uses structured output without tools or retries", async () => {
    const languageModel = model({
      decision: "RESPOND",
      addressee: "EVE",
      reason: "FOLLOW_UP_TO_EVE",
    });
    const result = await classifyParticipation({
      config: config(languageModel),
      context: { prompt: "bounded transcript", messageCount: 2, characterCount: 18 },
    });

    expect(result).toMatchObject({
      decision: "RESPOND",
      addressee: "EVE",
      reason: "FOLLOW_UP_TO_EVE",
      modelId: "participation-test",
    });
    expect(languageModel.doGenerateCalls).toHaveLength(1);
    expect(languageModel.doGenerateCalls[0]?.temperature).toBe(0);
    expect(languageModel.doGenerateCalls[0]?.tools).toBeUndefined();
    expect(languageModel.doGenerateCalls[0]?.maxOutputTokens).toBe(96);
    expect(languageModel.doGenerateCalls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("enforces the configured group-request policy", async () => {
    const languageModel = model({
      decision: "SILENT",
      addressee: "GROUP",
      reason: "GROUP_REQUEST",
    });

    await expect(
      classifyParticipation({
        config: config(languageModel, "respond"),
        context: { prompt: "bounded transcript", messageCount: 2, characterCount: 18 },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ParticipationClassifierError>>({
        code: "classifier_inconsistent_output",
      }),
    );
  });

  it("rejects a reason/addressee contradiction", async () => {
    const languageModel = model({
      decision: "RESPOND",
      addressee: "HUMAN",
      reason: "FOLLOW_UP_TO_EVE",
    });

    await expect(
      classifyParticipation({
        config: config(languageModel),
        context: { prompt: "bounded transcript", messageCount: 2, characterCount: 18 },
      }),
    ).rejects.toMatchObject({ code: "classifier_inconsistent_output" });
  });

  it("rejects free-form or out-of-schema output", async () => {
    const languageModel = model({
      decision: "RESPOND",
      addressee: "EVE",
      reason: "FOLLOW_UP_TO_EVE",
      confidence: 0.9,
    });

    await expect(
      classifyParticipation({
        config: config(languageModel),
        context: { prompt: "bounded transcript", messageCount: 2, characterCount: 18 },
      }),
    ).rejects.toThrow();
  });

  it("recognizes a provider-wrapped timeout without retaining its message", () => {
    const timeout = new Error("sensitive provider details");
    timeout.name = "TimeoutError";
    expect(classifierErrorCode(new Error("wrapper", { cause: timeout }))).toBe(
      "classifier_timeout",
    );
  });

  it("does not retry provider failures", async () => {
    const languageModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("provider failed");
      },
    });

    await expect(
      classifyParticipation({
        config: config(languageModel),
        context: { prompt: "bounded transcript", messageCount: 2, characterCount: 18 },
      }),
    ).rejects.toThrow("provider failed");
    expect(languageModel.doGenerateCalls).toHaveLength(1);
  });
});
