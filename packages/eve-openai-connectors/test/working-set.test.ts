import { describe, expect, test } from "vitest";

import { buildInventory } from "../extension/lib/catalog.js";
import type { ConnectorToolItem, ConnectorWorkingSet, UpstreamTool } from "../extension/lib/types.js";
import {
  compactConnectorSearchOutput,
  connectorWorkingSet,
  isConnectorWorkingSet,
  materializeConnectorWorkingSet,
  mergeConnectorWorkingSet,
  shouldClearConnectorWorkingSet,
} from "../extension/lib/working-set.js";
import {
  ContextContainer,
  contextStorage,
} from "../node_modules/eve/dist/src/context/container.js";
import {
  deserializeContext,
  serializeContext,
} from "../node_modules/eve/dist/src/context/serialize.js";

const TOOLS: UpstreamTool[] = [
  {
    name: "github.search_issues",
    description: "Search GitHub issues.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "github.create_issue",
    description: "Create a GitHub issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_drive.search_files",
    description: "Search Google Drive files.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

const inventory = buildInventory(TOOLS, "", undefined, 56);

function manifest(items: readonly ConnectorToolItem[], source: "search" | "client" = "search") {
  return mergeConnectorWorkingSet(null, {
    authority: "principal-a",
    catalogFingerprint: inventory.fingerprint,
    items,
    source,
    max: 30,
  });
}

describe("durable connector working set", () => {
  test("stores only bounded references and compact search output contains no schema", () => {
    const merged = mergeConnectorWorkingSet(null, {
      authority: "principal-a",
      catalogFingerprint: inventory.fingerprint,
      items: [...inventory.items, ...inventory.items],
      source: "search",
      max: 2,
    });
    expect(merged.tools).toEqual([
      { name: "github_create_issue", upstream: "github.create_issue", source: "search" },
      { name: "github_search_issues", upstream: "github.search_issues", source: "search" },
    ]);
    expect(JSON.stringify(merged)).not.toContain("inputSchema");
    expect(JSON.stringify(merged)).not.toContain("properties");

    const output = compactConnectorSearchOutput(inventory.items);
    expect(output.loaded[0]).toEqual({
      name: "github_create_issue",
      summary: "[write — requires approval] Create a GitHub issue.",
    });
    expect(JSON.stringify(output)).not.toContain("inputSchema");
    expect(JSON.stringify(output)).not.toContain("properties");
  });

  test("new searches win, preserve relevance order, dedupe, and retain older tools", () => {
    const first = manifest(inventory.items.slice(0, 2));
    const second = mergeConnectorWorkingSet(first, {
      authority: "principal-a",
      catalogFingerprint: inventory.fingerprint,
      items: [inventory.items[1]!, inventory.items[2]!],
      source: "client",
      max: 3,
    });
    expect(second.tools).toEqual([
      { name: "github_search_issues", upstream: "github.search_issues", source: "client" },
      {
        name: "google_drive_search_files",
        upstream: "google_drive.search_files",
        source: "client",
      },
      { name: "github_create_issue", upstream: "github.create_issue", source: "search" },
    ]);
  });

  test("reconstructs after opaque compaction or restart using state plus the live catalog", () => {
    const durable = manifest(inventory.items, "client");
    const loaded = materializeConnectorWorkingSet(durable, "principal-a", inventory, 2);
    expect(loaded.map((entry) => entry.item)).toEqual(inventory.items.slice(0, 2));
    expect(loaded.every((entry) => entry.source === "client")).toBe(true);
  });

  test("survives Eve durable-context serialization without transcript history", async () => {
    const durable = manifest(inventory.items, "client");
    const firstWorker = new ContextContainer();
    await contextStorage.run(firstWorker, () => {
      expect(connectorWorkingSet.get()).toBeNull();
      connectorWorkingSet.update(() => durable);
    });

    const persisted = JSON.parse(JSON.stringify(serializeContext(firstWorker))) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(persisted)).not.toContain("inputSchema");
    const coldWorker = await deserializeContext(persisted);
    await contextStorage.run(coldWorker, () => {
      expect(connectorWorkingSet.get()).toEqual(durable);
    });
  });

  test("never materializes another principal's state", () => {
    const durable = manifest(inventory.items);
    expect(materializeConnectorWorkingSet(durable, "principal-b", inventory, 30)).toEqual([]);
    expect(shouldClearConnectorWorkingSet(durable, "principal-b", inventory.fingerprint)).toBe(
      true,
    );
  });

  test("fails closed on catalog change, removed tools, malformed state, and outage", () => {
    const durable = manifest(inventory.items);
    const changed = buildInventory(TOOLS.slice(0, 2), "", undefined, 56);
    expect(materializeConnectorWorkingSet(durable, "principal-a", changed, 30)).toEqual([]);
    expect(materializeConnectorWorkingSet(durable, "principal-a", null, 30)).toEqual([]);
    expect(shouldClearConnectorWorkingSet(durable, "principal-a", changed.fingerprint)).toBe(true);

    const removedOnly: ConnectorWorkingSet = {
      ...durable,
      catalogFingerprint: changed.fingerprint,
      tools: [{ name: "removed", upstream: "github.removed", source: "search" }],
    };
    expect(materializeConnectorWorkingSet(removedOnly, "principal-a", changed, 30)).toEqual([]);
    expect(isConnectorWorkingSet({ version: 1, authority: "principal-a", tools: [] })).toBe(false);
    expect(
      isConnectorWorkingSet({
        ...durable,
        tools: [{ ...durable.tools[0], inputSchema: { type: "object" } }],
      }),
    ).toBe(false);
    expect(materializeConnectorWorkingSet({ unexpected: true }, "principal-a", inventory, 30)).toEqual(
      [],
    );
  });

  test("a changed catalog or authority replaces rather than merges stale references", () => {
    const original = manifest(inventory.items);
    const changed = buildInventory(TOOLS.slice(1), "", undefined, 56);
    const replacedCatalog = mergeConnectorWorkingSet(original, {
      authority: "principal-a",
      catalogFingerprint: changed.fingerprint,
      items: changed.items,
      source: "search",
      max: 30,
    });
    expect(replacedCatalog.tools.map((entry) => entry.upstream)).toEqual(
      changed.items.map((item) => item.upstream),
    );

    const replacedAuthority = mergeConnectorWorkingSet(original, {
      authority: "principal-b",
      catalogFingerprint: inventory.fingerprint,
      items: [inventory.items[2]!],
      source: "search",
      max: 30,
    });
    expect(replacedAuthority.tools).toEqual([
      {
        name: "google_drive_search_files",
        upstream: "google_drive.search_files",
        source: "search",
      },
    ]);
  });
});
