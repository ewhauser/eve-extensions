import { callSlackApi } from "eve/channels/slack";

import type {
  AgentProgressSnapshot,
  ProgressPublicationContext,
  ProgressRootBinding,
  ProgressSurface,
  SlackProgressApi,
  SlackProgressPublisherOptions,
} from "./lib/types.js";
import { slackProgressSessionState } from "./lib/state.js";

export type SlackPlanTaskStatus = "pending" | "in_progress" | "complete" | "error";

export interface SlackTaskCardBlock {
  readonly type: "task_card";
  readonly task_id: string;
  readonly title: string;
  readonly status: SlackPlanTaskStatus;
  readonly output?: Readonly<Record<string, unknown>>;
}

export interface SlackPlanBlock {
  readonly type: "plan";
  readonly block_id: string;
  readonly title: string;
  readonly tasks: readonly SlackTaskCardBlock[];
}

export interface RenderedSlackProgress {
  readonly text: string;
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
  readonly fingerprint: string;
}

function boundedText(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function richText(value: string): Readonly<Record<string, unknown>> {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [{ type: "text", text: value }],
      },
    ],
  };
}

function renderTask(
  task: AgentProgressSnapshot["tasks"][number],
  lifecycle: AgentProgressSnapshot["lifecycle"],
): SlackTaskCardBlock {
  const title = boundedText(task.title, 200) || "Untitled task";
  if (task.status === "completed") {
    return { type: "task_card", task_id: task.id, title, status: "complete" };
  }
  if (task.status === "cancelled") {
    return {
      type: "task_card",
      task_id: task.id,
      title,
      status: "error",
      output: richText("Cancelled"),
    };
  }
  if (task.status === "in_progress" && (lifecycle === "failed" || lifecycle === "cancelled")) {
    const label = lifecycle === "failed" ? "Agent turn failed" : "Agent turn cancelled";
    return {
      type: "task_card",
      task_id: task.id,
      title,
      status: "error",
      output: richText(label),
    };
  }
  return {
    type: "task_card",
    task_id: task.id,
    title,
    status: task.status,
  };
}

function taskLimit(value: number | undefined): number {
  const requested = value === undefined || !Number.isFinite(value) ? 50 : Math.floor(value);
  return Math.min(50, Math.max(1, requested));
}

function sessionHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function renderSlackProgress(
  snapshot: AgentProgressSnapshot,
  options: { readonly title: string; readonly maxTasks?: number },
): RenderedSlackProgress {
  const maxTasks = taskLimit(options.maxTasks);
  const title = boundedText(options.title, 200) || "Work plan";
  const tasks = snapshot.tasks.slice(0, maxTasks).map((task) => renderTask(task, snapshot.lifecycle));
  const text = [title, ...tasks.map((task) => `- (${task.status}) ${task.title}`)].join("\n");
  const blocks: readonly Readonly<Record<string, unknown>>[] =
    tasks.length === 0
      ? [
          {
            type: "section",
            block_id: `eve-progress-${sessionHash(snapshot.sessionId)}-r${snapshot.revision}`,
            text: { type: "mrkdwn", text: `*${title}*\n_No tasks in the current plan._` },
          },
        ]
      : [
          {
            type: "plan",
            block_id: `eve-progress-${sessionHash(snapshot.sessionId)}-r${snapshot.revision}`,
            title,
            tasks,
          } satisfies SlackPlanBlock,
        ];
  const fingerprint = JSON.stringify({ text, blocks });
  return { text, blocks, fingerprint };
}

function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultTitle(
  snapshot: AgentProgressSnapshot,
  context: ProgressPublicationContext,
): string {
  return context.parent === undefined ? "Work plan" : `${snapshot.agent.name} work plan`;
}

function resolveTitle(
  option: SlackProgressPublisherOptions["title"],
  snapshot: AgentProgressSnapshot,
  context: ProgressPublicationContext,
): string {
  if (typeof option === "function") return option(snapshot, context);
  return option ?? defaultTitle(snapshot, context);
}

function stableClientMessageId(sessionId: string): string {
  const parts = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map((seed) => {
    let hash = seed;
    for (let index = 0; index < sessionId.length; index += 1) {
      hash ^= sessionId.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  });
  const hex = parts.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function slackError(operation: string, response: Readonly<Record<string, unknown>>): Error {
  const code = typeof response.error === "string" ? response.error : "unknown_error";
  return new Error(`Slack ${operation} failed: ${code}`);
}

const defaultApi: SlackProgressApi = async (input) =>
  callSlackApi({
    botToken: input.botToken,
    operation: input.operation,
    body: input.body,
  });

/**
 * Creates the Slack adapter. Each Eve session durably owns its own Slack
 * binding and message metadata in extension state.
 */
export function createSlackProgressPublisher(
  options: SlackProgressPublisherOptions,
) {
  const api = options.api ?? defaultApi;
  const maxTasks = taskLimit(options.maxTasks);
  const queues = new Map<string, Promise<void>>();

  async function serialized(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    queues.set(key, next);
    try {
      await next;
    } finally {
      if (queues.get(key) === next) queues.delete(key);
    }
  }

  async function tokenFor(binding: ProgressRootBinding) {
    return options.resolveBotToken === undefined
      ? options.botToken
      : options.resolveBotToken(binding);
  }

  return {
    async bind(context: ProgressPublicationContext): Promise<void> {
      const isRootSlack =
        context.parent === undefined && context.channel.kind === "channel:slack";
      const isChildWithInheritedMetadata = context.parent !== undefined;
      if (!isRootSlack && !isChildWithInheritedMetadata) return;
      const channelId = metadataString(context.channel.metadata, "channelId");
      const threadTs = metadataString(context.channel.metadata, "threadTs");
      if (channelId === undefined || threadTs === undefined) {
        if (isRootSlack) {
          throw new Error(
            "Slack progress binding requires channelId and threadTs metadata.",
          );
        }
        return;
      }
      const teamId = metadataString(context.channel.metadata, "teamId");
      const binding: ProgressRootBinding = {
        rootSessionId: context.rootSessionId,
        channelId,
        threadTs,
        ...(teamId === undefined ? {} : { teamId }),
      };
      slackProgressSessionState.update((current) => {
        const previous = current.binding;
        const sameDestination =
          previous?.rootSessionId === binding.rootSessionId &&
          previous.channelId === binding.channelId &&
          previous.threadTs === binding.threadTs &&
          previous.teamId === binding.teamId;
        return {
          binding,
          surface: sameDestination ? current.surface : null,
        };
      });
    },

    async publish(
      snapshot: AgentProgressSnapshot,
      context: ProgressPublicationContext,
    ): Promise<void> {
      const key = `${snapshot.rootSessionId}\u0000${snapshot.sessionId}`;
      await serialized(key, async () => {
        const state = slackProgressSessionState.get();
        const binding = state.binding;
        if (binding === null) return;
        const current =
          state.surface?.rootSessionId === snapshot.rootSessionId &&
          state.surface.sessionId === snapshot.sessionId
            ? state.surface
            : null;
        if (current === null && snapshot.tasks.length === 0) return;

        const rendered = renderSlackProgress(snapshot, {
          title: resolveTitle(options.title, snapshot, context),
          maxTasks,
        });
        if (current !== null && current.fingerprint === rendered.fingerprint) {
          if (snapshot.revision > current.revision) {
            slackProgressSessionState.update((value) => ({
              ...value,
              surface: { ...current, revision: snapshot.revision },
            }));
          }
          return;
        }
        if (current !== null && snapshot.revision < current.revision) return;

        const botToken = await tokenFor(binding);
        if (current === null) {
          const response = await api({
            botToken,
            operation: "chat.postMessage",
            body: {
              channel: binding.channelId,
              thread_ts: binding.threadTs,
              text: rendered.text,
              blocks: rendered.blocks,
              client_msg_id: stableClientMessageId(snapshot.sessionId),
              unfurl_links: false,
              unfurl_media: false,
            },
          });
          if (response.ok !== true) throw slackError("chat.postMessage", response);
          if (typeof response.ts !== "string" || response.ts.length === 0) {
            throw new Error("Slack chat.postMessage succeeded without a message ts.");
          }
          const surface: ProgressSurface = {
            rootSessionId: snapshot.rootSessionId,
            sessionId: snapshot.sessionId,
            channelId: binding.channelId,
            messageTs: response.ts,
            revision: snapshot.revision,
            fingerprint: rendered.fingerprint,
          };
          slackProgressSessionState.update((value) => ({ ...value, surface }));
          return;
        }

        const response = await api({
          botToken,
          operation: "chat.update",
          body: {
            channel: current.channelId,
            ts: current.messageTs,
            text: rendered.text,
            blocks: rendered.blocks,
          },
        });
        if (response.ok !== true) throw slackError("chat.update", response);
        slackProgressSessionState.update((value) => ({
          ...value,
          surface: {
            ...current,
            revision: snapshot.revision,
            fingerprint: rendered.fingerprint,
          },
        }));
      });
    },
  };
}
