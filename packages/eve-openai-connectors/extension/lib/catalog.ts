import { buildNameMap } from "./naming.js";
import { flagsFromAnnotations } from "./policy.js";
import type { ConnectorToolItem, SearchInput, UpstreamTool } from "./types.js";

/** Keep materialized descriptions bounded so search results stay cheap. */
const MAX_DESCRIPTION_LENGTH = 700;

export interface Inventory {
  items: ConnectorToolItem[];
  byUpstream: Map<string, ConnectorToolItem>;
  /** service → tool count, insertion-ordered by first appearance. */
  services: Map<string, number>;
  readOnlyCount: number;
  loadedAt: number;
}

function serviceOf(upstream: string): string {
  const dot = upstream.indexOf(".");
  return dot === -1 ? upstream : upstream.slice(0, dot);
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

export function buildInventory(
  tools: readonly UpstreamTool[],
  prefix: string,
  warn?: (message: string) => void,
  maxToolNameLength = 64,
  allowedServices?: ReadonlySet<string>,
): Inventory {
  const named = tools.filter(
    (tool): tool is UpstreamTool & { name: string } =>
      typeof tool?.name === "string" &&
      tool.name.length > 0 &&
      (allowedServices === undefined || allowedServices.has(serviceOf(tool.name).toLowerCase())),
  );
  const nameMap = buildNameMap(
    named.map((tool) => tool.name),
    prefix,
    warn,
    maxToolNameLength,
  );
  const byName = new Map(named.map((tool) => [tool.name, tool]));

  const items: ConnectorToolItem[] = [];
  const byUpstream = new Map<string, ConnectorToolItem>();
  const services = new Map<string, number>();
  let readOnlyCount = 0;

  for (const [upstream, mapped] of nameMap) {
    const tool = byName.get(upstream);
    if (!tool) continue;
    const flags = flagsFromAnnotations(tool.annotations);
    const item: ConnectorToolItem = {
      name: mapped,
      upstream,
      service: serviceOf(upstream),
      description: decorateDescription(tool.description ?? tool.title ?? "", flags),
      inputSchema:
        typeof tool.inputSchema === "object" && tool.inputSchema !== null
          ? (tool.inputSchema as ConnectorToolItem["inputSchema"])
          : { type: "object" },
      readOnly: flags.readOnly,
      destructive: flags.destructive,
    };
    items.push(item);
    byUpstream.set(upstream, item);
    services.set(item.service, (services.get(item.service) ?? 0) + 1);
    if (item.readOnly) readOnlyCount++;
  }

  return { items, byUpstream, services, readOnlyCount, loadedAt: Date.now() };
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

  constructor(private readonly ttlMs: number) {}

  /** Return the cached inventory when fresh, without loading. */
  peek(principal: string): Inventory | null {
    const entry = this.positive.get(principal);
    if (entry && entry.expiresAt > Date.now()) return entry.inventory;
    return null;
  }

  async get(principal: string, loader: () => Promise<Inventory>): Promise<Inventory> {
    const cached = this.peek(principal);
    if (cached) return cached;

    const negative = this.negative.get(principal);
    if (negative && negative.expiresAt > Date.now()) throw negative.error;

    const existing = this.inflight.get(principal);
    if (existing) return existing;

    const load = (async () => {
      try {
        const inventory = await loader();
        this.positive.set(principal, {
          inventory,
          expiresAt: Date.now() + this.ttlMs,
        });
        this.negative.delete(principal);
        return inventory;
      } catch (error) {
        this.negative.set(principal, {
          error,
          expiresAt: Date.now() + NEGATIVE_TTL_MS,
        });
        throw error;
      } finally {
        this.inflight.delete(principal);
      }
    })();
    this.inflight.set(principal, load);
    return load;
  }
}
