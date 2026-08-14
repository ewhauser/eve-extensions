import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { BoundedTtlCache } from "./cache.js";
import { buildNameMap } from "./naming.js";
import { flagsFromAnnotations } from "./policy.js";
import type {
  ConnectorToolItem,
  JsonObject,
  JsonValue,
  SearchInput,
  UpstreamTool,
} from "./types.js";

/** Keep materialized descriptions bounded so search results stay cheap. */
const MAX_DESCRIPTION_LENGTH = 700;

export interface Inventory {
  /** Content address of the normalized catalog and mapping configuration. */
  fingerprint: string;
  /** Shared, deeply immutable descriptor array. */
  items: readonly ConnectorToolItem[];
  byUpstream: ReadonlyMap<string, ConnectorToolItem>;
  byName: ReadonlyMap<string, ConnectorToolItem>;
  /** service → tool count, insertion-ordered by first appearance. */
  services: ReadonlyMap<string, number>;
  readOnlyCount: number;
  loadedAt: number;
  estimatedBytes: number;
}

interface InternedCatalog extends Omit<Inventory, "loadedAt"> {}

// Catalogs outlive the default five-minute principal inventory but remain
// bounded under both cardinality and estimated retained content.
const catalogInternCache = new BoundedTtlCache<InternedCatalog>({
  ttlMs: 15 * 60_000,
  maxEntries: 256,
  maxEstimatedBytes: 128 * 1024 * 1024,
  registerMetrics: true,
});

function serviceOf(upstream: string): string {
  const dot = upstream.indexOf(".");
  return dot === -1 ? upstream : upstream.slice(0, dot);
}

function serviceIncluded(
  upstream: string,
  allowedServices: ReadonlySet<string> | undefined,
  excludedServices: ReadonlySet<string> | undefined,
): boolean {
  const service = serviceOf(upstream).toLowerCase();
  return (
    (allowedServices === undefined || allowedServices.has(service)) &&
    (excludedServices === undefined || !excludedServices.has(service))
  );
}

function decorateDescription(
  description: string,
  flags: { readOnly: boolean; destructive: boolean },
): string {
  let text = description.trim();
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    text = `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
  }
  // Eve's approval channel has no severity flag, so the write/destructive
  // tier is surfaced where both the model and any approval UI can see it.
  if (flags.destructive) return `[destructive write — requires approval] ${text}`;
  if (!flags.readOnly) return `[write — requires approval] ${text}`;
  return text;
}

export function stableJson(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item) ?? "null").join(",")}]`;
      }
      const object = value as Record<string, unknown>;
      const fields: string[] = [];
      for (const key of Object.keys(object).sort()) {
        const encoded = stableJson(object[key]);
        if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${fields.join(",")}}`;
    }
    default:
      return undefined;
  }
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else {
    for (const item of Object.values(value)) deepFreezeJson(item);
  }
  return Object.freeze(value);
}

function immutableSchema(value: unknown): JsonObject {
  const schema = typeof value === "object" && value !== null ? value : { type: "object" };
  const encoded = stableJson(schema) ?? '{"type":"object"}';
  return deepFreezeJson(JSON.parse(encoded) as JsonObject) as JsonObject;
}

function readonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  return Object.freeze({
    get size() {
      return source.size;
    },
    has: (key: K) => source.has(key),
    get: (key: K) => source.get(key),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      const view = readonlyMap(source);
      source.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]: () => source[Symbol.iterator](),
  });
}

function fingerprintCatalog(
  tools: readonly UpstreamTool[],
  prefix: string,
  maxToolNameLength: number,
  toolNameFormat: "flat" | "service-qualified",
  allowedServices: ReadonlySet<string> | undefined,
  excludedServices: ReadonlySet<string> | undefined,
): { fingerprint: string; estimatedBytes: number } {
  const normalizedTools = tools
    .filter(
      (tool): tool is UpstreamTool & { name: string } =>
        typeof tool?.name === "string" &&
        tool.name.length > 0 &&
        serviceIncluded(tool.name, allowedServices, excludedServices),
    )
    .map((tool) => ({ tool, encoded: stableJson(tool) ?? "{}" }))
    .sort((a, b) => a.tool.name.localeCompare(b.tool.name) || a.encoded.localeCompare(b.encoded));
  const encoded = stableJson({
    format: 1,
    prefix,
    maxToolNameLength,
    toolNameFormat,
    allowedServices: allowedServices === undefined ? null : [...allowedServices].sort(),
    excludedServices: excludedServices === undefined ? null : [...excludedServices].sort(),
    tools: normalizedTools.map(({ tool }) => tool),
  }) ?? "{}";
  return {
    fingerprint: createHash("sha256").update(encoded, "utf8").digest("hex"),
    estimatedBytes: Buffer.byteLength(encoded, "utf8"),
  };
}

export function buildInventory(
  tools: readonly UpstreamTool[],
  prefix: string,
  warn?: (message: string) => void,
  maxToolNameLength = 64,
  allowedServices?: ReadonlySet<string>,
  excludedServices?: ReadonlySet<string>,
  toolNameFormat: "flat" | "service-qualified" = "flat",
): Inventory {
  const { fingerprint, estimatedBytes } = fingerprintCatalog(
    tools,
    prefix,
    maxToolNameLength,
    toolNameFormat,
    allowedServices,
    excludedServices,
  );
  const catalog = catalogInternCache.getOrCreate(fingerprint, estimatedBytes, () =>
    materializeCatalog(
      tools,
      prefix,
      warn,
      maxToolNameLength,
      toolNameFormat,
      allowedServices,
      excludedServices,
      fingerprint,
      estimatedBytes,
    ),
  );
  return Object.freeze({ ...catalog, loadedAt: Date.now() });
}

function materializeCatalog(
  tools: readonly UpstreamTool[],
  prefix: string,
  warn: ((message: string) => void) | undefined,
  maxToolNameLength: number,
  toolNameFormat: "flat" | "service-qualified",
  allowedServices: ReadonlySet<string> | undefined,
  excludedServices: ReadonlySet<string> | undefined,
  fingerprint: string,
  estimatedBytes: number,
): InternedCatalog {
  const named = tools.filter(
    (tool): tool is UpstreamTool & { name: string } =>
      typeof tool?.name === "string" &&
      tool.name.length > 0 &&
      serviceIncluded(tool.name, allowedServices, excludedServices),
  );
  const nameMap = buildNameMap(
    named.map((tool) => tool.name),
    prefix,
    warn,
    maxToolNameLength,
    toolNameFormat,
  );
  const byName = new Map(named.map((tool) => [tool.name, tool]));

  const items: ConnectorToolItem[] = [];
  const byUpstream = new Map<string, ConnectorToolItem>();
  const byMappedName = new Map<string, ConnectorToolItem>();
  const services = new Map<string, number>();
  let readOnlyCount = 0;

  for (const [upstream, mapped] of nameMap) {
    const tool = byName.get(upstream);
    if (!tool) continue;
    const flags = flagsFromAnnotations(tool.annotations);
    const item: ConnectorToolItem = Object.freeze({
      name: mapped,
      upstream,
      service: serviceOf(upstream),
      description: decorateDescription(tool.description ?? tool.title ?? "", flags),
      inputSchema: immutableSchema(tool.inputSchema),
      readOnly: flags.readOnly,
      destructive: flags.destructive,
    });
    items.push(item);
    byUpstream.set(upstream, item);
    byMappedName.set(mapped, item);
    services.set(item.service, (services.get(item.service) ?? 0) + 1);
    if (item.readOnly) readOnlyCount++;
  }

  return Object.freeze({
    fingerprint,
    items: Object.freeze(items),
    byUpstream: readonlyMap(byUpstream),
    byName: readonlyMap(byMappedName),
    services: readonlyMap(services),
    readOnlyCount,
    estimatedBytes,
  });
}

const TOKEN_SPLIT = /[\s_\-./]+/;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((token) => token.length > 1);
}

/**
 * Token-overlap search: 3 points per name-token hit, 1 per description-token
 * hit, sorted descending (ties break alphabetically by name for determinism).
 * An unknown `service` throws, listing the available services, so a wrong
 * guess is self-correcting for the model.
 */
export function searchInventory(
  inventory: Inventory,
  input: SearchInput,
  limits: { limitDefault: number; limitMax: number },
): ConnectorToolItem[] {
  let candidates = inventory.items;
  if (input.service !== undefined && input.service !== "") {
    const service = String(input.service).toLowerCase();
    if (!inventory.services.has(service)) {
      const available = [...inventory.services.keys()].sort().join(", ");
      throw new Error(
        `Unknown service ${JSON.stringify(input.service)}. Available services: ${available}.`,
      );
    }
    candidates = candidates.filter((item) => item.service === service);
  }

  const rawLimit = typeof input.limit === "number" ? Math.floor(input.limit) : limits.limitDefault;
  const limit = Math.max(1, Math.min(rawLimit, limits.limitMax));

  const keywords = Array.isArray(input.keywords)
    ? input.keywords.join(" ")
    : String(input.keywords ?? "");
  const queryTokens = [...new Set(tokenize(keywords))];
  if (queryTokens.length === 0) {
    return [...candidates].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
  }

  const scored = candidates
    .map((item) => {
      const nameTokens = new Set(tokenize(item.upstream));
      const descriptionTokens = new Set(tokenize(item.description));
      let score = 0;
      for (const token of queryTokens) {
        if (nameTokens.has(token)) score += 3;
        if (descriptionTokens.has(token)) score += 1;
      }
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

  return scored.slice(0, limit).map((entry) => entry.item);
}

/** Compare every field that can affect schema, execution routing, or policy. */
export function sameToolDescriptor(
  expected: ConnectorToolItem,
  current: ConnectorToolItem,
): boolean {
  return (
    expected === current ||
    (expected.name === current.name &&
      expected.upstream === current.upstream &&
      expected.service === current.service &&
      expected.description === current.description &&
      expected.readOnly === current.readOnly &&
      expected.destructive === current.destructive &&
      stableJson(expected.inputSchema) === stableJson(current.inputSchema))
  );
}

const NEGATIVE_TTL_MS = 30_000;

/**
 * Per-principal inventory cache: TTL-bounded positive entries, brief negative
 * caching so a broken token cannot produce a request storm, and in-flight
 * promise deduplication for concurrent loads.
 */
export class InventoryCache {
  private readonly positive = new Map<string, { inventory: Inventory; expiresAt: number }>();
  private readonly negative = new Map<string, { error: unknown; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<Inventory>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1_000,
  ) {}

  /** Return the cached inventory when fresh, without loading. */
  peek(principal: string): Inventory | null {
    this.prune();
    const entry = this.positive.get(principal);
    if (entry && entry.expiresAt > Date.now()) {
      this.positive.delete(principal);
      this.positive.set(principal, entry);
      return entry.inventory;
    }
    return null;
  }

  /** Whether another caller currently owns the shared load for this key. */
  isLoading(principal: string): boolean {
    return this.inflight.has(principal);
  }

  /** Invalidate only this principal; stale in-flight loads cannot repopulate it. */
  invalidate(principal: string): void {
    if (this.inflight.has(principal)) {
      this.generations.set(principal, (this.generations.get(principal) ?? 0) + 1);
    } else {
      this.generations.delete(principal);
    }
    this.positive.delete(principal);
    this.negative.delete(principal);
    this.inflight.delete(principal);
  }

  async get(
    principal: string,
    loader: () => Promise<Inventory>,
    options: {
      cacheFailure?: (error: unknown) => boolean;
      cacheSuccess?: (inventory: Inventory) => boolean;
    } = {},
  ): Promise<Inventory> {
    const cached = this.peek(principal);
    if (cached) return cached;

    const negative = this.negative.get(principal);
    if (negative && negative.expiresAt > Date.now()) {
      this.negative.delete(principal);
      this.negative.set(principal, negative);
      throw negative.error;
    }

    const existing = this.inflight.get(principal);
    if (existing) return existing;

    const generation = this.generations.get(principal) ?? 0;
    const load = (async () => {
      try {
        const inventory = await loader();
        if (
          (this.generations.get(principal) ?? 0) === generation &&
          (options.cacheSuccess?.(inventory) ?? true)
        ) {
          this.positive.set(principal, {
            inventory,
            expiresAt: Date.now() + this.ttlMs,
          });
          this.trim(this.positive);
          this.negative.delete(principal);
        }
        return inventory;
      } catch (error) {
        if (
          (this.generations.get(principal) ?? 0) === generation &&
          (options.cacheFailure?.(error) ?? true)
        ) {
          this.negative.set(principal, {
            error,
            expiresAt: Date.now() + NEGATIVE_TTL_MS,
          });
          this.trim(this.negative);
        }
        throw error;
      } finally {
        if ((this.generations.get(principal) ?? 0) === generation) {
          this.inflight.delete(principal);
        }
        if (
          !this.positive.has(principal) &&
          !this.negative.has(principal) &&
          !this.inflight.has(principal)
        ) {
          this.generations.delete(principal);
        }
      }
    })();
    this.inflight.set(principal, load);
    return load;
  }

  private prune(): void {
    const now = Date.now();
    for (const [principal, entry] of this.positive) {
      if (entry.expiresAt <= now) this.positive.delete(principal);
    }
    for (const [principal, entry] of this.negative) {
      if (entry.expiresAt <= now) this.negative.delete(principal);
    }
  }

  private trim<T>(entries: Map<string, T>): void {
    while (entries.size > this.maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }
}
