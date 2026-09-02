import type {
  DynamicConnectionResolveContext,
  McpClientConnectionDefinition,
} from "eve/connections";
import { describe, expect, test, vi } from "vitest";

import connectors, {
  connectorToolFilter,
  DEFAULT_BASE_URL,
} from "../extension/connections/connectors.js";
import extension from "../extension/extension.js";

function resolveContext(): DynamicConnectionResolveContext & { readonly messages: readonly [] } {
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
});
