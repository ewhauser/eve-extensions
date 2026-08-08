import { afterEach, describe, expect, test } from "vitest";
import { ConnectorAuthError, ConnectorProtocolError } from "../extension/lib/errors.js";
import { createProtocolClient, parseSseResponse } from "../extension/lib/protocol.js";
import { startFakeMcpServer, type FakeServer } from "./helpers/fake-server.js";

const TOOLS = [
  { name: "github.search_issues", description: "Search issues.", annotations: { readOnlyHint: true } },
  { name: "github.create_issue", description: "Create an issue.", annotations: { readOnlyHint: false, destructiveHint: false } },
];

let server: FakeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("protocol client", () => {
  test("JSON response bodies: initialize → list → call round-trip", async () => {
    server = await startFakeMcpServer({ tools: TOOLS });
    const client = createProtocolClient({ baseUrl: server.url, token: "tok" });
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    const result = await client.callTool("github.search_issues", { query: "bug" });
    expect(result.content).toBeDefined();
    // The full handshake ran exactly once.
    expect(server.requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  });

  test("SSE response bodies parse identically", async () => {
    server = await startFakeMcpServer({ tools: TOOLS, sse: true });
    const client = createProtocolClient({ baseUrl: server.url, token: "tok" });
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
  });

  test("required headers are sent and the token never leaks into errors", async () => {
    server = await startFakeMcpServer({ tools: TOOLS });
    const client = createProtocolClient({ baseUrl: server.url, token: "sekret-token" });
    await client.listTools();
    const headers = server.requests[0]?.headers ?? {};
    expect(headers.authorization).toBe("Bearer sekret-token");
    expect(headers["x-openai-product-sku"]).toBe("codex");
    expect(headers.originator).toBe("codex_cli_rs");

    await server.close();
    server = await startFakeMcpServer({ rejectStatus: 500 });
    const failing = createProtocolClient({ baseUrl: server.url, token: "sekret-token" });
    const error = await failing.listTools().catch((e: Error) => e);
    expect(error).toBeInstanceOf(ConnectorProtocolError);
    expect(String(error)).not.toContain("sekret-token");
  });

  test("Mcp-Session-Id is echoed when present and omitted when absent", async () => {
    server = await startFakeMcpServer({ tools: TOOLS, sessionId: "sess-42" });
    const client = createProtocolClient({ baseUrl: server.url, token: "tok" });
    await client.listTools();
    const [first, ...rest] = server.requests;
    expect(first?.headers["mcp-session-id"]).toBeUndefined();
    for (const request of rest) {
      expect(request.headers["mcp-session-id"]).toBe("sess-42");
    }

    await server.close();
    server = await startFakeMcpServer({ tools: TOOLS });
    const noSession = createProtocolClient({ baseUrl: server.url, token: "tok" });
    await noSession.listTools();
    for (const request of server.requests) {
      expect(request.headers["mcp-session-id"]).toBeUndefined();
    }
  });

  test("HTTP 401 maps to ConnectorAuthError", async () => {
    server = await startFakeMcpServer({ rejectStatus: 401 });
    const client = createProtocolClient({ baseUrl: server.url, token: "tok" });
    await expect(client.listTools()).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  test("tools/list pagination is followed", async () => {
    server = await startFakeMcpServer({ tools: TOOLS, pageSize: 1 });
    const client = createProtocolClient({ baseUrl: server.url, token: "tok" });
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
  });

  test("a failed initialize is retried on the next operation", async () => {
    server = await startFakeMcpServer({ rejectStatus: 503 });
    const url = server.url;
    const client = createProtocolClient({ baseUrl: url, token: "tok" });
    await expect(client.listTools()).rejects.toBeInstanceOf(ConnectorProtocolError);
    await server.close();
    // Same address now healthy — the client must not be stuck on the failure.
    server = await startFakeMcpServer({ tools: TOOLS });
    const healthy = createProtocolClient({ baseUrl: server.url, token: "tok" });
    await expect(healthy.listTools()).resolves.toHaveLength(2);
  });
});

describe("SSE parsing", () => {
  test("takes the frame carrying result/error and matching id", () => {
    const body = [
      "event: ping",
      "data: {}",
      "",
      "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}",
      "",
      "data: [DONE]",
    ].join("\n");
    expect(parseSseResponse(body, 7)).toMatchObject({ result: { ok: true } });
    expect(parseSseResponse(body, 8)).toBeNull();
    expect(parseSseResponse("data: not-json\n", 1)).toBeNull();
  });
});
