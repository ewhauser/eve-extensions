import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { getProjectLinkConfig } from "../extension.js";
import { projectContextInputSchema } from "../lib/context.js";
import {
  getProjectLinkService,
  resolveProjectChannel,
} from "../lib/runtime.js";

const projectProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  context: projectContextInputSchema,
});

const newLinkInputSchema = z.object({
  proposal: projectProposalSchema,
  preset: z.string().trim().min(1).max(100).optional(),
  channelUrl: z.string().url().max(2_000).optional(),
});

const existingLinkInputSchema = z.object({});

const resourceSchema = z.object({
  id: z.string().trim().min(1).max(500),
  url: z.string().url().max(2_000),
  title: z.string().trim().min(1).max(300),
  metadata: z.record(z.string(), z.string().max(4_000)).optional(),
});

const completeInputSchema = z.object({
  bindingId: z.string().uuid(),
  resource: resourceSchema,
});

const emptyInputSchema = z.object({});

function approval(enabled: boolean) {
  return enabled ? (() => "user-approval" as const) : undefined;
}

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const config = getProjectLinkConfig();
      const channel = await resolveProjectChannel(ctx);
      if (!channel) return null;

      const service = getProjectLinkService();
      const binding = await service.status(channel);
      const presets = service.availablePresets().join(", ");
      const tools: Record<string, any> = {};

      tools.link = defineTool({
        description: binding
          ? "Return this channel's existing project-link plan. The tool is idempotent and never calls an external project API."
          : `Reserve a stable channel link and return a plan for using tools already mounted in this agent. This tool never calls an external project API or accepts credentials. Available configured presets: ${presets}.`,
        inputSchema: binding ? existingLinkInputSchema : newLinkInputSchema,
        ...(approval(config.approvals.link) === undefined
          ? {}
          : { approval: approval(config.approvals.link) }),
        execute: async (input) => {
          const result = await service.link(channel, {
            ...("proposal" in input ? { proposal: input.proposal } : {}),
            ...("preset" in input && input.preset !== undefined
              ? { preset: input.preset }
              : {}),
            ...("channelUrl" in input && input.channelUrl !== undefined
              ? { channelUrl: input.channelUrl }
              : {}),
          });
          return {
            created: result.created,
            bindingId: result.binding.id,
            status: result.binding.status,
            preset: result.binding.presetId,
            resource: result.binding.resource,
            plan: result.plan,
            next:
              result.binding.status === "active"
                ? "The channel is already linked. Use guide for deeper retrieval instructions."
                : "Use the confirmed proposal, plan, and mounted tools to find or create the external resource, then call complete with its id, URL, and title.",
          };
        },
      });

      tools.status = defineTool({
        description:
          "Read this channel's cached project-link status without contacting an external system.",
        inputSchema: emptyInputSchema,
        execute: async () => {
          const current = await service.status(channel);
          if (!current) return { linked: false };
          return {
            linked: true,
            bindingId: current.id,
            status: current.status,
            preset: current.presetId,
            projectTitle: current.title,
            resource: current.resource,
            contextGeneratedAt: current.context?.generatedAt,
          };
        },
      });

      if (!binding) return tools;

      tools.guide = defineTool({
        description:
            "Return the configured preset's tool-discovery, provisioning, retrieval, and update guidance for this channel. This does not call the external system.",
        inputSchema: emptyInputSchema,
        execute: async () => {
          const current = await service.status(channel);
          return {
            status: current?.status,
            resource: current?.resource,
            plan: await service.guide(channel),
          };
        },
      });

      tools.unlink = defineTool({
        description:
          "Remove this channel's project binding. This retains the external resource and all of its content.",
        inputSchema: emptyInputSchema,
        ...(approval(config.approvals.unlink) === undefined
          ? {}
          : { approval: approval(config.approvals.unlink) }),
        execute: async () => {
          const removed = await service.unlink(channel);
          return {
            unlinked: removed !== null,
            retainedResourceUrl: removed?.resource?.url,
          };
        },
      });

      if (binding.status === "pending") {
        tools.complete = defineTool({
          description:
            "Attach the external resource returned by an already-mounted tool and activate this channel link. This tool does not contact the external system.",
          inputSchema: completeInputSchema,
          execute: async (input) => {
            const completed = await service.complete(channel, input);
            return {
              completed: true,
              bindingId: completed.id,
              status: completed.status,
              preset: completed.presetId,
              resource: completed.resource,
            };
          },
        });
        return tools;
      }

      tools.save_context = defineTool({
        description:
          "Save a newly curated structured context card to this channel's durable prompt cache. This tool does not write to the external system; use the mounted system tools separately when external synchronization is requested.",
        inputSchema: projectContextInputSchema,
        ...(approval(config.approvals.saveContext) === undefined
          ? {}
          : { approval: approval(config.approvals.saveContext) }),
        execute: async (input) => {
          const updated = await service.saveContext(channel, input);
          return {
            saved: true,
            resourceUrl: updated.resource?.url,
            generatedAt: updated.context?.generatedAt,
            revision: updated.revision,
          };
        },
      });

      return tools;
    },
  },
});
