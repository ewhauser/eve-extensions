import type { DynamicResolveContext, DynamicToolSet } from "eve/tools";

import { getAgentBuilderConfig, type AgentBuilderExtensionConfig } from "../../extension.js";
import {
  createRunnerCapabilityService,
  type CapabilityPreparation,
  type RunnerCapabilityMode,
  type RunnerCapabilityService,
} from "../capabilities.js";
import {
  createBootstrapService,
  type BootstrapResult,
  type ExecutionLeaseRecord,
  type ExecutionRole,
} from "../bootstrap.js";
import { createAgentDiscoveryService, type AgentDiscoveryService } from "../discovery.js";
import {
  timestampSchema,
  type OwnerScope,
  type PublishedAgentVersion,
  type SavedAgentDraft,
  type Timestamp,
} from "../domain.js";
import { createRoleScopedAgentBuilderService, type RoleScopedAgentBuilderService } from "../roles.js";
import {
  createAgentBuilderService,
  fingerprintMutationRequest,
  type AgentBuilderService,
} from "../service.js";
import {
  createBuildWorkflowCoordinator,
  type BuildWorkflowCoordinator,
} from "../workflow-service.js";
import { ownerCacheKey, ownerInputFromDynamic } from "./owner.js";

export interface PreparedRunnerTurn {
  readonly owner: OwnerScope;
  readonly lease: ExecutionLeaseRecord;
  readonly saved: SavedAgentDraft | PublishedAgentVersion;
  readonly capabilities: CapabilityPreparation;
}

export interface AgentBuilderRuntime {
  readonly config: AgentBuilderExtensionConfig;
  readonly service: AgentBuilderService;
  readonly bootstrap: ReturnType<typeof createBootstrapService>;
  readonly capabilities: RunnerCapabilityService;
  readonly discovery: AgentDiscoveryService;
  readonly roles: RoleScopedAgentBuilderService;
  readonly workflow: BuildWorkflowCoordinator;
}

const runtimes = new WeakMap<object, AgentBuilderRuntime>();
const preparedTurnsByRuntime = new WeakMap<
  AgentBuilderRuntime,
  Map<string, BootstrapResult<PreparedRunnerTurn>>
>();

function preparedTurns(runtime: AgentBuilderRuntime): Map<string, BootstrapResult<PreparedRunnerTurn>> {
  let turns = preparedTurnsByRuntime.get(runtime);
  if (turns === undefined) {
    turns = new Map();
    preparedTurnsByRuntime.set(runtime, turns);
  }
  return turns;
}

export function getAgentBuilderRuntime(): AgentBuilderRuntime {
  const config = getAgentBuilderConfig();
  const existing = runtimes.get(config.store as object);
  if (existing !== undefined) return existing;
  const service = createAgentBuilderService({
    store: config.store,
    resolveOwner: config.resolveOwner,
    ...(config.clock === undefined ? {} : { clock: config.clock }),
    ...(config.serviceIds === undefined ? {} : { ids: config.serviceIds }),
    ...(config.maxAgentFamiliesPerOwner === undefined
      ? {}
      : { maxAgentFamiliesPerOwner: config.maxAgentFamiliesPerOwner }),
  });
  const capabilities = createRunnerCapabilityService(config.capabilities);
  const bootstrap = createBootstrapService({
    store: config.store,
    ...(config.clock === undefined ? {} : { clock: config.clock }),
    ...(config.bootstrapIds === undefined ? {} : { ids: config.bootstrapIds }),
    ...(config.tokenSource === undefined ? {} : { tokenSource: config.tokenSource }),
    ...(config.maxBootstrapGrantTtlMs === undefined
      ? {}
      : { maxGrantTtlMs: config.maxBootstrapGrantTtlMs }),
    ...(config.executionLeaseTtlMs === undefined
      ? {}
      : { executionLeaseTtlMs: config.executionLeaseTtlMs }),
  });
  const runtime: AgentBuilderRuntime = Object.freeze({
    config,
    service,
    bootstrap,
    capabilities,
    discovery: createAgentDiscoveryService({
      store: config.store,
      maxRosterEntries: config.maxRosterEntries,
      maxRosterCharacters: config.maxRosterCharacters,
    }),
    roles: createRoleScopedAgentBuilderService({
      service,
      capabilities,
      store: config.store,
      ...(config.clock === undefined ? {} : { clock: config.clock }),
    }),
    workflow: createBuildWorkflowCoordinator({
      store: config.store,
      resolveOwner: config.resolveOwner,
      bootstrap,
      ...(config.clock === undefined ? {} : { clock: config.clock }),
      ...(config.workflowIds === undefined ? {} : { ids: config.workflowIds }),
      ...(config.maxAgentFamiliesPerOwner === undefined
        ? {}
        : { maxAgentFamiliesPerOwner: config.maxAgentFamiliesPerOwner }),
    }),
  });
  runtimes.set(config.store as object, runtime);
  return runtime;
}

export function runtimeTimestamp(runtime: AgentBuilderRuntime): Timestamp {
  return timestampSchema.parse(runtime.config.clock?.now() ?? new Date().toISOString());
}

/**
 * Eve tool-call IDs are only meaningful inside their session/turn. Persist a
 * compact trusted identity over the complete execution scope so two fresh
 * children may safely reuse the same model-authored call ID.
 */
export function scopedToolOperationId(
  ctx: Pick<import("eve/tools").ToolContext, "callId" | "session">,
): Promise<string> {
  return fingerprintMutationRequest({
    sessionId: ctx.session.id,
    turnId: ctx.session.turn.id,
    callId: ctx.callId,
    schema: "eve-tool-operation-v1",
  });
}

export function eventTurnId(event: unknown): string {
  if (typeof event !== "object" || event === null) throw new Error("EVE_TURN_CONTEXT_REQUIRED");
  const data = (event as Record<string, unknown>).data;
  const turnId =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>).turnId
      : undefined;
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw new Error("EVE_TURN_CONTEXT_REQUIRED");
  }
  return turnId;
}

export async function resolveDynamicOwner(
  runtime: AgentBuilderRuntime,
  ctx: DynamicResolveContext,
): Promise<OwnerScope> {
  const resolved = await runtime.service.resolveOwner(ownerInputFromDynamic(ctx));
  if (!resolved.ok) throw new Error(resolved.error.code);
  return resolved.owner;
}

function preparedKey(owner: OwnerScope, childSessionId: string, turnId: string): string {
  return `${ownerCacheKey(owner)}\u0000${childSessionId}\u0000${turnId}`;
}

async function loadSaved(
  runtime: AgentBuilderRuntime,
  lease: ExecutionLeaseRecord,
): Promise<SavedAgentDraft | PublishedAgentVersion | null> {
  if (lease.target.kind === "draft") {
    const family = await runtime.config.store.getFamily({
      owner: lease.owner,
      agentId: lease.target.agentId,
    });
    return family?.draft?.draftId === lease.target.draftId &&
      family.draft.draftRevision === lease.target.draftRevision
      ? family.draft
      : null;
  }
  return runtime.config.store.getVersion({
    owner: lease.owner,
    agentId: lease.target.agentId,
    specId: lease.target.specId,
    version: lease.target.specVersion,
  });
}

export async function inspectRunnerTurn(input: {
  readonly role: ExecutionRole;
  readonly mode: RunnerCapabilityMode;
  readonly event: unknown;
  readonly ctx: DynamicResolveContext;
  readonly begin: boolean;
}): Promise<BootstrapResult<PreparedRunnerTurn>> {
  const runtime = getAgentBuilderRuntime();
  const owner = await resolveDynamicOwner(runtime, input.ctx);
  const turnId = eventTurnId(input.event);
  const key = preparedKey(owner, input.ctx.session.id, turnId);
  const turns = preparedTurns(runtime);
  const cached = turns.get(key);
  if (cached !== undefined) {
    if (!cached.ok || !input.begin || cached.value.lease.status === "running") return cached;
    const claimed = await runtime.bootstrap.beginExecution({
      owner,
      childSessionId: input.ctx.session.id,
      executionTurnId: turnId,
      occurredAt: runtimeTimestamp(runtime),
      capabilityPlan: cached.value.capabilities.plan,
    });
    if (!claimed.ok) {
      const failed = { ok: false, error: claimed.error } as const;
      turns.set(key, failed);
      return failed;
    }
    const running = {
      ok: true,
      value: Object.freeze({ ...cached.value, lease: claimed.value }),
    } as const;
    turns.set(key, running);
    return running;
  }
  const leaseResult = await runtime.bootstrap.getLease({
    owner,
    childSessionId: input.ctx.session.id,
  });
  if (!leaseResult.ok) {
    turns.set(key, leaseResult);
    return leaseResult;
  }
  if (leaseResult.value.role !== input.role) {
    const failed = {
      ok: false,
      error: { code: "BOOTSTRAP_BINDING_MISMATCH", message: "Runner role does not match lease" },
    } as const;
    turns.set(key, failed);
    return failed;
  }
  if (leaseResult.value.bootstrapTurnId === turnId) {
    const failed = {
      ok: false,
      error: { code: "LEASE_NOT_READY", message: "Bootstrap turn cannot execute a saved task" },
    } as const;
    turns.set(key, failed);
    return failed;
  }
  const saved = await loadSaved(runtime, leaseResult.value);
  if (saved === null) {
    const failed = {
      ok: false,
      error: { code: "TARGET_CHANGED", message: "The exact leased target is unavailable" },
    } as const;
    turns.set(key, failed);
    return failed;
  }
  const capabilityResult = await runtime.capabilities.prepare({
    owner,
    requirements:
      input.role === "test_runner" || input.role === "active_runner"
        ? saved.toolRequirements
        : [],
    mode: input.mode,
  });
  if (!capabilityResult.ok) {
    const failed = { ok: false, error: capabilityResult.error } as const;
    turns.set(key, failed);
    return failed;
  }
  const claimed = input.begin
    ? await runtime.bootstrap.beginExecution({
        owner,
        childSessionId: input.ctx.session.id,
        executionTurnId: turnId,
        occurredAt: runtimeTimestamp(runtime),
        capabilityPlan: capabilityResult.value.plan,
      })
    : leaseResult;
  if (!claimed.ok) {
    turns.set(key, claimed);
    return claimed;
  }
  const value: PreparedRunnerTurn = Object.freeze({
    owner,
    lease: claimed.value,
    saved,
    capabilities: capabilityResult.value,
  });
  const prepared = { ok: true, value } as const;
  turns.set(key, prepared);
  return prepared;
}

export async function cachedRunnerTurn(input: {
  readonly role: ExecutionRole;
  readonly mode: RunnerCapabilityMode;
  readonly event: unknown;
  readonly ctx: DynamicResolveContext;
}): Promise<BootstrapResult<PreparedRunnerTurn>> {
  const runtime = getAgentBuilderRuntime();
  const owner = await resolveDynamicOwner(runtime, input.ctx);
  const turnId = eventTurnId(input.event);
  const cached = preparedTurns(runtime).get(preparedKey(owner, input.ctx.session.id, turnId));
  return cached === undefined
    ? inspectRunnerTurn({ ...input, begin: false })
    : cached;
}

export function clearPreparedRunnerTurn(
  runtime: AgentBuilderRuntime,
  owner: OwnerScope,
  childSessionId: string,
  turnId: string,
): void {
  preparedTurnsByRuntime
    .get(runtime)
    ?.delete(preparedKey(owner, childSessionId, turnId));
}

export type LoweredRunnerTools = DynamicToolSet;
