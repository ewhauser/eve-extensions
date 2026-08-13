import type { Approval } from "eve/tools";
import {
  buildInventory,
  InventoryCache,
  sameToolDescriptor,
  searchInventory,
  type Inventory,
} from "./catalog.js";
import {
  clientToolSearchResultsFromMessages,
  materializeClientToolSearchOutput,
  MIN_CLIENT_SEARCH_OUTPUT_BYTES,
  parseClientToolSearchInput,
} from "./client-search.js";
import { getConnectorCacheMetrics } from "./cache.js";
import { ConnectorAuthError, ConnectorToolError } from "./errors.js";
import { searchResultsFromMessages } from "./messages.js";
import {
  searchToolName as buildSearchToolName,
  statusToolName as buildStatusToolName,
  validateMaxToolNameLength,
  validateToolPrefix,
} from "./naming.js";
import { buildApprovalPolicy } from "./policy.js";
import {
  createProtocolClient,
  DEFAULT_BASE_URL,
  type ProtocolClient,
} from "./protocol.js";
import type {
  ConnectorContext,
  ConnectorSession,
  ConnectorStatus,
  ClientToolSearchInput,
  ClientToolSearchOutput,
  ConnectorToolItem,
  CreateConnectorsOptions,
  SearchInput,
} from "./types.js";

/** Overall budget for the catalog load inside `begin()` (the resolver runs
 * before every model call and must stay fast). The load continues in the
 * background and populates the cache for the next step. */
const BEGIN_CATALOG_BUDGET_MS = 5_000;

/**
 * Per-tool provider options that mark a tool as deferred for provider-native
 * tool search. Eve's patched provider bridge forwards these options and
 * injects the matching Anthropic or OpenAI search tool automatically.
 */
export const DEFER_PROVIDER_OPTIONS = {
  anthropic: { deferLoading: true },
  openai: { deferLoading: true },
} as const;

export interface Connectors {
  /**
   * Call from the `step.started` resolver. Returns `null` when disabled,
   * when there is no principal, or when `getToken` yields no token —
   * otherwise a session describing the discovery tool plus previously
   * discovered tools rebuilt from history. Never throws.
   */
  begin(ctx: ConnectorContext & { messages?: readonly unknown[] }): Promise<ConnectorSession | null>;
  /** Execute body for the search tool. Accepts the raw tool input object. */
  search(
    ctx: ConnectorContext,
    input: SearchInput | Record<string, unknown>,
  ): Promise<ConnectorToolItem[]>;
  /** Execute OpenAI client tool search, or the bounded progressive provider fallback. */
  clientSearch(
    ctx: ConnectorContext,
    input: ClientToolSearchInput | Record<string, unknown>,
    namespace: string,
  ): Promise<ClientToolSearchOutput>;
  /** Execute a materialized connector tool after revalidating current catalog membership. */
  call(
    ctx: ConnectorContext,
    upstream: string,
    input: Record<string, unknown>,
    expected?: ConnectorToolItem,
  ): Promise<unknown>;
  /** Execute body for the optional status tool. */
  status(ctx: ConnectorContext): Promise<ConnectorStatus>;
  /** Approval policy for a discovered tool (declarative config or custom override). */
  approvalFor(item: ConnectorToolItem): Approval;
}

function firstErrorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0] ?? message;
}

function normalizeAllowedServices(services: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (services === undefined) return undefined;
  const normalized = new Set<string>();
  for (const service of services) {
    const value = service.trim().toLowerCase();
    if (!value) {
      throw new Error("eve-openai-connectors: allowedServices entries must be non-empty strings.");
    }
    normalized.add(value);
  }
  return normalized;
}

function serviceFromUpstream(upstream: string): string {
  return upstream.split(".", 1)[0]?.toLowerCase() ?? "";
}

const MAX_PRINCIPAL_CACHE_ENTRIES = 1_000;
const DEFAULT_CLIENT_SEARCH_MAX_BYTES = 64 * 1024;
const DEFAULT_CLIENT_SEARCH_TIMEOUT_MS = 5_000;

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createConnectors(options: CreateConnectorsOptions): Connectors {
  if (typeof options?.getToken !== "function") {
    throw new Error("eve-openai-connectors: createConnectors requires a getToken(ctx) function.");
  }
  const enabled = options.enabled ?? true;
  const allowedServices = normalizeAllowedServices(options.allowedServices);
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const toolPrefix = options.toolPrefix ?? "apps_";
  validateToolPrefix(toolPrefix);
  const maxToolNameLength = options.maxToolNameLength ?? 64;
  validateMaxToolNameLength(maxToolNameLength);
  const inventoryTtlMs = options.inventoryTtlMs ?? 300_000;
  const maxMaterializedTools = options.maxMaterializedTools ?? 30;
  const searchLimitDefault = options.searchLimitDefault ?? 8;
  const searchLimitMax = options.searchLimitMax ?? 25;
  const clientSearchMaxBytes = options.clientSearchMaxBytes ?? DEFAULT_CLIENT_SEARCH_MAX_BYTES;
  const clientSearchTimeoutMs = options.clientSearchTimeoutMs ?? DEFAULT_CLIENT_SEARCH_TIMEOUT_MS;
  if (
    !Number.isInteger(clientSearchMaxBytes) ||
    clientSearchMaxBytes < MIN_CLIENT_SEARCH_OUTPUT_BYTES
  ) {
    throw new Error(
      `eve-openai-connectors: clientSearchMaxBytes must be an integer of at least ${MIN_CLIENT_SEARCH_OUTPUT_BYTES}.`,
    );
  }
  if (!Number.isInteger(clientSearchTimeoutMs) || clientSearchTimeoutMs <= 0) {
    throw new Error("eve-openai-connectors: clientSearchTimeoutMs must be a positive integer.");
  }
  const logger = options.logger ?? console;
  const discovery = options.discovery ?? "client";

  const searchToolName = buildSearchToolName(toolPrefix);
  const statusToolName = buildStatusToolName(toolPrefix);
  const approvalPolicy = options.approvalFor ?? buildApprovalPolicy(options.approvals);

  const cache = new InventoryCache(inventoryTtlMs, MAX_PRINCIPAL_CACHE_ENTRIES);
  const clients = new Map<string, { client: ProtocolClient; token: string }>();
  /** Principals whose most recent failure has already been logged. */
  const loggedFailures = new Set<string>();

  function shouldLogFailure(key: string): boolean {
    if (loggedFailures.has(key)) return false;
    loggedFailures.add(key);
    while (loggedFailures.size > MAX_PRINCIPAL_CACHE_ENTRIES * 2) {
      const oldest = loggedFailures.values().next().value as string | undefined;
      if (oldest === undefined) break;
      loggedFailures.delete(oldest);
    }
    return true;
  }

  function invalidatePrincipal(principal: string): void {
    clients.delete(principal);
    cache.invalidate(principal);
    loggedFailures.delete(`catalog:${principal}`);
  }

  function principalOf(ctx: ConnectorContext): string | null {
    if (options.getPrincipal) {
      try {
        return options.getPrincipal(ctx) || null;
      } catch {
        return null;
      }
    }
    const auth = ctx?.session?.auth;
    const caller = auth?.current ?? auth?.initiator ?? null;
    if (!caller || typeof caller.principalId !== "string" || !caller.principalId) return null;
    const issuer = caller.issuer ?? caller.authenticator;
    return issuer ? `user:${issuer}:${caller.principalId}` : `user:${caller.principalId}`;
  }

  async function tokenFor(ctx: ConnectorContext, principal: string): Promise<string | null> {
    try {
      const token = (await options.getToken(ctx)) || null;
      if (!token) {
        invalidatePrincipal(principal);
      } else {
        loggedFailures.delete(`token:${principal}`);
      }
      return token;
    } catch (error) {
      invalidatePrincipal(principal);
      if (shouldLogFailure(`token:${principal}`)) {
        logger.error(
          `eve-openai-connectors: getToken failed for a user — treating as no access. ${firstErrorLine(error)}`,
        );
      }
      return null;
    }
  }

  function clientFor(principal: string, token: string): ProtocolClient {
    const existing = clients.get(principal);
    if (existing && existing.token === token) {
      clients.delete(principal);
      clients.set(principal, existing);
      return existing.client;
    }
    if (existing) {
      // A rotated credential gets a fresh protocol session and authorization
      // inventory. The immutable catalog it returns may still be interned.
      cache.invalidate(principal);
      loggedFailures.delete(`catalog:${principal}`);
    }
    const client = createProtocolClient({ baseUrl, token });
    clients.set(principal, { client, token });
    while (clients.size > MAX_PRINCIPAL_CACHE_ENTRIES) {
      const oldest = clients.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      invalidatePrincipal(oldest);
      loggedFailures.delete(`token:${oldest}`);
    }
    return client;
  }

  function loadInventory(principal: string, token: string): Promise<Inventory> {
    const client = clientFor(principal, token);
    return cache.get(principal, async () => {
      const tools = await client.listTools();
      const inventory = buildInventory(
        tools,
        toolPrefix,
        (message) => logger.warn(message),
        maxToolNameLength,
        allowedServices,
      );
      loggedFailures.delete(`catalog:${principal}`);
      return inventory;
    });
  }

  function searchDescription(inventory: Inventory | null): string {
    const header =
      "Search the ChatGPT connector tools available to the current user. " +
      `Matching tools become callable on your next step using their generated name (e.g. ${toolPrefix}github_search_repositories). ` +
      "Read-only tools run without approval; write tools require human approval before running.";
    if (!inventory) {
      return (
        header +
        " NOTE: the connector catalog is temporarily unavailable — previously discovered tools remain visible and will be revalidated when called; retry the search later."
      );
    }
    const services = [...inventory.services.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([service, count]) => `${service} (${count})`)
      .join(", ");
    return `${header} Available services: ${services}.`;
  }

  const searchInputSchema: ConnectorSession["searchInputSchema"] = {
    type: "object",
    properties: {
      keywords: {
        type: "string",
        description: "Space-separated keywords describing the capability you need.",
      },
      service: {
        type: "string",
        description: "Optional service filter, e.g. \"github\" or \"google_drive\".",
      },
      limit: {
        type: "number",
        description: `Maximum results (default ${searchLimitDefault}, max ${searchLimitMax}).`,
      },
    },
    required: ["keywords"],
    additionalProperties: false,
  };

  const statusInputSchema: ConnectorSession["statusInputSchema"] = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  return {
    async begin(ctx): Promise<ConnectorSession | null> {
      try {
        if (!enabled) return null;
        const principal = principalOf(ctx);
        if (!principal) return null;
        const token = await tokenFor(ctx, principal);
        if (!token) return null;

        // Detect credential rotation before consulting principal-scoped state.
        clientFor(principal, token);
        let inventory: Inventory | null = cache.peek(principal);
        if (!inventory) {
          // Bounded attempt; the load keeps running and fills the cache for
          // the next step. Failure degrades the search description only.
          inventory = await Promise.race([
            loadInventory(principal, token).catch((error: unknown) => {
              if (shouldLogFailure(`catalog:${principal}`)) {
                logger.warn(
                  `eve-openai-connectors: connector catalog load failed — continuing with previously discovered tools. ${firstErrorLine(error)}`,
                );
              }
              return null;
            }),
            new Promise<null>((resolve) => {
              const timer = setTimeout(() => resolve(null), BEGIN_CATALOG_BUDGET_MS);
              timer.unref?.();
            }),
          ]);
        }

        const discovered = searchResultsFromMessages(ctx.messages ?? [], {
          searchToolName,
          max: maxMaterializedTools,
        }).filter(
          (item) =>
            allowedServices === undefined || allowedServices.has(serviceFromUpstream(item.upstream)),
        );
        const loaded = inventory
          ? clientToolSearchResultsFromMessages(
              ctx.messages ?? [],
              inventory,
              maxMaterializedTools,
            )
          : [];
        const deferred = discovery === "deferred" && inventory ? inventory.items : [];

        return {
          principal,
          searchToolName,
          searchToolDescription: searchDescription(inventory),
          searchInputSchema,
          statusToolName,
          statusToolDescription:
            "Report the health of the ChatGPT connector catalog for the current user: available services, tool counts, and whether the access token works.",
          statusInputSchema,
          discovered,
          loaded,
          clientSearchEnabled: discovery === "client",
          deferred,
          catalogFingerprint: inventory?.fingerprint ?? null,
        };
      } catch (error) {
        // The resolver must never throw.
        logger.error(
          `eve-openai-connectors: begin() failed unexpectedly — connectors disabled for this step. ${firstErrorLine(error)}`,
        );
        return null;
      }
    },

    async search(ctx, input): Promise<ConnectorToolItem[]> {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Connector search is unavailable: no authenticated user.");
      const token = await tokenFor(ctx, principal);
      if (!token) throw new Error("Connector search is unavailable: the current user has no access token.");
      const inventory = await loadInventory(principal, token);
      return searchInventory(inventory, (input ?? { keywords: "" }) as SearchInput, {
        limitDefault: searchLimitDefault,
        limitMax: searchLimitMax,
      });
    },

    async clientSearch(ctx, input, namespace): Promise<ClientToolSearchOutput> {
      return within(
        (async () => {
          const parsed = parseClientToolSearchInput(input);
          const principal = principalOf(ctx);
          if (!principal) {
            throw new Error("Connector tool search is unavailable: no authenticated user.");
          }
          const token = await tokenFor(ctx, principal);
          if (!token) {
            throw new Error(
              "Connector tool search is unavailable: the current user has no access token.",
            );
          }
          const inventory = await loadInventory(principal, token);
          const matches = searchInventory(inventory, parsed, {
            limitDefault: searchLimitDefault,
            limitMax: searchLimitMax,
          });
          return materializeClientToolSearchOutput(
            inventory,
            matches,
            namespace,
            clientSearchMaxBytes,
          );
        })(),
        clientSearchTimeoutMs,
        `Connector tool search exceeded its ${clientSearchTimeoutMs}ms latency budget.`,
      );
    },

    async call(ctx, upstream, input, expected): Promise<unknown> {
      if (typeof upstream !== "string" || upstream.length === 0) {
        throw new Error("Connector call requires the stored upstream tool name.");
      }
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Connector call is unavailable: no authenticated user.");
      const token = await tokenFor(ctx, principal);
      if (!token) throw new Error("Connector call is unavailable: the current user has no access token.");
      const service = serviceFromUpstream(upstream);
      if (allowedServices !== undefined && !allowedServices.has(service)) {
        throw new Error(`Connector service ${JSON.stringify(service)} is not allowed by this extension.`);
      }

      // Tool definitions may outlive a credential/catalog rotation. Always
      // revalidate membership and policy-relevant descriptor content before
      // crossing the network with the current principal's token.
      const inventory = await loadInventory(principal, token);
      const authorized = inventory.byUpstream.get(upstream);
      if (!authorized) {
        throw new Error(
          `Connector tool ${JSON.stringify(upstream)} is not available to the current user.`,
        );
      }
      if (expected !== undefined && !sameToolDescriptor(expected, authorized)) {
        throw new Error(
          `Connector tool ${JSON.stringify(upstream)} changed since discovery; retry discovery before calling it.`,
        );
      }

      const signal = (ctx as { abortSignal?: AbortSignal }).abortSignal;
      const startedAt = Date.now();
      let outcome = "ok";
      try {
        const result = await clientFor(principal, token).callTool(
          upstream,
          input ?? {},
          signal ? { signal } : {},
        );
        if (result.isError) {
          outcome = "tool-error";
          throw new ConnectorToolError(extractErrorText(result.content) ?? `${upstream} reported an error.`);
        }
        return result.structuredContent ?? result.content;
      } catch (error) {
        if (outcome === "ok") outcome = "error";
        throw error;
      } finally {
        // Log name, duration, and outcome only — never arguments or results.
        if (outcome !== "ok") {
          logger.warn(
            `eve-openai-connectors: ${upstream} → ${outcome} in ${Date.now() - startedAt}ms`,
          );
        }
      }
    },

    async status(ctx): Promise<ConnectorStatus> {
      const principal = principalOf(ctx);
      const token = principal ? await tokenFor(ctx, principal) : null;
      if (!principal || !token) {
        return {
          enabled,
          tokenPresent: false,
          cache: getConnectorCacheMetrics(),
          catalog: { ok: false, error: "No access token for the current user.", authError: false },
        };
      }
      try {
        const inventory = await loadInventory(principal, token);
        return {
          enabled,
          tokenPresent: true,
          cache: getConnectorCacheMetrics(),
          catalog: {
            ok: true,
            totalTools: inventory.items.length,
            readOnlyTools: inventory.readOnlyCount,
            services: [...inventory.services.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([service, tools]) => ({ service, tools })),
          },
        };
      } catch (error) {
        return {
          enabled,
          tokenPresent: true,
          cache: getConnectorCacheMetrics(),
          catalog: {
            ok: false,
            error: firstErrorLine(error),
            authError: error instanceof ConnectorAuthError,
          },
        };
      }
    },

    approvalFor(item): Approval {
      return approvalPolicy(item);
    },
  };
}

function extractErrorText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : null,
      )
      .filter((text): text is string => text !== null && text.length > 0);
    if (texts.length > 0) return texts.join("\n");
  }
  return null;
}
