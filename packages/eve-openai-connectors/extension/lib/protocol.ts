import { ConnectorAuthError, ConnectorProtocolError } from "./errors.js";
import type { UpstreamCallResult, UpstreamTool } from "./types.js";

/**
 * Minimal streamable-HTTP MCP client for the ChatGPT plugin service.
 * No dependencies beyond `fetch`.
 *
 * Privacy contract: this module never logs anything. The token is held in
 * memory for the duration of a request and sent to exactly one origin; tool
 * arguments and results are never inspected beyond JSON parsing.
 */

export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/ps/mcp";

const PROTOCOL_VERSION = "2025-06-18";
const INIT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
/** Defensive bound on `tools/list` pagination (none observed in practice). */
const MAX_LIST_PAGES = 10;

export interface ProtocolClientOptions {
  baseUrl?: string;
  token: string;
  clientName?: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  initTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface ProtocolClient {
  /** Idempotent; performed lazily by the other methods as needed. */
  initialize(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<UpstreamTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<UpstreamCallResult>;
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: number | string; message?: string };
}

function combineSignals(
  timeoutMs: number,
  external: AbortSignal | undefined,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

/**
 * Extract the JSON-RPC response from a `text/event-stream` body: scan `data:`
 * lines and take the frame carrying `result` or `error` (matching `id` when
 * one is present on the frame).
 */
export function parseSseResponse(body: string, id: number): JsonRpcResponse | null {
  let match: JsonRpcResponse | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const data = rawLine.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof frame !== "object" || frame === null) continue;
    const candidate = frame as JsonRpcResponse;
    if (candidate.result === undefined && candidate.error === undefined) continue;
    if (candidate.id !== undefined && candidate.id !== id) continue;
    match = candidate;
  }
  return match;
}

export function createProtocolClient(options: ProtocolClientOptions): ProtocolClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;

  let nextId = 0;
  let sessionId: string | null = null;
  let initialized: Promise<void> | null = null;

  async function rpc(
    method: string,
    params: unknown,
    opts: { notification?: boolean; timeoutMs: number; signal?: AbortSignal },
  ): Promise<JsonRpcResponse | null> {
    const id = opts.notification ? undefined : ++nextId;
    const envelope: JsonRpcEnvelope = { jsonrpc: "2.0", method, params };
    if (id !== undefined) envelope.id = id;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${options.token}`,
      "X-OpenAI-Product-Sku": "codex",
      originator: "codex_cli_rs",
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    let response: Response;
    try {
      response = await fetchImpl(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: combineSignals(opts.timeoutMs, opts.signal),
      });
    } catch (cause) {
      throw new ConnectorProtocolError(
        `Connector request failed (${method}): ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    sessionId = response.headers.get("mcp-session-id") ?? sessionId;

    if (response.status === 401 || response.status === 403) {
      throw new ConnectorAuthError(
        "Connector service rejected the token (HTTP " +
          `${response.status}) — it is missing required scope, invalid, or expired.`,
        { status: response.status },
      );
    }
    if (!response.ok) {
      throw new ConnectorProtocolError(
        `Connector service returned HTTP ${response.status} for ${method}.`,
        { status: response.status },
      );
    }
    if (opts.notification) {
      // Drain the body; notifications have no response payload we need.
      await response.text().catch(() => "");
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let payload: JsonRpcResponse | null = null;
    if (contentType.includes("text/event-stream")) {
      payload = parseSseResponse(text, id as number);
    } else if (text.trim()) {
      try {
        payload = JSON.parse(text) as JsonRpcResponse;
      } catch {
        payload = null;
      }
    }
    if (!payload) {
      throw new ConnectorProtocolError(
        `Connector service returned an unparseable response for ${method}.`,
      );
    }
    if (payload.error) {
      const error = payload.error;
      throw new ConnectorProtocolError(
        `Connector service error for ${method}: ${error.message ?? "unknown error"}`,
        { ...(error.code !== undefined ? { code: error.code } : {}) },
      );
    }
    return payload;
  }

  async function doInitialize(signal?: AbortSignal): Promise<void> {
    await rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: options.clientName ?? "eve-openai-connectors",
          version: options.clientVersion ?? "0.1.0",
        },
      },
      { timeoutMs: initTimeoutMs, ...(signal ? { signal } : {}) },
    );
    await rpc(
      "notifications/initialized",
      {},
      { notification: true, timeoutMs: initTimeoutMs, ...(signal ? { signal } : {}) },
    );
  }

  function ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!initialized) {
      initialized = doInitialize(signal).catch((error: unknown) => {
        initialized = null; // allow retry on the next operation
        throw error;
      });
    }
    return initialized;
  }

  return {
    initialize: (signal?: AbortSignal) => ensureInitialized(signal),

    async listTools(signal?: AbortSignal): Promise<UpstreamTool[]> {
      await ensureInitialized(signal);
      const tools: UpstreamTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const payload = await rpc("tools/list", cursor ? { cursor } : {}, {
          timeoutMs: initTimeoutMs,
          ...(signal ? { signal } : {}),
        });
        const result = (payload?.result ?? {}) as {
          tools?: UpstreamTool[];
          nextCursor?: string;
        };
        tools.push(...(Array.isArray(result.tools) ? result.tools : []));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return tools;
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
      opts: { signal?: AbortSignal } = {},
    ): Promise<UpstreamCallResult> {
      await ensureInitialized(opts.signal);
      const payload = await rpc(
        "tools/call",
        { name, arguments: args },
        { timeoutMs: callTimeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      return (payload?.result ?? {}) as UpstreamCallResult;
    },
  };
}
