import type { AgentCompactionStrategyInput } from "eve";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { codexRemoteCompaction } from "../src/index.js";

function compactResponse(output: readonly unknown[]): Response {
  return new Response(
    JSON.stringify({
      created_at: 1_765_000_000,
      id: "resp_compact_1",
      object: "response.compaction",
      output,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 10 },
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

function strategyInput(messages: readonly ModelMessage[]): AgentCompactionStrategyInput {
  return {
    continuationProviderOptions: { openai: { store: false } },
    force: false,
    messages,
    model: "openai/gpt-5.3-codex",
    providerOptions: { openai: { serviceTier: "priority" } },
    system: "You are a coding agent.",
    thresholdTokens: 180_000,
  };
}

describe("codexRemoteCompaction", () => {
  it("uses /responses/compact and returns retained user intent plus the encrypted checkpoint", async () => {
    const remoteFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        compactResponse([
          {
            content: [{ text: "server-retained copy", type: "input_text" }],
            id: "msg_server_retained",
            role: "user",
            status: "completed",
            type: "message",
          },
          { encrypted_content: "opaque-checkpoint", id: "cmp_1", type: "compaction" },
        ]),
    );
    const messages: ModelMessage[] = [
      { content: "Build the feature.", role: "user" },
      { content: "Working on it.", role: "assistant" },
      { content: "Preserve compatibility.", role: "user" },
    ];

    const result = await codexRemoteCompaction({
      apiKey: () => "test-api-key",
      fetch: remoteFetch,
    })(strategyInput(messages));

    expect(remoteFetch).toHaveBeenCalledOnce();
    const [url, init] = remoteFetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses/compact");
    expect(init?.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer test-api-key" }),
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.3-codex");
    expect(body.service_tier).toBe("priority");
    expect(JSON.stringify(body.input)).toContain("You are a coding agent.");
    expect(Object.keys(body).sort()).toEqual(["input", "model", "service_tier"]);
    expect(result).toEqual([
      { content: "Build the feature.", role: "user" },
      { content: "Preserve compatibility.", role: "user" },
      {
        content: [
          {
            kind: "openai.compaction",
            providerOptions: {
              openai: {
                encryptedContent: "opaque-checkpoint",
                itemId: "cmp_1",
                type: "compaction",
              },
            },
            type: "custom",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("keeps the newest user messages under the Codex remote-v2 budget", async () => {
    const remoteFetch = vi.fn(async () =>
      compactResponse([{ encrypted_content: "opaque", id: "cmp_2", type: "compaction" }]),
    );

    const result = await codexRemoteCompaction({
      apiKey: () => "test-api-key",
      fetch: remoteFetch,
      retainedUserMessageTokens: 3,
    })(
      strategyInput([
        { content: "abcdefghijklmnop", role: "user" },
        { content: "assistant detail", role: "assistant" },
        { content: "WXYZ", role: "user" },
      ]),
    );

    expect(result.slice(0, -1)).toEqual([
      { content: "abcd…2 tokens truncated…mnop", role: "user" },
      { content: "WXYZ", role: "user" },
    ]);
  });

  it("replays an existing encrypted checkpoint into the next compact request", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const remoteFetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return compactResponse([
        { encrypted_content: "next-checkpoint", id: "cmp_next", type: "compaction" },
      ]);
    });
    const priorCheckpoint: ModelMessage = {
      content: [
        {
          kind: "openai.compaction",
          providerOptions: {
            openai: {
              encryptedContent: "prior-checkpoint",
              itemId: "cmp_prior",
              type: "compaction",
            },
          },
          type: "custom",
        },
      ],
      role: "assistant",
    };

    await codexRemoteCompaction({ apiKey: () => "test-api-key", fetch: remoteFetch })(
      strategyInput([
        { content: "original request", role: "user" },
        priorCheckpoint,
        { content: "follow-up", role: "user" },
      ]),
    );

    expect(requestBody?.input).toEqual(
      expect.arrayContaining([
        {
          encrypted_content: "prior-checkpoint",
          id: "cmp_prior",
          type: "compaction",
        },
      ]),
    );
  });

  it("retains image-only user messages using Codex's minimum one-token charge", async () => {
    const remoteFetch = vi.fn(async () =>
      compactResponse([{ encrypted_content: "opaque", id: "cmp_image", type: "compaction" }]),
    );
    const imageMessage: ModelMessage = {
      content: [
        {
          data: new URL("https://example.com/reference.png"),
          mediaType: "image/png",
          type: "file",
        },
      ],
      role: "user",
    };

    const result = await codexRemoteCompaction({
      apiKey: () => "test-api-key",
      fetch: remoteFetch,
      retainedUserMessageTokens: 1,
    })(strategyInput([imageMessage]));

    expect(result[0]).toEqual(imageMessage);
  });

  it("requires stateless continuation so encrypted content is replayed", async () => {
    const input = strategyInput([{ content: "request", role: "user" }]);
    const strategy = codexRemoteCompaction({
      apiKey: () => "test-api-key",
      fetch: vi.fn(),
    });

    await expect(
      strategy({ ...input, continuationProviderOptions: { openai: { store: true } } }),
    ).rejects.toThrow("modelOptions.providerOptions.openai.store to be false");
  });

  it("rejects ambiguous remote output instead of falling back to prose", async () => {
    const remoteFetch = vi.fn(async () => compactResponse([]));
    const strategy = codexRemoteCompaction({
      apiKey: () => "test-api-key",
      fetch: remoteFetch,
    });

    await expect(strategy(strategyInput([{ content: "request", role: "user" }]))).rejects.toThrow(
      "returned 0 valid compaction items; expected exactly one",
    );
  });

  it("surfaces remote API failures without a local fallback", async () => {
    const remoteFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "invalid_request", message: "invalid input", type: "api_error" },
          }),
          { headers: { "content-type": "application/json" }, status: 400 },
        ),
    );
    const strategy = codexRemoteCompaction({
      apiKey: () => "test-api-key",
      fetch: remoteFetch,
    });

    await expect(strategy(strategyInput([{ content: "request", role: "user" }]))).rejects.toThrow();
  });
});
