import { defineState } from "eve/context";

import type { Inventory } from "./catalog.js";
import type {
  ConnectorSearchOutput,
  ConnectorToolItem,
  ConnectorWorkingSet,
  ConnectorWorkingSetEntry,
  ConnectorWorkingSetSource,
  MaterializedWorkingSetEntry,
} from "./types.js";

export const CONNECTOR_WORKING_SET_VERSION = 1 as const;
const MAX_SUMMARY_LENGTH = 240;

/** Durable, extension-scoped connector references for the current session. */
export const connectorWorkingSet = defineState<ConnectorWorkingSet | null>(
  "working-set",
  () => null,
);

function boundedLimit(max: number): number {
  return Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isWorkingSetEntry(value: unknown): value is ConnectorWorkingSetEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ConnectorWorkingSetEntry>;
  return (
    hasOnlyKeys(value, ["name", "upstream", "source"]) &&
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    typeof entry.upstream === "string" &&
    entry.upstream.length > 0 &&
    (entry.source === "search" || entry.source === "client")
  );
}

export function isConnectorWorkingSet(value: unknown): value is ConnectorWorkingSet {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<ConnectorWorkingSet>;
  return (
    hasOnlyKeys(value, ["version", "authority", "catalogFingerprint", "tools"]) &&
    manifest.version === CONNECTOR_WORKING_SET_VERSION &&
    typeof manifest.authority === "string" &&
    manifest.authority.length > 0 &&
    typeof manifest.catalogFingerprint === "string" &&
    manifest.catalogFingerprint.length > 0 &&
    Array.isArray(manifest.tools) &&
    manifest.tools.every(isWorkingSetEntry)
  );
}

function referenceFor(
  item: ConnectorToolItem,
  source: ConnectorWorkingSetSource,
): ConnectorWorkingSetEntry {
  return Object.freeze({ name: item.name, upstream: item.upstream, source });
}

/**
 * Merge one successful search into durable state. New results retain search
 * relevance order and win over older duplicates; the complete manifest stays
 * count bounded.
 */
export function mergeConnectorWorkingSet(
  current: unknown,
  update: {
    authority: string;
    catalogFingerprint: string;
    items: readonly ConnectorToolItem[];
    source: ConnectorWorkingSetSource;
    max: number;
  },
): ConnectorWorkingSet {
  const limit = boundedLimit(update.max);
  const prior =
    isConnectorWorkingSet(current) &&
    current.authority === update.authority &&
    current.catalogFingerprint === update.catalogFingerprint
      ? current.tools
      : [];
  const candidates = [
    ...update.items.map((item) => referenceFor(item, update.source)),
    ...prior,
  ];
  const tools: ConnectorWorkingSetEntry[] = [];
  const seenNames = new Set<string>();
  const seenUpstream = new Set<string>();
  for (const candidate of candidates) {
    if (seenNames.has(candidate.name) || seenUpstream.has(candidate.upstream)) continue;
    seenNames.add(candidate.name);
    seenUpstream.add(candidate.upstream);
    if (tools.length < limit) tools.push(candidate);
  }
  return Object.freeze({
    version: CONNECTOR_WORKING_SET_VERSION,
    authority: update.authority,
    catalogFingerprint: update.catalogFingerprint,
    tools: Object.freeze(tools),
  });
}

/**
 * Join durable references against a freshly authorized, exact-version catalog.
 * Any authority, catalog, mapping, or membership mismatch fails closed.
 */
export function materializeConnectorWorkingSet(
  value: unknown,
  authority: string,
  inventory: Inventory | null,
  max: number,
): MaterializedWorkingSetEntry[] {
  if (
    inventory === null ||
    !isConnectorWorkingSet(value) ||
    value.authority !== authority ||
    value.catalogFingerprint !== inventory.fingerprint
  ) {
    return [];
  }

  const materialized: MaterializedWorkingSetEntry[] = [];
  for (const reference of value.tools.slice(0, boundedLimit(max))) {
    const item = inventory.byUpstream.get(reference.upstream);
    if (!item || item.name !== reference.name) continue;
    materialized.push(Object.freeze({ item, source: reference.source }));
  }
  return materialized;
}

export function shouldClearConnectorWorkingSet(
  value: unknown,
  authority: string,
  catalogFingerprint: string | null,
): boolean {
  if (value === null || value === undefined) return false;
  if (!isConnectorWorkingSet(value) || value.authority !== authority) return true;
  return catalogFingerprint !== null && value.catalogFingerprint !== catalogFingerprint;
}

function shortSummary(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_SUMMARY_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

/** Compact model-facing result for ordinary progressive search. */
export function compactConnectorSearchOutput(
  items: readonly ConnectorToolItem[],
): ConnectorSearchOutput {
  return Object.freeze({
    loaded: Object.freeze(
      items.map((item) =>
        Object.freeze({ name: item.name, summary: shortSummary(item.description) }),
      ),
    ),
  });
}
