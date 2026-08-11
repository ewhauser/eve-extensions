import type { DynamicResolveContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import type { ProjectBinding } from "../extension/lib/types.js";
import { notionProjectHub } from "../extension/presets/notion.js";
import { preset } from "../extension/presets/preset.js";
import { createMemoryProjectLinkStore } from "../extension/stores/memory.js";

const channel = { kind: "slack", workspaceId: "T1", channelId: "C1" } as const;

const pending: ProjectBinding = {
  id: "00000000-0000-4000-8000-000000000001",
  channel,
  presetId: "context-hub",
  title: "Atlas",
  status: "pending",
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
  revision: 0,
};

const resolveContext = {
  session: {
    id: "session",
    auth: { current: null, initiator: null },
  },
  channel: {
    kind: "slack",
    metadata: { teamId: "T1", channelId: "C1" },
  },
  messages: [],
} as unknown as DynamicResolveContext;

describe("configured extension runtime", () => {
  it("mounts dynamic tools and instructions from the installed config", async () => {
    const { default: projectLink } = await import(
      "../extension/extension.js"
    );
    const store = createMemoryProjectLinkStore([pending]);
    projectLink({
      store,
      presets: [
        preset(notionProjectHub, { id: "context-hub" }),
        preset(notionProjectHub, {
          id: "detailed",
          activeContextMode: "card",
        }),
      ],
      approvals: { link: false, saveContext: false, unlink: false },
    });

    // Dynamic contributions may be evaluated in a different authored-module
    // graph than the configured mount. The installed config must survive it.
    vi.resetModules();
    const [{ getProjectLinkConfig }, { default: projectLinkTools }, { default: projectContext }] =
      await Promise.all([
        import("../extension/extension.js"),
        import("../extension/tools/project-link.js"),
        import("../extension/instructions/project-context.js"),
      ]);

    expect(getProjectLinkConfig()).toMatchObject({
      store,
      maxPromptCharacters: 7_000,
      maxPointerPromptCharacters: 3_000,
    });
    expect(getProjectLinkConfig().presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "context-hub",
          activeContextMode: "pointer",
        }),
        expect.objectContaining({ id: "detailed", activeContextMode: "card" }),
      ]),
    );

    const tools = await projectLinkTools.events["step.started"]?.(
      {} as never,
      resolveContext,
    );
    expect(tools).toMatchObject({
      link: expect.any(Object),
      status: expect.any(Object),
      guide: expect.any(Object),
      complete: expect.any(Object),
    });

    const instructions = await projectContext.events["turn.started"]?.(
      {} as never,
      resolveContext,
    );
    expect(instructions).toMatchObject({
      markdown: expect.stringContaining("# Pending project link"),
    });

    const active: ProjectBinding = {
      ...pending,
      status: "active",
      resource: {
        id: "notion-page",
        url: "https://notion.so/atlas",
        title: "Atlas",
      },
      context: {
        summary: "Detailed cached summary.",
        principals: [{ name: "Ada", role: "DRI" }],
        decisions: [],
        milestones: [],
        upcomingMeetings: [],
        sources: [],
        openQuestions: [],
        nextSteps: [],
        generatedAt: "2026-08-11T12:00:00.000Z",
      },
      revision: 1,
    };
    expect(await store.replace(active, 0)).toBe(true);

    const activeInstructions = await projectContext.events["turn.started"]?.(
      {} as never,
      resolveContext,
    );
    expect(activeInstructions).toMatchObject({
      markdown: expect.stringContaining("# Linked project"),
    });
    expect(activeInstructions?.markdown).toContain(
      "Canonical resource: https://notion.so/atlas",
    );
    expect(activeInstructions?.markdown).not.toContain("# Pending project link");

    expect(
      await store.replace(
        { ...active, presetId: "detailed", revision: 2 },
        1,
      ),
    ).toBe(true);
    const detailedInstructions = await projectContext.events["turn.started"]?.(
      {} as never,
      resolveContext,
    );
    expect(detailedInstructions?.markdown).toContain("# Linked project context");
    expect(detailedInstructions?.markdown).toContain(
      "Summary: Detailed cached summary.",
    );
    expect(detailedInstructions?.markdown).toContain("Principals:\n- Ada — DRI");
  });
});
