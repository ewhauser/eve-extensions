import { afterEach, describe, expect, test } from "vitest";

import {
  ContextContainer,
  contextStorage,
} from "../node_modules/eve/dist/src/context/container.js";
import { replayDynamicTools } from "../node_modules/eve/dist/src/context/build-dynamic-tools.js";
import { validateDurableDynamicToolCallbacks } from "../node_modules/eve/dist/src/context/dynamic-tool-lifecycle.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
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
  Reflect.set(globalThis, Symbol.for("eve:dynamic-tool-callbacks"), new Map());
});

describe("extension durable discovery lifecycle", () => {
  test("persists compact search results across steps and ignores opaque transcript replacement", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });

    // The package namespace must bind config without build-time ambient scope;
    // production consumers can also import the public `connectors` subpath.
    expect(Reflect.get(globalThis, Symbol.for("eve.ext-config-scope"))).toBeUndefined();
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

  test("rebinds materialized execute and approval callbacks from JSON-only Eve 0.49 metadata", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });

    const [{ default: extension }, { default: dynamic }] = await Promise.all([
      import("../extension/extension.js"),
      import("../extension/tools/connectors.js"),
    ]);
    extension({
      getToken: () => "token-a",
      discovery: "search",
      baseUrl: server.url,
      includeStatus: false,
      approvalFor: (item) =>
        item.readOnly
          ? () => "not-applicable"
          : {
              request: () => "user-approval",
              response: ({ responder }) =>
                responder.principalId === "approver-a"
                  ? { status: "allowed" }
                  : { status: "rejected", reason: "Not an authorized approver." },
            },
    });

    const container = new ContextContainer();
    await contextStorage.run(container, async () => {
      const ctx = resolveContext("principal-a");
      container.set(SessionKey, {
        sessionId: ctx.session.id,
        auth: ctx.session.auth,
        turn: { id: "durable-turn", sequence: 0 },
      });
      const first = (await dynamic.events["step.started"]?.({}, ctx as never)) as Record<
        string,
        DynamicToolEntry
      >;
      const readSearch = await first.search!.execute(
        { keywords: "search issues", service: "github" },
        { ...ctx, callId: "search-call", toolName: "connectors__search" } as never,
      );
      const writeSearch = await first.search!.execute(
        { keywords: "create issue", service: "github" },
        { ...ctx, callId: "search-call-2", toolName: "connectors__search" } as never,
      );
      expect(readSearch).toEqual({
        loaded: [{ name: "github__search_issues", summary: "Search GitHub issues." }],
      });
      expect(writeSearch).toEqual({
        loaded: [
          {
            name: "github__create_issue",
            summary: "[write — requires approval] Create a GitHub issue.",
          },
        ],
      });

      const materialized = (await dynamic.events["step.started"]?.({}, ctx as never)) as Record<
        string,
        DynamicToolEntry
      >;
      const read = materialized["eve:absolute:github__search_issues"]!;
      const write = materialized["eve:absolute:github__create_issue"]!;
      const persisted = [
        {
          callbacks: validateDurableDynamicToolCallbacks("github__search_issues", read),
          description: read.description,
          entryKey: "eve:absolute:github__search_issues",
          inputSchema: read.inputSchema,
          name: "github__search_issues",
          resolverSlug: "connectors",
        },
        {
          callbacks: validateDurableDynamicToolCallbacks("github__create_issue", write),
          description: write.description,
          entryKey: "eve:absolute:github__create_issue",
          inputSchema: write.inputSchema,
          name: "github__create_issue",
          resolverSlug: "connectors",
        },
      ];
      const checkpoint = JSON.parse(JSON.stringify(persisted));
      expect(JSON.stringify(checkpoint)).not.toContain("token-a");
      expect(Object.keys(checkpoint[1].callbacks).sort()).toEqual([
        "approvalRequest",
        "approvalResponse",
        "execute",
      ]);

      // A new worker starts with an empty callback registry. Re-resolving the
      // same durable working set rebinds the current implementations by tool
      // name and phase before replaying the JSON checkpoint.
      Reflect.set(globalThis, Symbol.for("eve:dynamic-tool-callbacks"), new Map());
      const rebound = (await dynamic.events["step.started"]?.({}, ctx as never)) as Record<
        string,
        DynamicToolEntry
      >;
      validateDurableDynamicToolCallbacks(
        "github__search_issues",
        rebound["eve:absolute:github__search_issues"]!,
      );
      validateDurableDynamicToolCallbacks(
        "github__create_issue",
        rebound["eve:absolute:github__create_issue"]!,
      );

      const [replayedRead, replayedWrite] = replayDynamicTools(checkpoint as never);
      const readApproval =
        typeof replayedRead!.approval === "function"
          ? replayedRead!.approval
          : replayedRead!.approval!.request;
      const writeApproval =
        typeof replayedWrite!.approval === "function"
          ? replayedWrite!.approval
          : replayedWrite!.approval!.request;
      expect(await readApproval({ toolName: replayedRead!.name } as never)).toBe("not-applicable");
      expect(await writeApproval({ toolName: replayedWrite!.name } as never)).toBe("user-approval");
      expect(typeof replayedWrite!.approval).toBe("object");
      await expect(
        typeof replayedWrite!.approval === "function"
          ? Promise.reject(new Error("Expected approval response policy."))
          : replayedWrite!.approval!.response!({
              responder: { principalId: "approver-a" },
            } as never),
      ).resolves.toEqual({ status: "allowed" });
      expect(replayedRead!.execute).toBeTypeOf("function");
      await expect(
        replayedRead!.execute!(
          { query: "durability" },
          { toolCallId: "read-call" } as never,
        ),
      ).resolves.toEqual([
        {
          type: "text",
          text: JSON.stringify({
            name: "github.search_issues",
            args: { query: "durability" },
          }),
        },
      ]);
    });
  });

  test("replays client tool search and a returned read-only tool across an Eve 0.49 restart", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });

    const [{ default: extension }, { default: dynamic }] = await Promise.all([
      import("../extension/extension.js"),
      import("../extension/tools/connectors.js"),
    ]);
    extension({
      getToken: () => "token-a",
      discovery: "client",
      baseUrl: server.url,
      includeStatus: false,
    });

    const container = new ContextContainer();
    await contextStorage.run(container, async () => {
      const ctx = resolveContext("principal-a");
      container.set(SessionKey, {
        sessionId: ctx.session.id,
        auth: ctx.session.auth,
        turn: { id: "client-durable-turn", sequence: 0 },
      });

      const first = (await dynamic.events["step.started"]?.({}, ctx as never)) as Record<
        string,
        DynamicToolEntry
      >;
      const marker = first.client_tool_search!;
      const persistedSearch = [
        {
          callbacks: validateDurableDynamicToolCallbacks(
            "openai__client_tool_search",
            marker,
          ),
          description: marker.description,
          entryKey: "client_tool_search",
          inputSchema: marker.inputSchema,
          name: "openai__client_tool_search",
          providerOptions: marker.providerOptions,
          resolverSlug: "connectors",
        },
      ];
      const searchCheckpoint = JSON.parse(JSON.stringify(persistedSearch));
      expect(JSON.stringify(searchCheckpoint)).not.toContain("token-a");
      expect(searchCheckpoint[0].callbacks).toEqual({
        execute: {
          closure: { maxMaterializedTools: 30, namespace: "" },
        },
      });

      Reflect.set(globalThis, Symbol.for("eve:dynamic-tool-callbacks"), new Map());
      const reboundSearch = (await dynamic.events["step.started"]?.(
        {},
        ctx as never,
      )) as Record<string, DynamicToolEntry>;
      validateDurableDynamicToolCallbacks(
        "openai__client_tool_search",
        reboundSearch.client_tool_search!,
      );

      const [replayedSearch] = replayDynamicTools(searchCheckpoint as never);
      await expect(
        replayedSearch!.execute!(
          {
            arguments: { keywords: "search issues", service: "github" },
            call_id: "provider-search-call",
          },
          { toolCallId: "search-call" } as never,
        ),
      ).resolves.toMatchObject({
        tools: [{ name: "github__search_issues", type: "function" }],
      });

      const materialized = (await dynamic.events["step.started"]?.({}, ctx as never)) as Record<
        string,
        DynamicToolEntry
      >;
      const read = materialized["eve:absolute:github__search_issues"]!;
      const persistedRead = [
        {
          callbacks: validateDurableDynamicToolCallbacks("github__search_issues", read),
          description: read.description,
          entryKey: "eve:absolute:github__search_issues",
          inputSchema: read.inputSchema,
          name: "github__search_issues",
          resolverSlug: "connectors",
        },
      ];
      const readCheckpoint = JSON.parse(JSON.stringify(persistedRead));

      Reflect.set(globalThis, Symbol.for("eve:dynamic-tool-callbacks"), new Map());
      const reboundRead = (await dynamic.events["step.started"]?.({}, ctx as never)) as Record<
        string,
        DynamicToolEntry
      >;
      validateDurableDynamicToolCallbacks(
        "github__search_issues",
        reboundRead["eve:absolute:github__search_issues"]!,
      );

      const [replayedRead] = replayDynamicTools(readCheckpoint as never);
      const readApproval =
        typeof replayedRead!.approval === "function"
          ? replayedRead!.approval
          : replayedRead!.approval!.request;
      expect(await readApproval({ toolName: replayedRead!.name } as never)).toBe(
        "not-applicable",
      );
      await expect(
        replayedRead!.execute!(
          { query: "durability" },
          { toolCallId: "read-call" } as never,
        ),
      ).resolves.toEqual([
        {
          type: "text",
          text: JSON.stringify({
            name: "github.search_issues",
            args: { query: "durability" },
          }),
        },
      ]);
    });
  });
});
