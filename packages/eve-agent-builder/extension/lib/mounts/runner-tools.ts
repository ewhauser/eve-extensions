import {
  defineDynamic,
  defineTool,
  type DynamicToolEntry,
  type DynamicToolSet,
  type ToolContext,
  type ToolDefinition,
} from "eve/tools";
import type {
  Approval,
  ApprovalContext,
  ApprovalResponseContext,
  ApprovalStatus,
} from "eve/tools/approval";
import { z } from "zod";

import {
  type ResolvedRunnerCapability,
  type RunnerCapabilityDescriptor,
  type RunnerCapabilityMode,
} from "../capabilities.js";
import {
  bootstrapTargetsEqual,
  parseBootstrapMessage,
  type ExecutionLeaseRecord,
  type ExecutionRole,
} from "../bootstrap.js";
import {
  fingerprintTestStep,
  type TestCapabilityStepScope,
  type TestPolicyResult,
} from "../test-policy.js";
import {
  pmBuildSubmissionInputSchema,
  qaBuildSubmissionInputSchema,
  recordBuildTestInputSchema,
} from "../workflow-service.js";
import {
  ownerChannelFromContext,
  ownerInputFromSession,
  ownersEqual,
} from "../runtime/owner.js";
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
  const draftGet = defineTool({
    description: "Read the exact owner-scoped draft bound to this lease.",
    inputSchema: emptySchema,
    execute: async (_input, ctx) => {
      await executeOwner(ctx, lease, runtimeChannel);
      return getAgentBuilderRuntime().roles.readDraft(
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
          return getAgentBuilderRuntime().workflow.submitPm(
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
        execute: async (_input, ctx) => {
          await executeOwner(ctx, lease, runtimeChannel);
          return getAgentBuilderRuntime().roles.listCapabilityMetadata(
            ownerInputFromSession(ctx, runtimeChannel),
            lease,
          );
        },
      }),
      agent_builder__implementor_submit: defineTool({
        description:
          "Atomically submit implementation-owned instructions, capability requirements, and triggers with a typed handoff outcome.",
        inputSchema: implementorToolSubmissionSchema,
        execute: async (submission, ctx) => {
          await executeOwner(ctx, lease, runtimeChannel);
          return getAgentBuilderRuntime().workflow.submitImplementor(
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
          return getAgentBuilderRuntime().workflow.submitQa(
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
            return getAgentBuilderRuntime().workflow.recordTestResult(
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
  readonly capability: Pick<ResolvedRunnerCapability, "descriptor" | "modelToolName">;
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

interface DurableCapabilityReference {
  readonly descriptor: RunnerCapabilityDescriptor;
  readonly modelToolName: string;
  readonly mode: RunnerCapabilityMode;
  readonly consequential: boolean;
}

async function resolveDurableCapability(
  owner: ExecutionLeaseRecord["owner"],
  reference: DurableCapabilityReference,
): Promise<ResolvedRunnerCapability> {
  const prepared = await getAgentBuilderRuntime().capabilities.prepare({
    owner,
    requirements: [
      {
        capabilityId: reference.descriptor.capabilityId,
        level: "required",
        displayNameSnapshot: reference.descriptor.displayName,
        schemaFingerprint: reference.descriptor.schemaFingerprint,
        consequential: reference.consequential,
      },
    ],
    mode: reference.mode,
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  const capability = prepared.value.resolved[0];
  const selected = prepared.value.plan.selected[0];
  if (
    capability === undefined ||
    selected === undefined ||
    prepared.value.resolved.length !== 1 ||
    prepared.value.plan.selected.length !== 1 ||
    capability.descriptor.capabilityId !== reference.descriptor.capabilityId ||
    capability.descriptor.schemaFingerprint !== reference.descriptor.schemaFingerprint ||
    capability.modelToolName !== reference.modelToolName ||
    selected.modelToolName !== reference.modelToolName ||
    selected.schemaFingerprint !== reference.descriptor.schemaFingerprint
  ) {
    throw new Error("CAPABILITY_SCHEMA_CHANGED");
  }
  return capability;
}

function approvalDenied(status: ApprovalStatus | undefined): boolean {
  return (
    status === false ||
    status === "denied" ||
    (typeof status === "object" && status !== null && status.type === "denied")
  );
}

function approvalRequestPolicy(approval: Approval<unknown> | undefined) {
  if (approval === undefined) return undefined;
  return typeof approval === "function" ? approval : approval.request;
}

function approvalResponsePolicy(approval: Approval<unknown> | undefined) {
  return typeof approval === "object" && approval !== null
    ? approval.response
    : undefined;
}

async function approvalOwner(
  ctx: ApprovalContext<unknown>,
  lease: ExecutionLeaseRecord,
  runtimeChannel: Parameters<typeof ownerInputFromSession>[1],
) {
  const resolved = await getAgentBuilderRuntime().service.resolveOwner(
    ownerInputFromSession(ctx, runtimeChannel),
  );
  return resolved.ok && ownersEqual(resolved.owner, lease.owner)
    ? resolved.owner
    : null;
}

async function requestDurableCapabilityApproval(input: {
  readonly reference: DurableCapabilityReference;
  readonly lease: ExecutionLeaseRecord;
  readonly role: ExecutionRole;
  readonly runtimeChannel: Parameters<typeof ownerInputFromSession>[1];
  readonly ctx: ApprovalContext<unknown>;
}): Promise<ApprovalStatus> {
  const owner = await approvalOwner(input.ctx, input.lease, input.runtimeChannel);
  if (owner === null) return { type: "denied", reason: "OWNER_MISMATCH" };
  const capability = await resolveDurableCapability(owner, input.reference);
  const hostApproval = capability.tool.approval as Approval<unknown> | undefined;
  const original = await approvalRequestPolicy(hostApproval)?.(input.ctx);
  if (approvalDenied(original)) return original!;
  if (input.role !== "test_runner" || !input.reference.consequential) {
    return original ?? "not-applicable";
  }
  const step = await testStep({
    lease: input.lease,
    capability: input.reference,
    owner,
    callId: input.ctx.callId,
    toolName: input.ctx.toolName,
    toolInput: input.ctx.toolInput,
    childSessionId: input.ctx.session.id,
    executionTurnId: input.ctx.session.turn.id,
  });
  if (!step.ok) return { type: "denied", reason: step.error.code };
  const inputPolicy = getAgentBuilderRuntime().config.verifiedTestInputPolicy;
  if (inputPolicy === undefined) return { type: "denied", reason: "INPUT_UNAVAILABLE" };
  try {
    const availability = await inputPolicy.availability(step.value);
    return availability.status === "available"
      ? "user-approval"
      : { type: "denied", reason: availability.code };
  } catch {
    return { type: "denied", reason: "INPUT_UNAVAILABLE" };
  }
}

async function respondDurableCapabilityApproval(input: {
  readonly reference: DurableCapabilityReference;
  readonly lease: ExecutionLeaseRecord;
  readonly role: ExecutionRole;
  readonly runtimeChannel: Parameters<typeof ownerInputFromSession>[1];
  readonly ctx: ApprovalResponseContext<unknown>;
}) {
  const runtime = getAgentBuilderRuntime();
  const resolved = await runtime.service.resolveOwner({
    current: input.ctx.responder,
    initiator: input.ctx.session.initiator,
    channel: input.runtimeChannel,
  });
  if (!resolved.ok || !ownersEqual(resolved.owner, input.lease.owner)) {
    return { status: "rejected" as const, reason: "OWNER_MISMATCH" };
  }
  const capability = await resolveDurableCapability(resolved.owner, input.reference);
  const hostApproval = capability.tool.approval as Approval<unknown> | undefined;
  const hostResponse = approvalResponsePolicy(hostApproval);
  if (hostResponse !== undefined) {
    const original = await hostResponse(input.ctx);
    if (original.status === "rejected") return original;
  }
  if (input.role !== "test_runner" || !input.reference.consequential) {
    return { status: "allowed" as const };
  }
  const step = await testStep({
    lease: input.lease,
    capability: input.reference,
    owner: resolved.owner,
    callId: input.ctx.request.callId,
    toolName: input.ctx.request.toolName,
    toolInput: input.ctx.request.toolInput,
    childSessionId: input.ctx.session.id,
    executionTurnId: input.ctx.session.turn.id,
  });
  if (!step.ok) return { status: "rejected" as const, reason: step.error.code };
  const inputPolicy = runtime.config.verifiedTestInputPolicy;
  if (inputPolicy?.authorizeResponse !== undefined) {
    const decision = await inputPolicy.authorizeResponse({
      step: step.value,
      response: input.ctx,
    });
    if (decision.status === "rejected") return decision;
  }
  const authorized = await runtime.config.store.authorizeTestInput({
    step: step.value,
    requestId: input.ctx.request.requestId,
    responder: {
      principalId: input.ctx.responder.principalId,
      principalType: input.ctx.responder.principalType,
    },
    occurredAt: runtimeTimestamp(runtime),
  });
  return authorized.ok
    ? { status: "allowed" as const }
    : { status: "rejected" as const, reason: authorized.error.code };
}

async function executeDurableCapability(input: {
  readonly reference: DurableCapabilityReference;
  readonly lease: ExecutionLeaseRecord;
  readonly role: ExecutionRole;
  readonly runtimeChannel: Parameters<typeof ownerInputFromSession>[1];
  readonly toolInput: unknown;
  readonly ctx: ToolContext;
}) {
  const currentOwner = await executeOwner(input.ctx, input.lease, input.runtimeChannel);
  const runtime = getAgentBuilderRuntime();
  const authoritative = await runtime.config.store.getExecutionLease({
    owner: currentOwner,
    childSessionId: input.ctx.session.id,
  });
  if (
    authoritative === null ||
    authoritative.leaseId !== input.lease.leaseId ||
    authoritative.status !== "running" ||
    authoritative.executionTurnId !== input.ctx.session.turn.id ||
    !bootstrapTargetsEqual(authoritative.target, input.lease.target) ||
    !authoritative.capabilityPlan?.selected.some(
      (entry) =>
        entry.capabilityId === input.reference.descriptor.capabilityId &&
        entry.modelToolName === input.reference.modelToolName &&
        entry.schemaFingerprint === input.reference.descriptor.schemaFingerprint,
    )
  ) {
    throw new Error("LEASE_CLOSED");
  }
  const occurredAt = runtimeTimestamp(runtime);
  if (Date.parse(occurredAt) >= Date.parse(authoritative.expiresAt)) {
    await runtime.bootstrap.closeExecution({
      owner: currentOwner,
      childSessionId: input.ctx.session.id,
      executionTurnId: input.ctx.session.turn.id,
      status: "failed",
      occurredAt,
      terminalCode: "LEASE_EXPIRED",
    });
    throw new Error("LEASE_EXPIRED");
  }
  let step: TestCapabilityStepScope | undefined;
  if (input.role === "test_runner") {
    const scoped = await testStep({
      lease: authoritative,
      capability: input.reference,
      owner: currentOwner,
      callId: input.ctx.callId,
      toolName: input.reference.modelToolName,
      toolInput: input.toolInput,
      childSessionId: input.ctx.session.id,
      executionTurnId: input.ctx.session.turn.id,
    });
    if (!scoped.ok) throw new Error(scoped.error.code);
    step = scoped.value;
    const selected = authoritative.capabilityPlan?.selected.find(
      (entry) => entry.capabilityId === input.reference.descriptor.capabilityId,
    );
    const started = await runtime.config.store.beginTestCapabilityExecution({
      step,
      consequential: selected?.consequential ?? true,
      occurredAt,
    });
    if (!started.ok) throw new Error(started.error.code);
  }
  const capability = await resolveDurableCapability(currentOwner, input.reference);
  try {
    const result = await capability.tool.execute.call(
      capability.tool,
      input.toolInput,
      input.ctx,
    );
    if (step !== undefined) {
      const completed = await runtime.config.store.completeTestCapabilityExecution({
        owner: currentOwner,
        workflowId: step.workflowId,
        testRunId: step.testRunId,
        leaseId: step.leaseId,
        childSessionId: step.childSessionId,
        executionTurnId: step.executionTurnId,
        callId: step.callId,
        status: "succeeded",
        occurredAt: runtimeTimestamp(runtime),
      });
      if (!completed.ok) throw new Error(completed.error.code);
    }
    return result;
  } catch (error) {
    if (step !== undefined) {
      const completed = await runtime.config.store.completeTestCapabilityExecution({
        owner: currentOwner,
        workflowId: step.workflowId,
        testRunId: step.testRunId,
        leaseId: step.leaseId,
        childSessionId: step.childSessionId,
        executionTurnId: step.executionTurnId,
        callId: step.callId,
        status: "failed",
        occurredAt: runtimeTimestamp(runtime),
        errorCode:
          error instanceof Error && error.name.length > 0
            ? error.name
            : "CAPABILITY_EXECUTION_FAILED",
      });
      if (!completed.ok) throw new Error(completed.error.code);
    }
    throw error;
  }
}

async function projectDurableCapabilityOutput(
  reference: DurableCapabilityReference,
  owner: ExecutionLeaseRecord["owner"],
  output: unknown,
) {
  const capability = await resolveDurableCapability(owner, reference);
  const project = capability.tool.toModelOutput;
  return typeof project === "function"
    ? project.call(capability.tool, output)
    : { type: "json" as const, value: output === undefined ? null : output };
}

function lowerDurableCapabilities(input: {
  readonly capabilities: readonly ResolvedRunnerCapability[];
  readonly lease: ExecutionLeaseRecord;
  readonly role: ExecutionRole;
  readonly mode: RunnerCapabilityMode;
  readonly runtimeChannel: Parameters<typeof ownerInputFromSession>[1];
}): DynamicToolSet {
  const lease = input.lease;
  const role = input.role;
  const mode = input.mode;
  const runtimeChannel = input.runtimeChannel;
  const selectedById = new Map(
    lease.capabilityPlan?.selected.map((entry) => [entry.capabilityId, entry]) ?? [],
  );
  const lowered: Record<string, DynamicToolEntry<any, any>> = {};
  for (const capability of input.capabilities) {
    const selected = selectedById.get(capability.descriptor.capabilityId);
    if (
      selected === undefined ||
      selected.modelToolName !== capability.modelToolName ||
      selected.schemaFingerprint !== capability.descriptor.schemaFingerprint
    ) {
      throw new Error("CAPABILITY_NOT_SELECTED");
    }
    const reference: DurableCapabilityReference = {
      descriptor: capability.descriptor,
      modelToolName: capability.modelToolName,
      mode,
      consequential: selected.consequential,
    };
    const tool = capability.tool;
    lowered[reference.modelToolName] = defineTool({
      description: tool.description,
      inputSchema: tool.inputSchema as ToolDefinition<any, any>["inputSchema"],
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: tool.outputSchema as ToolDefinition<any, any>["outputSchema"] }),
      approval: {
        request: async (ctx) =>
          requestDurableCapabilityApproval({
            reference,
            lease,
            role,
            runtimeChannel,
            ctx,
          }),
        response: async (ctx) =>
          respondDurableCapabilityApproval({
            reference,
            lease,
            role,
            runtimeChannel,
            ctx,
          }),
      },
      toModelOutput: async (output) =>
        projectDurableCapabilityOutput(reference, lease.owner, output),
      execute: async (toolInput, ctx) =>
        executeDurableCapability({
          reference,
          lease,
          role,
          runtimeChannel,
          toolInput,
          ctx,
        }),
    } as ToolDefinition<any, any>) as DynamicToolEntry<any, any>;
  }
  return Object.freeze(lowered);
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
        const runtimeChannel = ownerChannelFromContext(dynamicCtx.channel);
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
                const redeemRuntime = getAgentBuilderRuntime();
                const resolved = await redeemRuntime.service.resolveOwner(
                  ownerInputFromSession(toolCtx, runtimeChannel),
                );
                if (!resolved.ok) throw new Error(resolved.error.code);
                if (!ownersEqual(resolved.owner, owner)) throw new Error("OWNER_MISMATCH");
                return redeemRuntime.bootstrap.redeem({
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
        const runnerLease = prepared.value.lease;
        const capabilityOmissions = prepared.value.capabilities.plan.optionalOmissions;
        const contextTool = defineTool({
          description: "Return the immutable, non-secret identity of this single leased run.",
          inputSchema: emptySchema,
          execute: async (_empty, ctx) => {
            await executeOwner(ctx, runnerLease, runtimeChannel);
            return {
              leaseId: runnerLease.leaseId,
              role: runnerLease.role,
              target: runnerLease.target,
              capabilityOmissions,
            };
          },
        });
        return {
          ...roleControlTools(input.role, runnerLease, runtimeChannel),
          ...(input.role === "test_runner" || input.role === "active_runner"
            ? lowerDurableCapabilities({
                capabilities: prepared.value.capabilities.resolved,
                lease: runnerLease,
                role: input.role,
                mode: input.mode,
                runtimeChannel,
              })
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
