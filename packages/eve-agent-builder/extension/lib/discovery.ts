import { z } from "zod";

import {
  agentIdSchema,
  canonicalizeAgentName,
  ownerScopeSchema,
  type AgentId,
  type OwnerScope,
  type PublishedAgentVersion,
  type SavedAgentKind,
} from "./domain.js";
import type { ActiveFamilyStoreRecord, AgentBuilderStore } from "./store.js";

export const DEFAULT_MAX_ROSTER_ENTRIES = 25;
export const DEFAULT_MAX_ROSTER_CHARACTERS = 12_000;
export const DEFAULT_SEARCH_PAGE_SIZE = 10;
export const MAX_SEARCH_PAGE_SIZE = 20;

export interface ActiveAgentEntry {
  readonly agentId: AgentId;
  readonly specId: PublishedAgentVersion["specId"];
  readonly version: number;
  readonly name: string;
  readonly canonicalName: string;
  readonly kind: SavedAgentKind;
  readonly description: string;
  readonly familyRevision: number;
}

export interface RenderedAgentRoster {
  readonly content: string;
  readonly included: readonly ActiveAgentEntry[];
  readonly omittedCount: number;
  /** UTF-16 code-unit count, matching JavaScript `String.length`. */
  readonly characterCount: number;
}

export interface SearchActiveAgentsInput {
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SearchActiveAgentsPage {
  readonly entries: readonly ActiveAgentEntry[];
  readonly nextCursor?: string;
}

export type SearchActiveAgentsResult =
  | { readonly ok: true; readonly value: SearchActiveAgentsPage }
  | {
      readonly ok: false;
      readonly error: Readonly<{
        code: "INVALID_INPUT" | "INVALID_CURSOR";
        message: string;
      }>;
    };

export type ActiveAgentGetResult =
  | { readonly status: "found"; readonly entry: ActiveAgentEntry }
  | { readonly status: "not_found" };

export type ActiveAgentRunAdmission =
  | {
      readonly status: "ready";
      readonly entry: ActiveAgentEntry & { readonly kind: "agent" };
      readonly version: PublishedAgentVersion & { readonly kind: "agent" };
    }
  | {
      readonly status: "load_skill_required";
      readonly agentId: AgentId;
      readonly skillName: string;
      readonly instruction: string;
    }
  | { readonly status: "not_found" };

export interface AgentDiscoveryOptions {
  readonly store: AgentBuilderStore;
  readonly maxRosterEntries?: number;
  readonly maxRosterCharacters?: number;
}

interface CursorPayload {
  readonly version: 1;
  readonly ownerHash: string;
  readonly query: string;
  readonly afterCanonicalName: string;
  readonly afterAgentId: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left: ActiveAgentEntry, right: ActiveAgentEntry): number {
  return (
    compareText(left.canonicalName, right.canonicalName) ||
    compareText(left.agentId, right.agentId)
  );
}

function toEntry(record: ActiveFamilyStoreRecord): ActiveAgentEntry {
  const { activeVersion: version, family } = record;
  return Object.freeze({
    agentId: family.agentId,
    specId: version.specId,
    version: version.version,
    name: version.name,
    canonicalName: canonicalizeAgentName(version.name),
    kind: version.kind,
    description: version.description,
    familyRevision: family.revision,
  });
}

function tokens(value: string): readonly string[] {
  return canonicalizeAgentName(value)
    .split(/[^\p{Letter}\p{Number}]+/gu)
    .filter((token) => token.length > 0);
}

function matches(entry: ActiveAgentEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true;
  if (
    entry.canonicalName.startsWith(normalizedQuery) ||
    canonicalizeAgentName(entry.agentId).startsWith(normalizedQuery)
  ) {
    return true;
  }
  const haystack = tokens(`${entry.name} ${entry.description}`);
  return tokens(normalizedQuery).every((needle) =>
    haystack.some((candidate) => candidate.startsWith(needle)),
  );
}

function renderRosterContent(
  entries: readonly ActiveAgentEntry[],
  omittedCount: number,
): string {
  return [
    "Active saved agents for the current user. Run by stable agentId, not by name.",
    "Use agent_builder__agent_search or agent_builder__agent_get for omitted or ambiguous entries.",
    ...entries.map((entry) =>
      JSON.stringify({
        agentId: entry.agentId,
        name: entry.name,
        description: entry.description,
      }),
    ),
    ...(omittedCount === 0 ? [] : [`Omitted active agents: ${omittedCount}`]),
  ].join("\n");
}

async function hashOwner(owner: OwnerScope): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `eve-agent-builder-owner-v1:${JSON.stringify([owner.tenantKey, owner.ownerKey])}`,
    ),
  );
  return Buffer.from(digest).toString("base64url");
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorPayload | null {
  if (raw.length < 1 || raw.length > 4_096) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const parsed = z
      .object({
        version: z.literal(1),
        ownerHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        query: z.string().max(512),
        afterCanonicalName: z.string().max(128),
        afterAgentId: z.string().min(1).max(512),
      })
      .strict()
      .safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class AgentDiscoveryService {
  readonly #store: AgentBuilderStore;
  readonly #maxRosterEntries: number;
  readonly #maxRosterCharacters: number;

  constructor(options: AgentDiscoveryOptions) {
    this.#store = options.store;
    this.#maxRosterEntries = options.maxRosterEntries ?? DEFAULT_MAX_ROSTER_ENTRIES;
    this.#maxRosterCharacters =
      options.maxRosterCharacters ?? DEFAULT_MAX_ROSTER_CHARACTERS;
    if (!Number.isSafeInteger(this.#maxRosterEntries) || this.#maxRosterEntries < 1) {
      throw new TypeError("maxRosterEntries must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxRosterCharacters) || this.#maxRosterCharacters < 256) {
      throw new TypeError("maxRosterCharacters must be a safe integer of at least 256");
    }
  }

  async list(owner: OwnerScope): Promise<readonly ActiveAgentEntry[]> {
    const parsed = ownerScopeSchema.parse(owner);
    const records = await this.#store.listActiveFamilies(parsed);
    return Object.freeze(records.map(toEntry).sort(compareEntries));
  }

  async roster(owner: OwnerScope): Promise<RenderedAgentRoster> {
    const activeAgents = (await this.list(owner)).filter((entry) => entry.kind === "agent");
    const included: ActiveAgentEntry[] = [];
    for (const entry of activeAgents) {
      if (included.length >= this.#maxRosterEntries) break;
      const candidate = [...included, entry];
      const omittedCount = activeAgents.length - candidate.length;
      if (renderRosterContent(candidate, omittedCount).length > this.#maxRosterCharacters) {
        break;
      }
      included.push(entry);
    }
    const omittedCount = activeAgents.length - included.length;
    const content = renderRosterContent(included, omittedCount);
    return Object.freeze({
      content,
      included: Object.freeze(included),
      omittedCount,
      characterCount: content.length,
    });
  }

  async get(owner: OwnerScope, rawAgentId: unknown): Promise<ActiveAgentGetResult> {
    const parsed = agentIdSchema.safeParse(rawAgentId);
    if (!parsed.success) return { status: "not_found" };
    const entry = (await this.list(owner)).find(
      (candidate) => candidate.agentId === parsed.data,
    );
    return entry === undefined ? { status: "not_found" } : { status: "found", entry };
  }

  async search(
    owner: OwnerScope,
    rawInput: SearchActiveAgentsInput,
  ): Promise<SearchActiveAgentsResult> {
    const input = z
      .object({
        query: z.string().max(512).optional(),
        cursor: z.string().max(4_096).optional(),
        limit: z.number().int().safe().min(1).max(MAX_SEARCH_PAGE_SIZE).optional(),
      })
      .strict()
      .safeParse(rawInput);
    const parsedOwner = ownerScopeSchema.safeParse(owner);
    if (!input.success || !parsedOwner.success) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Search input or owner scope is invalid" },
      };
    }
    const normalizedQuery = canonicalizeAgentName(input.data.query ?? "");
    const ownerHash = await hashOwner(parsedOwner.data);
    const cursor = input.data.cursor === undefined ? null : decodeCursor(input.data.cursor);
    if (
      input.data.cursor !== undefined &&
      (cursor === null || cursor.ownerHash !== ownerHash || cursor.query !== normalizedQuery)
    ) {
      return {
        ok: false,
        error: { code: "INVALID_CURSOR", message: "Search cursor is invalid for this owner and query" },
      };
    }
    const entries = (await this.list(parsedOwner.data)).filter((entry) =>
      matches(entry, normalizedQuery),
    );
    const afterIndex =
      cursor === null
        ? 0
        : entries.findIndex(
            (entry) =>
              entry.canonicalName === cursor.afterCanonicalName &&
              entry.agentId === cursor.afterAgentId,
          ) + 1;
    if (cursor !== null && afterIndex === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_CURSOR",
          message: "Search cursor no longer references a valid ordered entry",
        },
      };
    }
    const limit = input.data.limit ?? DEFAULT_SEARCH_PAGE_SIZE;
    const page = entries.slice(afterIndex, afterIndex + limit);
    const last = page.at(-1);
    const hasMore = afterIndex + page.length < entries.length;
    return {
      ok: true,
      value: Object.freeze({
        entries: Object.freeze(page),
        ...(hasMore && last !== undefined
          ? {
              nextCursor: encodeCursor({
                version: 1,
                ownerHash,
                query: normalizedQuery,
                afterCanonicalName: last.canonicalName,
                afterAgentId: last.agentId,
              }),
            }
          : {}),
      }),
    };
  }

  async admitRun(owner: OwnerScope, rawAgentId: unknown): Promise<ActiveAgentRunAdmission> {
    const found = await this.get(owner, rawAgentId);
    if (found.status === "not_found") return found;
    if (found.entry.kind === "skill") {
      return {
        status: "load_skill_required",
        agentId: found.entry.agentId,
        skillName: found.entry.name,
        instruction: `Load saved skill ${found.entry.name} (${found.entry.agentId}) through the saved-skill surface; skills cannot run by agentId.`,
      };
    }
    const version = await this.#store.getVersion({
      owner,
      agentId: found.entry.agentId,
      specId: found.entry.specId,
      version: found.entry.version,
    });
    if (version === null || version.kind !== "agent") return { status: "not_found" };
    return {
      status: "ready",
      entry: { ...found.entry, kind: "agent" },
      version: { ...version, kind: "agent" },
    };
  }
}

export function createAgentDiscoveryService(
  options: AgentDiscoveryOptions,
): AgentDiscoveryService {
  return new AgentDiscoveryService(options);
}
