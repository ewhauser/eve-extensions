import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import {
  lowerResolvedCapabilities,
  type RunnerCapabilityMode,
} from "../capabilities.js";
import {
  bootstrapTargetsEqual,
  parseBootstrapMessage,
  type ExecutionLeaseRecord,
  type ExecutionRole,
} from "../bootstrap.js";
import { savedAgentKindSchema, savedToolRequirementSchema, savedTriggerDefinitionSchema } from "../domain.js";
import { ownerInputFromSession, ownersEqual } from "../runtime/owner.js";
import {
  cachedRunnerTurn,
  eventTurnId,
  getAgentBuilderRuntime,
  resolveDynamicOwner,
  runtimeTimestamp,
} from "../runtime/service.js";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? (part as Record<string, unknown>).text
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

const emptySchema = z.object({}).strict();
const pmPatchSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    kind: savedAgentKindSchema.optional(),
    description: z.string().max(8_000).optional(),
    pmBrief: z.string().max(32_000).optional(),
  })
  .strict();
const implementorPatchSchema = z
  .object({
    instructions: z.string().max(128_000).optional(),
    toolRequirements: z
      .array(
        z
          .object({
            capabilityId: z.string().min(1).max(512),
            level: z.enum(["required", "optional"]),
            displayNameSnapshot: z.string().min(1).max(256),
            schemaFingerprint: z.string().min(1).max(512),
            consequential: z.boolean(),
          })
          .strict(),
      )
      .max(256)
      .readonly()
      .optional(),
    triggers: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("schedule"),
              triggerId: z.string().min(1).max(512),
              displaySchedule: z.string().min(1).max(512),
              timezone: z.string().min(1).max(128),
              normalizedSchedule: z.record(z.string(), z.unknown()),
              destination: z
                .object({
                  channelKind: z.string().min(1).max(128),
                  address: z.string().min(1).max(2_048),
                  threadKey: z.string().min(1).max(2_048).optional(),
                })
                .strict(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("event"),
              triggerId: z.string().min(1).max(512),
              sourceId: z.string().min(1).max(512),
              filter: z.record(z.string(), z.unknown()),
              destination: z
                .object({
                  channelKind: z.string().min(1).max(128),
                  address: z.string().min(1).max(2_048),
                  threadKey: z.string().min(1).max(2_048).optional(),
                })
                .strict(),
            })
            .strict(),
        ]),
      )
      .max(256)
      .readonly()
      .optional(),
  })
  .strict();
const implementorDomainPatchSchema = z
  .object({
    instructions: z.string().max(128_000).optional(),
    toolRequirements: z.array(savedToolRequirementSchema).max(256).readonly().optional(),
    triggers: z.array(savedTriggerDefinitionSchema).max(256).readonly().optional(),
  })
  .strict();
const qaPatchSchema = z
  .object({
    testChecklist: z.array(z.string().min(1).max(4_000)).max(256).readonly().optional(),
    qaFindings: z.array(z.string().min(1).max(8_000)).max(256).readonly().optional(),
  })
  .strict();

async function executeOwner(
  ctx: ToolContext,
  lease: ExecutionLeaseRecord,
): Promise<ExecutionLeaseRecord["owner"]> {
  const runtime = getAgentBuilderRuntime();
  const resolved = await runtime.service.resolveOwner(ownerInputFromSession(ctx));
  if (!resolved.ok) throw new Error(resolved.error.code);
  if (!ownersEqual(resolved.owner, lease.owner)) throw new Error("OWNER_MISMATCH");
  return resolved.owner;
}

function roleControlTools(role: ExecutionRole, lease: ExecutionLeaseRecord) {
  const runtime = getAgentBuilderRuntime();
  const draftGet = defineTool({
    description: "Read the exact owner-scoped draft bound to this lease.",
    inputSchema: emptySchema,
    execute: async (_input, ctx) => {
      await executeOwner(ctx, lease);
      return runtime.roles.readDraft(role as "pm" | "implementor" | "qa" | "test_runner", ownerInputFromSession(ctx), lease);
    },
  });
  if (role === "pm") {
    return {
      agent_builder__draft_get: draftGet,
      agent_builder__pm_patch: defineTool({
        description: "Patch only PM-owned fields on the exact leased draft revision.",
        inputSchema: pmPatchSchema,
        execute: async (patch, ctx) => {
          await executeOwner(ctx, lease);
          return runtime.roles.patchPm(
            { lease, mutationContext: { ownerResolution: ownerInputFromSession(ctx), operationId: ctx.callId } },
            patch,
          );
        },
      }),
    };
  }
  if (role === "implementor") {
    return {
      agent_builder__draft_get: draftGet,
      agent_builder__capability_list: defineTool({
        description: "List read-only metadata for capabilities eligible for the current owner.",
        inputSchema: emptySchema,
        execute: async (_input, ctx) =>
          runtime.roles.listCapabilityMetadata(ownerInputFromSession(ctx), lease),
      }),
      agent_builder__implementor_patch: defineTool({
        description: "Patch only implementor-owned instructions, capability requirements, and triggers.",
        inputSchema: implementorPatchSchema,
        execute: async (patch, ctx) => {
          await executeOwner(ctx, lease);
          const validatedPatch = implementorDomainPatchSchema.parse(patch);
          return runtime.roles.patchImplementor(
            { lease, mutationContext: { ownerResolution: ownerInputFromSession(ctx), operationId: ctx.callId } },
            validatedPatch,
          );
        },
      }),
    };
  }
  if (role === "qa") {
    return {
      agent_builder__draft_get: draftGet,
      agent_builder__qa_patch: defineTool({
        description: "Patch only QA-owned checklist and findings fields.",
        inputSchema: qaPatchSchema,
        execute: async (patch, ctx) => {
          await executeOwner(ctx, lease);
          return runtime.roles.patchQa(
            { lease, mutationContext: { ownerResolution: ownerInputFromSession(ctx), operationId: ctx.callId } },
            patch,
          );
        },
      }),
    };
  }
  return role === "test_runner" ? { agent_builder__draft_get: draftGet } : {};
}

export function createAgentBuilderRunnerTools(input: {
  readonly role: ExecutionRole;
  readonly mode: RunnerCapabilityMode;
}) {
  return defineDynamic({
    events: {
      "step.started": async (event, dynamicCtx) => {
        const runtime = getAgentBuilderRuntime();
        const owner = await resolveDynamicOwner(runtime, dynamicCtx);
        const lease = await runtime.config.store.getExecutionLease({
          owner,
          childSessionId: dynamicCtx.session.id,
        });
        if (lease === null) {
          const bootstrap = parseBootstrapMessage(latestUserMessage(dynamicCtx.messages));
          if (bootstrap === null) return null;
          return {
            agent_builder__bootstrap_redeem: defineTool({
              description: "Redeem the opaque bootstrap grant for this exact child session and return a ready receipt.",
              inputSchema: emptySchema,
              execute: async (_empty, toolCtx) => {
                if (toolCtx.session.parent === undefined) throw new Error("BOOTSTRAP_BINDING_MISMATCH");
                const resolved = await runtime.service.resolveOwner(ownerInputFromSession(toolCtx));
                if (!resolved.ok) throw new Error(resolved.error.code);
                if (!ownersEqual(resolved.owner, owner)) throw new Error("OWNER_MISMATCH");
                return runtime.bootstrap.redeem({
                  token: bootstrap.token,
                  owner: resolved.owner,
                  role: input.role,
                  parentSessionId: toolCtx.session.parent.sessionId,
                  parentTurnId: toolCtx.session.parent.turn.id,
                  parentCallId: toolCtx.session.parent.callId,
                  childSessionId: toolCtx.session.id,
                  bootstrapTurnId: toolCtx.session.turn.id,
                });
              },
            }),
          };
        }
        const turnId = eventTurnId(event);
        if (lease.bootstrapTurnId === turnId) return null;
        const prepared = await cachedRunnerTurn({ ...input, event, ctx: dynamicCtx });
        if (!prepared.ok) return null;
        const contextTool = defineTool({
          description: "Return the immutable, non-secret identity of this single leased run.",
          inputSchema: emptySchema,
          execute: async (_empty, ctx) => {
            await executeOwner(ctx, prepared.value.lease);
            return {
              leaseId: prepared.value.lease.leaseId,
              role: prepared.value.lease.role,
              target: prepared.value.lease.target,
              capabilityOmissions: prepared.value.capabilities.plan.optionalOmissions,
            };
          },
        });
        return {
          ...roleControlTools(input.role, prepared.value.lease),
          ...(input.role === "test_runner" || input.role === "active_runner"
            ? lowerResolvedCapabilities(
                prepared.value.capabilities.resolved,
                async (capability, ctx) => {
                  const currentOwner = await executeOwner(ctx, prepared.value.lease);
                  const authoritative = await runtime.config.store.getExecutionLease({
                    owner: currentOwner,
                    childSessionId: ctx.session.id,
                  });
                  if (
                    authoritative === null ||
                    authoritative.leaseId !== prepared.value.lease.leaseId ||
                    authoritative.status !== "running" ||
                    authoritative.executionTurnId !== ctx.session.turn.id ||
                    !bootstrapTargetsEqual(authoritative.target, prepared.value.lease.target) ||
                    !authoritative.capabilityPlan?.selected.some(
                      (entry) =>
                        entry.capabilityId === capability.descriptor.capabilityId &&
                        entry.modelToolName === capability.modelToolName &&
                        entry.schemaFingerprint === capability.descriptor.schemaFingerprint,
                    )
                  ) {
                    throw new Error("LEASE_CLOSED");
                  }
                  const occurredAt = runtimeTimestamp(runtime);
                  if (Date.parse(occurredAt) >= Date.parse(authoritative.expiresAt)) {
                    await runtime.bootstrap.closeExecution({
                      owner: currentOwner,
                      childSessionId: ctx.session.id,
                      executionTurnId: ctx.session.turn.id,
                      status: "failed",
                      occurredAt,
                      terminalCode: "LEASE_EXPIRED",
                    });
                    throw new Error("LEASE_EXPIRED");
                  }
                },
              )
            : {}),
          agent_builder__run_context: contextTool,
        };
      },
    },
  });
}

export const pmTools = createAgentBuilderRunnerTools({ role: "pm", mode: "direct" });
export const implementorTools = createAgentBuilderRunnerTools({ role: "implementor", mode: "direct" });
export const qaTools = createAgentBuilderRunnerTools({ role: "qa", mode: "direct" });
export const testRunnerTools = createAgentBuilderRunnerTools({ role: "test_runner", mode: "test" });
export const activeRunnerTools = createAgentBuilderRunnerTools({ role: "active_runner", mode: "direct" });
