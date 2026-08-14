import { afterEach, describe, expect, test } from "vitest";

import {
  ContextContainer,
  contextStorage,
} from "../node_modules/eve/dist/src/context/container.js";
import type { DynamicToolEntry } from "eve/tools";
import type { UpstreamTool } from "../extension/lib/types.js";
import { startFakeMcpServer, type FakeServer } from "./helpers/fake-server.js";

const CATALOG: UpstreamTool[] = [
  {
    name: "github.search_issues",
    description: "Search GitHub issues.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "github.create_issue",
    description: "Create a GitHub issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

function resolveContext(principalId: string, messages: readonly unknown[] = []) {
  return {
    session: {
      id: "durable-session",
      auth: {
        current: {
          attributes: {},
          authenticator: "test-idp",
          principalId,
          principalType: "user" as const,
        },
        initiator: null,
      },
    },
    channel: {},
    messages,
  };
}

let server: FakeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  Reflect.deleteProperty(globalThis, Symbol.for("eve.ext-config-scope"));
});

describe("extension durable discovery lifecycle", () => {
  test("persists compact search results across steps and ignores opaque transcript replacement", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });

    // The extension build supplies this scope at mount time. Set the same
    // ambient value before importing authored source for this lifecycle test.
    Reflect.set(globalThis, Symbol.for("eve.ext-config-scope"), "test.openai-connectors");
    const [{ default: extension }, { default: dynamic }] = await Promise.all([
      import("../extension/extension.js"),
      import("../extension/tools/connectors.js"),
    ]);
    extension({
      getToken: () => "token-a",
      discovery: "search",
      baseUrl: server.url,
      includeStatus: false,
    });

    const firstCtx = resolveContext("principal-a", [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "openai__search",
            output: {
              type: "json",
              value: [
                {
                  name: "github_create_issue",
                  upstream: "github.create_issue",
                  inputSchema: CATALOG[1]!.inputSchema,
                },
              ],
            },
          },
        ],
      },
    ]);
    const container = new ContextContainer();
    await contextStorage.run(container, async () => {
      const first = (await dynamic.events["step.started"]?.({}, firstCtx as never)) as Record<
        string,
        DynamicToolEntry
      >;
      // Pre-manifest transcript results are deliberately not migrated.
      expect(Object.keys(first)).toEqual(["search"]);

      const output = await first.search!.execute(
        { keywords: "search issues", service: "github" },
        { ...firstCtx, toolName: "openai__search" } as never,
      );
      expect(output).toEqual({
        loaded: [{ name: "github__search_issues", summary: "Search GitHub issues." }],
      });
      expect(JSON.stringify(output)).not.toContain("inputSchema");

      const compactedCtx = resolveContext("principal-a", [
        { role: "system", content: "opaque external checkpoint" },
      ]);
      const nextStep = (await dynamic.events["step.started"]?.({}, compactedCtx as never)) as Record<
        string,
        DynamicToolEntry
      >;
      expect(Object.keys(nextStep)).toEqual(["search", "eve:absolute:github__search_issues"]);
      expect(nextStep["eve:absolute:github__search_issues"]?.inputSchema).toEqual(
        CATALOG[0]!.inputSchema,
      );

      const otherPrincipal = (await dynamic.events["step.started"]?.(
        {},
        resolveContext("principal-b", [{ role: "system", content: "same session" }]) as never,
      )) as Record<string, DynamicToolEntry>;
      expect(Object.keys(otherPrincipal)).toEqual(["search"]);
    });
  });
});
