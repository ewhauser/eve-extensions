import { TOOL_NAME_PATTERN } from "./naming.js";
import type { ConnectorToolItem } from "./types.js";

export interface SearchResultsFromMessagesOptions {
  /** Name of the discovery tool whose results to scan. */
  searchToolName?: string;
  /** Cap on returned items; the most recently discovered win. */
  max?: number;
}

const DEFAULT_SEARCH_TOOL_NAME = "apps_search";
const DEFAULT_MAX = 30;

function matchesSearchToolName(toolName: unknown, searchToolName: string): boolean {
  return (
    toolName === searchToolName ||
    (typeof toolName === "string" && toolName.endsWith(`__${searchToolName}`))
  );
}

function coerceItem(candidate: unknown): ConnectorToolItem | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const raw = candidate as Record<string, unknown>;
  if (typeof raw.name !== "string" || !TOOL_NAME_PATTERN.test(raw.name)) return null;
  if (typeof raw.upstream !== "string" || raw.upstream.length === 0) return null;

  const readOnly = raw.readOnly === true;
  // Fail closed: anything not explicitly marked non-destructive is destructive.
  const destructive = readOnly ? false : raw.destructive !== false;
  return {
    name: raw.name,
    upstream: raw.upstream,
    service: typeof raw.service === "string" ? raw.service : "",
    description: typeof raw.description === "string" ? raw.description : "",
    inputSchema:
      typeof raw.inputSchema === "object" && raw.inputSchema !== null
        ? (raw.inputSchema as ConnectorToolItem["inputSchema"])
        : { type: "object" },
    readOnly,
    destructive,
  };
}

/**
 * Rebuild previously discovered connector tools from conversation history —
 * no network involved. Scans `role: "tool"` messages for results of the
 * discovery tool, unwraps the AI SDK's `{type, value}` result envelope,
 * validates each item, and deduplicates by tool name (most recent wins).
 *
 * This is what makes discovered tools survive replay: every search result
 * carries its full input schema and policy flags, so a cold or failing
 * catalog never breaks the ability to call a tool the model already found.
 */
export function searchResultsFromMessages(
  messages: readonly unknown[],
  options: SearchResultsFromMessagesOptions = {},
): ConnectorToolItem[] {
  const searchToolName = options.searchToolName ?? DEFAULT_SEARCH_TOOL_NAME;
  const max = options.max ?? DEFAULT_MAX;

  const byName = new Map<string, ConnectorToolItem>();
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "tool" || !Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const { type, toolName, output } = part as {
        type?: unknown;
        toolName?: unknown;
        output?: unknown;
      };
      if (type !== "tool-result" || !matchesSearchToolName(toolName, searchToolName)) continue;
      if (output == null) continue;

      // Unwrap the AI SDK ToolResultOutput envelope; tolerate a bare value.
      let value: unknown =
        typeof output === "object" && "type" in output && "value" in output
          ? (output as { value: unknown }).value
          : output;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          continue;
        }
      }
      if (!Array.isArray(value)) continue;

      for (const candidate of value) {
        const item = coerceItem(candidate);
        if (!item) continue;
        // Delete-then-set moves the key to the end, giving recency order.
        byName.delete(item.name);
        byName.set(item.name, item);
      }
    }
  }

  const all = [...byName.values()];
  // Most recent first, capped.
  return all.reverse().slice(0, Math.max(0, max));
}
