import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { UpstreamTool } from "../../extension/lib/types.js";

export interface FakeServerOptions {
  /** Respond with `text/event-stream` bodies instead of JSON. */
  sse?: boolean;
  /** Return this `Mcp-Session-Id` header on every response. */
  sessionId?: string;
  /** Reject every request, or selected protocol methods, with an HTTP status. */
  rejectStatus?: number | ((method: string, authorization?: string) => number | undefined);
  /** Delay selected rejected responses to exercise credential-rotation races. */
  rejectDelayMs?: number;
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
  /** Delay tools/call responses to exercise cancellation and cleanup. */
  callDelayMs?: number;
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
      if (req.method === "DELETE") {
        requests.push({ method: "session/delete", headers: req.headers });
        const rejectStatus =
          typeof options.rejectStatus === "function"
            ? options.rejectStatus(
                "session/delete",
                typeof req.headers.authorization === "string"
                  ? req.headers.authorization
                  : undefined,
              )
            : options.rejectStatus;
        res.writeHead(rejectStatus ?? 204);
        res.end();
        return;
      }
      const envelope = body ? (JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { cursor?: string; name?: string; arguments?: Record<string, unknown> };
      }) : { method: "" };
      requests.push({ method: envelope.method, headers: req.headers });

      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const rejectStatus =
        typeof options.rejectStatus === "function"
          ? options.rejectStatus(envelope.method, authorization)
          : options.rejectStatus;
      if (rejectStatus) {
        const reject = () => {
          res.writeHead(rejectStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rejected" }));
        };
        if (options.rejectDelayMs) setTimeout(reject, options.rejectDelayMs);
        else reject();
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
          const tools = toolsFor(authorization);
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
                authorization,
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
      const delay =
        envelope.method === "tools/list"
          ? options.listDelayMs
          : envelope.method === "tools/call"
            ? options.callDelayMs
            : undefined;
      if (delay) {
        setTimeout(respond, delay);
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
