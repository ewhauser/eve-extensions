import { Buffer } from "node:buffer";

import { stableJson, type Inventory } from "./catalog.js";
import { TOOL_NAME_PATTERN } from "./naming.js";
import type {
  ClientFunctionTool,
  ClientToolSearchInput,
  ClientToolSearchOutput,
  ConnectorToolItem,
  JsonObject,
  LoadedConnectorTool,
  SearchInput,
} from "./types.js";

export const CLIENT_TOOL_SEARCH_MARKER_NAME = "client_tool_search";
const PROVIDER_TOOL_NAME_MAX = 64;
export const MIN_CLIENT_SEARCH_OUTPUT_BYTES = Buffer.byteLength('{"tools":[]}', "utf8");

export const CLIENT_TOOL_SEARCH_PARAMETERS: JsonObject = Object.freeze({
  type: "object",
  properties: {
    keywords: {
      type: "string",
      description: "Keywords describing the connector capability needed.",
    },
    service: {
      type: "string",
      description: "Optional connector service filter, such as github or google_drive.",
    },
    limit: {
      type: "integer",
      description: "Optional maximum number of matching functions to load.",
    },
  },
  required: ["keywords"],
  additionalProperties: false,
});

/**
 * The marker remains a normal bounded search function on unsupported providers.
 * The Eve patch recognizes `openai.clientToolSearch` and replaces this one
 * marker with `openai.tools.toolSearch({ execution: "client" })` on OpenAI.
 */
export const CLIENT_TOOL_SEARCH_PROVIDER_OPTIONS = Object.freeze({
  anthropic: { deferLoading: true },
  openai: {
    deferLoading: true,
    clientToolSearch: { parameters: CLIENT_TOOL_SEARCH_PARAMETERS },
  },
});

export const CLIENT_TOOL_SEARCH_MARKER_INPUT_SCHEMA: JsonObject = Object.freeze({
  oneOf: [
    CLIENT_TOOL_SEARCH_PARAMETERS,
    {
      type: "object",
      properties: {
        arguments: CLIENT_TOOL_SEARCH_PARAMETERS,
        call_id: { type: "string", minLength: 1 },
      },
      required: ["arguments", "call_id"],
      additionalProperties: false,
    },
  ],
});

export const CLIENT_TOOL_SEARCH_DESCRIPTION =
  "Search the current user's authorized ChatGPT connector inventory and load a small set of exact function definitions. Results never grant execution authority; every loaded function is reauthorized when invoked.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse either OpenAI's `{arguments, call_id}` wrapper or the bounded fallback's direct input. */
export function parseClientToolSearchInput(input: ClientToolSearchInput | Record<string, unknown>): SearchInput {
  if (!isRecord(input)) throw new Error("Connector tool search requires an object input.");

  const wrapped = "arguments" in input || "call_id" in input;
  let raw: Record<string, unknown>;
  if (wrapped) {
    if (typeof input.call_id !== "string" || input.call_id.length === 0) {
      throw new Error("Connector tool search requires the provider call_id.");
    }
    if (!isRecord(input.arguments)) {
      throw new Error("Connector tool search arguments must be an object.");
    }
    raw = input.arguments;
  } else {
    raw = input;
  }

  if (typeof raw.keywords !== "string") {
    throw new Error("Connector tool search keywords must be a string.");
  }
  if (raw.service !== undefined && typeof raw.service !== "string") {
    throw new Error("Connector tool search service must be a string when provided.");
  }
  if (
    raw.limit !== undefined &&
    (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit <= 0)
  ) {
    throw new Error("Connector tool search limit must be a positive integer when provided.");
  }
  for (const key of Object.keys(raw)) {
    if (key !== "keywords" && key !== "service" && key !== "limit") {
      throw new Error(`Connector tool search does not accept ${JSON.stringify(key)}.`);
    }
  }

  const parsed: SearchInput = { keywords: raw.keywords };
  if (raw.service !== undefined) parsed.service = raw.service as string;
  if (raw.limit !== undefined) parsed.limit = raw.limit as number;
  return parsed;
}

export function namespaceFromClientMarkerToolName(toolName: string): string {
  return toolName.endsWith(CLIENT_TOOL_SEARCH_MARKER_NAME)
    ? toolName.slice(0, -CLIENT_TOOL_SEARCH_MARKER_NAME.length)
    : "";
}

export function clientToolDescription(item: ConnectorToolItem, fingerprint: string): string {
  return `${item.description}\n[eve catalog: ${fingerprint}]`;
}

function clientFunctionTool(
  item: ConnectorToolItem,
  fingerprint: string,
  namespace: string,
): ClientFunctionTool | null {
  const name = `${namespace}${item.name}`;
  if (!TOOL_NAME_PATTERN.test(name) || name.length > PROVIDER_TOOL_NAME_MAX) return null;
  return Object.freeze({
    type: "function",
    name,
    description: clientToolDescription(item, fingerprint),
    defer_loading: true,
    parameters: item.inputSchema,
  });
}

/** Build an ordered, count-bounded and byte-bounded provider result. */
export function materializeClientToolSearchOutput(
  inventory: Inventory,
  matches: readonly ConnectorToolItem[],
  namespace: string,
  maxBytes: number,
): ClientToolSearchOutput {
  const tools: ClientFunctionTool[] = [];
  let bytes = MIN_CLIENT_SEARCH_OUTPUT_BYTES;
  for (const item of matches) {
    const definition = clientFunctionTool(item, inventory.fingerprint, namespace);
    if (!definition) continue;
    const definitionBytes =
      Buffer.byteLength(JSON.stringify(definition), "utf8") + (tools.length === 0 ? 0 : 1);
    if (definitionBytes > maxBytes - bytes) continue;
    tools.push(definition);
    bytes += definitionBytes;
  }
  return Object.freeze({ tools: Object.freeze(tools) });
}

function unwrapToolOutput(output: unknown): unknown {
  let value = output;
  if (isRecord(value) && "type" in value && "value" in value) value = value.value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value;
}

function isClientSearchResultName(toolName: unknown): boolean {
  return (
    toolName === "tool_search" ||
    (typeof toolName === "string" && toolName.endsWith(`__${CLIENT_TOOL_SEARCH_MARKER_NAME}`)) ||
    toolName === CLIENT_TOOL_SEARCH_MARKER_NAME
  );
}

function matchLoadedDefinition(
  candidate: unknown,
  inventory: Inventory,
): LoadedConnectorTool | null {
  if (!isRecord(candidate)) return null;
  if (
    candidate.type !== "function" ||
    typeof candidate.name !== "string" ||
    typeof candidate.description !== "string" ||
    candidate.defer_loading !== true ||
    !isRecord(candidate.parameters) ||
    !TOOL_NAME_PATTERN.test(candidate.name) ||
    candidate.name.length > PROVIDER_TOOL_NAME_MAX
  ) {
    return null;
  }

  const candidateName = candidate.name;
  let item = inventory.byName.get(candidateName);
  if (!item) {
    item = inventory.items.find((entry) => candidateName.endsWith(`__${entry.name}`));
  }
  if (!item) return null;
  if (candidate.description !== clientToolDescription(item, inventory.fingerprint)) return null;
  if (stableJson(candidate.parameters) !== stableJson(item.inputSchema)) return null;

  return Object.freeze({ item, providerName: candidateName, description: candidate.description });
}

/**
 * Rebuild loaded functions from durable conversation history. Definitions are
 * accepted only when they still exactly match the current authorized catalog
 * and its full content fingerprint.
 */
export function clientToolSearchResultsFromMessages(
  messages: readonly unknown[],
  inventory: Inventory,
  max: number,
): LoadedConnectorTool[] {
  const byName = new Map<string, LoadedConnectorTool>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool-result" || !isClientSearchResultName(part.toolName)) {
        continue;
      }
      const value = unwrapToolOutput(part.output);
      if (!isRecord(value) || !Array.isArray(value.tools)) continue;
      for (const candidate of value.tools) {
        const loaded = matchLoadedDefinition(candidate, inventory);
        if (!loaded) continue;
        byName.delete(loaded.item.name);
        byName.set(loaded.item.name, loaded);
      }
    }
  }
  return [...byName.values()].reverse().slice(0, Math.max(0, max));
}
