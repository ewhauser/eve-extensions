import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { formatBootstrapMessage } from "../bootstrap.js";
import { agentIdSchema } from "../domain.js";
import { getAgentBuilderRuntime, resolveDynamicOwner } from "../runtime/service.js";
import { ownerInputFromSession, ownersEqual } from "../runtime/owner.js";

const searchSchema = z
  .object({
    query: z.string().max(512).optional(),
    cursor: z.string().max(4_096).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const byIdSchema = z.object({ agentId: agentIdSchema }).strict();
const createDraftSchema = z
  .object({
    name: z.string().min(1).max(256),
    kind: z.enum(["agent", "skill"]),
    description: z.string().max(8_000).optional(),
  })
  .strict();
const publishSchema = z
  .object({
    agentId: agentIdSchema,
    expectedRevision: z.number().int().positive(),
    expectedDraftRevision: z.number().int().positive(),
  })
  .strict();
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

export default defineDynamic({
  events: {
    "step.started": async (_event, dynamicCtx) => {
      const runtime = getAgentBuilderRuntime();
      const dynamicOwner = await resolveDynamicOwner(runtime, dynamicCtx);
      const channel = {
        ...(dynamicCtx.channel.kind === undefined ? {} : { kind: dynamicCtx.channel.kind }),
        ...(dynamicCtx.channel.metadata === undefined
          ? {}
          : { metadata: dynamicCtx.channel.metadata }),
      };

      async function currentOwner(toolCtx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[1]) {
        const resolved = await runtime.service.resolveOwner(ownerInputFromSession(toolCtx, channel));
        if (!resolved.ok) throw new Error(resolved.error.code);
        if (!ownersEqual(resolved.owner, dynamicOwner)) throw new Error("OWNER_MISMATCH");
        return resolved.owner;
      }

      return {
        agent_builder__draft_create: defineTool({
          description: "Create a new owner-scoped saved-agent draft with system-owned IDs and revisions.",
          inputSchema: createDraftSchema,
          execute: async (input, ctx) => {
            await currentOwner(ctx);
            return runtime.service.createDraft(
              { ownerResolution: ownerInputFromSession(ctx, channel), operationId: ctx.callId },
              input,
            );
          },
        }),
        agent_builder__agent_search: defineTool({
          description:
            "Search this authenticated user's active saved agents and skills by normalized prefix/token matching. Cursors are owner-bound.",
          inputSchema: searchSchema,
          execute: async (input, ctx) =>
            runtime.discovery.search(await currentOwner(ctx), {
              ...(input.query === undefined ? {} : { query: input.query }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }),
        }),
        agent_builder__agent_get: defineTool({
          description: "Get one active saved agent or skill owned by the authenticated user.",
          inputSchema: byIdSchema,
          execute: async (input, ctx) => runtime.discovery.get(await currentOwner(ctx), input.agentId),
        }),
        agent_builder__prepare_active_run: defineTool({
          description:
            "Issue a one-use active-runner bootstrap for one immutable active saved agent. A saved skill returns load_skill_required instead.",
          inputSchema: byIdSchema,
          execute: async (input, ctx) => {
            const owner = await currentOwner(ctx);
            const admission = await runtime.discovery.admitRun(owner, input.agentId);
            if (admission.status !== "ready") return admission;
            const issued = await runtime.bootstrap.issue({
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
            const owner = await currentOwner(ctx);
            const family = await runtime.config.store.getFamily({ owner, agentId: input.agentId });
            if (family?.draft === undefined || family.lifecycle === "archived" || family.lifecycle === "deleted") {
              return { ok: false as const, error: { code: "TARGET_CHANGED", message: "Exact draft is unavailable" } };
            }
            const issued = await runtime.bootstrap.issue({
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
        agent_builder__publish: defineTool({
          description: "Publish the exact current draft as a new immutable version.",
          inputSchema: publishSchema,
          approval: () => "user-approval",
          execute: async (input, ctx) => {
            await currentOwner(ctx);
            return runtime.service.publishDraft(
              { ownerResolution: ownerInputFromSession(ctx, channel), operationId: ctx.callId },
              input,
            );
          },
        }),
        agent_builder__activate: defineTool({
          description: "Atomically select an immutable published version as the active version.",
          inputSchema: activateSchema,
          approval: () => "user-approval",
          execute: async (input, ctx) => {
            await currentOwner(ctx);
            return runtime.service.activateVersion(
              { ownerResolution: ownerInputFromSession(ctx, channel), operationId: ctx.callId },
              input,
            );
          },
        }),
        agent_builder__archive: defineTool({
          description: "Archive an owner-scoped saved-agent family.",
          inputSchema: lifecycleSchema,
          approval: () => "user-approval",
          execute: async (input, ctx) => {
            await currentOwner(ctx);
            return runtime.service.archiveFamily(
              { ownerResolution: ownerInputFromSession(ctx, channel), operationId: ctx.callId },
              input,
            );
          },
        }),
        agent_builder__restore: defineTool({
          description: "Restore an archived owner-scoped saved-agent family.",
          inputSchema: lifecycleSchema,
          approval: () => "user-approval",
          execute: async (input, ctx) => {
            await currentOwner(ctx);
            return runtime.service.restoreFamily(
              { ownerResolution: ownerInputFromSession(ctx, channel), operationId: ctx.callId },
              input,
            );
          },
        }),
        agent_builder__delete: defineTool({
          description: "Irreversibly tombstone an owner-scoped saved-agent family.",
          inputSchema: lifecycleSchema,
          approval: () => "user-approval",
          execute: async (input, ctx) => {
            await currentOwner(ctx);
            return runtime.service.deleteFamily(
              { ownerResolution: ownerInputFromSession(ctx, channel), operationId: ctx.callId },
              input,
            );
          },
        }),
      };
    },
  },
});
