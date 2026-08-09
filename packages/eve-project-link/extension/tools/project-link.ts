import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import extension from "../extension.js";
import { projectContextInputSchema } from "../lib/context.js";
import {
  getProjectLinkService,
  resolveProjectChannel,
} from "../lib/runtime.js";

const linkInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).max(100).optional(),
  channelUrl: z.string().url().max(2_000).optional(),
});

const emptyInputSchema = z.object({});

function approval(enabled: boolean) {
  return enabled ? (() => "user-approval" as const) : undefined;
}

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const channel = await resolveProjectChannel(ctx);
      if (!channel) return null;

      const service = getProjectLinkService();
      const binding = await service.status(channel);
      const tools: Record<string, any> = {};

      tools.link = defineTool({
        description:
          binding?.status === "error"
            ? "Retry this channel's failed external project link using its stable idempotency key."
            : "Link this entire channel to a new external project created from the configured provider template. If it is already linked, return the existing binding.",
        inputSchema: linkInputSchema,
        ...(approval(extension.config.approvals.link) === undefined
          ? {}
          : { approval: approval(extension.config.approvals.link) }),
        execute: async (input, toolCtx) => {
          const result = await service.link(
            channel,
            {
              title: input.title,
              ...(input.provider === undefined ? {} : { provider: input.provider }),
              ...(input.channelUrl === undefined ? {} : { channelUrl: input.channelUrl }),
            },
            toolCtx,
          );
          return {
            created: result.created,
            pending: result.pending,
            status: result.binding.status,
            provider: result.binding.provider,
            projectTitle: result.binding.title,
            projectUrl: result.binding.externalProject?.url,
            message: result.pending
              ? "Another invocation is still provisioning this channel's project."
              : result.created
                ? "The project page was created from the configured template and linked to this channel. Curate the channel, then save its context card."
                : "This channel is already linked to the returned project.",
          };
        },
      });

      tools.status = defineTool({
        description:
          "Read this channel's cached project-link status and external project URL without contacting the provider.",
        inputSchema: emptyInputSchema,
        execute: async () => {
          const current = await service.status(channel);
          if (!current) return { linked: false };
          return {
            linked: true,
            bindingId: current.id,
            status: current.status,
            provider: current.provider,
            projectTitle: current.title,
            projectUrl: current.externalProject?.url,
            contextGeneratedAt: current.context?.generatedAt,
            lastError: current.lastError,
          };
        },
      });

      if (!binding) return tools;

      tools.unlink = defineTool({
        description:
          "Remove this channel's project binding. This retains the external project page and all of its content.",
        inputSchema: emptyInputSchema,
        ...(approval(extension.config.approvals.unlink) === undefined
          ? {}
          : { approval: approval(extension.config.approvals.unlink) }),
        execute: async () => {
          const removed = await service.unlink(channel);
          return {
            unlinked: removed !== null,
            retainedProjectUrl: removed?.externalProject?.url,
          };
        },
      });

      if (binding.status !== "active") return tools;

      tools.save_context = defineTool({
        description:
          "Save a newly curated, structured context card to both the external project and this channel's prompt cache. Use after gathering channel history, people, decisions, sources, milestones, and meetings.",
        inputSchema: projectContextInputSchema,
        ...(approval(extension.config.approvals.saveContext) === undefined
          ? {}
          : { approval: approval(extension.config.approvals.saveContext) }),
        execute: async (input, toolCtx) => {
          const updated = await service.saveContext(channel, input, toolCtx);
          return {
            saved: true,
            projectUrl: updated.externalProject?.url,
            generatedAt: updated.context?.generatedAt,
            revision: updated.revision,
          };
        },
      });

      tools.refresh = defineTool({
        description:
          "Refresh this channel's prompt cache from the linked external project. This is read-only at the provider; it does not re-curate Slack history.",
        inputSchema: emptyInputSchema,
        execute: async (_input, toolCtx) => {
          const updated = await service.refresh(channel, toolCtx);
          return {
            refreshed: true,
            projectUrl: updated.externalProject?.url,
            generatedAt: updated.context?.generatedAt,
            revision: updated.revision,
          };
        },
      });

      return tools;
    },
  },
});
