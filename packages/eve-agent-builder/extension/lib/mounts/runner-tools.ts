import {
  defineDynamic,
  defineTool,
  type ApprovalContext,
  type ApprovalResponseContext,
  type ToolContext,
} from "eve/tools";
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
import {
  composeConsequentialTestApproval,
  fingerprintTestStep,
  type TestCapabilityStepScope,
  type TestPolicyResult,
} from "../test-policy.js";
import {
  pmBuildSubmissionInputSchema,
  qaBuildSubmissionInputSchema,
  recordBuildTestInputSchema,
} from "../workflow-service.js";
import { ownerInputFromSession, ownersEqual } from "../runtime/owner.js";
import {
  cachedRunnerTurn,
  eventTurnId,
  getAgentBuilderRuntime,
  resolveDynamicOwner,
  runtimeTimestamp,
  scopedToolOperationId,
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
const implementorToolSubmissionSchema = z
  .object({
    patch: z
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
      .strict(),
    result: z.enum(["completed_handoff", "needs_user_input", "failed"]),
  })
  .strict();
async function executeOwner(
  ctx: ToolContext,
  lease: ExecutionLeaseRecord,
  runtimeChannel: Parameters<typeof ownerInputFromSession>[1] = {},
): Promise<ExecutionLeaseRecord["owner"]> {
  const runtime = getAgentBuilderRuntime();
  const resolved = await runtime.service.resolveOwner(ownerInputFromSession(ctx, runtimeChannel));
  if (!resolved.ok) throw new Error(resolved.error.code);
  if (!ownersEqual(resolved.owner, lease.owner)) throw new Error("OWNER_MISMATCH");
  return resolved.owner;
}

function roleControlTools(
  role: ExecutionRole,
  lease: ExecutionLeaseRecord,
  runtimeChannel: Parameters<typeof ownerInputFromSession>[1],
) {
  const runtime = getAgentBuilderRuntime();
  const draftGet = defineTool({
    description: "Read the exact owner-scoped draft bound to this lease.",
    inputSchema: emptySchema,
    execute: async (_input, ctx) => {
      await executeOwner(ctx, lease, runtimeChannel);
      return runtime.roles.readDraft(
        role as "pm" | "implementor" | "qa" | "test_runner",
        ownerInputFromSession(ctx, runtimeChannel),
        lease,
      );
    },
  });
  if (role === "pm") {
    return {
      agent_builder__draft_get: draftGet,
      agent_builder__pm_submit: defineTool({
        description:
          "Atomically submit PM-owned fields with a completed_handoff, needs_user_input, or failed outcome.",
        inputSchema: pmBuildSubmissionInputSchema,
        execute: async (submission, ctx) => {
          await executeOwner(ctx, lease, runtimeChannel);
          return runtime.workflow.submitPm(
            {
              ownerResolution: ownerInputFromSession(ctx, runtimeChannel),
              operationId: await scopedToolOperationId(ctx),
              childSessionId: ctx.session.id,
              executionTurnId: ctx.session.turn.id,
            },
            submission,
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
          runtime.roles.listCapabilityMetadata(ownerInputFromSession(ctx, runtimeChannel), lease),
      }),
      agent_builder__implementor_submit: defineTool({
        description:
          "Atomically submit implementation-owned instructions, capability requirements, and triggers with a typed handoff outcome.",
        inputSchema: implementorToolSubmissionSchema,
        execute: async (submission, ctx) => {
          await executeOwner(ctx, lease, runtimeChannel);
          return runtime.workflow.submitImplementor(
            {
              ownerResolution: ownerInputFromSession(ctx, runtimeChannel),
              operationId: await scopedToolOperationId(ctx),
              childSessionId: ctx.session.id,
              executionTurnId: ctx.session.turn.id,
            },
            submission,
          );
        },
      }),
    };
  }
  if (role === "qa") {
    return {
      agent_builder__draft_get: draftGet,
      agent_builder__qa_submit: defineTool({
        description:
          "Atomically submit QA-owned checklist/findings with needs_test, changes_requested, approved, needs_user_input, or failed.",
        inputSchema: qaBuildSubmissionInputSchema,
        execute: async (submission, ctx) => {
          await executeOwner(ctx, lease, runtimeChannel);
          return runtime.workflow.submitQa(
            {
              ownerResolution: ownerInputFromSession(ctx, runtimeChannel),
              operationId: await scopedToolOperationId(ctx),
              childSessionId: ctx.session.id,
              executionTurnId: ctx.session.turn.id,
            },
            submission,
          );
        },
      }),
    };
  }
  return role === "test_runner"
    ? {
        agent_builder__draft_get: draftGet,
        agent_builder__test_submit: defineTool({
          description:
            "Record minimal typed evidence for this exact isolated test run after selected capability steps finish.",
          inputSchema: recordBuildTestInputSchema,
          execute: async (result, ctx) => {
            await executeOwner(ctx, lease, runtimeChannel);
            return runtime.workflow.recordTestResult(
              {
                ownerResolution: ownerInputFromSession(ctx, runtimeChannel),
                operationId: await scopedToolOperationId(ctx),
                childSessionId: ctx.session.id,
                executionTurnId: ctx.session.turn.id,
              },
              result,
            );
          },
        }),
      }
    : {};
}

async function testStep(input: {
  readonly lease: ExecutionLeaseRecord;
  readonly capability: Parameters<typeof lowerResolvedCapabilities>[0][number];
  readonly owner: ExecutionLeaseRecord["owner"];
  readonly callId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly childSessionId: string;
  readonly executionTurnId: string;
}): Promise<TestPolicyResult<TestCapabilityStepScope>> {
  const workflow = input.lease.workflow;
  if (
    input.lease.role !== "test_runner" ||
    input.lease.target.kind !== "draft" ||
    workflow === undefined ||
    workflow.testRunId === undefined ||
    input.lease.executionTurnId !== input.executionTurnId
  ) {
    return {
      ok: false,
      error: { code: "WORKFLOW_CHANGED", message: "Exact test workflow is unavailable" },
    };
  }
  const selected = input.lease.capabilityPlan?.selected.find(
    (item) =>
      item.capabilityId === input.capability.descriptor.capabilityId &&
      item.modelToolName === input.capability.modelToolName &&
      item.schemaFingerprint === input.capability.descriptor.schemaFingerprint,
  );
  if (selected === undefined || input.lease.capabilityPlan?.mode !== "test") {
    return {
      ok: false,
      error: { code: "CAPABILITY_NOT_SELECTED", message: "Capability is not selected" },
    };
  }
  const identity = {
    owner: input.owner,
    workflowId: workflow.workflowId,
    workflowRevision: workflow.workflowRevision,
    testRunId: workflow.testRunId,
    agentId: input.lease.target.agentId,
    draftId: input.lease.target.draftId,
    draftRevision: input.lease.target.draftRevision,
    leaseId: input.lease.leaseId,
    childSessionId: input.childSessionId,
    executionTurnId: input.executionTurnId,
    capabilityId: input.capability.descriptor.capabilityId,
    schemaFingerprint: input.capability.descriptor.schemaFingerprint,
    modelToolName: input.toolName,
    callId: input.callId,
    toolInput: input.toolInput,
  } as const;
  return {
    ok: true,
    value: {
      owner: input.owner,
      workflowId: workflow.workflowId,
      workflowRevision: workflow.workflowRevision,
      testRunId: workflow.testRunId,
      agentId: input.lease.target.agentId,
      draftId: input.lease.target.draftId,
      draftRevision: input.lease.target.draftRevision,
      leaseId: input.lease.leaseId,
      childSessionId: input.childSessionId,
      executionTurnId: input.executionTurnId,
      capabilityId: input.capability.descriptor.capabilityId,
      schemaFingerprint: input.capability.descriptor.schemaFingerprint,
      modelToolName: input.toolName,
      callId: input.callId,
      stepFingerprint: await fingerprintTestStep(identity),
      expiresAt: input.lease.expiresAt,
    },
  };
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
        if (lease.bootstrapTurnId === turnId) {
          return null;
        }
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
          ...roleControlTools(input.role, prepared.value.lease, {
            ...(dynamicCtx.channel.kind === undefined
              ? {}
              : { kind: dynamicCtx.channel.kind }),
            ...(dynamicCtx.channel.metadata === undefined
              ? {}
              : { metadata: dynamicCtx.channel.metadata }),
          }),
          ...(input.role === "test_runner" || input.role === "active_runner"
            ? lowerResolvedCapabilities(
                prepared.value.capabilities.resolved,
                async (capability, ctx, toolInput) => {
                  const currentOwner = await executeOwner(ctx, prepared.value.lease, {
                    ...(dynamicCtx.channel.kind === undefined
                      ? {}
                      : { kind: dynamicCtx.channel.kind }),
                    ...(dynamicCtx.channel.metadata === undefined
                      ? {}
                      : { metadata: dynamicCtx.channel.metadata }),
                  });
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
                  if (input.role !== "test_runner") return;
                  const scoped = await testStep({
                    lease: authoritative,
                    capability,
                    owner: currentOwner,
                    callId: ctx.callId,
                    toolName: capability.modelToolName,
                    toolInput,
                    childSessionId: ctx.session.id,
                    executionTurnId: ctx.session.turn.id,
                  });
                  if (!scoped.ok) throw new Error(scoped.error.code);
                  const selected = authoritative.capabilityPlan?.selected.find(
                    (entry) => entry.capabilityId === capability.descriptor.capabilityId,
                  );
                  const started = await runtime.config.store.beginTestCapabilityExecution({
                    step: scoped.value,
                    consequential: selected?.consequential ?? true,
                    occurredAt,
                  });
                  if (!started.ok) throw new Error(started.error.code);
                  return {
                    complete: async (status: "succeeded" | "failed", errorCode?: string) => {
                      const completed = await runtime.config.store.completeTestCapabilityExecution({
                        owner: currentOwner,
                        workflowId: scoped.value.workflowId,
                        testRunId: scoped.value.testRunId,
                        leaseId: scoped.value.leaseId,
                        childSessionId: scoped.value.childSessionId,
                        executionTurnId: scoped.value.executionTurnId,
                        callId: scoped.value.callId,
                        status,
                        occurredAt: runtimeTimestamp(runtime),
                        ...(errorCode === undefined ? {} : { errorCode }),
                      });
                      if (!completed.ok) throw new Error(completed.error.code);
                    },
                  };
                },
                input.role !== "test_runner"
                  ? undefined
                  : (capability, hostApproval) => {
                      const selected = prepared.value.lease.capabilityPlan?.selected.find(
                        (entry) => entry.capabilityId === capability.descriptor.capabilityId,
                      );
                      if (selected?.consequential !== true) return hostApproval;
                      const resolveRequestOwner = async (ctx: ApprovalContext<unknown>) => {
                        const resolved = await runtime.service.resolveOwner(
                          ownerInputFromSession(ctx, {
                            ...(dynamicCtx.channel.kind === undefined
                              ? {}
                              : { kind: dynamicCtx.channel.kind }),
                            ...(dynamicCtx.channel.metadata === undefined
                              ? {}
                              : { metadata: dynamicCtx.channel.metadata }),
                          }),
                        );
                        return resolved.ok && ownersEqual(resolved.owner, prepared.value.owner)
                          ? resolved.owner
                          : null;
                      };
                      const requestStep = async (ctx: ApprovalContext<unknown>) => {
                        const approvedOwner = await resolveRequestOwner(ctx);
                        return approvedOwner === null
                          ? ({
                              ok: false,
                              error: { code: "OWNER_MISMATCH", message: "Approval owner changed" },
                            } as const)
                          : testStep({
                              lease: prepared.value.lease,
                              capability,
                              owner: approvedOwner,
                              callId: ctx.callId,
                              toolName: ctx.toolName,
                              toolInput: ctx.toolInput,
                              childSessionId: ctx.session.id,
                              executionTurnId: ctx.session.turn.id,
                            });
                      };
                      const responseStep = async (ctx: ApprovalResponseContext<unknown>) => {
                        const resolved = await runtime.service.resolveOwner({
                          current: ctx.responder,
                          initiator: ctx.session.initiator,
                          channel: {
                            ...(dynamicCtx.channel.kind === undefined
                              ? {}
                              : { kind: dynamicCtx.channel.kind }),
                            ...(dynamicCtx.channel.metadata === undefined
                              ? {}
                              : { metadata: dynamicCtx.channel.metadata }),
                          },
                        });
                        return !resolved.ok || !ownersEqual(resolved.owner, prepared.value.owner)
                          ? ({
                              ok: false,
                              error: { code: "OWNER_MISMATCH", message: "Responder owner changed" },
                            } as const)
                          : testStep({
                              lease: prepared.value.lease,
                              capability,
                              owner: resolved.owner,
                              callId: ctx.request.callId,
                              toolName: ctx.request.toolName,
                              toolInput: ctx.request.toolInput,
                              childSessionId: ctx.session.id,
                              executionTurnId: ctx.session.turn.id,
                            });
                      };
                      return composeConsequentialTestApproval({
                        ...(hostApproval === undefined ? {} : { hostApproval }),
                        getStep: requestStep,
                        getResponseStep: responseStep,
                        ...(runtime.config.verifiedTestInputPolicy === undefined
                          ? {}
                          : { inputPolicy: runtime.config.verifiedTestInputPolicy }),
                        authorize: async (step, ctx) =>
                          runtime.config.store.authorizeTestInput({
                            step,
                            requestId: ctx.request.requestId,
                            responder: {
                              principalId: ctx.responder.principalId,
                              principalType: ctx.responder.principalType,
                            },
                            occurredAt: runtimeTimestamp(runtime),
                          }),
                      });
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
