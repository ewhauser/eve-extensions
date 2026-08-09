import { describe, expect, it, vi } from "vitest";

import { createProjectContextCard } from "../extension/lib/context.js";
import {
  NOTION_API_VERSION,
  notionProjectProvider,
} from "../extension/providers/notion.js";
import type { ProjectLinkContext } from "../extension/lib/types.js";

const ctx = { session: { id: "session", auth: {} } } as ProjectLinkContext;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("notionProjectProvider", () => {
  it("creates a project from the configured template and writes its context card", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init = {}) => {
      const url = String(request);
      requests.push({ url, init });
      if (url.endsWith("/v1/data_sources/projects/query")) {
        return jsonResponse({ results: [] });
      }
      if (url.endsWith("/v1/pages") && init.method === "POST") {
        return jsonResponse({
          object: "page",
          id: "page-id",
          url: "https://www.notion.so/page-id",
        });
      }
      if (url.includes("/v1/blocks/page-id/children")) {
        return jsonResponse({ results: [{ object: "block", id: "block" }] });
      }
      if (url.endsWith("/v1/pages/page-id") && init.method === "PATCH") {
        return jsonResponse({ object: "page", id: "page-id" });
      }
      throw new Error(`Unexpected request: ${init.method} ${url}`);
    });
    const token = vi.fn(async () => "secret-notion-token");
    const provider = notionProjectProvider({
      token,
      projectsDataSourceId: "projects",
      projectTemplateId: "template",
      fetch,
      baseUrl: "https://notion.test/",
      templatePollIntervalMs: 0,
      templateTimeoutMs: 0,
    });

    const project = await provider.createProject(
      {
        bindingId: "link-1",
        channel: { kind: "slack", workspaceId: "T1", channelId: "C1" },
        title: "Project Atlas",
        channelUrl: "https://acme.slack.com/archives/C1",
      },
      ctx,
    );
    expect(project).toEqual({
      id: "page-id",
      title: "Project Atlas",
      url: "https://www.notion.so/page-id",
    });

    const createBody = JSON.parse(String(requests[1]?.init.body));
    expect(createBody).toMatchObject({
      parent: { type: "data_source_id", data_source_id: "projects" },
      template: { type: "template_id", template_id: "template" },
      properties: {
        Name: { title: [{ type: "text", text: { content: "Project Atlas" } }] },
        "Eve Link ID": {
          rich_text: [{ type: "text", text: { content: "link-1" } }],
        },
        "Channel URL": { url: "https://acme.slack.com/archives/C1" },
      },
    });

    const context = createProjectContextCard(
      {
        summary: "A concise project summary",
        principals: [],
        decisions: [],
        milestones: [],
        upcomingMeetings: [],
        sources: [],
        openQuestions: [],
        nextSteps: [],
      },
      "2026-08-09T12:00:00.000Z",
    );
    await provider.writeContext(project, context, ctx);
    const patchBody = JSON.parse(String(requests.at(-1)?.init.body));
    expect(patchBody.properties.Summary.rich_text[0].text.content).toBe(
      "A concise project summary",
    );
    expect(
      JSON.parse(patchBody.properties["Eve context"].rich_text[0].text.content),
    ).toEqual(context);
    expect(patchBody.properties["Eve last synced"]).toEqual({
      date: { start: "2026-08-09T12:00:00.000Z" },
    });

    for (const request of requests) {
      const headers = new Headers(request.init.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-notion-token");
      expect(headers.get("notion-version")).toBe(NOTION_API_VERSION);
    }
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("reuses a page with the same link id before creating another", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init = {}) => {
      const url = String(request);
      if (url.endsWith("/query")) {
        return jsonResponse({
          results: [
            {
              object: "page",
              id: "existing-page",
              url: "https://notion.so/existing-page",
            },
          ],
        });
      }
      if (url.includes("/blocks/existing-page/children")) {
        return jsonResponse({ results: [{ object: "block", id: "block" }] });
      }
      throw new Error(`Unexpected request: ${init.method} ${url}`);
    });
    const provider = notionProjectProvider({
      token: async () => "token",
      projectsDataSourceId: "projects",
      projectTemplateId: "template",
      fetch,
      baseUrl: "https://notion.test",
      templateTimeoutMs: 0,
    });

    const project = await provider.createProject(
      {
        bindingId: "same-id",
        channel: { kind: "slack", workspaceId: "T1", channelId: "C1" },
        title: "Atlas",
      },
      ctx,
    );
    expect(project.id).toBe("existing-page");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reads the machine context property and falls back to human-readable fields", async () => {
    const encoded = createProjectContextCard(
      {
        summary: "Machine context",
        principals: [],
        decisions: [],
        milestones: [],
        upcomingMeetings: [],
        sources: [],
        openQuestions: [],
        nextSteps: [],
      },
      "2026-08-09T12:00:00.000Z",
    );
    const pages = [
      {
        object: "page",
        id: "page",
        properties: {
          "Eve context": {
            type: "rich_text",
            rich_text: [{ plain_text: JSON.stringify(encoded) }],
          },
        },
      },
      {
        object: "page",
        id: "page",
        properties: {
          Summary: {
            type: "rich_text",
            rich_text: [{ plain_text: "Human summary" }],
          },
          Status: { type: "status", status: { name: "At risk" } },
        },
      },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(pages.shift()),
    );
    const provider = notionProjectProvider({
      token: async () => "token",
      projectsDataSourceId: "projects",
      projectTemplateId: "template",
      fetch,
      baseUrl: "https://notion.test",
    });
    const project = { id: "page", title: "Atlas", url: "https://notion.so/page" };

    expect((await provider.readContext(project, ctx))?.summary).toBe("Machine context");
    expect(await provider.readContext(project, ctx)).toMatchObject({
      summary: "Human summary",
      status: "At risk",
    });
  });

  it("surfaces Notion errors without exposing the bearer token", async () => {
    const provider = notionProjectProvider({
      token: async () => "super-secret-token",
      projectsDataSourceId: "projects",
      projectTemplateId: "template",
      fetch: async () =>
        jsonResponse({ code: "object_not_found", message: "No access" }, 404),
    });

    await expect(
      provider.createProject(
        {
          bindingId: "id",
          channel: { kind: "slack", workspaceId: "T1", channelId: "C1" },
          title: "Atlas",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "object_not_found", status: 404 });
    await expect(
      provider.createProject(
        {
          bindingId: "id",
          channel: { kind: "slack", workspaceId: "T1", channelId: "C1" },
          title: "Atlas",
        },
        ctx,
      ),
    ).rejects.not.toThrow("super-secret-token");
  });

  it("rejects invalid context returned by a custom Notion aggregator", async () => {
    const provider = notionProjectProvider({
      token: async () => "token",
      projectsDataSourceId: "projects",
      projectTemplateId: "template",
      fetch: async () => jsonResponse({ object: "page", id: "page" }),
      readContext: async () => ({ summary: "missing required arrays" }) as never,
    });

    await expect(
      provider.readContext(
        { id: "page", title: "Atlas", url: "https://notion.so/page" },
        ctx,
      ),
    ).rejects.toThrow("invalid context card");
  });
});
