import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorModelRequest } from "../src/types.js";

const ai = vi.hoisted(() => ({
  generateText: vi.fn(),
  object: vi.fn((options: unknown) => ({ kind: "object-output", options })),
  isNoObjectGenerated: vi.fn((error: unknown) =>
    typeof error === "object" && error !== null && "noObjectGenerated" in error),
}));

vi.mock("ai", () => ({
  generateText: ai.generateText,
  NoObjectGeneratedError: { isInstance: ai.isNoObjectGenerated },
  Output: { object: ai.object },
}));

import { createAiSdkMonitorInvoker } from "../src/ai-sdk.js";

const request: MonitorModelRequest = {
  model: "provider/classifier",
  reasoning: "minimal",
  instructions: "Classify the evidence.",
  input: { message: "hello" },
  timeoutMs: 2_000,
  maxInputTokens: 100,
  maxOutputTokens: 25,
  repairAttempt: 1,
  previousInvalidOutput: { action: "invalid" },
};

describe("AI SDK monitor adapter", () => {
  beforeEach(() => {
    ai.generateText.mockReset();
    ai.object.mockClear();
  });

  it("maps the restricted request without enabling tools or provider retries", async () => {
    ai.generateText.mockResolvedValue({
      output: { action: "ignore", reason: "not relevant" },
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    const resolveModel = vi.fn(() => ({ modelId: "resolved" }) as never);
    const headers = vi.fn(() => ({ "x-monitor": "test" }));
    const invoke = createAiSdkMonitorInvoker({ resolveModel, headers });

    const result = await invoke(request);

    expect(resolveModel).toHaveBeenCalledWith(request.model, request);
    expect(headers).toHaveBeenCalledWith(request);
    expect(ai.generateText).toHaveBeenCalledOnce();
    const options = ai.generateText.mock.calls[0]![0];
    expect(options).toMatchObject({
      model: { modelId: "resolved" },
      reasoning: "minimal",
      maxOutputTokens: 25,
      timeout: 2_000,
      maxRetries: 0,
      headers: { "x-monitor": "test" },
      output: { kind: "object-output" },
    });
    expect(options).not.toHaveProperty("tools");
    expect(JSON.parse(options.prompt)).toEqual({
      evidence: request.input,
      repair: {
        instruction: "Return one corrected object matching the required decision schema.",
        previousInvalidOutput: request.previousInvalidOutput,
      },
    });
    expect(options.instructions).toContain("untrusted evidence");
    expect(result).toEqual({
      output: { action: "ignore", reason: "not relevant" },
      usage: { inputTokens: 12, outputTokens: 4 },
    });
  });

  it("returns invalid structured text for the runtime's one schema-repair attempt", async () => {
    ai.generateText.mockRejectedValue({
      noObjectGenerated: true,
      text: JSON.stringify({ action: "invented" }),
      usage: { inputTokens: 9, outputTokens: 2 },
    });
    const invoke = createAiSdkMonitorInvoker();

    await expect(invoke({ ...request, repairAttempt: 0, previousInvalidOutput: undefined })).resolves.toEqual({
      output: { action: "invented" },
      usage: { inputTokens: 9, outputTokens: 2 },
    });
  });

  it("rethrows provider failures instead of translating them into schema repair", async () => {
    const providerFailure = new Error("provider unavailable");
    ai.generateText.mockRejectedValue(providerFailure);
    const invoke = createAiSdkMonitorInvoker();

    await expect(invoke(request)).rejects.toBe(providerFailure);
  });
});
