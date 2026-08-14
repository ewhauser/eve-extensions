import type { DynamicResolveContext, Approval } from "eve/tools";
import type { CacheMetrics } from "./cache.js";
import type { ConnectorAuthError } from "./errors.js";

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
  /** Eve's step/tool cancellation signal, when one is available. */
  readonly abortSignal?: AbortSignal;
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

/** One discoverable connector tool from the current authorized inventory. */
export interface ConnectorToolItem {
  /** Mapped, API-legal tool name, e.g. `github__search_repositories`. */
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

export interface ConnectorSearchSummary {
  readonly name: string;
  readonly summary: string;
}

/** Compact ordinary-search result sent to the model. Never contains schemas. */
export interface ConnectorSearchOutput {
  readonly loaded: readonly ConnectorSearchSummary[];
}

export interface ConnectorSearchResult {
  readonly output: ConnectorSearchOutput;
  readonly items: readonly ConnectorToolItem[];
  readonly authority: string;
  readonly catalogFingerprint: string;
}

/** Raw input emitted by OpenAI for a client-executed `tool_search_call`. */
export interface ClientToolSearchInput {
  arguments?: unknown;
  call_id?: unknown;
}

/** Model-facing function definition loaded by client-executed tool search. */
export interface ClientFunctionTool extends JsonObject {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly defer_loading: true;
  readonly parameters: JsonObject;
}

export interface ClientToolSearchOutput {
  readonly tools: readonly ClientFunctionTool[];
}

export interface ClientToolSearchResult {
  readonly output: ClientToolSearchOutput;
  readonly items: readonly ConnectorToolItem[];
  readonly authority: string;
  readonly catalogFingerprint: string;
}

export type ConnectorWorkingSetSource = "search" | "client";

export interface ConnectorWorkingSetEntry {
  readonly name: string;
  readonly upstream: string;
  readonly source: ConnectorWorkingSetSource;
}

/** Versioned, bounded, per-session references. It intentionally contains no schemas. */
export interface ConnectorWorkingSet {
  readonly version: 1;
  readonly authority: string;
  readonly catalogFingerprint: string;
  readonly tools: readonly ConnectorWorkingSetEntry[];
}

export interface MaterializedWorkingSetEntry {
  readonly item: ConnectorToolItem;
  readonly source: ConnectorWorkingSetSource;
}

/** A client-loaded definition matched back to the current authorized catalog. */
export interface LoadedConnectorTool {
  readonly item: ConnectorToolItem;
  /** Version-tagged description reconstructed from the current catalog. */
  readonly description: string;
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

export type ConnectorDiscovery = "client" | "search" | "deferred";
export type ConnectorResolutionStatus = "available" | "degraded" | "unavailable";
export type ProtocolClientLifetime = "principal" | "operation";

/** Count-bounded, schema-free diagnostic emitted once per `begin()` call. */
export interface ConnectorResolutionSummary {
  readonly status: ConnectorResolutionStatus;
  readonly discovery: ConnectorDiscovery;
  readonly catalogToolCount: number;
  readonly materializedToolCount: number;
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
  /** Static, case-insensitive connector service denylist. */
  excludedServices?: readonly string[];
  /** Endpoint override. */
  baseUrl?: string;
  /** Prefix on generated tool names. May be empty; otherwise must contain only API-legal name characters. */
  toolPrefix?: string;
  /** Generated connector name format. The extension uses `service-qualified` names such as `zoom__search_meetings`. */
  toolNameFormat?: "flat" | "service-qualified";
  /** Maximum generated name length before any outer Eve extension namespace is added. */
  maxToolNameLength?: number;
  /** Connector-catalog cache lifetime per user, ms. */
  inventoryTtlMs?: number;
  /** Cap on re-materialized tools per model step. */
  maxMaterializedTools?: number;
  searchLimitDefault?: number;
  searchLimitMax?: number;
  /** Maximum total serialized bytes returned by one client tool search. */
  clientSearchMaxBytes?: number;
  /** Wall-clock budget for one client tool search, including catalog lookup. */
  clientSearchTimeoutMs?: number;
  /**
   * Declarative approval policy (simple or detailed mode). Ignored when
   * `approvalFor` is supplied.
   */
  approvals?: ApprovalsConfig;
  /** Fully custom approval policy per tool. Overrides `approvals`. */
  approvalFor?(item: ConnectorToolItem): Approval;
  /**
   * Transform arguments after live-catalog authorization succeeds and
   * immediately before the upstream `tools/call` request. The hook cannot
   * change routing or the upstream tool name.
   */
  transformCallInput?(
    ctx: ConnectorContext,
    tool: ConnectorToolItem,
    input: Readonly<Record<string, unknown>>,
  ): Record<string, unknown>;
  /** Called after credential-scoped client and inventory state is invalidated. */
  onAuthError?(ctx: ConnectorContext, error: ConnectorAuthError): Promise<void> | void;
  /** Called at most once for each `begin()` resolution. Callback failures are ignored. */
  onResolution?(
    ctx: ConnectorContext,
    summary: ConnectorResolutionSummary,
  ): Promise<void> | void;
  /** Retain protocol clients per principal, or close one after each network operation. */
  protocolClientLifetime?: ProtocolClientLifetime;
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
   * - `"client"` — advertise one OpenAI client-executed `tool_search` and
   *   load a bounded authorized subset. Other providers use the bounded
   *   progressive marker tool instead of restoring the full catalog.
   * - `"search"` — progressive discovery through the extension's search
   *   tool; works with unpatched Eve.
   * - `"deferred"` — expose the full catalog as deferred tools and let
   *   Anthropic or OpenAI perform provider-native tool search. Requires the
   *   Eve 0.38.0 patch shipped with this package. Falls back to search when
   *   the catalog is unavailable.
   */
  discovery?: ConnectorDiscovery;
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
  /** Ordinary-search tools revalidated from the durable working set. */
  discovered: readonly ConnectorToolItem[];
  /** Client-search definitions revalidated from the durable working set. */
  loaded: readonly LoadedConnectorTool[];
  /** Bound used when atomically updating the durable working set. */
  maxMaterializedTools: number;
  /** Whether this step should contribute the client-search marker tool. */
  clientSearchEnabled: boolean;
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
