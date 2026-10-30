import { dynamicEvaluate } from "../node_modules/eve/dist/src/dynamic/definition.js";
import type { DynamicContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  session: { id: "session", auth: { current: null, initiator: null } },
  channel: { kind: "channel:slack", metadata: { teamId: "T1", channelId: "C1" } },
} as unknown as DynamicContext;

type ExecutableTool = {
  readonly description: string;
  readonly approval?: unknown;
  readonly inputSchema: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  execute(input: unknown, ctx: unknown): Promise<unknown>;
};

async function loadTools(store: ReturnType<typeof createMemoryProjectLinkStore>) {
  const [{ default: projectLink }, { default: projectLinkTools }] = await Promise.all([
    import("../extension/extension.js"),
    import("../extension/tools/project-link.js"),
  ]);
  projectLink({
    store,
    presets: [preset(notionProjectHub, { id: "context-hub" })],
    approvals: { link: true, saveContext: true, unlink: true },
  });
  return await dynamicEvaluate(projectLinkTools)(resolveContext) as unknown as Record<string, ExecutableTool>;
}

afterEach(() => vi.resetModules());

describe("durable project-link tools", () => {
  it("re-evaluates mounted callbacks after module reload and preserves the channel lifecycle", async () => {
    const store = createMemoryProjectLinkStore([pending]);
    const pendingTools = await loadTools(store);
    const pendingNames = ["link", "status", "guide", "unlink", "complete"];
    expect(Object.keys(pendingTools).sort()).toEqual([...pendingNames].sort());
    expect(pendingTools.link?.approval).toBeDefined();
    expect(pendingTools.unlink?.approval).toBeDefined();
    const checkpoint = JSON.parse(JSON.stringify(Object.entries(pendingTools).map(([name, tool]) => ({
      name,
      description: tool.description,
    }))));

    vi.resetModules();
    const resumedPending = await loadTools(store);
    expect(Object.entries(resumedPending).map(([name, tool]) => ({ name, description: tool.description }))).toEqual(checkpoint);
    await expect(resumedPending.link?.execute({}, {})).resolves.toMatchObject({
      created: false, bindingId: pending.id, status: "pending",
    });
    await expect(resumedPending.status?.execute({}, {})).resolves.toMatchObject({
      linked: true, bindingId: pending.id, status: "pending",
    });
    await expect(resumedPending.guide?.execute({}, {})).resolves.toMatchObject({
      status: "pending", plan: { bindingId: pending.id },
    });
    await expect(resumedPending.complete?.execute({
      bindingId: pending.id,
      resource: { id: "notion-page", url: "https://notion.so/atlas", title: "Atlas" },
    }, {})).resolves.toMatchObject({ completed: true, status: "active" });

    vi.resetModules();
    const activeTools = await loadTools(store);
    expect(Object.keys(activeTools).sort()).toEqual(["link", "status", "guide", "unlink", "save_context"].sort());
    expect(activeTools.save_context?.approval).toBeDefined();
    const schema = activeTools.save_context?.inputSchema;
    expect(schema?.safeParse({ summary: "  After restart.  " })).toMatchObject({
      success: true,
      data: { summary: "After restart.", principals: [], decisions: [], milestones: [], upcomingMeetings: [], sources: [], openQuestions: [], nextSteps: [] },
    });
    expect(schema?.safeParse({ summary: " " }).success).toBe(false);
    await expect(activeTools.save_context?.execute({
      summary: "Curated after restart.", principals: [], decisions: [], milestones: [], upcomingMeetings: [], sources: [], openQuestions: [], nextSteps: [],
    }, {})).resolves.toMatchObject({ saved: true, revision: 2 });
    await expect(activeTools.unlink?.execute({}, {})).resolves.toEqual({
      unlinked: true, retainedResourceUrl: "https://notion.so/atlas",
    });
  });
});
