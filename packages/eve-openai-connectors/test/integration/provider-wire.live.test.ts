import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFER_PROVIDER_OPTIONS } from "../../extension/lib/connectors.js";
import { mapUpstreamName } from "../../extension/lib/naming.js";
import { createProtocolClient } from "../../extension/lib/protocol.js";

// Wire-level tests for the two claims offline tests cannot verify:
//
//  1. Every mapped connector tool name is accepted by the real model APIs
//     (the DESIGN §3 failure class).
//  2. `defer_loading` + provider-native tool search are accepted on the wire —
//     directly against Anthropic, and through the Vercel AI Gateway for both
//     Anthropic and OpenAI models (the deferred-mode open questions).
//
// Gating: ANTHROPIC_API_KEY (direct block), AI_GATEWAY_API_KEY (gateway block).
// The catalog comes live when CODEX_ACCESS_TOKEN is set, otherwise from the
// recorded snapshot in test/fixtures/catalog.live.json.

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const gatewayKey = process.env.AI_GATEWAY_API_KEY;
const codexToken = process.env.CODEX_ACCESS_TOKEN;

const DIRECT_ANTHROPIC_MODEL = process.env.INTEGRATION_ANTHROPIC_MODEL ?? "claude-sonnet-5";
const GATEWAY_ANTHROPIC_MODEL =
  process.env.INTEGRATION_GATEWAY_ANTHROPIC_MODEL ?? "anthropic/claude-sonnet-5";
const GATEWAY_OPENAI_MODEL =
  process.env.INTEGRATION_GATEWAY_OPENAI_MODEL ?? "openai/gpt-5.6-luna";

const SEARCH_PROMPT =
  "You have a large set of deferred tools. Use tool search to find a tool for " +
  "searching GitHub repositories, then reply with the name of the best match. " +
  "Do not call any tool other than tool search.";

interface CatalogEntry {
  name: string;
  description: string;
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  if (codexToken) {
    const client = createProtocolClient({ token: codexToken });
    const tools = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description ?? t.name }));
  }
  const fixture = join(__dirname, "..", "fixtures", "catalog.live.json");
  if (!existsSync(fixture)) throw new Error("No CODEX_ACCESS_TOKEN and no recorded catalog fixture.");
  const { tools } = JSON.parse(readFileSync(fixture, "utf8")) as { tools: CatalogEntry[] };
  return tools.map((t) => ({ name: t.name, description: t.description || t.name }));
}

function mappedEntries(catalog: CatalogEntry[], count: number) {
  return catalog.slice(0, count).map((entry) => ({
    name: `openai__${mapUpstreamName(entry.name, "", 56)}`,
    description: entry.description.slice(0, 200) || entry.name,
  }));
}

// ── Direct Anthropic API ────────────────────────────────────────────────────

async function anthropicMessages(body: object, beta?: string): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicKey!,
      "anthropic-version": "2023-06-01",
      ...(beta ? { "anthropic-beta": beta } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!anthropicKey)("direct Anthropic API (ANTHROPIC_API_KEY)", () => {
  test("mapped connector tool names are accepted as regular tools", async () => {
    const catalog = await loadCatalog();
    const tools = mappedEntries(catalog, 40).map((entry) => ({
      ...entry,
      input_schema: { type: "object" },
    }));
    const res = await anthropicMessages({
      model: DIRECT_ANTHROPIC_MODEL,
      max_tokens: 64,
      tools,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 400)).toBe(200);
  });

  test("defer_loading + tool_search_tool_regex work end to end", async () => {
    const catalog = await loadCatalog();
    const tools = [
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      ...mappedEntries(catalog, 80).map((entry) => ({
        ...entry,
        input_schema: { type: "object" },
        defer_loading: true,
      })),
    ];
    const body = {
      model: DIRECT_ANTHROPIC_MODEL,
      max_tokens: 600,
      tools,
      messages: [{ role: "user", content: SEARCH_PROMPT }],
    };

    // The AI SDK provider sends no beta header for tool search; verify whether
    // the live API agrees, falling back to the advanced-tool-use beta.
    const candidates: Array<string | undefined> = [undefined, "advanced-tool-use-2025-11-20"];
    let last = "";
    for (const beta of candidates) {
      const res = await anthropicMessages(body, beta);
      const text = await res.text();
      if (res.status === 200) {
        const message = JSON.parse(text) as { content: Array<{ type: string; name?: string }> };
        const blockTypes = message.content.map((block) => block.type);
        console.log(`tool search OK (beta header: ${beta ?? "none"}); blocks: ${blockTypes.join(", ")}`);
        expect(
          blockTypes.some((type) => type.includes("tool_search") || type === "server_tool_use"),
          `expected tool-search activity, got: ${blockTypes.join(", ")}`,
        ).toBe(true);
        return;
      }
      last = `beta=${beta ?? "none"} → ${res.status}: ${text.slice(0, 300)}`;
      console.log(last);
    }
    throw new Error(`all beta-header candidates rejected — ${last}`);
  });
});

// ── Vercel AI Gateway ───────────────────────────────────────────────────────

describe.skipIf(!gatewayKey)("AI Gateway passthrough (AI_GATEWAY_API_KEY)", () => {
  async function gatewayDeferredRun(modelId: string, searchTool: Record<string, unknown>) {
    const { generateText, jsonSchema, gateway } = await import("ai");
    const catalog = await loadCatalog();

    // Plain tool objects (the AI SDK `tool()` helper is an identity function);
    // typed loosely because this test exercises the wire, not the typings.
    const tools: Record<string, unknown> = { ...searchTool };
    for (const entry of mappedEntries(catalog, 80)) {
      tools[entry.name] = {
        description: entry.description,
        inputSchema: jsonSchema({ type: "object" }),
        providerOptions: DEFER_PROVIDER_OPTIONS,
      };
    }

    const result = await generateText({
      model: gateway(modelId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      prompt: SEARCH_PROMPT,
    });

    const parts = result.steps.flatMap((step) => step.content.map((part) => part.type));
    console.log(
      `${modelId}: finishReason=${result.finishReason}; parts=${parts.join(", ")}; ` +
        `toolCalls=${result.toolCalls.map((call) => call.toolName).join(", ") || "none"}; ` +
        `text=${result.text.slice(0, 160)}`,
    );
    return { result, parts };
  }

  test("anthropic model via gateway accepts deferred tools + search tool", async () => {
    const { anthropic } = await import("@ai-sdk/anthropic");
    const { result, parts } = await gatewayDeferredRun(GATEWAY_ANTHROPIC_MODEL, {
      tool_search_tool_regex: anthropic.tools.toolSearchRegex_20251119(),
    });
    expect(result.finishReason).not.toBe("error");
    // Evidence the request was coherent: either search activity or an answer
    // naming a github tool.
    const searched = parts.some((type) => type.includes("tool_search") || type.includes("tool-"));
    expect(searched || /github/i.test(result.text)).toBe(true);
  });

  test("openai model via gateway accepts deferred tools + search tool", async () => {
    const { openai } = await import("@ai-sdk/openai");
    const { result, parts } = await gatewayDeferredRun(GATEWAY_OPENAI_MODEL, {
      tool_search: openai.tools.toolSearch({}),
    });
    expect(result.finishReason).not.toBe("error");
    const searched = parts.some((type) => type.includes("tool_search") || type.includes("tool-"));
    expect(searched || /github/i.test(result.text)).toBe(true);
  });
});
