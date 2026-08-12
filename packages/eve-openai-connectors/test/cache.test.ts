import { describe, expect, test, vi } from "vitest";

import { BoundedTtlCache, getConnectorCacheMetrics } from "../extension/lib/cache.js";
import { buildInventory } from "../extension/lib/catalog.js";
import { getOrCreateDeferredToolSet } from "../extension/lib/tool-cache.js";
import type { UpstreamTool } from "../extension/lib/types.js";

const BASE_CATALOG: UpstreamTool[] = [
  {
    name: "github.search_issues",
    description: "Search issues.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];

describe("content-addressed catalog interning", () => {
  test("equivalent catalogs share frozen descriptors and schema identities", () => {
    const first = buildInventory(structuredClone(BASE_CATALOG), "apps_");
    const second = buildInventory(structuredClone(BASE_CATALOG), "apps_");

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.items).toBe(first.items);
    expect(second.items[0]).toBe(first.items[0]);
    expect(second.items[0]?.inputSchema).toBe(first.items[0]?.inputSchema);
    expect(Object.isFrozen(first.items)).toBe(true);
    expect(Object.isFrozen(first.items[0]?.inputSchema)).toBe(true);
  });

  test("annotations, service filters, and prefixes participate in the content address", () => {
    const base = buildInventory(structuredClone(BASE_CATALOG), "apps_");
    const changedAnnotations = structuredClone(BASE_CATALOG);
    changedAnnotations[0] = {
      ...changedAnnotations[0]!,
      annotations: {
        ...changedAnnotations[0]!.annotations,
        openWorldHint: false,
      },
    };

    const annotated = buildInventory(changedAnnotations, "apps_");
    const filtered = buildInventory(structuredClone(BASE_CATALOG), "apps_", undefined, 64, new Set(["github"]));
    const prefixed = buildInventory(structuredClone(BASE_CATALOG), "other_");

    expect(annotated.fingerprint).not.toBe(base.fingerprint);
    expect(annotated.items).not.toBe(base.items);
    expect(filtered.fingerprint).not.toBe(base.fingerprint);
    expect(prefixed.fingerprint).not.toBe(base.fingerprint);
  });
});

describe("bounded shared caches", () => {
  test("TTL, entry, and estimated-byte limits evict LRU content", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00Z"));
    try {
      const cache = new BoundedTtlCache<object>({
        ttlMs: 100,
        maxEntries: 2,
        maxEstimatedBytes: 12,
      });
      const a = cache.getOrCreate("a", 6, () => ({ id: "a" }));
      expect(cache.getOrCreate("a", 6, () => ({ id: "not-a" }))).toBe(a);
      cache.getOrCreate("b", 6, () => ({ id: "b" }));
      cache.getOrCreate("c", 6, () => ({ id: "c" }));
      expect(cache.metrics()).toMatchObject({ hits: 1, misses: 3, entries: 2, estimatedBytes: 12 });

      vi.advanceTimersByTime(101);
      expect(cache.metrics()).toMatchObject({ entries: 0, estimatedBytes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("unchanged catalogs reuse connector-scoped dynamic tool-definition records", () => {
    const owner = {};
    const fingerprint = `tool-cache-test-${Date.now()}-${Math.random()}`;
    let creates = 0;
    const first = getOrCreateDeferredToolSet(owner, fingerprint, 189, () => {
      creates++;
      return { github_search_issues: { branded: true } };
    });
    const second = getOrCreateDeferredToolSet(owner, fingerprint, 189, () => {
      creates++;
      return { github_search_issues: { branded: false } };
    });

    expect(second).toBe(first);
    expect(creates).toBe(1);
    expect(getConnectorCacheMetrics()).toMatchObject({
      hits: expect.any(Number),
      misses: expect.any(Number),
      entries: expect.any(Number),
      estimatedBytes: expect.any(Number),
    });
  });
});
