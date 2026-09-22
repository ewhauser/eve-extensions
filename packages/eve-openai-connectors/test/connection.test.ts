import type { DynamicResolveContext } from "eve";
import type {
  McpClientConnectionDefinition,
} from "eve/connections";
import { describe, expect, test, vi } from "vitest";

import connectors, {
  connectorToolFilter,
  DEFAULT_BASE_URL,
} from "../extension/connections/connectors.js";
import extension from "../extension/extension.js";

function resolveContext(): DynamicResolveContext {
  const current = {
    attributes: {},
    authenticator: "test",
    issuer: "https://idp.example.com",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return {
    channel: { kind: "test" },
    messages: [],
    model: null,
    session: { auth: { current, initiator: current }, id: "session-1" },
  };
}

async function resolveConnection(): Promise<McpClientConnectionDefinition | null> {
  const handler = connectors.events["session.started"]!;
  const result = await handler({}, resolveContext());
  if (result === null) return null;
  if (typeof (result as Partial<McpClientConnectionDefinition>).url === "string") {
    return result as McpClientConnectionDefinition;
  }
  throw new Error("Expected one MCP connection.");
}

describe("dynamic connector connection", () => {
  test("returns one caller-scoped vanilla MCP connection", async () => {
    const getToken = vi.fn(() => "secret-token");
    extension({ getToken });

    const connection = await resolveConnection();
    expect(connection).toMatchObject({
      description: expect.stringContaining("experimental"),
      headers: {
        "X-OpenAI-Product-Sku": "codex",
        originator: "codex_cli_rs",
      },
      url: DEFAULT_BASE_URL,
    });
    expect(connection?.instanceKey).not.toContain("secret-token");
    expect(connection?.toolName?.toModelName("github.search_repositories")).toBe(
      "github__search_repositories",
    );
    expect(connection?.toolName).toMatchObject({ qualify: false, collisionPriority: -1 });

    const auth = connection?.auth;
    if (auth === undefined || typeof auth === "function") throw new Error("Expected static auth.");
    await expect(auth.getToken({} as never)).resolves.toEqual({ token: "secret-token" });
    expect(getToken).toHaveBeenCalledWith({ session: resolveContext().session });
  });

  test("fails closed when a credential is unavailable", async () => {
    extension({ getToken: () => null });
    const connection = await resolveConnection();
    const auth = connection?.auth;
    if (auth === undefined || typeof auth === "function") throw new Error("Expected static auth.");
    await expect(auth.getToken({} as never)).rejects.toMatchObject({
      connectionName: "connectors",
    });
  });

  test("returns no connection when disabled", async () => {
    extension({ enabled: false, getToken: () => "token" });
    await expect(resolveConnection()).resolves.toBeNull();
  });

  test("honors an application principal resolver that omits the connection", async () => {
    extension({ getPrincipal: () => null, getToken: () => "token" });
    await expect(resolveConnection()).resolves.toBeNull();
  });

  test("allowlist and denylist evaluate exact upstream service names", () => {
    expect(connectorToolFilter("github.search_repositories", ["GitHub"], undefined)).toBe(true);
    expect(connectorToolFilter("notion.search", ["github"], undefined)).toBe(false);
    expect(connectorToolFilter("github.delete_repository", ["github"], ["GITHUB"])).toBe(false);
    expect(connectorToolFilter("malformed_tool", undefined, undefined)).toBe(false);
  });

  test("policy changes produce a new durable connection instance key", async () => {
    extension({ allowedServices: ["github"], getToken: () => "token" });
    const github = await resolveConnection();
    extension({ allowedServices: ["notion"], getToken: () => "token" });
    const notion = await resolveConnection();
    expect(github?.instanceKey).not.toBe(notion?.instanceKey);
  });

  test("aliases change only the model name and durable instance identity", async () => {
    extension({ getToken: () => "token", serviceAliases: { datadog_preview: "datadog" } });
    const aliased = await resolveConnection();
    expect(aliased?.toolName?.toModelName("datadog_preview.search_logs")).toBe(
      "datadog__search_logs",
    );
    expect(aliased?.tools && "filter" in aliased.tools &&
      aliased.tools.filter("datadog_preview.search_logs")).toBe(true);
    extension({ getToken: () => "token" });
    const original = await resolveConnection();
    expect(original?.toolName?.toModelName("datadog_preview.search_logs")).toBe(
      "datadog_preview__search_logs",
    );
    expect(aliased?.instanceKey).not.toBe(original?.instanceKey);
  });

  test("async input transform receives exact upstream name and propagates failure", async () => {
    const transformCallInput = vi.fn(async (_ctx, upstream, input) => ({
      ...input, upstream,
    }));
    extension({ getToken: () => "token", transformCallInput });
    const connection = await resolveConnection();
    const transform = connection?.toolCall?.transformInput;
    expect(transform).toBeTypeOf("function");
    await expect(transform!({ session: resolveContext().session } as never,
      "datadog_preview.search_logs", { query: "x" })).resolves.toEqual({
      query: "x", upstream: "datadog_preview.search_logs",
    });
    expect(transformCallInput).toHaveBeenCalledWith(
      { session: resolveContext().session }, "datadog_preview.search_logs", { query: "x" },
    );
    transformCallInput.mockRejectedValueOnce(new Error("blocked"));
    await expect(transform!({ session: resolveContext().session } as never,
      "datadog_preview.search_logs", {})).rejects.toThrow("blocked");
  });

  test("rejects invalid service aliases", () => {
    expect(() => extension({ getToken: () => "token", serviceAliases: { "bad.name": "safe" } }))
      .toThrow();
    expect(() => extension({ getToken: () => "token", serviceAliases: { datadog: "bad.name" } }))
      .toThrow();
  });
});
