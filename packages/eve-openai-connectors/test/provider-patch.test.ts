import { readFileSync } from "node:fs";
import { generateText, stepCountIs } from "ai";
import { describe, expect, test, vi } from "vitest";

import {
  isDeferredTool,
  resolveToolSearchProviderTool,
} from "../node_modules/eve/dist/src/harness/provider-tools.js";
import { createOpenAI } from "../node_modules/eve/dist/src/compiled/@ai-sdk/openai/index.js";
import {
  CLIENT_TOOL_SEARCH_DESCRIPTION,
  CLIENT_TOOL_SEARCH_PARAMETERS,
  CLIENT_TOOL_SEARCH_PROVIDER_OPTIONS,
} from "../extension/lib/client-search.js";

function markerForCatalogSize(size: number) {
  const authorizedCatalog = Array.from({ length: size }, (_, index) => ({
    name: `private_service_tool_${index}`,
  }));
  const execute = async () => ({ tools: authorizedCatalog.slice(0, 2) });
  return {
    description: CLIENT_TOOL_SEARCH_DESCRIPTION,
    providerOptions: CLIENT_TOOL_SEARCH_PROVIDER_OPTIONS,
    execute,
  };
}

describe("Eve client tool-search provider bridge", () => {
  test("publishes explicitly service-qualified dynamic connector names without the mount prefix", () => {
    const lifecycle = readFileSync(
      new URL(
        "../node_modules/eve/dist/src/context/dynamic-tool-lifecycle.js",
        import.meta.url,
      ),
      "utf8",
    );
    expect(lifecycle).toContain("eve:absolute:");
    expect(lifecycle).toMatch(
      /startsWith\((?:ABSOLUTE_DYNAMIC_TOOL_NAME_PREFIX|["'`]eve:absolute:["'`])\)/,
    );
  });

  test("selects a later client marker and emits one constant-size OpenAI provider tool", async () => {
    const hostedDeferred = {
      description: "Unrelated hosted deferred tool.",
      providerOptions: { openai: { deferLoading: true } },
    };

    const resolveFor = async (catalogSize: number) => {
      const marker = markerForCatalogSize(catalogSize);
      expect([hostedDeferred, marker].map((tool) => isDeferredTool(tool as never)).some(Boolean)).toBe(
        true,
      );
      const resolved = await resolveToolSearchProviderTool("openai", [
        hostedDeferred as never,
        marker as never,
      ]);
      expect(resolved.name).toBe("tool_search");
      expect(resolved.replacedTool).toBe(marker);
      expect(resolved.tool).toMatchObject({
        type: "provider",
        isProviderExecuted: false,
        id: "openai.tool_search",
        args: {
          execution: "client",
          description: CLIENT_TOOL_SEARCH_DESCRIPTION,
          parameters: CLIENT_TOOL_SEARCH_PARAMETERS,
        },
        execute: marker.execute,
      });
      return JSON.stringify({ name: resolved.name, tool: resolved.tool });
    };

    const smallRequestTool = await resolveFor(10);
    const largeRequestTool = await resolveFor(200);
    expect(largeRequestTool).toBe(smallRequestTool);
    expect(largeRequestTool).not.toContain("private_service_tool_199");
  });

  test("does not reuse a client marker from a previous tool-set scan", async () => {
    const staleMarker = markerForCatalogSize(10);
    expect(isDeferredTool(staleMarker as never)).toBe(true);

    const hostedDeferred = {
      description: "Hosted deferred tool from a later request.",
      providerOptions: { openai: { deferLoading: true } },
    };
    const resolved = await resolveToolSearchProviderTool("openai", [hostedDeferred as never]);
    expect(resolved.replacedTool).toBeUndefined();
    expect(resolved.tool).toMatchObject({
      type: "provider",
      isProviderExecuted: false,
      id: "openai.tool_search",
      args: {},
    });
  });

  test("round-trips a client call_id and bounded tool_search_output on the Responses wire", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let requestNumber = 0;
    const mockFetch: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      requestNumber++;
      const output =
        requestNumber === 1
          ? [
              {
                type: "tool_search_call",
                id: "tool_search_item_1",
                execution: "client",
                call_id: "call_search_1",
                status: "completed",
                arguments: { keywords: "issues" },
              },
            ]
          : [
              {
                type: "message",
                id: "message_1",
                status: "completed",
                role: "assistant",
                content: [
                  { type: "output_text", text: "done", annotations: [], logprobs: [] },
                ],
              },
            ];
      return new Response(
        JSON.stringify({
          id: `response_${requestNumber}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.4",
          output,
          parallel_tool_calls: false,
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          temperature: null,
          top_p: null,
          max_output_tokens: null,
          previous_response_id: null,
          reasoning: null,
          service_tier: "default",
          store: false,
          text: { format: { type: "text" } },
          tool_choice: "auto",
          tools: [],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const loaded = {
      type: "function",
      name: "github__search_issues",
      description: "Search issues.\n[eve catalog: current]",
      defer_loading: true,
      parameters: { type: "object" },
    } as const;
    const execute = vi.fn(async () => ({ tools: [loaded] }));
    const marker = {
      description: CLIENT_TOOL_SEARCH_DESCRIPTION,
      providerOptions: CLIENT_TOOL_SEARCH_PROVIDER_OPTIONS,
      execute,
    };
    expect([marker].map((tool) => isDeferredTool(tool as never)).some(Boolean)).toBe(true);
    const resolved = await resolveToolSearchProviderTool("openai", [marker as never]);
    expect(resolved.replacedTool).toBe(marker);
    const openai = createOpenAI({ apiKey: "test", fetch: mockFetch });
    await generateText({
      model: openai.responses("gpt-5.4"),
      prompt: "Find issues.",
      tools: { [resolved.name]: resolved.tool },
      stopWhen: stepCountIs(2),
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toEqual([
      {
        type: "tool_search",
        execution: "client",
        description: CLIENT_TOOL_SEARCH_DESCRIPTION,
        parameters: CLIENT_TOOL_SEARCH_PARAMETERS,
      },
    ]);
    expect(JSON.stringify(requests[0])).not.toContain("github_search_issues");
    expect(execute).toHaveBeenCalledWith(
      { arguments: { keywords: "issues" }, call_id: "call_search_1" },
      expect.any(Object),
    );
    expect(requests[1]?.input).toEqual(
      expect.arrayContaining([
        {
          type: "tool_search_output",
          execution: "client",
          call_id: "call_search_1",
          status: "completed",
          tools: [loaded],
        },
      ]),
    );
  });
});
