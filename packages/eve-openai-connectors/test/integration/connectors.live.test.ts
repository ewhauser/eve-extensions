import { describe, expect, test } from "vitest";
import { createConnectors } from "../../extension/lib/connectors.js";
import { buildNameMap, TOOL_NAME_PATTERN } from "../../extension/lib/naming.js";
import { createProtocolClient } from "../../extension/lib/protocol.js";

// Live tests against the real ChatGPT plugin service. Gated on
// CODEX_ACCESS_TOKEN — a ChatGPT workspace credential with Codex scope.
const token = process.env.CODEX_ACCESS_TOKEN;

const ctx = { session: { id: "integration", auth: { current: null, initiator: null } } };

function connectors() {
  return createConnectors({
    getToken: () => token ?? null,
    getPrincipal: () => "integration",
  });
}

describe.skipIf(!token)("live connector service (CODEX_ACCESS_TOKEN)", () => {
  test("status reports a healthy catalog", async () => {
    const status = await connectors().status(ctx);
    expect(status.tokenPresent).toBe(true);
    if (!status.catalog.ok) throw new Error(`catalog unhealthy: ${status.catalog.error}`);
    expect(status.catalog.totalTools).toBeGreaterThan(50);
    expect(status.catalog.services.map((s) => s.service)).toContain("github");
  });

  test("the full live catalog maps to legal, injective tool names", async () => {
    const client = createProtocolClient({ token: token! });
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(50);
    const map = buildNameMap(tools.map((t) => t.name), "apps_");
    expect(map.size).toBe(new Set(tools.map((t) => t.name)).size); // no drops
    const mapped = [...map.values()];
    for (const name of mapped) expect(name).toMatch(TOOL_NAME_PATTERN);
    expect(new Set(mapped).size).toBe(mapped.length); // injective
  });

  test("begin → search → call round-trip with a read-only tool", async () => {
    const c = connectors();
    const session = await c.begin({ ...ctx, messages: [] });
    expect(session?.searchToolName).toBe("apps_search");
    expect(session?.searchToolDescription).toContain("github");

    const results = await c.search(ctx, { keywords: "search repositories", service: "github" });
    expect(results.length).toBeGreaterThan(0);
    const target = results.find((item) => item.readOnly);
    expect(target).toBeDefined();

    const data = await c.call(ctx, target!.upstream, { query: "eve" });
    expect(data).toBeDefined();
  });

  test("deferred discovery exposes the live catalog", async () => {
    const c = createConnectors({
      getToken: () => token ?? null,
      getPrincipal: () => "integration-deferred",
      discovery: "deferred",
    });
    const session = await c.begin({ ...ctx, messages: [] });
    expect(session?.deferred.length).toBeGreaterThan(50);
    for (const item of session!.deferred.slice(0, 10)) {
      expect(item.name).toMatch(TOOL_NAME_PATTERN);
      expect(item.upstream).toContain(".");
    }
  });
});
