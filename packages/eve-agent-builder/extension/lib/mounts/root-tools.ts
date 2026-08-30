import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { formatBootstrapMessage } from "../bootstrap.js";
import { agentIdSchema } from "../domain.js";
import {
  getAgentBuilderRuntime,
  resolveDynamicOwner,
  scopedToolOperationId,
} from "../runtime/service.js";
import {
  ownerChannelFromContext,
  ownerInputFromSession,
  ownersEqual,
} from "../runtime/owner.js";
import type { OwnerScope } from "../domain.js";
import type { ToolContext } from "eve/tools";

const searchSchema = z
  .object({
    query: z.string().max(512).optional(),
    cursor: z.string().max(4_096).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const byIdSchema = z.object({ agentId: agentIdSchema }).strict();
const emptySchema = z.object({}).strict();
const activateSchema = z
  .object({
    agentId: agentIdSchema,
    expectedRevision: z.number().int().positive(),
    specId: z.string().min(1).max(512),
    version: z.number().int().positive(),
  })
  .strict();
const lifecycleSchema = z
  .object({ agentId: agentIdSchema, expectedRevision: z.number().int().positive() })
  .strict();

const prepareRoleSchema = z
  .object({
    agentId: agentIdSchema,
    role: z.enum(["pm", "implementor", "qa", "test_runner"]),
  })
  .strict();

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? String((part as Record<string, unknown>).text)
        : "",
    )
    .join("");
}

function latestUserMessage(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message?.role === "user") return messageText(message.content);
  }
  return "";
}

type RuntimeChannel = ReturnType<typeof ownerChannelFromContext>;

async function currentOwner(
  toolCtx: ToolContext,
  expectedOwner: OwnerScope,
  channel: RuntimeChannel,
): Promise<OwnerScope> {
  const resolved = await getAgentBuilderRuntime().service.resolveOwner(
    ownerInputFromSession(toolCtx, channel),
  );
  if (!resolved.ok) throw new Error(resolved.error.code);
  if (!ownersEqual(resolved.owner, expectedOwner)) throw new Error("OWNER_MISMATCH");
  return resolved.owner;
}

export default defineDynamic({
  events: {
    "step.started": async (_event, dynamicCtx) => {
      const runtime = getAgentBuilderRuntime();
      const dynamicOwner = await resolveDynamicOwner(runtime, dynamicCtx);
      const channel = ownerChannelFromContext(dynamicCtx.channel);
      const usesVerifiedPublishApproval =
        runtime.config.verifiedPublishApprovalPolicy !== undefined;
      const publishUserInput = latestUserMessage(dynamicCtx.messages);

      return {
        agent_builder__workflow_allocate: defineTool({
          description:
            "Atomically allocate a private build workflow and system-owned family/draft IDs. The PM authors all user-facing requirements afterward.",
          inputSchema: emptySchema,
          execute: async (input, ctx) => {
            await currentOwner(ctx, dynamicOwner, channel);
            return getAgentBuilderRuntime().workflow.allocate(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                operationId: await scopedToolOperationId(ctx),
              },
              input,
            );
          },
        }),
        agent_builder__workflow_get: defineTool({
          description: "Return the typed durable state and deterministic next step for one private build.",
          inputSchema: byIdSchema,
          execute: async (input, ctx) => {
            await currentOwner(ctx, dynamicOwner, channel);
            return getAgentBuilderRuntime().workflow.getNext(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                agentId: input.agentId,
              },
              {},
            );
          },
        }),
        agent_builder__prepare_next_build_step: defineTool({
          description:
            "Issue a fresh current-turn bootstrap for only the role or test runner required by typed workflow state.",
          inputSchema: byIdSchema,
          execute: async (input, ctx) => {
            await currentOwner(ctx, dynamicOwner, channel);
            const prepared = await getAgentBuilderRuntime().workflow.prepareNext(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                agentId: input.agentId,
                parentSessionId: ctx.session.id,
                parentTurnId: ctx.session.turn.id,
                parentCallId: ctx.callId,
              },
              {},
            );
            if (!prepared.ok) return prepared;
            if (prepared.value.status !== "bootstrap_required") return prepared.value;
            return {
              status: prepared.value.status,
              role: prepared.value.role,
              mode: prepared.value.mode,
              workflow: prepared.value.workflow,
              target: prepared.value.grant.target,
              expiresAt: prepared.value.grant.expiresAt,
              bootstrapMessage: formatBootstrapMessage(prepared.value.grant.token),
            };
          },
        }),
        agent_builder__agent_search: defineTool({
          description:
            "Search this authenticated user's active saved agents and skills by normalized prefix/token matching. Cursors are owner-bound.",
          inputSchema: searchSchema,
          execute: async (input, ctx) =>
            getAgentBuilderRuntime().discovery.search(await currentOwner(ctx, dynamicOwner, channel), {
              ...(input.query === undefined ? {} : { query: input.query }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }),
        }),
        agent_builder__agent_get: defineTool({
          description: "Get one active saved agent or skill owned by the authenticated user.",
          inputSchema: byIdSchema,
          execute: async (input, ctx) =>
            getAgentBuilderRuntime().discovery.get(
              await currentOwner(ctx, dynamicOwner, channel),
              input.agentId,
            ),
        }),
        agent_builder__prepare_active_run: defineTool({
          description:
            "Issue a one-use active-runner bootstrap for one immutable active saved agent. A saved skill returns load_skill_required instead.",
          inputSchema: byIdSchema,
          execute: async (input, ctx) => {
            const owner = await currentOwner(ctx, dynamicOwner, channel);
            const activeRuntime = getAgentBuilderRuntime();
            const admission = await activeRuntime.discovery.admitRun(owner, input.agentId);
            if (admission.status !== "ready") return admission;
            const issued = await activeRuntime.bootstrap.issue({
              owner,
              role: "active_runner",
              target: {
                kind: "published",
                agentId: admission.entry.agentId,
                specId: admission.entry.specId,
                specVersion: admission.entry.version,
              },
              parentSessionId: ctx.session.id,
              parentTurnId: ctx.session.turn.id,
            });
            if (!issued.ok) return issued;
            return {
              status: "bootstrap_required" as const,
              protocolVersion: issued.value.protocolVersion,
              role: issued.value.role,
              target: issued.value.target,
              expiresAt: issued.value.expiresAt,
              bootstrapMessage: formatBootstrapMessage(issued.value.token),
            };
          },
        }),
        agent_builder__prepare_role: defineTool({
          description:
            "Issue a one-use bootstrap for a host-declared PM, implementor, QA, or test-runner child bound to the exact current draft revision.",
          inputSchema: prepareRoleSchema,
          execute: async (input, ctx) => {
            const owner = await currentOwner(ctx, dynamicOwner, channel);
            const roleRuntime = getAgentBuilderRuntime();
            const family = await roleRuntime.config.store.getFamily({ owner, agentId: input.agentId });
            const workflow = await roleRuntime.config.store.getBuildWorkflow({
              owner,
              agentId: input.agentId,
            });
            if (workflow !== null) {
              return {
                ok: false as const,
                error: {
                  code: "ROLE_FORBIDDEN",
                  message: "Workflow-managed drafts use the deterministic next-step tool",
                },
              };
            }
            if (family?.draft === undefined || family.lifecycle === "archived" || family.lifecycle === "deleted") {
              return { ok: false as const, error: { code: "TARGET_CHANGED", message: "Exact draft is unavailable" } };
            }
            const issued = await roleRuntime.bootstrap.issue({
              owner,
              role: input.role,
              target: {
                kind: "draft",
                agentId: family.agentId,
                draftId: family.draft.draftId,
                draftRevision: family.draft.draftRevision,
              },
              parentSessionId: ctx.session.id,
              parentTurnId: ctx.session.turn.id,
            });
            if (!issued.ok) return issued;
            return {
              status: "bootstrap_required" as const,
              protocolVersion: issued.value.protocolVersion,
              role: issued.value.role,
              target: issued.value.target,
              expiresAt: issued.value.expiresAt,
              bootstrapMessage: formatBootstrapMessage(issued.value.token),
            };
          },
        }),
        agent_builder__workflow_reopen: defineTool({
          description:
            "Atomically invalidate exact QA/test evidence for a publish-ready draft and return it to PM work before a requested edit.",
          inputSchema: byIdSchema,
          execute: async (input, ctx) => {
            await currentOwner(ctx, dynamicOwner, channel);
            return getAgentBuilderRuntime().workflow.reopen(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                operationId: await scopedToolOperationId(ctx),
                agentId: input.agentId,
              },
              {},
            );
          },
        }),
        agent_builder__workflow_publish: defineTool({
          description:
            "Atomically publish only the current QA-approved exact draft and advance the durable workflow. Requires this exact tool call's real user approval.",
          inputSchema: byIdSchema,
          approval: {
            request: () =>
              usesVerifiedPublishApproval ? "not-applicable" : "user-approval",
            response: async (ctx) => {
              const resolved = await getAgentBuilderRuntime().service.resolveOwner({
                current: ctx.responder,
                initiator: ctx.session.initiator,
                channel,
              });
              return resolved.ok && ownersEqual(resolved.owner, dynamicOwner)
                ? { status: "allowed" }
                : { status: "rejected", reason: "OWNER_MISMATCH" };
            },
          },
          execute: async (input, ctx) => {
            const owner = await currentOwner(ctx, dynamicOwner, channel);
            const publishRuntime = getAgentBuilderRuntime();
            if (usesVerifiedPublishApproval) {
              const policy = publishRuntime.config.verifiedPublishApprovalPolicy;
              if (policy === undefined) throw new Error("INPUT_UNAVAILABLE");
              let decision;
              try {
                decision = await policy.authorize({
                  owner,
                  agentId: input.agentId,
                  sessionId: ctx.session.id,
                  turnId: ctx.session.turn.id,
                  callId: ctx.callId,
                  userInput: publishUserInput,
                });
              } catch {
                throw new Error("INPUT_UNAVAILABLE");
              }
              if (decision.status !== "allowed") throw new Error(decision.code);
            }
            return publishRuntime.workflow.publish(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                operationId: await scopedToolOperationId(ctx),
                agentId: input.agentId,
              },
              {},
            );
          },
        }),
        agent_builder__activate: defineTool({
          description: "Atomically select an immutable published version as the active version.",
          inputSchema: activateSchema,
          approval: {
            request: () => "user-approval",
            response: async (ctx) => {
              const resolved = await getAgentBuilderRuntime().service.resolveOwner({
                current: ctx.responder,
                initiator: ctx.session.initiator,
                channel,
              });
              return resolved.ok && ownersEqual(resolved.owner, dynamicOwner)
                ? { status: "allowed" }
                : { status: "rejected", reason: "OWNER_MISMATCH" };
            },
          },
          execute: async (input, ctx) => {
            await currentOwner(ctx, dynamicOwner, channel);
            return getAgentBuilderRuntime().service.activateVersion(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                operationId: await scopedToolOperationId(ctx),
              },
              input,
            );
          },
        }),
        agent_builder__archive: defineTool({
          description: "Archive an owner-scoped saved-agent family.",
          inputSchema: lifecycleSchema,
          approval: {
            request: () => "user-approval",
            response: async (ctx) => {
              const resolved = await getAgentBuilderRuntime().service.resolveOwner({
                current: ctx.responder,
                initiator: ctx.session.initiator,
                channel,
              });
              return resolved.ok && ownersEqual(resolved.owner, dynamicOwner)
                ? { status: "allowed" }
                : { status: "rejected", reason: "OWNER_MISMATCH" };
            },
          },
          execute: async (input, ctx) => {
            await currentOwner(ctx, dynamicOwner, channel);
            return getAgentBuilderRuntime().service.archiveFamily(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                operationId: await scopedToolOperationId(ctx),
              },
              input,
            );
          },
        }),
        agent_builder__restore: defineTool({
          description: "Restore an archived owner-scoped saved-agent family.",
          inputSchema: lifecycleSchema,
          approval: {
            request: () => "user-approval",
            response: async (ctx) => {
              const resolved = await getAgentBuilderRuntime().service.resolveOwner({
                current: ctx.responder,
                initiator: ctx.session.initiator,
                channel,
              });
              return resolved.ok && ownersEqual(resolved.owner, dynamicOwner)
                ? { status: "allowed" }
                : { status: "rejected", reason: "OWNER_MISMATCH" };
            },
          },
          execute: async (input, ctx) => {
            await currentOwner(ctx, dynamicOwner, channel);
            return getAgentBuilderRuntime().service.restoreFamily(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                operationId: await scopedToolOperationId(ctx),
              },
              input,
            );
          },
        }),
        agent_builder__delete: defineTool({
          description: "Irreversibly tombstone an owner-scoped saved-agent family.",
          inputSchema: lifecycleSchema,
          approval: {
            request: () => "user-approval",
            response: async (ctx) => {
              const resolved = await getAgentBuilderRuntime().service.resolveOwner({
                current: ctx.responder,
                initiator: ctx.session.initiator,
                channel,
              });
              return resolved.ok && ownersEqual(resolved.owner, dynamicOwner)
                ? { status: "allowed" }
                : { status: "rejected", reason: "OWNER_MISMATCH" };
            },
          },
          execute: async (input, ctx) => {
            await currentOwner(ctx, dynamicOwner, channel);
            return getAgentBuilderRuntime().service.deleteFamily(
              {
                ownerResolution: ownerInputFromSession(ctx, channel),
                operationId: await scopedToolOperationId(ctx),
              },
              input,
            );
          },
        }),
      };
    },
  },
});
