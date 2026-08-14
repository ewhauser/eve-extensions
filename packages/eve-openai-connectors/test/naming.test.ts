import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildNameMap,
  mapUpstreamName,
  mapUpstreamServiceName,
  TOOL_NAME_PATTERN,
  validateToolPrefix,
} from "../extension/lib/naming.js";
import type { UpstreamTool } from "../extension/lib/types.js";

const FIXTURES = join(__dirname, "fixtures");

function loadCatalogNames(): string[] {
  const names: string[] = [];
  for (const file of ["catalog.synthetic.json", "catalog.live.json"]) {
    const path = join(FIXTURES, file);
    if (!existsSync(path)) continue;
    const { tools } = JSON.parse(readFileSync(path, "utf8")) as { tools: UpstreamTool[] };
    names.push(...tools.map((tool) => tool.name));
  }
  return names;
}

describe("name mapping (the §3 failure class — every static check misses this)", () => {
  test("every mapped catalog name is API-legal and the mapping is injective", () => {
    const names = loadCatalogNames();
    expect(names.length).toBeGreaterThan(0);
    const map = buildNameMap(names, "apps_");
    // No collisions expected in real or synthetic catalogs → nothing dropped.
    expect(map.size).toBe(new Set(names).size);
    const mapped = [...map.values()];
    for (const name of mapped) {
      expect(name).toMatch(TOOL_NAME_PATTERN);
    }
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  test("round-tripping through the stored upstream recovers the original exactly", () => {
    const names = loadCatalogNames();
    const map = buildNameMap(names, "apps_");
    // The reverse mapping is the stored key itself — assert the map's keys
    // are the exact upstream names, untouched.
    expect([...map.keys()].sort()).toEqual([...new Set(names)].sort());
  });

  test("dots map to underscores with the prefix prepended", () => {
    expect(mapUpstreamName("github.search_repositories", "apps_")).toBe(
      "apps_github_search_repositories",
    );
  });

  test("service-qualified names preserve the service as the tool namespace", () => {
    expect(mapUpstreamServiceName("zoom.search_meetings")).toBe("zoom__search_meetings");
    expect(mapUpstreamServiceName("google_drive.search_files")).toBe(
      "google_drive__search_files",
    );
    expect(buildNameMap(["github.search_issues"], "", undefined, 64, "service-qualified"))
      .toEqual(new Map([["github.search_issues", "github__search_issues"]]));
  });

  test("service-qualified names retain a stable hash when truncated", () => {
    const upstream = `long_service.${"x".repeat(80)}`;
    const mapped = mapUpstreamServiceName(upstream);
    expect(mapped).toHaveLength(64);
    expect(mapped).toMatch(TOOL_NAME_PATTERN);
    expect(mapped.startsWith("long_service__")).toBe(true);
    expect(mapped).toBe(mapUpstreamServiceName(upstream));
  });

  test("reserves room for the Eve extension namespace", () => {
    const mapped = mapUpstreamName(`service.${"x".repeat(80)}`, "", 56);
    expect(mapped).toHaveLength(56);
    expect(`openai__${mapped}`).toMatch(TOOL_NAME_PATTERN);
  });

  test("a synthetic 70-character name yields a stable, legal, hashed form", () => {
    const upstream = `service.${"x".repeat(62)}`; // 70 chars total
    const first = mapUpstreamName(upstream, "apps_");
    const second = mapUpstreamName(upstream, "apps_");
    expect(first).toBe(second);
    expect(first).toMatch(TOOL_NAME_PATTERN);
    expect(first.length).toBe(64);
    expect(first.slice(57, 58)).toBe("_");
    // Distinct over-long names must not collide after truncation.
    const sibling = mapUpstreamName(`service.${"y".repeat(62)}`, "apps_");
    expect(sibling).not.toBe(first);
  });

  test("characters outside [a-zA-Z0-9_-] are sanitized to underscores", () => {
    expect(mapUpstreamName("weird.tool:name/with spaces", "apps_")).toBe(
      "apps_weird_tool_name_with_spaces",
    );
  });

  test("collisions resolve deterministically: sorted order, first wins, dropped name warned", () => {
    const warnings: string[] = [];
    // Both map to apps_a_b.
    const map = buildNameMap(["a_b", "a.b"], "apps_", (m) => warnings.push(m));
    expect(map.get("a.b")).toBe("apps_a_b"); // "a.b" sorts before "a_b"
    expect(map.has("a_b")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("a_b");
  });

  test("prefix validation rejects illegal prefixes", () => {
    expect(() => validateToolPrefix("apps_")).not.toThrow();
    expect(() => validateToolPrefix("")).not.toThrow();
    expect(() => validateToolPrefix("apps.")).toThrow();
    expect(() => validateToolPrefix("x".repeat(33))).toThrow();
  });
});
