import { replayDynamicTools } from "../node_modules/eve/dist/src/context/build-dynamic-tools.js";
import {
  ContextContainer,
  contextStorage,
} from "../node_modules/eve/dist/src/context/container.js";
import { validateDurableDynamicToolCallbacks } from "../node_modules/eve/dist/src/context/dynamic-tool-lifecycle.js";
import { SessionKey } from "../node_modules/eve/dist/src/context/keys.js";
import type { DynamicResolveContext, DynamicToolEntry } from "eve/tools";
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

function durableMetadata(
  tools: Record<string, DynamicToolEntry>,
  names: readonly string[],
) {
  return names.map((entryKey) => {
    const tool = tools[entryKey]!;
    return {
      callbacks: validateDurableDynamicToolCallbacks(
        `project_link__${entryKey}`,
        tool,
      ),
      description: tool.description,
      entryKey,
      inputSchema: { type: "object", additionalProperties: true },
      name: `project_link__${entryKey}`,
      resolverSlug: "project-link",
    };
  });
}

afterEach(() => {
  Reflect.set(globalThis, Symbol.for("eve:dynamic-tool-callbacks"), new Map());
  vi.resetModules();
});

describe("durable project-link tools", () => {
  it("serializes, rebinds, and replays every mounted callback on Eve 0.49", async () => {
    const [{ default: projectLink }, { default: projectLinkTools }] =
      await Promise.all([
        import("../extension/extension.js"),
        import("../extension/tools/project-link.js"),
      ]);
    const store = createMemoryProjectLinkStore([pending]);
    projectLink({
      store,
      presets: [preset(notionProjectHub, { id: "context-hub" })],
      approvals: { link: true, saveContext: true, unlink: true },
    });

    const container = new ContextContainer();
    await contextStorage.run(container, async () => {
      container.set(SessionKey, {
        sessionId: resolveContext.session.id,
        auth: resolveContext.session.auth,
        turn: { id: "durable-turn", sequence: 0 },
      });
      const pendingTools = (await projectLinkTools.events["step.started"]?.(
        {} as never,
        resolveContext,
      )) as Record<string, DynamicToolEntry>;
      const pendingNames = ["link", "status", "guide", "unlink", "complete"];
      expect(Object.keys(pendingTools).sort()).toEqual([...pendingNames].sort());

      const pendingCheckpoint = JSON.parse(
        JSON.stringify(durableMetadata(pendingTools, pendingNames)),
      );
      for (const metadata of pendingCheckpoint) {
        expect(metadata.callbacks.execute.closure).toEqual({ channel });
      }
      expect(pendingCheckpoint[0].callbacks.approvalRequest.closure).toEqual({
        channel,
      });
      expect(pendingCheckpoint[3].callbacks.approvalRequest.closure).toEqual({
        channel,
      });

      Reflect.set(globalThis, Symbol.for("eve:dynamic-tool-callbacks"), new Map());
      const reboundPending = (await projectLinkTools.events["step.started"]?.(
        {} as never,
        resolveContext,
      )) as Record<string, DynamicToolEntry>;
      durableMetadata(reboundPending, pendingNames);

      const replayedPending = Object.fromEntries(
        replayDynamicTools(pendingCheckpoint as never).map((tool) => [
          tool.name.replace("project_link__", ""),
          tool,
        ]),
      );
      await expect(
        replayedPending.link!.execute!({}, {} as never),
      ).resolves.toMatchObject({
        created: false,
        bindingId: pending.id,
        status: "pending",
      });
      await expect(
        replayedPending.status!.execute!({}, {} as never),
      ).resolves.toMatchObject({
        linked: true,
        bindingId: pending.id,
        status: "pending",
      });
      await expect(
        replayedPending.guide!.execute!({}, {} as never),
      ).resolves.toMatchObject({
        status: "pending",
        plan: { bindingId: pending.id },
      });
      await expect(
        replayedPending.complete!.execute!(
          {
            bindingId: pending.id,
            resource: {
              id: "notion-page",
              url: "https://notion.so/atlas",
              title: "Atlas",
            },
          },
          {} as never,
        ),
      ).resolves.toMatchObject({ completed: true, status: "active" });

      const activeTools = (await projectLinkTools.events["step.started"]?.(
        {} as never,
        resolveContext,
      )) as Record<string, DynamicToolEntry>;
      const activeNames = ["link", "status", "guide", "unlink", "save_context"];
      expect(Object.keys(activeTools).sort()).toEqual([...activeNames].sort());
      const activeCheckpoint = JSON.parse(
        JSON.stringify(durableMetadata(activeTools, activeNames)),
      );
      const savedContext = activeCheckpoint.find(
        (metadata: { entryKey: string }) => metadata.entryKey === "save_context",
      );
      expect(savedContext.callbacks).toEqual({
        approvalRequest: { closure: { channel } },
        execute: { closure: { channel } },
      });

      Reflect.set(globalThis, Symbol.for("eve:dynamic-tool-callbacks"), new Map());
      const reboundActive = (await projectLinkTools.events["step.started"]?.(
        {} as never,
        resolveContext,
      )) as Record<string, DynamicToolEntry>;
      durableMetadata(reboundActive, activeNames);

      const replayedActive = Object.fromEntries(
        replayDynamicTools(activeCheckpoint as never).map((tool) => [
          tool.name.replace("project_link__", ""),
          tool,
        ]),
      );
      await expect(
        replayedActive.save_context!.execute!(
          {
            summary: "Curated after restart.",
            principals: [],
            decisions: [],
            milestones: [],
            upcomingMeetings: [],
            sources: [],
            openQuestions: [],
            nextSteps: [],
          },
          {} as never,
        ),
      ).resolves.toMatchObject({ saved: true, revision: 2 });
      await expect(
        replayedActive.unlink!.execute!({}, {} as never),
      ).resolves.toEqual({
        unlinked: true,
        retainedResourceUrl: "https://notion.so/atlas",
      });
    });
  });
});
