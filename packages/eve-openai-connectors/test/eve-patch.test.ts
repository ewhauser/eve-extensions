import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  passesToolFilter,
  projectConnectionToolNames,
} from "../node_modules/eve/dist/src/runtime/connections/mcp-client.js";
import { selectConnectionMatches } from "../node_modules/eve/dist/src/execution/tools/connection-search.js";
import type { ResolvedConnectionDefinition } from "../node_modules/eve/dist/src/runtime/types.js";

function connection(
  overrides: Partial<ResolvedConnectionDefinition> = {},
): ResolvedConnectionDefinition {
  return {
    connectionName: "connectors",
    description: "connectors",
    logicalPath: "connections/connectors.ts",
    protocol: "mcp",
    sourceId: "connectors",
    sourceKind: "module",
    url: "https://mcp.example.com",
    ...overrides,
  };
}

describe("carried Eve connection patches", () => {
  test("maps dotted names while retaining the authoritative upstream key", () => {
    const names = projectConnectionToolNames(
      connection({ toolName: { toModelName: (name) => name.replaceAll(".", "__") } }),
      ["github.search_repositories"],
    );
    expect([...names]).toEqual([["github.search_repositories", "github__search_repositories"]]);
  });

  test("projects service-qualified names without an extra connection prefix", () => {
    const names = projectConnectionToolNames(
      connection({ toolName: {
        qualify: false, collisionPriority: -1,
        toModelName: (name) => name.replace(".", "__"),
      } }),
      ["github.search_repositories"],
    );
    expect([...names]).toEqual([["github.search_repositories", "github__search_repositories"]]);
  });

  test("rejects collisions and overlong qualified names", () => {
    expect(() =>
      projectConnectionToolNames(connection({ toolName: { toModelName: () => "same" } }), [
        "a.tool",
        "b.tool",
      ]),
    ).toThrow("mapping collision");
    expect(() => projectConnectionToolNames(connection(), ["x".repeat(64)])).toThrow("must match");
  });

  test("predicate filters receive exact upstream names", () => {
    expect(
      passesToolFilter("github.search_repositories", {
        filter: (upstream) => upstream.startsWith("github."),
      }),
    ).toBe(true);
  });

  test("explicit app connection wins a projected-name collision regardless of score or order", () => {
    const connector = {
      item: { connection: "connectors", qualifiedName: "datadog__search_logs" },
      priority: -1, score: 10,
    };
    const authored = {
      item: { connection: "app-datadog", qualifiedName: "datadog__search_logs" },
      priority: 0, score: 1,
    };
    expect(selectConnectionMatches([connector, authored], 10)).toEqual([authored]);
    expect(selectConnectionMatches([authored, connector], 10)).toEqual([authored]);
  });

  test("compiled discovery carries annotations, upstream identity, and descriptor replay checks", () => {
    const source = readFileSync(
      new URL("../node_modules/eve/dist/src/execution/tools/connection-search.js", import.meta.url),
      "utf8",
    );
    expect(source).toContain("toolAnnotations");
    expect(source).toContain("upstreamToolName");
    expect(source).toContain("expectedMetadata");
  });
});
