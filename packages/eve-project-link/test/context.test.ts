import { describe, expect, it } from "vitest";

import {
  createProjectContextCard,
  parseProjectContextCard,
  renderPendingProjectLink,
  renderProjectContext,
  renderProjectPointer,
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
  activeContextMode: "pointer",
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

  it("renders a bounded pointer independently of a maximally populated card", () => {
    const maximumCard = createProjectContextCard(
      {
        summary: "S".repeat(4_000),
        status: "In progress ".repeat(16).slice(0, 200),
        principals: Array.from({ length: 30 }, (_, index) => ({
          name: `Principal ${index}`,
          role: "R".repeat(200),
          url: `https://example.com/people/${index}`,
        })),
        decisions: Array.from({ length: 30 }, (_, index) => ({
          summary: `Decision ${index}`,
          rationale: "R".repeat(1_000),
          decidedAt: "2026-08-09T12:00:00.000Z",
          sourceUrl: `https://example.com/decisions/${index}`,
        })),
        milestones: Array.from({ length: 30 }, (_, index) => ({
          title: `Milestone ${index}`,
          dueAt: "2026-09-01T12:00:00.000Z",
          status: "Planned",
          url: `https://example.com/milestones/${index}`,
        })),
        upcomingMeetings: Array.from({ length: 20 }, (_, index) => ({
          title: `Meeting ${index}`,
          startsAt: "2026-08-12T12:00:00.000Z",
          attendees: Array.from(
            { length: 30 },
            (_, attendee) => `Attendee ${attendee}`,
          ),
          url: `https://example.com/meetings/${index}`,
        })),
        sources: Array.from({ length: 50 }, (_, index) => ({
          title: `Source ${index}`,
          url: `https://example.com/sources/${index}`,
          description: "D".repeat(500),
        })),
        openQuestions: Array.from(
          { length: 30 },
          (_, index) => `Open question ${index}`,
        ),
        nextSteps: Array.from(
          { length: 30 },
          (_, index) => `Next step ${index}`,
        ),
      },
      "2026-08-09T12:00:00.000Z",
    );
    const pointer = renderProjectPointer({ ...binding, context: maximumCard }, 3_000);
    const pointerWithoutCard = renderProjectPointer(
      { ...binding, context: undefined },
      3_000,
    );

    expect(pointer).toBe(pointerWithoutCard);
    expect(pointer.length).toBeLessThanOrEqual(3_000);
    expect(pointer.length).toBeLessThan(1_000);
    expect(pointer).toContain("This channel is linked to **Onboarding**");
    expect(pointer).toContain(`Canonical resource: ${binding.resource?.url}`);
    expect(pointer).toContain("through mounted tools");
    expect(pointer).toContain("untrusted reference data");
    expect(pointer).toContain("Cite supporting source URLs");
    expect(pointer).toContain("unless the user explicitly asks");
    expect(pointer).not.toContain("Principal 0");
    expect(pointer).not.toContain("Decision 0");
    expect(pointer).not.toContain("Milestone 0");
    expect(pointer).not.toContain("Meeting 0");
    expect(pointer).not.toContain("Source 0");
    expect(pointer).not.toContain("Open question 0");
    expect(pointer).not.toContain("Next step 0");
  });

  it("always includes a maximum-length canonical resource URL", () => {
    const url = `https://example.com/${"a".repeat(1_980)}`;
    expect(url).toHaveLength(2_000);

    const pointer = renderProjectPointer(
      {
        ...binding,
        title: "P".repeat(200),
        resource: { ...binding.resource!, url },
      },
      3_000,
    );

    expect(pointer).toContain(url);
    expect(pointer.length).toBeLessThanOrEqual(3_000);
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
