import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { getProjectLinkConfig } from "../extension.js";
import {
  projectContextInputSchema,
  type ProjectContextInput,
} from "../lib/context.js";
import type { CompleteProjectLinkInput } from "../lib/project-link.js";
import {
  getProjectLinkService,
  resolveProjectChannel,
} from "../lib/runtime.js";
import type { ProjectChannel } from "../lib/types.js";

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

const completionVerificationSchema = z.object({
  resolution: z.enum(["created", "reused"]),
  evidence: z
    .array(
      z.object({
        requirementId: z.string().trim().min(1).max(100),
        evidence: z.string().trim().min(1).max(4_000),
        sourceUrl: z.string().url().max(2_000).optional(),
      }),
    )
    .max(30),
});

const completeInputSchema = z.object({
  bindingId: z.string().uuid(),
  resource: resourceSchema,
});

const verifiedCompleteInputSchema = completeInputSchema.extend({
  verification: completionVerificationSchema,
});

const emptyInputSchema = z.object({});

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

type DurableCallback = (
  closure: JsonObject,
  ...args: readonly unknown[]
) => unknown;

interface DurableCallbackDescriptor {
  readonly callback: DurableCallback;
  readonly closure: JsonObject;
}

interface DurableToolCallbacks {
  readonly execute: DurableCallbackDescriptor;
  readonly approvalRequest?: DurableCallbackDescriptor;
}

interface LinkToolInput {
  readonly proposal?: z.infer<typeof projectProposalSchema> | undefined;
  readonly preset?: string | undefined;
  readonly channelUrl?: string | undefined;
}

const DURABLE_DYNAMIC_TOOL_CALLBACKS = Symbol.for(
  "eve:durable-dynamic-tool-callbacks",
);

function approval(enabled: boolean) {
  return enabled ? (() => "user-approval" as const) : undefined;
}

function projectLinkClosure(channel: ProjectChannel): JsonObject {
  return { channel } as unknown as JsonObject;
}

function projectChannelFromClosure(closure: JsonObject): ProjectChannel {
  const candidate = closure.channel;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new Error("Project-link callback metadata is invalid.");
  }
  const record = candidate as JsonObject;
  if (
    typeof record.kind !== "string" ||
    typeof record.workspaceId !== "string" ||
    typeof record.channelId !== "string"
  ) {
    throw new Error("Project-link callback metadata is invalid.");
  }
  return {
    kind: record.kind,
    workspaceId: record.workspaceId,
    channelId: record.channelId,
  };
}

function requestProjectLinkApproval(): "user-approval" {
  return "user-approval";
}

async function executeLink(
  closure: JsonObject,
  input: LinkToolInput,
): Promise<unknown> {
  const channel = projectChannelFromClosure(closure);
  const result = await getProjectLinkService().link(channel, {
    ...(input.proposal === undefined ? {} : { proposal: input.proposal }),
    ...(input.preset === undefined ? {} : { preset: input.preset }),
    ...(input.channelUrl === undefined ? {} : { channelUrl: input.channelUrl }),
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
}

async function executeStatus(closure: JsonObject): Promise<unknown> {
  const current = await getProjectLinkService().status(
    projectChannelFromClosure(closure),
  );
  if (!current) return { linked: false };
  return {
    linked: true,
    bindingId: current.id,
    status: current.status,
    preset: current.presetId,
    projectTitle: current.title,
    resource: current.resource,
    completionVerification: current.completionVerification,
    contextGeneratedAt: current.context?.generatedAt,
  };
}

async function executeGuide(closure: JsonObject): Promise<unknown> {
  const channel = projectChannelFromClosure(closure);
  const service = getProjectLinkService();
  const current = await service.status(channel);
  return {
    status: current?.status,
    resource: current?.resource,
    plan: await service.guide(channel),
  };
}

async function executeUnlink(closure: JsonObject): Promise<unknown> {
  const removed = await getProjectLinkService().unlink(
    projectChannelFromClosure(closure),
  );
  return {
    unlinked: removed !== null,
    retainedResourceUrl: removed?.resource?.url,
  };
}

async function executeComplete(
  closure: JsonObject,
  input: CompleteProjectLinkInput,
): Promise<unknown> {
  const completed = await getProjectLinkService().complete(
    projectChannelFromClosure(closure),
    input,
  );
  return {
    completed: true,
    bindingId: completed.id,
    status: completed.status,
    preset: completed.presetId,
    resource: completed.resource,
    completionVerification: completed.completionVerification,
  };
}

async function executeSaveContext(
  closure: JsonObject,
  input: ProjectContextInput,
): Promise<unknown> {
  const updated = await getProjectLinkService().saveContext(
    projectChannelFromClosure(closure),
    input,
  );
  return {
    saved: true,
    resourceUrl: updated.resource?.url,
    generatedAt: updated.context?.generatedAt,
    revision: updated.revision,
  };
}

function stampDurableCallbacks<T extends object>(
  tool: T,
  closure: JsonObject,
  execute: DurableCallback,
  approvalRequired = false,
): T {
  const callbacks: DurableToolCallbacks = {
    execute: { callback: execute, closure },
    ...(approvalRequired
      ? {
          approvalRequest: {
            callback: requestProjectLinkApproval as DurableCallback,
            closure,
          },
        }
      : {}),
  };
  Object.defineProperty(tool, DURABLE_DYNAMIC_TOOL_CALLBACKS, {
    configurable: true,
    value: callbacks,
  });
  return tool;
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
      const closure = projectLinkClosure(channel);
      const tools: Record<string, any> = {};

      tools.link = stampDurableCallbacks(
        defineTool({
          description: binding
            ? "Return this channel's existing project-link plan. The tool is idempotent and never calls an external project API."
            : `Reserve a stable channel link and return a plan for using tools already mounted in this agent. This tool never calls an external project API or accepts credentials. Available configured presets: ${presets}.`,
          inputSchema: binding ? existingLinkInputSchema : newLinkInputSchema,
          ...(approval(config.approvals.link) === undefined
            ? {}
            : { approval: approval(config.approvals.link) }),
          execute: (input) => executeLink(closure, input as LinkToolInput),
        }),
        closure,
        executeLink as DurableCallback,
        config.approvals.link,
      );

      tools.status = stampDurableCallbacks(
        defineTool({
          description:
            "Read this channel's cached project-link status without contacting an external system.",
          inputSchema: emptyInputSchema,
          execute: () => executeStatus(closure),
        }),
        closure,
        executeStatus as DurableCallback,
      );

      if (!binding) return tools;

      tools.guide = stampDurableCallbacks(
        defineTool({
          description:
            "Return the configured preset's tool-discovery, provisioning, retrieval, and update guidance for this channel. This does not call the external system.",
          inputSchema: emptyInputSchema,
          execute: () => executeGuide(closure),
        }),
        closure,
        executeGuide as DurableCallback,
      );

      tools.unlink = stampDurableCallbacks(
        defineTool({
          description:
            "Remove this channel's project binding. This retains the external resource and all of its content.",
          inputSchema: emptyInputSchema,
          ...(approval(config.approvals.unlink) === undefined
            ? {}
            : { approval: approval(config.approvals.unlink) }),
          execute: () => executeUnlink(closure),
        }),
        closure,
        executeUnlink as DurableCallback,
        config.approvals.unlink,
      );

      if (binding.status === "pending") {
        const completionRequirements = service.plan(binding).completionRequirements;
        tools.complete = stampDurableCallbacks(
          defineTool({
            description: completionRequirements
              ? "Attach the externally verified resource and activate this channel link. Include evidence for every completion requirement in the plan. This tool does not contact the external system."
              : "Attach the external resource returned by an already-mounted tool and activate this channel link. This tool does not contact the external system.",
            inputSchema: completionRequirements
              ? verifiedCompleteInputSchema
              : completeInputSchema,
            execute: (input) =>
              executeComplete(closure, input as CompleteProjectLinkInput),
          }),
          closure,
          executeComplete as DurableCallback,
        );
        return tools;
      }

      tools.save_context = stampDurableCallbacks(
        defineTool({
          description:
            "Save a newly curated structured context card with this channel's durable binding. Pointer-mode prompts do not inject the card. This tool does not write to the external system; use mounted system tools separately when external synchronization is requested.",
          inputSchema: projectContextInputSchema,
          ...(approval(config.approvals.saveContext) === undefined
            ? {}
            : { approval: approval(config.approvals.saveContext) }),
          execute: (input) => executeSaveContext(closure, input),
        }),
        closure,
        executeSaveContext as DurableCallback,
        config.approvals.saveContext,
      );

      return tools;
    },
  },
});
