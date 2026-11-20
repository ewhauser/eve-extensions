import type { ConnectionToolCallDefinition } from "eve/connections";
import type { ResolvedConnectionDefinition } from "../node_modules/eve/dist/src/runtime/types.js";

type Transform = NonNullable<ConnectionToolCallDefinition["transformInput"]>;

// Eve 1.x prunes private declarations; keep the carried runtime contract explicit.
const runtime = await import(new URL(
  "../node_modules/eve/dist/src/runtime/connections/mcp-client.js",
  import.meta.url,
).href) as {
  passesToolFilter(names: readonly string[], filter: ResolvedConnectionDefinition["tools"]): boolean;
  projectConnectionToolNames(connection: ResolvedConnectionDefinition, names: readonly string[]): Map<string, string>;
  executeWithTransform(
    connection: ResolvedConnectionDefinition,
    upstreamToolName: string,
    args: unknown,
    options: { callId: string; abortSignal?: AbortSignal },
    execute: (input: Record<string, unknown>) => Promise<unknown>,
    context?: Parameters<Transform>[0],
  ): Promise<unknown>;
};

export const { passesToolFilter, projectConnectionToolNames, executeWithTransform } = runtime;
