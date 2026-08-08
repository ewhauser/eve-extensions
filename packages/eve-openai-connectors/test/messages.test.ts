import { describe, expect, test } from "vitest";
import { searchResultsFromMessages } from "../extension/lib/messages.js";
import type { ConnectorToolItem } from "../extension/lib/types.js";

function resultItem(overrides: Partial<ConnectorToolItem>): ConnectorToolItem {
  return {
    name: "apps_github_search_issues",
    upstream: "github.search_issues",
    service: "github",
    description: "Search issues.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    readOnly: true,
    destructive: false,
    ...overrides,
  };
}

function toolMessage(toolName: string, value: unknown, wrap = true) {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName,
        output: wrap ? { type: "json", value } : value,
      },
    ],
  };
}

describe("searchResultsFromMessages", () => {
  test("parses items out of wrapped tool results", () => {
    const items = searchResultsFromMessages([
      { role: "user", content: "find issues" },
      toolMessage("apps_search", [resultItem({})]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: "apps_github_search_issues",
      upstream: "github.search_issues",
      readOnly: true,
      destructive: false,
    });
  });

  test("parses results from a namespaced extension search tool", () => {
    const items = searchResultsFromMessages(
      [toolMessage("openai__search", [resultItem({})])],
      { searchToolName: "search" },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.upstream).toBe("github.search_issues");
  });

  test("tolerates a bare (unwrapped) value and a JSON-string value", () => {
    const bare = searchResultsFromMessages([toolMessage("apps_search", [resultItem({})], false)]);
    expect(bare).toHaveLength(1);
    const stringly = searchResultsFromMessages([
      toolMessage("apps_search", JSON.stringify([resultItem({})]), false),
    ]);
    expect(stringly).toHaveLength(1);
  });

  test("ignores other tools' results and non-tool roles", () => {
    const items = searchResultsFromMessages([
      toolMessage("connection_search", [resultItem({})]),
      {
        role: "assistant",
        content: [
          {
            type: "tool-result",
            toolName: "apps_search",
            output: { type: "json", value: [resultItem({ name: "apps_smuggled" })] },
          },
        ],
      },
    ]);
    expect(items).toHaveLength(0);
  });

  test("dedupes by name with the most recent result winning", () => {
    const items = searchResultsFromMessages([
      toolMessage("apps_search", [resultItem({ description: "old" })]),
      toolMessage("apps_search", [resultItem({ description: "new" })]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe("new");
  });

  test("caps at max, keeping the most recently discovered", () => {
    const older = toolMessage(
      "apps_search",
      [0, 1, 2].map((i) => resultItem({ name: `apps_old_${i}`, upstream: `old.${i}x` })),
    );
    const newer = toolMessage(
      "apps_search",
      [0, 1].map((i) => resultItem({ name: `apps_new_${i}`, upstream: `new.${i}x` })),
    );
    const items = searchResultsFromMessages([older, newer], { max: 2 });
    expect(items.map((item) => item.name)).toEqual(["apps_new_1", "apps_new_0"]);
  });

  test("drops malformed or illegally named items and fails closed on flags", () => {
    const items = searchResultsFromMessages([
      toolMessage("apps_search", [
        { name: "bad.name", upstream: "x.y" }, // illegal tool name
        { name: "apps_no_upstream" }, // missing upstream
        resultItem({ name: "apps_flags_missing", upstream: "svc.tool", readOnly: undefined as never, destructive: undefined as never }),
        "not-an-object",
      ]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: "apps_flags_missing",
      readOnly: false,
      destructive: true, // absent flags are treated as a destructive write
    });
  });

  test("respects a custom search tool name", () => {
    const items = searchResultsFromMessages(
      [toolMessage("connectors_search", [resultItem({})])],
      { searchToolName: "connectors_search" },
    );
    expect(items).toHaveLength(1);
  });
});
