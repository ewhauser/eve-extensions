import type { DynamicResolveContext, Approval } from "eve/tools";
import type { CacheMetrics } from "./cache.js";

/** The auth shape Eve provides on both resolve and tool contexts. */
export type SessionAuth = DynamicResolveContext["session"]["auth"];

/**
 * JSON-serializable values, structurally identical to Eve's internal
 * `JsonObject` (which `eve/tools` does not re-export) so schemas typecheck
 * straight into `defineTool`'s raw-JSON-Schema overload.
 */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Structural subset of Eve's `DynamicResolveContext` / `ToolContext` that this
 * package reads. Both context kinds satisfy it, so `getToken` and
 * `getPrincipal` receive whichever one triggered the operation.
 */
export interface ConnectorContext {
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
  };
}

/** A tool as returned by the upstream `tools/list`. */
export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** Result of an upstream `tools/call`. */
export interface UpstreamCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * One discoverable connector tool. This exact object travels through
 * search results in conversation history and is everything needed to
 * rebuild a callable tool offline — including `upstream`, the authoritative
 * reverse mapping. Never reconstruct the dotted name from the mapped one.
 */
export interface ConnectorToolItem {
  /** Mapped, API-legal tool name, e.g. `github_search_repositories`. */
  readonly name: string;
  /** Exact upstream dotted name, e.g. `github.search_repositories`. */
  readonly upstream: string;
  /** Service namespace, e.g. `github`. */
  readonly service: string;
  readonly description: string;
  /** Input schema as returned upstream; `{type:"object"}` when absent. */
  readonly inputSchema: JsonObject;
  /** From `annotations.readOnlyHint`. */
  readonly readOnly: boolean;
  /** From `annotations.destructiveHint`; true when annotations are missing. */
  readonly destructive: boolean;
}

export interface SearchInput {
  service?: string;
  keywords: string | string[];
  limit?: number;
}

/** Declarative approval treatment for a tool. */
export type ApprovalAction = "allow" | "approve" | "deny";

export interface ApprovalRule {
  /**
   * Glob pattern(s) matched against the upstream dotted name
   * (e.g. `github.*`, `notion.create_page`, `*.delete_*`). `*` matches any
   * run of characters, including dots.
   */
  match: string | readonly string[];
  action: ApprovalAction;
}

/**
 * Declarative approval configuration.
 *
 * - `mode: "simple"` (default) — annotation-driven: read-only tools run
 *   without approval, every write requires human approval, missing
 *   annotations are treated as destructive writes.
 * - `mode: "detailed"` — per-tool rules, first match wins; tools no rule
 *   matches fall back to the simple policy.
 */
export interface ApprovalsConfig {
  mode?: "simple" | "detailed";
  /** Detailed mode only: evaluated in order, first match wins. */
  rules?: readonly ApprovalRule[];
  /**
   * Detailed mode only: treatment when no rule matches. Defaults to the
   * simple annotation-driven policy.
   */
  fallback?: ApprovalAction;
}

export interface ConnectorsLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface CreateConnectorsOptions {
  /**
   * Return the current user's ChatGPT workspace bearer token, or `null` when
   * this user has no access. The single credential surface of the package.
   */
  getToken(ctx: ConnectorContext): Promise<string | null> | string | null;
  /** Master switch. When `false`, `begin()` always returns `null`. */
  enabled?: boolean;
  /**
   * Restrict discovery and execution to these connector service names, such
   * as `github` or `google_drive`. Omit to expose every authorized service.
   */
  allowedServices?: readonly string[];
  /** Endpoint override. */
  baseUrl?: string;
  /** Prefix on generated tool names. May be empty; otherwise must contain only API-legal name characters. */
  toolPrefix?: string;
  /** Maximum generated name length before any outer Eve extension namespace is added. */
  maxToolNameLength?: number;
  /** Connector-catalog cache lifetime per user, ms. */
  inventoryTtlMs?: number;
  /** Cap on re-materialized tools per model step. */
  maxMaterializedTools?: number;
  searchLimitDefault?: number;
  searchLimitMax?: number;
  /**
   * Declarative approval policy (simple or detailed mode). Ignored when
   * `approvalFor` is supplied.
   */
  approvals?: ApprovalsConfig;
  /** Fully custom approval policy per tool. Overrides `approvals`. */
  approvalFor?(item: ConnectorToolItem): Approval;
  /**
   * Stable per-user cache key. Defaults to Eve's convention over
   * `ctx.session.auth`: `user:<issuer>:<principalId>`. Supply your own when
   * running without auth (e.g. return a constant in development).
   */
  getPrincipal?(ctx: ConnectorContext): string | null;
  /** Destination for operational warnings. Defaults to `console`. Never receives tokens, tool arguments, or tool results. */
  logger?: ConnectorsLogger;
  /**
   * How the model discovers connector tools.
   *
   * - `"search"` — progressive discovery through the extension's search
   *   tool; works with unpatched Eve.
   * - `"deferred"` — expose the full catalog as deferred tools and let
   *   Anthropic or OpenAI perform provider-native tool search. Requires the
   *   Eve 0.31.3 patch shipped with this package. Falls back to search when
   *   the catalog is unavailable.
   */
  discovery?: "search" | "deferred";
}

/** What `begin()` returns for a step with connector access. */
export interface ConnectorSession {
  /** Cache key for the current user. */
  principal: string;
  /** `<prefix>search`, e.g. `apps_search`. */
  searchToolName: string;
  searchToolDescription: string;
  searchInputSchema: JsonObject;
  /** `<prefix>status` — optional diagnostic tool. */
  statusToolName: string;
  statusToolDescription: string;
  statusInputSchema: JsonObject;
  /**
   * Tools previously discovered via search in this conversation, rebuilt from
   * history (no network), capped at `maxMaterializedTools`, most recent first.
   */
  discovered: readonly ConnectorToolItem[];
  /**
   * The full mapped catalog in deferred mode. Empty in search mode and when
   * the catalog is unavailable, which signals the search fallback.
   */
  deferred: readonly ConnectorToolItem[];
  /** Content address used only to reuse connector-scoped tool definitions. */
  catalogFingerprint: string | null;
}

export interface ConnectorStatus {
  enabled: boolean;
  tokenPresent: boolean;
  /** Process-wide aggregate only; contains no principal or schema labels. */
  cache: CacheMetrics;
  catalog:
    | {
        ok: true;
        totalTools: number;
        readOnlyTools: number;
        services: Array<{ service: string; tools: number }>;
      }
    | { ok: false; error: string; authError: boolean };
}
