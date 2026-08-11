import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createConnectors } from "../extension/lib/connectors.js";
import { ConnectorToolError } from "../extension/lib/errors.js";
import type { ConnectorContext, ConnectorToolItem, UpstreamTool } from "../extension/lib/types.js";
import { startFakeMcpServer, type FakeServer } from "./helpers/fake-server.js";

const CATALOG = (
  JSON.parse(
    readFileSync(join(__dirname, "fixtures", "catalog.synthetic.json"), "utf8"),
  ) as { tools: UpstreamTool[] }
).tools;

/** A port nothing listens on — catalog loads fail fast with ECONNREFUSED. */
const DEAD_URL = "http://127.0.0.1:9/mcp";

type Ctx = ConnectorContext & { messages?: readonly unknown[] };

function makeCtx(messages: readonly unknown[] = []): Ctx {
  return {
    session: {
      id: "session-1",
      auth: {
        current: {
          attributes: {},
          authenticator: "test-idp",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
    },
    messages,
  };
}

function discoveredMessage(items: ConnectorToolItem[], toolName = "apps_search") {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "c1", toolName, output: { type: "json", value: items } },
    ],
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

  test("a failing catalog degrades apps_search but keeps discovered tools callable", async () => {
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: DEAD_URL,
      logger: silentLogger,
    });
    const session = await connectors.begin(makeCtx([discoveredMessage([searchItem])]));
    expect(session).not.toBeNull();
    expect(session?.searchToolDescription).toContain("temporarily unavailable");
    expect(session?.discovered).toHaveLength(1);
    expect(session?.discovered[0]?.upstream).toBe("github.search_issues");
  });

  test("happy path: description lists services, discovered capped most-recent-first", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...searchItem,
      name: `apps_tool_${i}`,
      upstream: `svc.tool_${i}`,
    }));
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      maxMaterializedTools: 3,
      logger: silentLogger,
    });
    const session = await connectors.begin(makeCtx([discoveredMessage(many)]));
    expect(session?.searchToolName).toBe("apps_search");
    expect(session?.searchToolDescription).toContain("github (4)");
    expect(session?.searchToolDescription).toContain("google_drive (2)");
    expect(session?.discovered.map((item) => item.name)).toEqual([
      "apps_tool_4",
      "apps_tool_3",
      "apps_tool_2",
    ]);
  });

  test("a custom prefix flows through search tool name and discovery", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      toolPrefix: "gpt_",
      logger: silentLogger,
    });
    const session = await connectors.begin(
      makeCtx([discoveredMessage([{ ...searchItem, name: "gpt_github_search_issues" }], "gpt_search")]),
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
    const fallback = await cold.begin(makeCtx([discoveredMessage([searchItem])]));
    expect(fallback?.deferred).toHaveLength(0);
    expect(fallback?.discovered).toHaveLength(1);
    expect(fallback?.searchToolDescription).toContain("temporarily unavailable");
  });

  test("search mode never populates deferred", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      logger: silentLogger,
    });
    const session = await connectors.begin(makeCtx());
    expect(session?.deferred).toHaveLength(0);
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
  test("search maps names, tags writes, and filters by service", async () => {
    server = await startFakeMcpServer({ tools: CATALOG });
    const connectors = createConnectors({
      getToken: () => "tok",
      baseUrl: server.url,
      logger: silentLogger,
    });
    const results = await connectors.search(makeCtx(), { keywords: "search issues", service: "github" });
    expect(results[0]?.name).toBe("apps_github_search_issues");
    expect(results[0]?.upstream).toBe("github.search_issues");

    const writes = await connectors.search(makeCtx(), { keywords: "create issue" });
    const create = writes.find((item) => item.upstream === "github.create_issue");
    expect(create?.description).toContain("[write — requires approval]");
    const destructive = await connectors.search(makeCtx(), { keywords: "delete branch" });
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

    const results = await connectors.search(makeCtx(), { keywords: "" });
    expect(results.every((item) => item.service === "github")).toBe(true);
    const replayed = await connectors.begin(
      makeCtx([
        discoveredMessage([
          {
            ...searchItem,
            name: "apps_google_drive_search_files",
            upstream: "google_drive.search_files",
            service: "google_drive",
          },
        ]),
      ]),
    );
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
    const results = await connectors.search(makeCtx(), { keywords: "hotline annotations" });
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
