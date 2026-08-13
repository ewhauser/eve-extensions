import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";

import { buildInventory } from "../extension/lib/catalog.js";
import {
  clientToolDescription,
  materializeClientToolSearchOutput,
  namespaceFromClientMarkerToolName,
  parseClientToolSearchInput,
} from "../extension/lib/client-search.js";
import type { UpstreamTool } from "../extension/lib/types.js";

const TOOLS: UpstreamTool[] = [
  {
    name: "github.search_issues",
    description: "Search GitHub issues.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "github.create_issue",
    description: "Create a GitHub issue.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_drive.search_files",
    description: "Search Google Drive files.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

describe("client tool-search input", () => {
  test("accepts OpenAI's call_id wrapper and the progressive fallback input", () => {
    expect(
      parseClientToolSearchInput({
        arguments: { keywords: "search issues", service: "github", limit: 2 },
        call_id: "call_123",
      }),
    ).toEqual({ keywords: "search issues", service: "github", limit: 2 });
    expect(parseClientToolSearchInput({ keywords: "files" })).toEqual({ keywords: "files" });
    expect(namespaceFromClientMarkerToolName("openai__client_tool_search")).toBe("openai__");
  });

  test.each([
    [{ arguments: { keywords: "issues" } }, /call_id/],
    [{ arguments: "issues", call_id: "call_1" }, /arguments must be an object/],
    [{ arguments: { keywords: 42 }, call_id: "call_1" }, /keywords must be a string/],
    [{ arguments: { keywords: "x", limit: 0 }, call_id: "call_1" }, /positive integer/],
    [{ arguments: { keywords: "x", extra: true }, call_id: "call_1" }, /does not accept/],
  ])("rejects malformed requests %#", (input, pattern) => {
    expect(() => parseClientToolSearchInput(input)).toThrow(pattern);
  });
});

describe("client tool-search materialization", () => {
  const inventory = buildInventory(TOOLS, "", undefined, 56);
  const searchIssues = inventory.byUpstream.get("github.search_issues")!;
  const createIssue = inventory.byUpstream.get("github.create_issue")!;

  test("emits exact namespaced function definitions with a catalog-version tag", () => {
    const output = materializeClientToolSearchOutput(
      inventory,
      [searchIssues, createIssue],
      "openai__",
      64 * 1024,
    );
    expect(output.tools.map((tool) => tool.name)).toEqual([
      "openai__github_search_issues",
      "openai__github_create_issue",
    ]);
    expect(output.tools[0]).toMatchObject({
      type: "function",
      defer_loading: true,
      parameters: TOOLS[0]!.inputSchema,
    });
    expect(output.tools[0]?.description).toBe(
      clientToolDescription(searchIssues, inventory.fingerprint),
    );
  });

  test("returns no tools for no matches and skips definitions beyond the byte budget", () => {
    expect(materializeClientToolSearchOutput(inventory, [], "openai__", 64 * 1024)).toEqual({
      tools: [],
    });
    const one = materializeClientToolSearchOutput(
      inventory,
      [searchIssues],
      "openai__",
      64 * 1024,
    );
    const exactBytes = Buffer.byteLength(JSON.stringify(one), "utf8");
    expect(
      materializeClientToolSearchOutput(
        inventory,
        [searchIssues, createIssue],
        "openai__",
        exactBytes,
      ).tools,
    ).toHaveLength(1);
    expect(
      materializeClientToolSearchOutput(inventory, [searchIssues], "openai__", 12).tools,
    ).toEqual([]);
  });
});
