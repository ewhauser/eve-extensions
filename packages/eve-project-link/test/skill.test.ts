import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("project-link skill", () => {
  it("gathers and confirms channel context before reserving a link", async () => {
    const skill = await readFile(
      new URL("../extension/skills/project-link/SKILL.md", import.meta.url),
      "utf8",
    );
    const prose = skill.replace(/\s+/g, " ");

    const gather = prose.indexOf("Before reserving anything");
    const confirm = prose.indexOf("Ask the user to confirm or edit the proposal");
    const reserve = prose.indexOf("After confirmation, call");

    expect(gather).toBeGreaterThanOrEqual(0);
    expect(confirm).toBeGreaterThan(gather);
    expect(reserve).toBeGreaterThan(confirm);
    expect(prose).toContain("channel is mixed-purpose");
    expect(prose).toContain("If history is unavailable");
    expect(prose).toContain("unless the user explicitly");
  });
});
