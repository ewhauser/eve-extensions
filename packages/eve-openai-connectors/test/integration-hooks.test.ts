import { afterEach, describe, expect, test, vi } from "vitest";

import { createConnectors, type Connectors } from "../extension/lib/connectors.js";
import { ConnectorAuthError, ConnectorToolError } from "../extension/lib/errors.js";
import type {
  ConnectorContext,
  ConnectorResolutionSummary,
  UpstreamTool,
} from "../extension/lib/types.js";
import { mergeConnectorWorkingSet } from "../extension/lib/working-set.js";
import { startFakeMcpServer, type FakeServer } from "./helpers/fake-server.js";

const CATALOG: UpstreamTool[] = [
  {
    name: "github.search_issues",
    description: "Search GitHub issues.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "google_drive.search_files",
    description: "Search Google Drive files.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "notion.create_page",
    description: "Create a Notion page.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

function makeCtx(principalId = "user-1", signal?: AbortSignal): ConnectorContext {
  const context: ConnectorContext = {
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
    ...(signal ? { abortSignal: signal } : {}),
  };
  return context;
}

const silentLogger = { warn: vi.fn(), error: vi.fn() };
let server: FakeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  silentLogger.warn.mockClear();
  silentLogger.error.mockClear();
});

function requestCount(target: FakeServer, method: string): number {
  return target.requests.filter((request) => request.method === method).length;
}

describe("bounded integration hooks", () => {
  test("excluded services fail closed across every discovery path and stale durable state", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const unrestricted = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      logger: silentLogger,
    });
    const staleSearch = await unrestricted.search(makeCtx(), {
      keywords: "files",
      service: "google_drive",
    });
    const staleWorkingSet = mergeConnectorWorkingSet(null, {
      authority: staleSearch.authority,
      catalogFingerprint: staleSearch.catalogFingerprint,
      items: staleSearch.items,
      source: "search",
      max: 30,
    });

    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      allowedServices: ["github", "google_drive", "notion"],
      excludedServices: [" Google_Drive "],
      discovery: "deferred",
      logger: silentLogger,
    });
    const search = await connectors.search(makeCtx(), { keywords: "", limit: 20 });
    expect(search.items.map((item) => item.service).sort()).toEqual(["github", "notion"]);

    const clientSearch = await connectors.clientSearch(
      makeCtx(),
      { keywords: "files", service: "google_drive" },
      "openai__",
    ).catch((error: Error) => error);
    expect(clientSearch).toBeInstanceOf(Error);
    expect(String(clientSearch)).toContain("Unknown service");

    const status = await connectors.status(makeCtx());
    expect(status.catalog).toMatchObject({
      ok: true,
      totalTools: 2,
      services: [{ service: "github", tools: 1 }, { service: "notion", tools: 1 }],
    });
    const session = await connectors.begin(makeCtx(), staleWorkingSet);
    expect(session?.deferred.map((item) => item.service).sort()).toEqual(["github", "notion"]);
    expect(session?.discovered).toEqual([]);

    const requestsBefore = server.requests.length;
    for (const name of [
      "google_drive.search_files",
      "google_drive_search_files",
      "apps_google_drive_search_files",
    ]) {
      await expect(connectors.call(makeCtx(), name, {})).rejects.toThrow("excluded");
    }
    expect(server.requests).toHaveLength(requestsBefore);
  });

  test("call input transformation receives the fresh descriptor immediately before execution", async () => {
    const order: string[] = [];
    let receivedName = "";
    let receivedInput: Record<string, unknown> | undefined;
    server = await startFakeMcpServer({
      tools: CATALOG,
      onCall: (name, input) => {
        order.push("call");
        receivedName = name;
        receivedInput = input;
        return { structuredContent: { ok: true } };
      },
    });
    let staleDescriptor: object | undefined;
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      transformCallInput: (_ctx, tool, input) => {
        order.push("transform");
        expect(tool).not.toBe(staleDescriptor);
        expect(tool.upstream).toBe("github.search_issues");
        expect(Object.isFrozen(input)).toBe(true);
        return { ...input, query: input.query === "__CURRENT_USER__" ? "me" : input.query };
      },
      logger: silentLogger,
    });
    const search = await connectors.search(makeCtx(), { keywords: "issues" });
    const item = search.items[0]!;
    staleDescriptor = { ...item };
    await expect(
      connectors.call(
        makeCtx(),
        item.upstream,
        { query: "__CURRENT_USER__" },
        staleDescriptor as typeof item,
      ),
    ).resolves.toEqual({ ok: true });
    expect(order).toEqual(["transform", "call"]);
    expect(receivedName).toBe("github.search_issues");
    expect(receivedInput).toEqual({ query: "me" });

    const authCallback = vi.fn();
    const throwing = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      transformCallInput: () => {
        throw new ConnectorAuthError("local transform rejected input");
      },
      onAuthError: authCallback,
      logger: silentLogger,
    });
    const throwingItem = (await throwing.search(makeCtx(), { keywords: "issues" })).items[0]!;
    const callsBefore = requestCount(server, "tools/call");
    await expect(
      throwing.call(makeCtx(), throwingItem.upstream, {}, throwingItem),
    ).rejects.toThrow("local transform rejected input");
    expect(requestCount(server, "tools/call")).toBe(callsBefore);
    expect(authCallback).not.toHaveBeenCalled();
  });

  test.each([
    ["catalog listing", (connectors: Connectors, ctx: ConnectorContext) => connectors.begin(ctx)],
    ["ordinary search", (connectors: Connectors, ctx: ConnectorContext) => connectors.search(ctx, { keywords: "issues" })],
    ["client search", (connectors: Connectors, ctx: ConnectorContext) => connectors.clientSearch(ctx, { keywords: "issues" }, "openai__")],
    ["status", (connectors: Connectors, ctx: ConnectorContext) => connectors.status(ctx)],
  ])("auth rejection from %s invalidates first and preserves the original error", async (_name, invoke) => {
    let rejectList = true;
    server = await startFakeMcpServer({
      tools: CATALOG,
      sessionId: "auth-session",
      rejectStatus: (method) => (rejectList && method === "tools/list" ? 401 : undefined),
    });
    const callback = vi.fn((_ctx: ConnectorContext, error: ConnectorAuthError) => {
      expect(error).toBeInstanceOf(ConnectorAuthError);
      rejectList = false;
      throw new Error("callback failure must stay hidden");
    });
    const connectors = createConnectors({
      getToken: () => "super-secret-token",
      baseUrl: server.url,
      onAuthError: callback,
      logger: silentLogger,
    });
    const ctx = makeCtx();
    const outcome = await invoke(connectors, ctx).catch((error: Error) => error);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toBe(ctx);
    expect(JSON.stringify(callback.mock.calls[0])).not.toContain("super-secret-token");
    expect(JSON.stringify(callback.mock.calls[0])).not.toContain("issues");
    if (outcome instanceof Error) {
      expect(outcome).toBeInstanceOf(ConnectorAuthError);
      expect(outcome.message).not.toContain("callback failure");
    }

    await expect(connectors.search(makeCtx(), { keywords: "issues" })).resolves.toMatchObject({
      items: [{ upstream: "github.search_issues" }],
    });
    expect(requestCount(server, "tools/list")).toBe(2);
  });

  test("tool-call auth rejection invalidates catalog state before the callback", async () => {
    let rejectCall = false;
    server = await startFakeMcpServer({
      tools: CATALOG,
      sessionId: "call-auth-session",
      rejectStatus: (method) => (rejectCall && method === "tools/call" ? 403 : undefined),
    });
    const callback = vi.fn(() => {
      rejectCall = false;
      throw new Error("do not replace auth error");
    });
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      onAuthError: callback,
      logger: silentLogger,
    });
    const item = (await connectors.search(makeCtx(), { keywords: "issues" })).items[0]!;
    rejectCall = true;
    await expect(connectors.call(makeCtx(), item.upstream, {}, item)).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    await expect(connectors.call(makeCtx(), item.upstream, {}, item)).resolves.toBeDefined();
    expect(requestCount(server, "tools/list")).toBe(2);
  });

  test("auth state is already invalidated while an async callback refreshes credentials", async () => {
    let rejectList = true;
    server = await startFakeMcpServer({
      tools: CATALOG,
      rejectStatus: (method) => (rejectList && method === "tools/list" ? 401 : undefined),
    });
    let refreshedDuringCallback = false;
    let connectors!: Connectors;
    connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      onAuthError: async () => {
        rejectList = false;
        const refreshed = await connectors.search(makeCtx(), { keywords: "issues" });
        refreshedDuringCallback = refreshed.items[0]?.upstream === "github.search_issues";
      },
      logger: silentLogger,
    });
    await expect(connectors.search(makeCtx(), { keywords: "issues" })).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
    expect(refreshedDuringCallback).toBe(true);
    expect(requestCount(server, "tools/list")).toBe(2);
  });

  test("a stale auth rejection cannot evict or report a rotated credential", async () => {
    let token = "old-token";
    server = await startFakeMcpServer({
      tools: CATALOG,
      rejectStatus: (method, authorization) =>
        method === "tools/list" && authorization === "Bearer old-token" ? 401 : undefined,
      rejectDelayMs: 200,
    });
    const callback = vi.fn();
    const connectors = createConnectors({
      getToken: () => token,
      baseUrl: server.url,
      onAuthError: callback,
      logger: silentLogger,
    });
    const stale = connectors.search(makeCtx(), { keywords: "issues" });
    await vi.waitFor(() => expect(requestCount(server!, "tools/list")).toBe(1));
    token = "new-token";
    await expect(connectors.search(makeCtx(), { keywords: "issues" })).resolves.toBeDefined();
    await expect(stale).rejects.toBeInstanceOf(ConnectorAuthError);
    expect(callback).not.toHaveBeenCalled();

    const listCallsBefore = requestCount(server, "tools/list");
    await expect(connectors.search(makeCtx(), { keywords: "issues" })).resolves.toBeDefined();
    expect(requestCount(server, "tools/list")).toBe(listCallsBefore);
  });

  test("resolution diagnostics are once-only, bounded, and callback-safe", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const summaries: ConnectorResolutionSummary[] = [];
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      onResolution: (_ctx, summary) => {
        summaries.push(summary);
        throw new Error("diagnostic sink unavailable");
      },
      logger: silentLogger,
    });
    await expect(connectors.begin(makeCtx())).resolves.not.toBeNull();
    expect(summaries).toEqual([
      {
        status: "available",
        discovery: "client",
        catalogToolCount: 3,
        materializedToolCount: 0,
      },
    ]);
    expect(Object.keys(summaries[0]!).sort()).toEqual([
      "catalogToolCount",
      "discovery",
      "materializedToolCount",
      "status",
    ]);
    expect(JSON.stringify(summaries)).not.toMatch(/token|principal|schema|github|query/i);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      "eve-openai-connectors: onResolution callback failed.",
    );

    const unavailable: ConnectorResolutionSummary[] = [];
    const disabled = createConnectors({
      getToken: () => "unused",
      enabled: false,
      onResolution: (_ctx, summary) => {
        unavailable.push(summary);
      },
      logger: silentLogger,
    });
    await expect(disabled.begin(makeCtx())).resolves.toBeNull();
    expect(unavailable).toEqual([
      { status: "unavailable", discovery: "client", catalogToolCount: 0, materializedToolCount: 0 },
    ]);
  });

  test("deferred resolution reports a degraded search fallback", async () => {
    const summaries: ConnectorResolutionSummary[] = [];
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: "http://127.0.0.1:9/mcp",
      discovery: "deferred",
      onResolution: (_ctx, summary) => {
        summaries.push(summary);
      },
      logger: silentLogger,
    });
    await expect(connectors.begin(makeCtx())).resolves.not.toBeNull();
    expect(summaries).toEqual([
      { status: "degraded", discovery: "search", catalogToolCount: 0, materializedToolCount: 0 },
    ]);
  });
});

describe("operation-scoped protocol clients and cancellation", () => {
  test("closes sessions after success and upstream tool errors", async () => {
    let toolError = false;
    server = await startFakeMcpServer({
      tools: CATALOG,
      sessionId: "operation-session",
      onCall: () =>
        toolError
          ? { isError: true, content: [{ type: "text", text: "upstream failed" }] }
          : { structuredContent: { ok: true } },
    });
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      protocolClientLifetime: "operation",
      logger: silentLogger,
    });
    const item = (await connectors.search(makeCtx(), { keywords: "issues" })).items[0]!;
    expect(requestCount(server, "session/delete")).toBe(1);
    await expect(connectors.call(makeCtx(), item.upstream, {}, item)).resolves.toEqual({ ok: true });
    expect(requestCount(server, "session/delete")).toBe(2);

    toolError = true;
    await expect(connectors.call(makeCtx(), item.upstream, {}, item)).rejects.toBeInstanceOf(
      ConnectorToolError,
    );
    expect(requestCount(server, "session/delete")).toBe(3);
    expect(requestCount(server, "initialize")).toBe(3);
  });

  test("closes after auth rejection and does not retain the rejected inventory", async () => {
    let rejectList = true;
    server = await startFakeMcpServer({
      tools: CATALOG,
      sessionId: "operation-auth-session",
      rejectStatus: (method) => (rejectList && method === "tools/list" ? 401 : undefined),
    });
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      protocolClientLifetime: "operation",
      onAuthError: () => {
        rejectList = false;
      },
      logger: silentLogger,
    });
    await expect(connectors.search(makeCtx(), { keywords: "issues" })).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
    expect(requestCount(server, "session/delete")).toBe(1);
    await expect(connectors.search(makeCtx(), { keywords: "issues" })).resolves.toBeDefined();
    expect(requestCount(server, "tools/list")).toBe(2);
    expect(requestCount(server, "session/delete")).toBe(2);
  });

  test("cancellation closes the session and never poisons the next inventory load", async () => {
    server = await startFakeMcpServer({
      tools: CATALOG,
      sessionId: "operation-abort-session",
      listDelayMs: 200,
    });
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      protocolClientLifetime: "operation",
      logger: silentLogger,
    });
    const controller = new AbortController();
    const cancelled = connectors.search(makeCtx("user-1", controller.signal), {
      keywords: "issues",
    });
    await vi.waitFor(() => expect(requestCount(server!, "tools/list")).toBe(1));
    controller.abort();
    await expect(cancelled).rejects.toBeDefined();
    expect(requestCount(server, "session/delete")).toBe(1);

    await expect(connectors.search(makeCtx(), { keywords: "issues" })).resolves.toBeDefined();
    expect(requestCount(server, "tools/list")).toBe(2);
    expect(requestCount(server, "session/delete")).toBe(2);
  });

  test("an aborted waiter stops without cancelling another caller's shared catalog load", async () => {
    server = await startFakeMcpServer({ tools: CATALOG, listDelayMs: 200 });
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      logger: silentLogger,
    });
    const shared = connectors.search(makeCtx(), { keywords: "issues" });
    await vi.waitFor(() => expect(requestCount(server!, "tools/list")).toBe(1));
    const controller = new AbortController();
    const cancelledWaiter = connectors.search(makeCtx("user-1", controller.signal), {
      keywords: "issues",
    });
    controller.abort();
    await expect(cancelledWaiter).rejects.toBeDefined();
    await expect(shared).resolves.toBeDefined();
    expect(requestCount(server, "tools/list")).toBe(1);
    await expect(connectors.search(makeCtx(), { keywords: "issues" })).resolves.toBeDefined();
    expect(requestCount(server, "tools/list")).toBe(1);
  });

  test("an aborted begin degrades the current step without poisoning the next step", async () => {
    server = await startFakeMcpServer({
      tools: CATALOG,
      sessionId: "operation-begin-abort-session",
      listDelayMs: 200,
    });
    const summaries: ConnectorResolutionSummary[] = [];
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      protocolClientLifetime: "operation",
      onResolution: (_ctx, summary) => {
        summaries.push(summary);
      },
      logger: silentLogger,
    });
    const controller = new AbortController();
    const first = connectors.begin(makeCtx("user-1", controller.signal));
    await vi.waitFor(() => expect(requestCount(server!, "tools/list")).toBe(1));
    controller.abort();
    await expect(first).resolves.toMatchObject({ catalogFingerprint: null });
    expect(summaries).toEqual([
      { status: "degraded", discovery: "client", catalogToolCount: 0, materializedToolCount: 0 },
    ]);
    expect(requestCount(server, "session/delete")).toBe(1);

    await expect(connectors.begin(makeCtx())).resolves.toMatchObject({
      catalogFingerprint: expect.any(String),
    });
    expect(requestCount(server, "tools/list")).toBe(2);
    expect(requestCount(server, "session/delete")).toBe(2);
  });

  test("tool-call cancellation closes its operation-scoped session", async () => {
    server = await startFakeMcpServer({
      tools: CATALOG,
      sessionId: "operation-call-abort-session",
      callDelayMs: 200,
    });
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      protocolClientLifetime: "operation",
      logger: silentLogger,
    });
    const item = (await connectors.search(makeCtx(), { keywords: "issues" })).items[0]!;
    const controller = new AbortController();
    const cancelled = connectors.call(
      makeCtx("user-1", controller.signal),
      item.upstream,
      {},
      item,
    );
    await vi.waitFor(() => expect(requestCount(server!, "tools/call")).toBe(1));
    controller.abort();
    await expect(cancelled).rejects.toBeDefined();
    expect(requestCount(server, "session/delete")).toBe(2);
  });

  test.each([
    ["client search", (connectors: Connectors, ctx: ConnectorContext) => connectors.clientSearch(ctx, { keywords: "issues" }, "openai__")],
    ["status", (connectors: Connectors, ctx: ConnectorContext) => connectors.status(ctx)],
  ])("%s cancellation is propagated and not negatively cached", async (_name, invoke) => {
    server = await startFakeMcpServer({
      tools: CATALOG,
      sessionId: "operation-extra-abort-session",
      listDelayMs: 200,
    });
    const connectors = createConnectors({
      getToken: () => "token-a",
      baseUrl: server.url,
      protocolClientLifetime: "operation",
      logger: silentLogger,
    });
    const controller = new AbortController();
    const first = invoke(connectors, makeCtx("user-1", controller.signal));
    await vi.waitFor(() => expect(requestCount(server!, "tools/list")).toBe(1));
    controller.abort();
    const outcome = await first.catch((error: Error) => error);
    if (outcome instanceof Error) expect(outcome).toBeDefined();
    else expect(outcome).toMatchObject({ catalog: { ok: false } });
    expect(requestCount(server, "session/delete")).toBe(1);

    await expect(connectors.search(makeCtx(), { keywords: "issues" })).resolves.toBeDefined();
    expect(requestCount(server, "tools/list")).toBe(2);
    expect(requestCount(server, "session/delete")).toBe(2);
  });
});
