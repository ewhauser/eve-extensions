import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { UpstreamTool } from "../../extension/lib/types.js";

export interface FakeServerOptions {
  /** Respond with `text/event-stream` bodies instead of JSON. */
  sse?: boolean;
  /** Return this `Mcp-Session-Id` header on every response. */
  sessionId?: string;
  /** Reject every request with this HTTP status (e.g. 401). */
  rejectStatus?: number;
  tools?: UpstreamTool[] | ((authorization: string | undefined) => UpstreamTool[]);
  /** tools/call handler; defaults to echoing the arguments. */
  onCall?(
    name: string,
    args: Record<string, unknown>,
    authorization: string | undefined,
  ): unknown;
  /** Paginate tools/list into chunks of this size. */
  pageSize?: number;
  /** Delay tools/list responses to exercise client-side latency budgets. */
  listDelayMs?: number;
}

export interface FakeServer {
  url: string;
  /** All request headers seen, in order. */
  requests: Array<{ method: string; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}

export async function startFakeMcpServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  const toolsFor = (authorization: string | undefined): UpstreamTool[] =>
    typeof options.tools === "function" ? options.tools(authorization) : (options.tools ?? []);

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const envelope = body ? (JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { cursor?: string; name?: string; arguments?: Record<string, unknown> };
      }) : { method: "" };
      requests.push({ method: envelope.method, headers: req.headers });

      if (options.rejectStatus) {
        res.writeHead(options.rejectStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "rejected" }));
        return;
      }

      const headers: Record<string, string> = {};
      if (options.sessionId) headers["Mcp-Session-Id"] = options.sessionId;

      if (envelope.id === undefined) {
        // Notification — no payload.
        res.writeHead(202, headers);
        res.end();
        return;
      }

      let result: unknown;
      switch (envelope.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "fake-plugin-runtime", version: "0.0.1" },
          };
          break;
        case "tools/list": {
          const tools = toolsFor(
            typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
          );
          const pageSize = options.pageSize ?? (tools.length || 1);
          const start = envelope.params?.cursor ? Number(envelope.params.cursor) : 0;
          const page = tools.slice(start, start + pageSize);
          const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
          result = { tools: page, ...(next ? { nextCursor: next } : {}) };
          break;
        }
        case "tools/call": {
          const name = envelope.params?.name ?? "";
          const args = envelope.params?.arguments ?? {};
          result = options.onCall
            ? options.onCall(
                name,
                args,
                typeof req.headers.authorization === "string"
                  ? req.headers.authorization
                  : undefined,
              )
            : { content: [{ type: "text", text: JSON.stringify({ name, args }) }] };
          break;
        }
        default:
          result = {};
      }

      const respond = () => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result });
        if (options.sse) {
          res.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
          res.end(`event: message\ndata: ${payload}\n\n`);
        } else {
          res.writeHead(200, { ...headers, "Content-Type": "application/json" });
          res.end(payload);
        }
      };
      if (envelope.method === "tools/list" && options.listDelayMs) {
        setTimeout(respond, options.listDelayMs);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
