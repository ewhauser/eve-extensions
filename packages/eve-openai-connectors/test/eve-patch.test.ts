import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  passesToolFilter,
  projectConnectionToolNames,
} from "../node_modules/eve/dist/src/runtime/connections/mcp-client.js";
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

  test("compiled discovery and execution preserve projected identity and annotations", () => {
    const discovery = readFileSync(
      new URL("../node_modules/eve/dist/src/execution/tools/connection-tools.js", import.meta.url),
      "utf8",
    );
    const approval = readFileSync(
      new URL("../node_modules/eve/dist/src/execution/tools/connection-approval.js", import.meta.url),
      "utf8",
    );
    expect(discovery).toContain("modelName");
    expect(discovery).toContain("expectedMetadata");
    expect(approval).toContain("toolAnnotations");
    expect(approval).toContain("upstreamToolName");
  });
});
