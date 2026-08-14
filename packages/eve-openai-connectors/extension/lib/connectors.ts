import { createHash } from "node:crypto";
import type { Approval } from "eve/tools";
import {
  buildInventory,
  InventoryCache,
  sameToolDescriptor,
  searchInventory,
  type Inventory,
} from "./catalog.js";
import {
  clientToolDescription,
  materializeClientToolSearchOutput,
  MIN_CLIENT_SEARCH_OUTPUT_BYTES,
  parseClientToolSearchInput,
} from "./client-search.js";
import { getConnectorCacheMetrics } from "./cache.js";
import { ConnectorAuthError, ConnectorToolError } from "./errors.js";
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
  ClientToolSearchResult,
  ClientToolSearchInput,
  ConnectorSearchResult,
  ConnectorToolItem,
  CreateConnectorsOptions,
  SearchInput,
} from "./types.js";
export type {
  ConnectorContext,
  ConnectorDiscovery,
  ConnectorResolutionStatus,
  ConnectorResolutionSummary,
  ConnectorSearchResult,
  ConnectorStatus,
  ConnectorToolItem,
  CreateConnectorsOptions,
  ProtocolClientLifetime,
  SearchInput,
} from "./types.js";
export { ConnectorAuthError, ConnectorProtocolError, ConnectorToolError } from "./errors.js";
import {
  compactConnectorSearchOutput,
  materializeConnectorWorkingSet,
} from "./working-set.js";

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
   * otherwise a session describing the discovery tool plus working-set tools
   * revalidated against the current catalog. Never throws.
   */
  begin(ctx: ConnectorContext, workingSet?: unknown): Promise<ConnectorSession | null>;
  /** Execute body for the search tool. Accepts the raw tool input object. */
  search(
    ctx: ConnectorContext,
    input: SearchInput | Record<string, unknown>,
  ): Promise<ConnectorSearchResult>;
  /** Execute OpenAI client tool search, or the bounded progressive provider fallback. */
  clientSearch(
    ctx: ConnectorContext,
    input: ClientToolSearchInput | Record<string, unknown>,
    namespace: string,
  ): Promise<ClientToolSearchResult>;
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

function normalizeServices(
  option: "allowedServices" | "excludedServices",
  services: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (services === undefined) return undefined;
  const normalized = new Set<string>();
  for (const service of services) {
    const value = service.trim().toLowerCase();
    if (!value) {
      throw new Error(`eve-openai-connectors: ${option} entries must be non-empty strings.`);
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

async function within<T>(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
    timer.unref?.();
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal;
    try {
      return await operation(signal);
    } catch (error) {
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new Error(message, { cause: error });
      }
      throw error;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Connector operation aborted.");
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<T>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Connector operation aborted."),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function createConnectors(options: CreateConnectorsOptions): Connectors {
  if (typeof options?.getToken !== "function") {
    throw new Error("eve-openai-connectors: createConnectors requires a getToken(ctx) function.");
  }
  const enabled = options.enabled ?? true;
  const allowedServices = normalizeServices("allowedServices", options.allowedServices);
  const excludedServices = normalizeServices("excludedServices", options.excludedServices);
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const toolPrefix = options.toolPrefix ?? "apps_";
  validateToolPrefix(toolPrefix);
  const toolNameFormat = options.toolNameFormat ?? "flat";
  if (toolNameFormat === "service-qualified" && toolPrefix.length > 0) {
    throw new Error(
      "eve-openai-connectors: toolPrefix must be empty when toolNameFormat is \"service-qualified\".",
    );
  }
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
  const protocolClientLifetime = options.protocolClientLifetime ?? "principal";
  if (protocolClientLifetime !== "principal" && protocolClientLifetime !== "operation") {
    throw new Error(
      "eve-openai-connectors: protocolClientLifetime must be \"principal\" or \"operation\".",
    );
  }

  const searchToolName = buildSearchToolName(toolPrefix);
  const statusToolName = buildStatusToolName(toolPrefix);
  const approvalPolicy = options.approvalFor ?? buildApprovalPolicy(options.approvals);

  const cache = new InventoryCache(inventoryTtlMs, MAX_PRINCIPAL_CACHE_ENTRIES);
  const clients = new Map<string, { client: ProtocolClient; credentialFingerprint: string }>();
  /** Per-principal credential hashes only; raw tokens are never retained here. */
  const credentialFingerprints = new Map<string, string>();
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

  function credentialCacheKey(principal: string, fingerprint: string): string {
    return `${principal}:${fingerprint}`;
  }

  function closeRetainedClient(principal: string): void {
    const retained = clients.get(principal);
    clients.delete(principal);
    if (retained) void retained.client.close();
  }

  function invalidatePrincipal(principal: string): void {
    closeRetainedClient(principal);
    const fingerprint = credentialFingerprints.get(principal);
    credentialFingerprints.delete(principal);
    if (fingerprint) cache.invalidate(credentialCacheKey(principal, fingerprint));
    loggedFailures.delete(`catalog:${principal}`);
  }

  function accessFor(
    principal: string,
    token: string,
  ): { token: string; credentialFingerprint: string; cacheKey: string } {
    const credentialFingerprint = createHash("sha256").update(token, "utf8").digest("hex");
    const previous = credentialFingerprints.get(principal);
    if (previous !== undefined && previous !== credentialFingerprint) {
      closeRetainedClient(principal);
      cache.invalidate(credentialCacheKey(principal, previous));
      loggedFailures.delete(`catalog:${principal}`);
    }
    credentialFingerprints.delete(principal);
    credentialFingerprints.set(principal, credentialFingerprint);
    while (credentialFingerprints.size > MAX_PRINCIPAL_CACHE_ENTRIES) {
      const oldest = credentialFingerprints.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      invalidatePrincipal(oldest);
      loggedFailures.delete(`token:${oldest}`);
    }
    return {
      token,
      credentialFingerprint,
      cacheKey: credentialCacheKey(principal, credentialFingerprint),
    };
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

  function retainedClientFor(
    principal: string,
    token: string,
    credentialFingerprint: string,
  ): ProtocolClient {
    const existing = clients.get(principal);
    if (existing && existing.credentialFingerprint === credentialFingerprint) {
      clients.delete(principal);
      clients.set(principal, existing);
      return existing.client;
    }
    if (existing) {
      closeRetainedClient(principal);
    }
    const client = createProtocolClient({ baseUrl, token });
    clients.set(principal, { client, credentialFingerprint });
    while (clients.size > MAX_PRINCIPAL_CACHE_ENTRIES) {
      const oldest = clients.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      invalidatePrincipal(oldest);
      loggedFailures.delete(`token:${oldest}`);
    }
    return client;
  }

  async function notifyAuthError(
    ctx: ConnectorContext,
    principal: string,
    credentialFingerprint: string,
    error: ConnectorAuthError,
  ): Promise<void> {
    // A request started before credential rotation must not evict the newer
    // credential's client/inventory or notify the application about a token
    // it no longer owns.
    if (credentialFingerprints.get(principal) !== credentialFingerprint) return;
    invalidatePrincipal(principal);
    try {
      await options.onAuthError?.(ctx, error);
    } catch {
      logger.warn("eve-openai-connectors: onAuthError callback failed.");
    }
  }

  async function withProtocolClient<T>(
    ctx: ConnectorContext,
    principal: string,
    access: ReturnType<typeof accessFor>,
    operation: (client: ProtocolClient) => Promise<T>,
  ): Promise<T> {
    try {
      if (protocolClientLifetime === "operation") {
        const client = createProtocolClient({ baseUrl, token: access.token });
        try {
          return await operation(client);
        } finally {
          await client.close();
        }
      }
      return await operation(
        retainedClientFor(principal, access.token, access.credentialFingerprint),
      );
    } catch (error) {
      if (error instanceof ConnectorAuthError) {
        await notifyAuthError(ctx, principal, access.credentialFingerprint, error);
      }
      throw error;
    }
  }

  function loadInventory(
    ctx: ConnectorContext,
    principal: string,
    access: ReturnType<typeof accessFor>,
    signal = ctx.abortSignal,
  ): Promise<Inventory> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new Error("Connector operation aborted."),
      );
    }
    const joinsSharedLoad = cache.isLoading(access.cacheKey);
    const loading = cache.get(
      access.cacheKey,
      async () => {
        const tools = await withProtocolClient(ctx, principal, access, (client) =>
          client.listTools(signal),
        );
        const inventory = buildInventory(
          tools,
          toolPrefix,
          (message) => logger.warn(message),
          maxToolNameLength,
          allowedServices,
          excludedServices,
          toolNameFormat,
        );
        loggedFailures.delete(`catalog:${principal}`);
        return inventory;
      },
      {
        cacheFailure: () => !signal?.aborted,
        cacheSuccess: () => !signal?.aborted,
      },
    );
    // The load owner awaits protocol cleanup in its normal finally path. A
    // later waiter can stop waiting independently without cancelling that
    // shared request for everyone else.
    if (joinsSharedLoad) return waitWithSignal(loading, signal);
    return loading.then((inventory) => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Connector operation aborted.");
      }
      return inventory;
    });
  }

  function searchDescription(inventory: Inventory | null): string {
    const header =
      "Search the ChatGPT connector tools available to the current user. " +
      `Matching tools become callable on your next step using their generated name (e.g. ${toolNameFormat === "service-qualified" ? "github__search_repositories" : `${toolPrefix}github_search_repositories`}). ` +
      "Read-only tools run without approval; write tools require human approval before running.";
    if (!inventory) {
      return (
        header +
        " NOTE: the connector catalog is temporarily unavailable, so no discovered tool is callable; retry the search later."
      );
    }
    const services = [...inventory.services.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([service, count]) => `${service} (${count})`)
      .join(", ");
    return `${header} Available services: ${services}.`;
  }

  function identifierMatchesService(identifier: string, service: string): boolean {
    const value = identifier.trim().toLowerCase();
    const relative = toolPrefix && value.startsWith(toolPrefix.toLowerCase())
      ? value.slice(toolPrefix.length)
      : value;
    return (
      relative === service ||
      relative.startsWith(`${service}.`) ||
      relative.startsWith(`${service}_`)
    );
  }

  function excludedServiceFor(identifier: string): string | null {
    if (excludedServices === undefined) return null;
    for (const service of excludedServices) {
      if (identifierMatchesService(identifier, service)) return service;
    }
    return null;
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
    async begin(ctx, workingSet): Promise<ConnectorSession | null> {
      let resolutionEmitted = false;
      const emitResolution = (
        status: "available" | "degraded" | "unavailable",
        resolvedDiscovery: "client" | "search" | "deferred",
        catalogToolCount: number,
        materializedToolCount: number,
      ): void => {
        if (resolutionEmitted) return;
        resolutionEmitted = true;
        try {
          const callback = options.onResolution?.(
            ctx,
            Object.freeze({
              status,
              discovery: resolvedDiscovery,
              catalogToolCount,
              materializedToolCount,
            }),
          );
          if (callback) {
            void callback.catch(() => {
              logger.warn("eve-openai-connectors: onResolution callback failed.");
            });
          }
        } catch {
          logger.warn("eve-openai-connectors: onResolution callback failed.");
        }
      };
      try {
        if (!enabled) {
          emitResolution("unavailable", discovery, 0, 0);
          return null;
        }
        const principal = principalOf(ctx);
        if (!principal) {
          emitResolution("unavailable", discovery, 0, 0);
          return null;
        }
        const token = await tokenFor(ctx, principal);
        if (!token) {
          emitResolution("unavailable", discovery, 0, 0);
          return null;
        }

        // Detect credential rotation before consulting principal-scoped state.
        const access = accessFor(principal, token);
        let inventory: Inventory | null = cache.peek(access.cacheKey);
        if (!inventory) {
          // Bounded attempt; the load keeps running and fills the cache for
          // the next step. Failure degrades the search description only.
          inventory = await Promise.race([
            loadInventory(ctx, principal, access).catch((error: unknown) => {
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

        const materialized = materializeConnectorWorkingSet(
          workingSet,
          principal,
          inventory,
          maxMaterializedTools,
        );
        const discovered = materialized
          .filter((entry) => entry.source === "search")
          .map((entry) => entry.item);
        const loaded = materialized
          .filter((entry) => entry.source === "client")
          .map(({ item }) =>
            Object.freeze({
              item,
              description: clientToolDescription(item, inventory!.fingerprint),
            }),
          );
        const deferred = discovery === "deferred" && inventory ? inventory.items : [];
        const session: ConnectorSession = {
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
          maxMaterializedTools,
          clientSearchEnabled: discovery === "client",
          deferred,
          catalogFingerprint: inventory?.fingerprint ?? null,
        };
        emitResolution(
          inventory ? "available" : "degraded",
          discovery === "deferred" && !inventory ? "search" : discovery,
          inventory?.items.length ?? 0,
          discovered.length + loaded.length + deferred.length,
        );
        return session;
      } catch (error) {
        emitResolution("unavailable", discovery, 0, 0);
        // The resolver must never throw.
        logger.error(
          `eve-openai-connectors: begin() failed unexpectedly — connectors disabled for this step. ${firstErrorLine(error)}`,
        );
        return null;
      }
    },

    async search(ctx, input): Promise<ConnectorSearchResult> {
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Connector search is unavailable: no authenticated user.");
      const token = await tokenFor(ctx, principal);
      if (!token) throw new Error("Connector search is unavailable: the current user has no access token.");
      const access = accessFor(principal, token);
      const inventory = await loadInventory(ctx, principal, access);
      const items = searchInventory(
        inventory,
        (input ?? { keywords: "" }) as SearchInput,
        {
          limitDefault: searchLimitDefault,
          limitMax: searchLimitMax,
        },
      ).slice(0, maxMaterializedTools);
      return Object.freeze({
        output: compactConnectorSearchOutput(items),
        items,
        authority: principal,
        catalogFingerprint: inventory.fingerprint,
      });
    },

    async clientSearch(ctx, input, namespace): Promise<ClientToolSearchResult> {
      return within(
        ctx.abortSignal,
        clientSearchTimeoutMs,
        `Connector tool search exceeded its ${clientSearchTimeoutMs}ms latency budget.`,
        async (signal) => {
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
          const access = accessFor(principal, token);
          const inventory = await loadInventory(ctx, principal, access, signal);
          const matches = searchInventory(inventory, parsed, {
            limitDefault: searchLimitDefault,
            limitMax: searchLimitMax,
          }).slice(0, maxMaterializedTools);
          const output = materializeClientToolSearchOutput(
            inventory,
            matches,
            namespace,
            clientSearchMaxBytes,
          );
          const returnedNames = new Set(output.tools.map((tool) => tool.name));
          const items = matches.filter((item) => returnedNames.has(`${namespace}${item.name}`));
          return Object.freeze({
            output,
            items,
            authority: principal,
            catalogFingerprint: inventory.fingerprint,
          });
        },
      );
    },

    async call(ctx, upstream, input, expected): Promise<unknown> {
      if (typeof upstream !== "string" || upstream.length === 0) {
        throw new Error("Connector call requires the stored upstream tool name.");
      }
      const excludedService = excludedServiceFor(upstream);
      if (excludedService !== null) {
        throw new Error(
          `Connector service ${JSON.stringify(excludedService)} is excluded by this extension.`,
        );
      }
      const principal = principalOf(ctx);
      if (!principal) throw new Error("Connector call is unavailable: no authenticated user.");
      const token = await tokenFor(ctx, principal);
      if (!token) throw new Error("Connector call is unavailable: the current user has no access token.");
      const access = accessFor(principal, token);
      const service = serviceFromUpstream(upstream);
      if (allowedServices !== undefined && !allowedServices.has(service)) {
        throw new Error(`Connector service ${JSON.stringify(service)} is not allowed by this extension.`);
      }

      // Tool definitions may outlive a credential/catalog rotation. Always
      // revalidate membership and policy-relevant descriptor content before
      // crossing the network with the current principal's token.
      const inventory = await loadInventory(ctx, principal, access);
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

      const startedAt = Date.now();
      let outcome = "ok";
      try {
        const originalInput = Object.freeze({ ...(input ?? {}) });
        const transformedInput = options.transformCallInput
          ? options.transformCallInput(ctx, authorized, originalInput)
          : originalInput;
        if (
          typeof transformedInput !== "object" ||
          transformedInput === null ||
          Array.isArray(transformedInput)
        ) {
          throw new Error("Connector call input transformation must return an object.");
        }
        const result = await withProtocolClient(ctx, principal, access, (client) =>
          client.callTool(
            upstream,
            transformedInput,
            ctx.abortSignal ? { signal: ctx.abortSignal } : {},
          ),
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
        const access = accessFor(principal, token);
        const inventory = await loadInventory(ctx, principal, access);
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
