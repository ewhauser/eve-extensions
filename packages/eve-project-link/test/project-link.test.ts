import { describe, expect, it } from "vitest";

import { ProjectLinkService } from "../extension/lib/project-link.js";
import type { ProjectPreset, ProjectResource } from "../extension/lib/types.js";
import { linearProject } from "../extension/presets/linear.js";
import { notionProjectHub } from "../extension/presets/notion.js";
import { preset } from "../extension/presets/preset.js";
import { createMemoryProjectLinkStore } from "../extension/stores/memory.js";

const channel = { kind: "slack", workspaceId: "T1", channelId: "C1" } as const;
const resource: ProjectResource = {
  id: "project-page",
  url: "https://projects.example/project-page",
  title: "Project Atlas",
};

const presets: readonly ProjectPreset[] = [
  preset(notionProjectHub, {
    id: "context-hub",
    parameters: { container: "Projects" },
    tools: { add: { toolNames: ["notion__fetch_page"] } },
  }),
  preset(linearProject, {
    id: "product",
    parameters: { team: "Product Engineering" },
  }),
];

describe("ProjectLinkService", () => {
  it("reserves a link, attaches a tool-produced resource, caches context, and unlinks", async () => {
    const store = createMemoryProjectLinkStore();
    const service = new ProjectLinkService({
      store,
      presets,
      defaultPreset: "context-hub",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    const linked = await service.link(channel, {
      title: "Project Atlas",
      channelUrl: "https://slack.com/channel",
    });
    expect(linked).toMatchObject({
      created: true,
      binding: { status: "pending", presetId: "context-hub" },
      plan: {
        systemName: "Notion",
        toolHints: {
          connectionNames: ["notion"],
          toolNames: ["notion__fetch_page"],
        },
      },
    });

    const repeated = await service.link(channel, { title: "Ignored" });
    expect(repeated.created).toBe(false);
    expect(repeated.binding.id).toBe(linked.binding.id);

    const completed = await service.complete(channel, {
      bindingId: linked.binding.id,
      resource,
    });
    expect(completed).toMatchObject({ status: "active", resource, revision: 1 });

    const repeatedCompletion = await service.complete(channel, {
      bindingId: linked.binding.id,
      resource,
    });
    expect(repeatedCompletion.revision).toBe(1);

    const saved = await service.saveContext(channel, {
      summary: "Curated",
      principals: [],
      decisions: [],
      milestones: [],
      upcomingMeetings: [],
      sources: [],
      openQuestions: [],
      nextSteps: [],
    });
    expect(saved.context?.summary).toBe("Curated");
    expect(saved.revision).toBe(2);

    const removed = await service.unlink(channel);
    expect(removed?.resource?.url).toBe(resource.url);
    expect(await service.status(channel)).toBeNull();
  });

  it("resumes a durable pending reservation without a provisioning lease", async () => {
    const store = createMemoryProjectLinkStore([
      {
        id: "stable-link-id",
        channel,
        presetId: "context-hub",
        title: "Atlas",
        status: "pending",
        createdAt: "2026-08-09T11:00:00.000Z",
        updatedAt: "2026-08-09T11:00:00.000Z",
        revision: 0,
      },
    ]);
    const service = new ProjectLinkService({
      store,
      presets,
      defaultPreset: "product",
    });

    const result = await service.link(channel, { title: "Atlas" });
    expect(result).toMatchObject({
      created: false,
      binding: {
        id: "stable-link-id",
        status: "pending",
        presetId: "context-hub",
      },
      plan: { bindingId: "stable-link-id" },
    });
  });

  it("supports Linear and rejects target or resource switching without unlinking", async () => {
    const service = new ProjectLinkService({
      store: createMemoryProjectLinkStore(),
      presets,
    });
    const linked = await service.link(channel, {
      title: "Atlas",
      preset: "product",
    });
    expect(linked.plan).toMatchObject({
      presetId: "product",
      presetKey: "linear/project@1",
      system: "linear",
    });

    await expect(
      service.link(channel, {
        title: "Atlas",
        preset: "context-hub",
      }),
    ).rejects.toThrow("unlink it before switching");

    await service.complete(channel, { bindingId: linked.binding.id, resource });
    await expect(
      service.complete(channel, {
        bindingId: linked.binding.id,
        resource: { ...resource, id: "another" },
      }),
    ).rejects.toThrow("different resource");
  });

  it("requires an active resource before saving context", async () => {
    const service = new ProjectLinkService({
      store: createMemoryProjectLinkStore(),
      presets,
    });
    await service.link(channel, { title: "Atlas" });

    await expect(
      service.saveContext(channel, {
        summary: "Pending",
        principals: [],
        decisions: [],
        milestones: [],
        upcomingMeetings: [],
        sources: [],
        openQuestions: [],
        nextSteps: [],
      }),
    ).rejects.toThrow("pending");
  });
});
