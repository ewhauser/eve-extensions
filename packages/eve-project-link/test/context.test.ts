import { describe, expect, it } from "vitest";

import {
  createProjectContextCard,
  parseProjectContextCard,
  renderPendingProjectLink,
  renderProjectContext,
} from "../extension/lib/context.js";
import type {
  ProjectBinding,
  ProjectLinkPlan,
} from "../extension/lib/types.js";

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
  presetId: "context-hub",
  title: "Onboarding",
  status: "active",
  resource: {
    id: "page",
    url: "https://notion.so/page",
    title: "Onboarding",
  },
  context: card,
  createdAt: "2026-08-09T11:00:00.000Z",
  updatedAt: "2026-08-09T12:00:00.000Z",
  revision: 2,
};

const plan: ProjectLinkPlan = {
  bindingId: "binding",
  channel: binding.channel,
  title: binding.title,
  context: card,
  presetId: "context-hub",
  presetKey: "notion/project-hub@1",
  presetName: "Context Hub",
  system: "notion",
  systemName: "Notion",
  systemDescription: "Notion workspace",
  resourceLabel: "Notion page",
  toolHints: {
    connectionNames: ["notion"],
    discoveryQueries: ["Search and fetch Notion pages"],
  },
  provisioningInstructions: "Find or create the page.",
  retrievalInstructions: "Read the page and related project databases.",
};

describe("project context", () => {
  it("round trips a validated card", () => {
    expect(parseProjectContextCard(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  it("renders untrusted-data guidance and useful project sections", () => {
    const rendered = renderProjectContext(binding, 6_000, plan);
    expect(rendered).toContain("untrusted reference material");
    expect(rendered).toContain("tools already mounted");
    expect(rendered).toContain("Likely connections: notion");
    expect(rendered).toContain("Read the page and related project databases");
    expect(rendered).toContain("Principals:\n- Ada — DRI");
    expect(rendered).toContain("Decisions:\n- Use Notion first");
    expect(rendered).toContain("PRD: https://example.com/prd");
  });

  it("keeps incomplete links and active links without a card recoverable", () => {
    const pending = renderPendingProjectLink(plan, 2_000);
    expect(pending).toContain("Binding ID: binding");
    expect(pending).toContain(
      "Confirmed summary: Ship the new onboarding flow.",
    );
    expect(pending).toContain("Confirmed status: In progress");
    expect(pending).toContain("do not create a second");
    expect(pending).toContain("Find or create the page");

    const withoutContext = renderProjectContext(
      { ...binding, context: undefined },
      2_000,
      plan,
    );
    expect(withoutContext).toContain("Cached context: not curated yet");
    expect(withoutContext).toContain("Read the page and related project databases");
  });

  it("respects the configured prompt budget without cutting a line", () => {
    const rendered = renderProjectContext(binding, 260);
    expect(rendered.length).toBeLessThanOrEqual(260);
    expect(rendered).not.toMatch(/\uFFFD/);
  });
});
