import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { slackParticipationConfigSchema } from "../extension/extension.js";

describe("slack participation config", () => {
  it("applies conservative rollout defaults", () => {
    const config = slackParticipationConfigSchema.parse({ model: "openai/gpt-5-mini" });

    expect(config).toMatchObject({
      strategy: "classifier",
      model: "openai/gpt-5-mini",
      mode: "shadow",
      recentMessages: 12,
      maxContextCharacters: 12_000,
      timeoutMs: 2_000,
      groupRequests: "silent",
    });
  });

  it("accepts deterministic-only routing without a model", () => {
    const config = slackParticipationConfigSchema.parse({ strategy: "deterministic" });

    expect(config).toMatchObject({
      strategy: "deterministic",
      mode: "shadow",
    });
    expect(config.model).toBeUndefined();
  });

  it("accepts a language model and callback", () => {
    const model = new MockLanguageModelV4();
    const onDecision = vi.fn();
    const config = slackParticipationConfigSchema.parse({ model, onDecision });

    expect(config.model).toBe(model);
    expect(config.onDecision).toBe(onDecision);
  });

  it.each([
    { model: "" },
    { model: {} },
    { strategy: "deterministic", model: {} },
    { strategy: "classifier" },
    { strategy: "unknown", model: "valid" },
    { model: "valid", recentMessages: 1 },
    { model: "valid", recentMessages: 51 },
    { model: "valid", maxContextCharacters: 999 },
    { model: "valid", timeoutMs: 99 },
    { model: "valid", onDecision: "nope" },
  ])("rejects invalid config %#", (value) => {
    expect(slackParticipationConfigSchema.safeParse(value).success).toBe(false);
  });
});
