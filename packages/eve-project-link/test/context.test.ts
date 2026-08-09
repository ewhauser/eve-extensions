import { describe, expect, it } from "vitest";

import {
  createProjectContextCard,
  parseProjectContextCard,
  renderProjectContext,
} from "../extension/lib/context.js";
import type { ProjectBinding } from "../extension/lib/types.js";

const card = createProjectContextCard(
  {
    summary: "Ship the new onboarding flow.",
    status: "In progress",
    principals: [{ name: "Ada", role: "DRI" }],
    decisions: [
      {
        summary: "Use Notion first",
        sourceUrl: "https://example.com/decision",
      },
    ],
    milestones: [],
    upcomingMeetings: [],
    sources: [{ title: "PRD", url: "https://example.com/prd" }],
    openQuestions: ["Who owns launch comms?"],
    nextSteps: ["Finish the prototype"],
  },
  "2026-08-09T12:00:00.000Z",
);

const binding: ProjectBinding = {
  id: "binding",
  channel: { kind: "slack", workspaceId: "T1", channelId: "C1" },
  provider: "notion",
  title: "Onboarding",
  status: "active",
  externalProject: {
    id: "page",
    url: "https://notion.so/page",
    title: "Onboarding",
  },
  context: card,
  createdAt: "2026-08-09T11:00:00.000Z",
  updatedAt: "2026-08-09T12:00:00.000Z",
  revision: 2,
};

describe("project context", () => {
  it("round trips a validated card", () => {
    expect(parseProjectContextCard(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  it("renders untrusted-data guidance and useful project sections", () => {
    const rendered = renderProjectContext(binding, 6_000);
    expect(rendered).toContain("untrusted reference material");
    expect(rendered).toContain("Principals:\n- Ada — DRI");
    expect(rendered).toContain("Decisions:\n- Use Notion first");
    expect(rendered).toContain("PRD: https://example.com/prd");
  });

  it("respects the configured prompt budget without cutting a line", () => {
    const rendered = renderProjectContext(binding, 260);
    expect(rendered.length).toBeLessThanOrEqual(260);
    expect(rendered).not.toMatch(/\uFFFD/);
  });
});
