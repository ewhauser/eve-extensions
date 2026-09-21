import { describe, expect, test, vi } from "vitest";

import { executeWithTransform } from "../node_modules/eve/dist/src/runtime/connections/mcp-client.js";
import type { ResolvedConnectionDefinition } from "../node_modules/eve/dist/src/runtime/types.js";

function connection(transformInput: NonNullable<NonNullable<ResolvedConnectionDefinition["toolCall"]>["transformInput"]>): ResolvedConnectionDefinition {
  return {
    connectionName: "connectors",
    description: "test",
    logicalPath: "connections/connectors.ts",
    protocol: "mcp",
    sourceId: "connectors",
    sourceKind: "module",
    toolCall: { transformInput },
    url: "https://mcp.example.com",
  };
}

describe("mounted MCP call input transform", () => {
  test("passes exact upstream name and transformed input to execution", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const transformInput = vi.fn(async (_ctx, name, input) => ({ ...input, name }));
    const result = await executeWithTransform(
      connection(transformInput), "datadog_preview.search_logs", { query: "x" },
      { callId: "call-1" }, execute,
      { callId: "call-1", toolName: "datadog_preview.search_logs" },
    );
    expect(transformInput).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1", toolName: "datadog_preview.search_logs" }),
      "datadog_preview.search_logs", { query: "x" },
    );
    expect(result).toEqual({ query: "x", name: "datadog_preview.search_logs" });
    expect(execute).toHaveBeenCalledWith(result);
  });

  test("a rejected transform prevents the upstream execution", async () => {
    const execute = vi.fn(async () => ({}));
    const transformInput = vi.fn(async () => { throw new Error("blocked"); });
    await expect(executeWithTransform(
      connection(transformInput), "datadog_preview.search_logs", {},
      { callId: "call-2" }, execute,
      { callId: "call-2", toolName: "datadog_preview.search_logs" },
    )).rejects.toThrow("blocked");
    expect(execute).not.toHaveBeenCalled();
  });
});
