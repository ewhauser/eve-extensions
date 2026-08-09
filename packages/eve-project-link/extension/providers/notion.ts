import {
  createProjectContextCard,
  parseProjectContextCard,
} from "../lib/context.js";
import type {
  CreateExternalProjectInput,
  ExternalProject,
  ProjectContextCard,
  ProjectLinkContext,
  ProjectProvider,
} from "../lib/types.js";

export const NOTION_API_VERSION = "2026-03-11";

export interface NotionProjectProperties {
  readonly title: string;
  readonly linkId: string;
  readonly channelKind: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelUrl: string;
  readonly summary: string;
  readonly context: string;
  readonly lastSyncedAt: string;
  readonly status: string;
}

export const DEFAULT_NOTION_PROJECT_PROPERTIES: NotionProjectProperties = {
  title: "Name",
  linkId: "Eve Link ID",
  channelKind: "Channel kind",
  workspaceId: "Workspace ID",
  channelId: "Channel ID",
  channelUrl: "Channel URL",
  summary: "Summary",
  context: "Eve context",
  lastSyncedAt: "Eve last synced",
  status: "Status",
};

export type NotionTokenResolver = (
  ctx: ProjectLinkContext,
) => string | null | Promise<string | null>;

export interface NotionPage {
  readonly object: "page";
  readonly id: string;
  readonly url?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface NotionContextReaderInput {
  readonly page: NotionPage;
  readonly project: ExternalProject;
  /** Authenticated request helper for related data-source queries. */
  request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
}

export interface NotionProjectProviderOptions {
  readonly token: NotionTokenResolver;
  /** ID of the Projects data source, not the containing database ID. */
  readonly projectsDataSourceId: string;
  /** ID of the Project database template to clone for each link. */
  readonly projectTemplateId: string;
  readonly templateTimezone?: string;
  readonly properties?: Partial<NotionProjectProperties>;
  readonly baseUrl?: string;
  readonly notionVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly templatePollIntervalMs?: number;
  readonly templateTimeoutMs?: number;
  readonly maxContextCharacters?: number;
  /** Override the default `Eve context` JSON reader to aggregate related databases. */
  readonly readContext?: (
    input: NotionContextReaderInput,
  ) => ProjectContextCard | null | Promise<ProjectContextCard | null>;
}

export class NotionProjectLinkError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "NotionProjectLinkError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

interface NotionClient {
  request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T>;
}

interface NotionListResponse {
  readonly results?: readonly unknown[];
}

function requiredString(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty.`);
  return normalized;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotionPage(value: unknown): value is NotionPage {
  return isRecord(value) && value.object === "page" && typeof value.id === "string";
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.plain_text === "string") return item.plain_text;
      const text = item.text;
      return isRecord(text) && typeof text.content === "string" ? text.content : "";
    })
    .join("");
}

function propertyText(property: unknown): string {
  if (!isRecord(property) || typeof property.type !== "string") return "";
  return plainText(property[property.type]);
}

function propertyStatus(property: unknown): string | undefined {
  if (!isRecord(property) || typeof property.type !== "string") return undefined;
  const value = property[property.type];
  if (isRecord(value) && typeof value.name === "string") return value.name;
  const text = propertyText(property).trim();
  return text || undefined;
}

function richText(content: string): { readonly rich_text: readonly unknown[] } {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(content.length, offset + 1_900);
    if (end < content.length) {
      const code = content.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(content.slice(offset, end));
    offset = end;
  }
  return {
    rich_text: chunks.map((chunk) => ({
      type: "text",
      text: { content: chunk },
    })),
  };
}

function title(content: string): { readonly title: readonly unknown[] } {
  return {
    title: [{ type: "text", text: { content } }],
  };
}

function pageUrl(page: NotionPage): string {
  return page.url ?? `https://www.notion.so/${page.id.replaceAll("-", "")}`;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function externalProject(page: NotionPage, fallbackTitle: string): ExternalProject {
  return {
    id: page.id,
    url: pageUrl(page),
    title: fallbackTitle,
  };
}

function createClient(
  options: Required<
    Pick<NotionProjectProviderOptions, "baseUrl" | "fetch" | "notionVersion">
  >,
  token: string,
): NotionClient {
  return {
    async request<T>(
      method: "GET" | "POST" | "PATCH",
      path: string,
      body?: unknown,
    ) {
      const response = await options.fetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "notion-version": options.notionVersion,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const raw = await response.text();
      let value: unknown;
      try {
        value = raw ? JSON.parse(raw) : null;
      } catch {
        value = null;
      }

      if (!response.ok) {
        const error = isRecord(value) ? value : {};
        const message =
          typeof error.message === "string"
            ? error.message
            : `Notion API request failed with HTTP ${response.status}.`;
        const code = typeof error.code === "string" ? error.code : undefined;
        throw new NotionProjectLinkError(message, response.status, code);
      }
      return value as T;
    },
  };
}

export function notionProjectProvider(
  inputOptions: NotionProjectProviderOptions,
): ProjectProvider {
  const projectsDataSourceId = requiredString(
    inputOptions.projectsDataSourceId,
    "projectsDataSourceId",
  );
  const projectTemplateId = requiredString(
    inputOptions.projectTemplateId,
    "projectTemplateId",
  );
  const properties = {
    ...DEFAULT_NOTION_PROJECT_PROPERTIES,
    ...inputOptions.properties,
  };
  const options = {
    baseUrl: trimTrailingSlash(inputOptions.baseUrl ?? "https://api.notion.com"),
    fetch: inputOptions.fetch ?? globalThis.fetch,
    notionVersion: inputOptions.notionVersion ?? NOTION_API_VERSION,
    maxContextCharacters: inputOptions.maxContextCharacters ?? 40_000,
    templatePollIntervalMs: inputOptions.templatePollIntervalMs ?? 250,
    templateTimeoutMs: inputOptions.templateTimeoutMs ?? 15_000,
  };
  if (options.templatePollIntervalMs < 0) {
    throw new Error("templatePollIntervalMs must be nonnegative.");
  }
  if (options.templateTimeoutMs < 0) {
    throw new Error("templateTimeoutMs must be nonnegative.");
  }
  if (options.maxContextCharacters < 1) {
    throw new Error("maxContextCharacters must be positive.");
  }

  async function clientFor(ctx: ProjectLinkContext): Promise<NotionClient> {
    const token = await inputOptions.token(ctx);
    if (!token?.trim()) {
      throw new NotionProjectLinkError(
        "No Notion token is available for this Eve session.",
        401,
        "missing_token",
      );
    }
    return createClient(options, token.trim());
  }

  async function findByLinkId(client: NotionClient, bindingId: string) {
    const response = await client.request<NotionListResponse>(
      "POST",
      `/v1/data_sources/${encodeURIComponent(projectsDataSourceId)}/query`,
      {
        filter: {
          property: properties.linkId,
          rich_text: { equals: bindingId },
        },
        page_size: 2,
        result_type: "page",
      },
    );
    const pages = (response.results ?? []).filter(isNotionPage);
    if (pages.length > 1) {
      throw new Error(
        `Notion contains multiple Projects with Eve Link ID ${bindingId}; repair the duplicate before retrying.`,
      );
    }
    return pages[0] ?? null;
  }

  async function waitForTemplate(client: NotionClient, pageId: string): Promise<void> {
    const deadline = Date.now() + options.templateTimeoutMs;
    do {
      const response = await client.request<NotionListResponse>(
        "GET",
        `/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=1`,
      );
      if ((response.results?.length ?? 0) > 0) return;
      if (Date.now() >= deadline) break;
      await wait(options.templatePollIntervalMs);
    } while (true);

    throw new Error(
      `Notion did not finish applying project template ${projectTemplateId} within ${options.templateTimeoutMs}ms. Retrying the link is safe.`,
    );
  }

  async function defaultReadContext(page: NotionPage): Promise<ProjectContextCard | null> {
    const pageProperties = page.properties ?? {};
    const encoded = propertyText(pageProperties[properties.context]).trim();
    if (encoded) {
      try {
        const parsed = parseProjectContextCard(JSON.parse(encoded));
        if (parsed) return parsed;
      } catch {
        // Fall through to human-readable fields.
      }
    }

    const summary = propertyText(pageProperties[properties.summary]).trim();
    if (!summary) return null;
    const status = propertyStatus(pageProperties[properties.status]);
    return createProjectContextCard({
      summary,
      ...(status === undefined ? {} : { status }),
      principals: [],
      decisions: [],
      milestones: [],
      upcomingMeetings: [],
      sources: [],
      openQuestions: [],
      nextSteps: [],
    });
  }

  return {
    kind: "notion",
    async createProject(input: CreateExternalProjectInput, ctx: ProjectLinkContext) {
      const client = await clientFor(ctx);
      const existing = await findByLinkId(client, input.bindingId);
      if (existing) {
        await waitForTemplate(client, existing.id);
        return externalProject(existing, input.title);
      }

      const pageProperties: Record<string, unknown> = {
        [properties.title]: title(input.title),
        [properties.linkId]: richText(input.bindingId),
        [properties.channelKind]: richText(input.channel.kind),
        [properties.workspaceId]: richText(input.channel.workspaceId),
        [properties.channelId]: richText(input.channel.channelId),
      };
      if (input.channelUrl !== undefined) {
        pageProperties[properties.channelUrl] = { url: input.channelUrl };
      }

      const page = await client.request<NotionPage>("POST", "/v1/pages", {
        parent: {
          type: "data_source_id",
          data_source_id: projectsDataSourceId,
        },
        properties: pageProperties,
        template: {
          type: "template_id",
          template_id: projectTemplateId,
          ...(inputOptions.templateTimezone === undefined
            ? {}
            : { timezone: inputOptions.templateTimezone }),
        },
      });
      if (!isNotionPage(page)) throw new Error("Notion returned an invalid page response.");
      await waitForTemplate(client, page.id);
      return externalProject(page, input.title);
    },
    async readContext(project: ExternalProject, ctx: ProjectLinkContext) {
      const client = await clientFor(ctx);
      const page = await client.request<NotionPage>(
        "GET",
        `/v1/pages/${encodeURIComponent(project.id)}`,
      );
      if (!isNotionPage(page)) throw new Error("Notion returned an invalid page response.");
      if (inputOptions.readContext) {
        const custom = await inputOptions.readContext({
          page,
          project,
          request: (method, path, body) => client.request(method, path, body),
        });
        if (custom === null) return null;
        const parsed = parseProjectContextCard(custom);
        if (!parsed) throw new Error("The custom Notion readContext returned an invalid context card.");
        return parsed;
      }
      return defaultReadContext(page);
    },
    async writeContext(
      project: ExternalProject,
      context: ProjectContextCard,
      ctx: ProjectLinkContext,
    ) {
      const encoded = JSON.stringify(context);
      if (encoded.length > options.maxContextCharacters) {
        throw new Error(
          `Project context is ${encoded.length} characters; the Notion adapter limit is ${options.maxContextCharacters}.`,
        );
      }
      const client = await clientFor(ctx);
      await client.request(
        "PATCH",
        `/v1/pages/${encodeURIComponent(project.id)}`,
        {
          properties: {
            [properties.summary]: richText(context.summary),
            [properties.context]: richText(encoded),
            [properties.lastSyncedAt]: { date: { start: context.generatedAt } },
          },
        },
      );
    },
  };
}

export default notionProjectProvider;
