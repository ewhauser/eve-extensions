import { describe, expect, it, vi } from "vitest";

import { ProjectLinkService } from "../extension/lib/project-link.js";
import { createMemoryProjectLinkStore } from "../extension/stores/memory.js";
import type {
  ExternalProject,
  ProjectContextCard,
  ProjectLinkContext,
  ProjectProvider,
} from "../extension/lib/types.js";

const channel = { kind: "slack", workspaceId: "T1", channelId: "C1" } as const;
const ctx = { session: { id: "session", auth: {} } } as ProjectLinkContext;
const external: ExternalProject = {
  id: "notion-page",
  url: "https://notion.so/notion-page",
  title: "Project Atlas",
};

function card(summary: string): ProjectContextCard {
  return {
    summary,
    principals: [],
    decisions: [],
    milestones: [],
    upcomingMeetings: [],
    sources: [],
    openQuestions: [],
    nextSteps: [],
    generatedAt: "2026-08-09T12:00:00.000Z",
  };
}

function fakeProvider(
  overrides: Partial<ProjectProvider> = {},
): ProjectProvider {
  return {
    kind: "notion",
    createProject: vi.fn(async () => external),
    readContext: vi.fn(async () => card("Refreshed")),
    writeContext: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("ProjectLinkService", () => {
  it("creates one active binding, writes context, refreshes, and unlinks safely", async () => {
    const provider = fakeProvider();
    const store = createMemoryProjectLinkStore();
    const service = new ProjectLinkService({
      store,
      providers: [provider],
      defaultProvider: "notion",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    const linked = await service.link(
      channel,
      { title: "Project Atlas", channelUrl: "https://slack.com/channel" },
      ctx,
    );
    expect(linked.created).toBe(true);
    expect(linked.binding).toMatchObject({ status: "active", revision: 1 });
    expect(provider.createProject).toHaveBeenCalledOnce();

    const repeated = await service.link(channel, { title: "Ignored" }, ctx);
    expect(repeated.created).toBe(false);
    expect(provider.createProject).toHaveBeenCalledOnce();

    const saved = await service.saveContext(
      channel,
      {
        summary: "Curated",
        principals: [],
        decisions: [],
        milestones: [],
        upcomingMeetings: [],
        sources: [],
        openQuestions: [],
        nextSteps: [],
      },
      ctx,
    );
    expect(saved.context?.summary).toBe("Curated");
    expect(provider.writeContext).toHaveBeenCalledOnce();

    const refreshed = await service.refresh(channel, ctx);
    expect(refreshed.context?.summary).toBe("Refreshed");
    expect(refreshed.revision).toBe(3);

    const removed = await service.unlink(channel);
    expect(removed?.externalProject?.url).toBe(external.url);
    expect(await service.status(channel)).toBeNull();
  });

  it("retains the stable binding id when retrying a failed provider create", async () => {
    const seenIds: string[] = [];
    let attempts = 0;
    const provider = fakeProvider({
      async createProject(input) {
        attempts += 1;
        seenIds.push(input.bindingId);
        if (attempts === 1) throw new Error("template timed out");
        return external;
      },
    });
    const service = new ProjectLinkService({
      store: createMemoryProjectLinkStore(),
      providers: [provider],
      defaultProvider: "notion",
    });

    await expect(
      service.link(channel, { title: "Project Atlas" }, ctx),
    ).rejects.toThrow("template timed out");
    expect((await service.status(channel))?.status).toBe("error");

    const retried = await service.link(channel, { title: "Project Atlas" }, ctx);
    expect(retried.binding.status).toBe("active");
    expect(seenIds).toHaveLength(2);
    expect(new Set(seenIds).size).toBe(1);
  });

  it("recovers an expired provisioning lease with the original binding id", async () => {
    const store = createMemoryProjectLinkStore([
      {
        id: "stable-link-id",
        channel,
        provider: "notion",
        title: "Atlas",
        status: "provisioning",
        createdAt: "2026-08-09T11:59:00.000Z",
        updatedAt: "2026-08-09T11:59:00.000Z",
        revision: 0,
      },
    ]);
    const provider = fakeProvider();
    const service = new ProjectLinkService({
      store,
      providers: [provider],
      defaultProvider: "notion",
      now: () => new Date("2026-08-09T12:00:02.000Z"),
      provisioningTimeoutMs: 1_000,
    });

    const result = await service.link(channel, { title: "Atlas" }, ctx);
    expect(result.binding).toMatchObject({
      id: "stable-link-id",
      status: "active",
      revision: 2,
    });
    expect(provider.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: "stable-link-id" }),
      ctx,
    );
  });

  it("rejects a provider switch until the old binding is unlinked", async () => {
    const service = new ProjectLinkService({
      store: createMemoryProjectLinkStore(),
      providers: [fakeProvider(), fakeProvider({ kind: "linear" })],
      defaultProvider: "notion",
    });
    await service.link(channel, { title: "Atlas" }, ctx);

    await expect(
      service.link(channel, { title: "Atlas", provider: "linear" }, ctx),
    ).rejects.toThrow("unlink it before switching");
  });
});
