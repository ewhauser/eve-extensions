#!/usr/bin/env node
// probe.mjs — operational probe for the ChatGPT connector service.
//
// Verifies that a token works against the live endpoint and reports catalog
// health: initialize, tools/list, namespace counts, annotation coverage, and
// (optionally) one read-only live call. Also validates this package's
// name-mapping invariants against the real catalog.
//
// Usage:
//   CODEX_ACCESS_TOKEN=<token> node scripts/probe.mjs [flags]
//
//   Flags:
//     --call [TOOL]       make one live read-only call (default tool:
//                         github.search_repositories, query "eve")
//     --call-args JSON    arguments for --call
//     --record FILE       write a sanitized catalog snapshot (names,
//                         annotations, truncated descriptions) usable as
//                         test/fixtures/catalog.live.json
//     --base-url URL      endpoint override
//
// The token is read from CODEX_ACCESS_TOKEN (or CHATGPT_ACCESS_TOKEN) and is
// never printed. No dependencies; Node 18+.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
function flagValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const BASE_URL = flagValue("--base-url") ?? "https://chatgpt.com/backend-api/ps/mcp";
const DO_CALL = args.includes("--call");
const CALL_TOOL = flagValue("--call") ?? "github.search_repositories";
const CALL_ARGS = JSON.parse(flagValue("--call-args") ?? '{"query":"eve"}');
const RECORD = flagValue("--record");

const token = process.env.CODEX_ACCESS_TOKEN ?? process.env.CHATGPT_ACCESS_TOKEN;
if (!token) {
  console.error(
    "Set CODEX_ACCESS_TOKEN (a ChatGPT workspace credential with Codex scope). An OpenAI API key will not work.",
  );
  process.exit(2);
}

let sessionId = null;
let nextId = 0;

async function rpc(method, params, notification = false) {
  const body = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: ++nextId, method, params };
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "X-OpenAI-Product-Sku": "codex",
    originator: "codex_cli_rs",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(BASE_URL, { method: "POST", headers, body: JSON.stringify(body) });
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  if (res.status === 401 || res.status === 403) {
    throw new Error(`HTTP ${res.status} — token rejected (missing scope, invalid, or expired).`);
  }
  const text = await res.text();
  if (notification) return null;
  let payload = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const frame = JSON.parse(line.slice(5).trim());
        if (frame.result !== undefined || frame.error !== undefined) payload = frame;
      } catch {}
    }
  } else if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: { message: `unparseable body (HTTP ${res.status})` } };
    }
  }
  if (!payload) throw new Error(`No JSON-RPC payload for ${method} (HTTP ${res.status}).`);
  if (payload.error) {
    throw new Error(`${method} error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

const report = { baseUrl: BASE_URL, serverInfo: null, toolCount: 0, namespaces: {}, annotations: null, naming: null, liveCall: "skipped", recorded: null };

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "eve-openai-connectors-probe", version: "0.1.0" },
  });
  report.serverInfo = init?.serverInfo ?? null;
  await rpc("notifications/initialized", {}, true);

  const tools = [];
  let cursor;
  do {
    const page = await rpc("tools/list", cursor ? { cursor } : {});
    tools.push(...(page?.tools ?? []));
    cursor = page?.nextCursor;
  } while (cursor);
  report.toolCount = tools.length;

  for (const tool of tools) {
    const namespace = tool.name.includes(".") ? tool.name.split(".")[0] : tool.name;
    report.namespaces[namespace] = (report.namespaces[namespace] ?? 0) + 1;
  }

  const withAnnotations = tools.filter((tool) => tool.annotations && typeof tool.annotations === "object");
  report.annotations = {
    present: withAnnotations.length,
    readOnly: withAnnotations.filter((tool) => tool.annotations.readOnlyHint === true).length,
    destructive: withAnnotations.filter((tool) => tool.annotations.destructiveHint === true).length,
    missing: tools.length - withAnnotations.length,
  };

  // Name-mapping invariants against the real catalog. Reserve eight
  // characters for the required `openai__` Eve extension namespace.
  const PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
  const mapped = new Map();
  const collisions = [];
  const illegal = [];
  for (const tool of tools) {
    const name = tool.name.replace(/\./g, "_").replace(/[^a-zA-Z0-9_-]/g, "_");
    const hash = createHash("sha256").update(tool.name, "utf8").digest("hex").slice(0, 6);
    const relativeName = name.length <= 56 ? name : `${name.slice(0, 49)}_${hash}`;
    const finalName = `openai__${relativeName}`;
    if (!PATTERN.test(finalName)) illegal.push(tool.name);
    if (mapped.has(finalName)) collisions.push([mapped.get(finalName), tool.name]);
    mapped.set(finalName, tool.name);
  }
  const longest = tools.reduce((a, b) => (b.name.length > a.name.length ? b : a), { name: "" });
  report.naming = {
    longestUpstream: `${longest.name} (${longest.name.length} chars)`,
    illegalAfterMapping: illegal,
    collisions,
  };

  if (DO_CALL) {
    const target = tools.find((tool) => tool.name === CALL_TOOL);
    if (!target) {
      report.liveCall = { tool: CALL_TOOL, error: "tool not present in this catalog" };
    } else if (target.annotations?.readOnlyHint !== true) {
      report.liveCall = { tool: CALL_TOOL, error: "refusing: tool is not read-only" };
    } else {
      const result = await rpc("tools/call", { name: CALL_TOOL, arguments: CALL_ARGS });
      const text = JSON.stringify(result?.structuredContent ?? result?.content ?? result);
      report.liveCall = {
        tool: CALL_TOOL,
        isError: result?.isError === true,
        resultBytes: text.length,
        head: text.slice(0, 200),
      };
    }
  }

  if (RECORD) {
    const snapshot = {
      note: `Sanitized live catalog snapshot recorded by scripts/probe.mjs against ${BASE_URL}.`,
      recordedAt: new Date().toISOString(),
      serverInfo: report.serverInfo,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: (tool.description ?? "").slice(0, 300),
        annotations: tool.annotations ?? undefined,
      })),
    };
    writeFileSync(RECORD, JSON.stringify(snapshot, null, 2) + "\n");
    report.recorded = `${RECORD} (${snapshot.tools.length} tools)`;
  }
} catch (error) {
  report.error = String(error?.message ?? error);
}

console.log("REPORT " + JSON.stringify(report, null, 2));
process.exit(report.error ? 1 : 0);
