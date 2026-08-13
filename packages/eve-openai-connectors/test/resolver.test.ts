import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getConnectorCacheMetrics } from "../extension/lib/cache.js";
import { createConnectors } from "../extension/lib/connectors.js";
import { ConnectorToolError } from "../extension/lib/errors.js";
import type { ConnectorContext, ConnectorToolItem, UpstreamTool } from "../extension/lib/types.js";
import { mergeConnectorWorkingSet } from "../extension/lib/working-set.js";
import { startFakeMcpServer, type FakeServer } from "./helpers/fake-server.js";

const CATALOG = (
  JSON.parse(
    readFileSync(join(__dirname, "fixtures", "catalog.synthetic.json"), "utf8"),
  ) as { tools: UpstreamTool[] }
).tools;

/** A port nothing listens on — catalog loads fail fast with ECONNREFUSED. */
const DEAD_URL = "http://127.0.0.1:9/mcp";

type Ctx = ConnectorContext;

function makeCtx(_messages: readonly unknown[] = [], principalId = "user-1"): Ctx {
  return {
    session: {
      id: "session-1",
      auth: {
        current: {
          attributes: {},
          authenticator: "test-idp",
          principalId,
          principalType: "user",
        },
        initiator: null,
      },
    },
  };
}

const searchItem: ConnectorToolItem = {
  name: "apps_github_search_issues",
  upstream: "github.search_issues",
  service: "github",
  description: "Search issues.",
  inputSchema: { type: "object" },
  readOnly: true,
  destructive: false,
};

const silentLogger = { warn: vi.fn(), error: vi.fn() };

let server: FakeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  silentLogger.warn.mockClear();
  silentLogger.error.mockClear();
});

describe("begin() — the step.started contract (never throws)", () => {
  test("returns null when disabled, without touching getToken", async () => {
    const getToken = vi.fn();
    const connectors = createConnectors({ getToken, enabled: false, logger: silentLogger });
    expect(await connectors.begin(makeCtx())).toBeNull();
    expect(getToken).not.toHaveBeenCalled();
  });

  test("returns null when there is no principal", async () => {
    const getToken = vi.fn();
    const connectors = createConnectors({ getToken, baseUrl: DEAD_URL, logger: silentLogger });
    const ctx: Ctx = { session: { id: "s", auth: { current: null, initiator: null } } };
    expect(await connectors.begin(ctx)).toBeNull();
    expect(getToken).not.toHaveBeenCalled();
  });

  test("returns null when getToken yields null, without touching the network", async () => {
    const connectors = createConnectors({
      getToken: () => null,
      baseUrl: DEAD_URL,
      logger: silentLogger,
    });
    expect(await connectors.begin(makeCtx())).toBeNull();
  });

  test("a throwing getToken is treated as null and logged once per principal", async () => {
    const connectors = createConnectors({
      getToken: () => {
        throw new Error("secret store down");
      },
      baseUrl: DEAD_URL,
      logger: silentLogger,
    });
    expect(await connectors.begin(makeCtx())).toBeNull();
    expect(await connectors.begin(makeCtx())).toBeNull();
    expect(silentLogger.error).toHaveBeenCalledTimes(1);
    expect(String(silentLogger.error.mock.calls[0]?.[0])).not.toContain("Bearer");
  });

  test("a failing catalog degrades apps_search and fails closed on durable references", async () => {
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: DEAD_URL,
      logger: silentLogger,
    });
    const session = await connectors.begin(makeCtx(), {
      version: 1,
      authority: "user:test-idp:user-1",
      catalogFingerprint: "previous",
      tools: [{ name: searchItem.name, upstream: searchItem.upstream, source: "search" }],
    });
    expect(session).not.toBeNull();
    expect(session?.searchToolDescription).toContain("temporarily unavailable");
    expect(session?.discovered).toEqual([]);
  });

  test("happy path: description lists services and durable discoveries stay bounded", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      maxMaterializedTools: 3,
      logger: silentLogger,
    });
    const search = await connectors.search(makeCtx(), { keywords: "" });
    const workingSet = mergeConnectorWorkingSet(null, {
      authority: "user:test-idp:user-1",
      catalogFingerprint: search.catalogFingerprint,
      items: search.items,
      source: "search",
      max: 3,
    });
    const session = await connectors.begin(makeCtx(), workingSet);
    expect(session?.searchToolName).toBe("apps_search");
    expect(session?.searchToolDescription).toContain("github (4)");
    expect(session?.searchToolDescription).toContain("google_drive (2)");
    expect(session?.discovered).toHaveLength(3);
    expect(session?.discovered.map((item) => item.name)).toEqual(
      search.items.slice(0, 3).map((item) => item.name),
    );
  });

  test("a custom prefix flows through search tool name and discovery", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      toolPrefix: "gpt_",
      logger: silentLogger,
    });
    const search = await connectors.search(makeCtx(), { keywords: "search issues" });
    const session = await connectors.begin(
      makeCtx(),
      mergeConnectorWorkingSet(null, {
        authority: "user:test-idp:user-1",
        catalogFingerprint: search.catalogFingerprint,
        items: search.items,
        source: "search",
        max: 30,
      }),
    );
    expect(session?.searchToolName).toBe("gpt_search");
    expect(session?.discovered[0]?.name).toBe("gpt_github_search_issues");
  });

  test("deferred discovery exposes the full catalog and falls back when unavailable", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      discovery: "deferred",
      logger: silentLogger,
    });
    const session = await connectors.begin(makeCtx());
    expect(session?.deferred).toHaveLength(CATALOG.length);
    expect(session?.deferred.map((item) => item.name)).toContain("apps_github_search_issues");

    const cold = createConnectors({
      getToken: () => "tok",
      baseUrl: DEAD_URL,
      discovery: "deferred",
      logger: silentLogger,
    });
    const fallback = await cold.begin(makeCtx(), {
      version: 1,
      authority: "user:test-idp:user-1",
      catalogFingerprint: session?.catalogFingerprint ?? "previous",
      tools: [{ name: searchItem.name, upstream: searchItem.upstream, source: "search" }],
    });
    expect(fallback?.deferred).toHaveLength(0);
    expect(fallback?.discovered).toHaveLength(0);
    expect(fallback?.searchToolDescription).toContain("temporarily unavailable");
  });

  test("client mode is the default and never exposes the full deferred catalog", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      logger: silentLogger,
    });
    const session = await connectors.begin(makeCtx());
    expect(session?.deferred).toHaveLength(0);
    expect(session?.clientSearchEnabled).toBe(true);
    expect(session?.loaded).toEqual([]);
  });

  test("getPrincipal override enables auth-less deployments", async () => {
    const connectors = createConnectors({
      getToken: () => "tok",
      getPrincipal: () => "dev",
      baseUrl: DEAD_URL,
      logger: silentLogger,
    });
    const ctx: Ctx = { session: { id: "s", auth: { current: null, initiator: null } } };
    const session = await connectors.begin(ctx);
    expect(session?.principal).toBe("dev");
  });
});

describe("search / call / status against a live (fake) catalog", () => {
  test("client search loads a bounded exact subset and a cold worker rebuilds it from state", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      searchLimitMax: 2,
      logger: silentLogger,
    });
    const result = await connectors.clientSearch(
      makeCtx(),
      {
        arguments: { keywords: "search github", service: "github", limit: 25 },
        call_id: "call_123",
      },
      "openai__",
    );
    const output = result.output;
    expect(output.tools).toHaveLength(2);
    expect(output.tools.every((tool) => tool.name.startsWith("openai__apps_github_"))).toBe(true);
    expect(output.tools.every((tool) => tool.description.includes("[eve catalog: "))).toBe(true);

    const workingSet = mergeConnectorWorkingSet(null, {
      authority: "user:test-idp:user-1",
      catalogFingerprint: result.catalogFingerprint,
      items: result.items,
      source: "client",
      max: 30,
    });
    const restarted = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      searchLimitMax: 2,
      logger: silentLogger,
    });
    const replay = await restarted.begin(makeCtx(), workingSet);
    expect(replay?.loaded.map((entry) => entry.item.name)).toEqual(
      result.items.map((item) => item.name),
    );
    expect(replay?.loaded.map((entry) => entry.description)).toEqual(
      output.tools.map((tool) => tool.description),
    );
  });

  test("client search handles no matches, malformed input, authorization, and output budgets", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      clientSearchMaxBytes: 12,
      logger: silentLogger,
    });
    await expect(
      connectors.clientSearch(makeCtx(), { keywords: "no-such-capability" }, "openai__"),
    ).resolves.toMatchObject({ output: { tools: [] }, items: [] });
    await expect(
      connectors.clientSearch(
        makeCtx(),
        { arguments: { keywords: "search" }, call_id: "" },
        "openai__",
      ),
    ).rejects.toThrow(/call_id/);
    await expect(
      connectors.clientSearch(makeCtx(), { keywords: "search", service: "slack" }, "openai__"),
    ).rejects.toThrow(/Unknown service/);
    await expect(
      connectors.clientSearch(makeCtx(), { keywords: "search" }, "openai__"),
    ).resolves.toMatchObject({ output: { tools: [] }, items: [] });

    const noToken = createConnectors({ getToken: () => null, logger: silentLogger });
    await expect(
      noToken.clientSearch(makeCtx(), { keywords: "search" }, "openai__"),
    ).rejects.toThrow(/no access token/);
  });

  test("client search failures and latency overruns fail without exposing a catalog", async () => {
    const failing = createConnectors({
      getToken: () => "tok",
      baseUrl: DEAD_URL,
      logger: silentLogger,
    });
    await expect(
      failing.clientSearch(makeCtx(), { keywords: "search" }, "openai__"),
    ).rejects.toThrow();

    server = await startFakeMcpServer({ tools: CATALOG, listDelayMs: 50 });
    const slow = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      clientSearchTimeoutMs: 5,
      logger: silentLogger,
    });
    await expect(
      slow.clientSearch(makeCtx(), { keywords: "search" }, "openai__"),
    ).rejects.toThrow(/5ms latency budget/);
  });

  test("search maps names, tags writes, and filters by service", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      logger: silentLogger,
    });
    const { items: results, output } = await connectors.search(makeCtx(), {
      keywords: "search issues",
      service: "github",
    });
    expect(results[0]?.name).toBe("apps_github_search_issues");
    expect(results[0]?.upstream).toBe("github.search_issues");
    expect(output.loaded[0]).toEqual({
      name: "apps_github_search_issues",
      summary: "Search issues and pull requests in GitHub repositories.",
    });
    expect(JSON.stringify(output)).not.toContain("inputSchema");

    const { items: writes } = await connectors.search(makeCtx(), { keywords: "create issue" });
    const create = writes.find((item) => item.upstream === "github.create_issue");
    expect(create?.description).toContain("[write — requires approval]");
    const { items: destructive } = await connectors.search(makeCtx(), {
      keywords: "delete branch",
    });
    expect(destructive[0]?.description).toContain("[destructive write — requires approval]");

    await expect(
      connectors.search(makeCtx(), { keywords: "x", service: "nope" }),
    ).rejects.toThrow(/Available services: .*github/);
  });

  test("allowedServices restricts discovery, status, and direct calls", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      discovery: "deferred",
      allowedServices: [" GitHub "],
      logger: silentLogger,
    });

    const session = await connectors.begin(makeCtx());
    expect(session?.deferred.length).toBeGreaterThan(0);
    expect(session?.deferred.every((item) => item.service === "github")).toBe(true);
    expect(session?.searchToolDescription).not.toContain("google_drive");

    const { items: results } = await connectors.search(makeCtx(), { keywords: "" });
    expect(results.every((item) => item.service === "github")).toBe(true);
    const replayed = await connectors.begin(makeCtx(), {
      version: 1,
      authority: "user:test-idp:user-1",
      catalogFingerprint: session?.catalogFingerprint ?? "",
      tools: [
        {
          name: "apps_google_drive_search_files",
          upstream: "google_drive.search_files",
          source: "search",
        },
      ],
    });
    expect(replayed?.discovered).toEqual([]);
    expect(await connectors.status(makeCtx())).toMatchObject({
      catalog: { ok: true, services: [{ service: "github", tools: 4 }] },
    });

    const callsBefore = server.requests.filter((request) => request.method === "tools/call").length;
    await expect(connectors.call(makeCtx(), "google_drive.search_files", {})).rejects.toThrow(
      /not allowed/,
    );
    expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(callsBefore);
  });

  test("missing annotations surface as destructive and require approval", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      logger: silentLogger,
    });
    const { items: results } = await connectors.search(makeCtx(), {
      keywords: "hotline annotations",
    });
    const hotline = results.find((item) => item.upstream === "hotline.call");
    expect(hotline).toMatchObject({ readOnly: false, destructive: true });
  });

  test("call returns structuredContent ?? content and maps isError to a thrown error", async () => {
    server = await startFakeMcpServer({
      tools: CATALOG,
      onCall: (name) =>
        name === "github.search_issues"
          ? { structuredContent: { issues: [1, 2] }, content: [{ type: "text", text: "raw" }] }
          : { isError: true, content: [{ type: "text", text: "workspace admin says no" }] },
    });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      logger: silentLogger,
    });
    await expect(connectors.call(makeCtx(), "github.search_issues", {})).resolves.toEqual({
      issues: [1, 2],
    });
    await expect(connectors.call(makeCtx(), "github.delete_branch", {})).rejects.toThrow(
      ConnectorToolError,
    );
    await expect(connectors.call(makeCtx(), "github.delete_branch", {})).rejects.toThrow(
      /workspace admin says no/,
    );
  });

  test("status reports catalog health", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      logger: silentLogger,
    });
    const status = await connectors.status(makeCtx());
    expect(status.tokenPresent).toBe(true);
    expect(status.catalog).toMatchObject({ ok: true, totalTools: CATALOG.length });
    expect(status.cache).toMatchObject({
      hits: expect.any(Number),
      misses: expect.any(Number),
      entries: expect.any(Number),
      estimatedBytes: expect.any(Number),
    });

    const noToken = createConnectors({ getToken: () => null, logger: silentLogger });
    expect((await noToken.status(makeCtx())).tokenPresent).toBe(false);
  });

  test("concurrent searches share one catalog load", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      logger: silentLogger,
    });
    await Promise.all([
      connectors.search(makeCtx(), { keywords: "search" }),
      connectors.search(makeCtx(), { keywords: "create" }),
      connectors.search(makeCtx(), { keywords: "notion" }),
    ]);
    const listCalls = server.requests.filter((request) => request.method === "tools/list");
    expect(listCalls).toHaveLength(1);
  });
});

describe("catalog interning and authorization isolation", () => {
  test("many principals retain one large immutable catalog graph", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const largeCatalog: UpstreamTool[] = Array.from({ length: 120 }, (_, index) => ({
      name: `memory_${suffix}.tool_${index}`,
      description: `Synthetic memory regression tool ${index}.`,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 12 }, (__, field) => [
            `field_${field}`,
            { type: "string", description: `Field ${field} for tool ${index}.` },
          ]),
        ),
        required: ["field_0"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    }));
    server = await startFakeMcpServer({ tools: largeCatalog });
    const connectors = createConnectors({
      getToken: (ctx) => `token-${ctx.session.auth.current?.principalId ?? "unknown"}`,
      baseUrl: server.url,
      discovery: "deferred",
      logger: silentLogger,
    });
    const before = getConnectorCacheMetrics();
    const sessions = await Promise.all(
      Array.from({ length: 32 }, (_, index) => connectors.begin(makeCtx([], `user-${index}`))),
    );
    const deferred = sessions.map((session) => session?.deferred).filter((items) => items !== undefined);

    expect(deferred).toHaveLength(32);
    expect(new Set(deferred).size).toBe(1);
    expect(new Set(deferred.flatMap((items) => items)).size).toBe(largeCatalog.length);
    expect(new Set(deferred.flatMap((items) => items.map((item) => item.inputSchema))).size).toBe(
      largeCatalog.length,
    );
    const after = getConnectorCacheMetrics();
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBeGreaterThanOrEqual(31);
    expect(after.estimatedBytes - before.estimatedBytes).toBeGreaterThan(0);
  });

  test("credential invalidation and rotation refresh authorization but reuse unchanged content", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    let token: string | null = "token-a";
    const connectors = createConnectors({
      getToken: () => token,
      baseUrl: server.url,
      discovery: "deferred",
      logger: silentLogger,
    });

    const first = await connectors.begin(makeCtx());
    token = null;
    expect(await connectors.begin(makeCtx())).toBeNull();
    token = "token-b";
    const second = await connectors.begin(makeCtx());

    expect(second?.deferred).toBe(first?.deferred);
    expect(server.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
  });

  test("divergent catalogs and stale per-principal tools fail closed", async () => {
    const sharedRead: UpstreamTool = {
      name: "github.shared",
      description: "Shared tool.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    const sharedWrite: UpstreamTool = {
      ...sharedRead,
      annotations: { readOnlyHint: false, destructiveHint: false },
    };
    const privileged: UpstreamTool = {
      name: "github.admin_secret",
      description: "Privileged tool.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    server = await startFakeMcpServer({
      tools: (authorization) =>
        authorization === "Bearer token-a" ? [sharedRead, privileged] : [sharedWrite],
    });
    const connectors = createConnectors({
      getToken: (ctx) =>
        ctx.session.auth.current?.principalId === "user-a" ? "token-a" : "token-b",
      baseUrl: server.url,
      discovery: "deferred",
      logger: silentLogger,
    });
    const sessionA = await connectors.begin(makeCtx([], "user-a"));
    const sessionB = await connectors.begin(makeCtx([], "user-b"));
    const privilegedItem = sessionA?.deferred.find((item) => item.upstream === privileged.name);
    const staleSharedItem = sessionA?.deferred.find((item) => item.upstream === sharedRead.name);

    expect(sessionA?.deferred).not.toBe(sessionB?.deferred);
    expect(sessionB?.deferred.map((item) => item.upstream)).toEqual(["github.shared"]);
    expect(privilegedItem).toBeDefined();
    expect(staleSharedItem).toBeDefined();
    const callsBefore = server.requests.filter((request) => request.method === "tools/call").length;
    await expect(
      connectors.call(makeCtx([], "user-b"), privileged.name, {}, privilegedItem),
    ).rejects.toThrow(/not available to the current user/);
    await expect(
      connectors.call(makeCtx([], "user-b"), sharedRead.name, {}, staleSharedItem),
    ).rejects.toThrow(/changed since discovery/);
    expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(
      callsBefore,
    );
  });
});
