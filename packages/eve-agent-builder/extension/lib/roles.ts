import { z } from "zod";

import type { RunnerCapabilityDescriptor, RunnerCapabilityService } from "./capabilities.js";
import {
  bootstrapTargetsEqual,
  type ExecutionLeaseRecord,
  type ExecutionRole,
} from "./bootstrap.js";
import {
  savedAgentKindSchema,
  savedToolRequirementSchema,
  savedTriggerDefinitionSchema,
  type SavedAgentFamily,
  type SavedToolRequirement,
  type SavedTriggerDefinition,
} from "./domain.js";
import type {
  AgentBuilderClock,
  AgentBuilderMutationContext,
  AgentBuilderResult,
  AgentBuilderService,
} from "./service.js";
import type { AgentBuilderStoreMutationSuccess } from "./store.js";
import type { AgentBuilderStore } from "./store.js";

export type AgentBuilderRoleOperation =
  | "draft_create"
  | "workflow_allocate"
  | "workflow_reopen"
  | "bootstrap_issue"
  | "draft_read"
  | "pm_patch"
  | "implementor_patch"
  | "qa_patch"
  | "pm_submit"
  | "implementor_submit"
  | "qa_submit"
  | "test_submit"
  | "capability_metadata"
  | "capability_execute"
  | "test_request"
  | "publish"
  | "activate"
  | "archive"
  | "restore"
  | "delete"
  | "provision"
  | "agent_discovery";

const ALL_OPERATIONS: readonly AgentBuilderRoleOperation[] = Object.freeze([
  "draft_create",
  "workflow_allocate",
  "workflow_reopen",
  "bootstrap_issue",
  "draft_read",
  "pm_patch",
  "implementor_patch",
  "qa_patch",
  "pm_submit",
  "implementor_submit",
  "qa_submit",
  "test_submit",
  "capability_metadata",
  "capability_execute",
  "test_request",
  "publish",
  "activate",
  "archive",
  "restore",
  "delete",
  "provision",
  "agent_discovery",
]);

export const agentBuilderRoleOperations = ALL_OPERATIONS;

export const rolePermissionMatrix: Readonly<
  Record<ExecutionRole | "root", ReadonlySet<AgentBuilderRoleOperation>>
> = Object.freeze({
  root: new Set<AgentBuilderRoleOperation>([
    "draft_create",
    "workflow_allocate",
    "workflow_reopen",
    "bootstrap_issue",
    "agent_discovery",
    "test_request",
    "publish",
    "activate",
    "archive",
    "restore",
    "delete",
  ]),
  pm: new Set<AgentBuilderRoleOperation>(["draft_read", "pm_patch", "pm_submit"]),
  implementor: new Set<AgentBuilderRoleOperation>([
    "draft_read",
    "implementor_patch",
    "implementor_submit",
    "capability_metadata",
  ]),
  qa: new Set<AgentBuilderRoleOperation>([
    "draft_read",
    "qa_patch",
    "qa_submit",
    "test_request",
  ]),
  test_runner: new Set<AgentBuilderRoleOperation>([
    "draft_read",
    "capability_execute",
    "test_submit",
  ]),
  active_runner: new Set<AgentBuilderRoleOperation>(["capability_execute"]),
});

export function roleMayPerform(
  role: ExecutionRole | "root",
  operation: AgentBuilderRoleOperation,
): boolean {
  return rolePermissionMatrix[role].has(operation);
}

export interface PmDraftPatch {
  readonly name?: string;
  readonly kind?: "agent" | "skill";
  readonly description?: string;
  /** PM-owned requirements are encoded in the reviewed `pmBrief` field. */
  readonly pmBrief?: string;
}

export interface ImplementorDraftPatch {
  readonly instructions?: string;
  readonly toolRequirements?: readonly SavedToolRequirement[];
  readonly triggers?: readonly SavedTriggerDefinition[];
}

export interface QaDraftPatch {
  readonly testChecklist?: readonly string[];
  readonly qaFindings?: readonly string[];
}

const pmPatchSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    kind: savedAgentKindSchema.optional(),
    description: z.string().max(8_000).optional(),
    pmBrief: z.string().max(32_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Patch must not be empty");

const implementorPatchSchema = z
  .object({
    instructions: z.string().max(128_000).optional(),
    toolRequirements: z.array(savedToolRequirementSchema).max(256).readonly().optional(),
    triggers: z.array(savedTriggerDefinitionSchema).max(256).readonly().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Patch must not be empty");

const qaPatchSchema = z
  .object({
    testChecklist: z.array(z.string().min(1).max(4_000)).max(256).readonly().optional(),
    qaFindings: z.array(z.string().min(1).max(8_000)).max(256).readonly().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Patch must not be empty");

export type RoleServiceError = Readonly<{
  readonly code:
    | "ROLE_FORBIDDEN"
    | "BOOTSTRAP_REQUIRED"
    | "OWNER_MISMATCH"
    | "TARGET_CHANGED"
    | "INVALID_INPUT";
  readonly message: string;
}>;

export type RoleServiceResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: RoleServiceError }
  | AgentBuilderResult<Value>;

export interface RoleMutationInput {
  readonly lease: ExecutionLeaseRecord;
  readonly mutationContext: AgentBuilderMutationContext;
}

export class RoleScopedAgentBuilderService {
  readonly #service: AgentBuilderService;
  readonly #capabilities: RunnerCapabilityService;
  readonly #store: AgentBuilderStore;
  readonly #clock: AgentBuilderClock;

  constructor(input: {
    readonly service: AgentBuilderService;
    readonly capabilities: RunnerCapabilityService;
    readonly store: AgentBuilderStore;
    readonly clock?: AgentBuilderClock;
  }) {
    this.#service = input.service;
    this.#capabilities = input.capabilities;
    this.#store = input.store;
    this.#clock = input.clock ?? { now: () => new Date().toISOString() };
  }

  async readDraft(
    role: Extract<ExecutionRole, "pm" | "implementor" | "qa" | "test_runner">,
    ownerInput: unknown,
    lease: ExecutionLeaseRecord,
  ): Promise<RoleServiceResult<SavedAgentFamily>> {
    const owner = await this.#service.resolveOwner(ownerInput);
    if (!owner.ok) return owner;
    const authorized = await this.#authorize(role, "draft_read", owner.owner, lease);
    if (!authorized.ok) return authorized;
    const result = await this.#service.getFamily(ownerInput, {
      agentId: authorized.target.agentId,
    });
    if (!result.ok) return result;
    if (
      result.value.draft?.draftId !== authorized.target.draftId ||
      result.value.draft.draftRevision !== authorized.target.draftRevision
    ) {
      return {
        ok: false,
        error: { code: "TARGET_CHANGED", message: "The exact leased draft changed" },
      };
    }
    return result;
  }

  patchPm(
    input: RoleMutationInput,
    rawPatch: unknown,
  ): Promise<RoleServiceResult<AgentBuilderStoreMutationSuccess>> {
    return this.#patch("pm", "pm_patch", input, rawPatch, pmPatchSchema);
  }

  patchImplementor(
    input: RoleMutationInput,
    rawPatch: unknown,
  ): Promise<RoleServiceResult<AgentBuilderStoreMutationSuccess>> {
    return this.#patch(
      "implementor",
      "implementor_patch",
      input,
      rawPatch,
      implementorPatchSchema,
    );
  }

  patchQa(
    input: RoleMutationInput,
    rawPatch: unknown,
  ): Promise<RoleServiceResult<AgentBuilderStoreMutationSuccess>> {
    return this.#patch("qa", "qa_patch", input, rawPatch, qaPatchSchema);
  }

  async listCapabilityMetadata(
    ownerInput: unknown,
    lease: ExecutionLeaseRecord,
  ): Promise<RoleServiceResult<readonly RunnerCapabilityDescriptor[]>> {
    const resolved = await this.#service.resolveOwner(ownerInput);
    if (!resolved.ok) return resolved;
    const owner = resolved.owner;
    const authorized = await this.#authorize(
      "implementor",
      "capability_metadata",
      owner,
      lease,
    );
    if (!authorized.ok) return authorized;
    try {
      return { ok: true, value: await this.#capabilities.list(owner) };
    } catch {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Capability registry metadata is unavailable",
        },
      };
    }
  }

  async #patch<Patch extends object>(
    role: Extract<ExecutionRole, "pm" | "implementor" | "qa">,
    operation: AgentBuilderRoleOperation,
    input: RoleMutationInput,
    rawPatch: unknown,
    schema: z.ZodType<Patch>,
  ): Promise<RoleServiceResult<AgentBuilderStoreMutationSuccess>> {
    if (input.lease.workflow !== undefined) {
      return {
        ok: false,
        error: {
          code: "ROLE_FORBIDDEN",
          message: "Workflow-scoped roles must use one atomic patch-and-handoff submission",
        },
      };
    }
    const owner = await this.#service.resolveOwner(input.mutationContext.ownerResolution);
    if (!owner.ok) return owner;
    const authorized = await this.#authorize(role, operation, owner.owner, input.lease);
    if (!authorized.ok) return authorized;
    const patch = schema.safeParse(rawPatch);
    if (!patch.success) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Role patch contains forbidden fields" },
      };
    }
    return this.#service.patchDraft(input.mutationContext, {
      agentId: authorized.target.agentId,
      expectedRevision: await this.#familyRevision(input, authorized.target.agentId),
      expectedDraftRevision: authorized.target.draftRevision,
      patch: patch.data,
    });
  }

  async #familyRevision(input: RoleMutationInput, agentId: string): Promise<number> {
    const family = await this.#service.getFamily(input.mutationContext.ownerResolution, {
      agentId,
    });
    return family.ok ? family.value.revision : 0;
  }

  async #authorize(
    role: ExecutionRole,
    operation: AgentBuilderRoleOperation,
    owner: ExecutionLeaseRecord["owner"],
    claimedLease: ExecutionLeaseRecord,
  ): Promise<
    | { readonly ok: true; readonly target: Extract<ExecutionLeaseRecord["target"], { kind: "draft" }> }
    | { readonly ok: false; readonly error: RoleServiceError }
  > {
    if (!roleMayPerform(role, operation)) {
      return {
        ok: false,
        error: { code: "ROLE_FORBIDDEN", message: `${role} cannot perform ${operation}` },
      };
    }
    if (!sameOwner(owner, claimedLease.owner)) {
      return {
        ok: false,
        error: { code: "OWNER_MISMATCH", message: "Current user does not own the role lease" },
      };
    }
    const lease = await this.#store.getExecutionLease({
      owner,
      childSessionId: claimedLease.childSessionId,
    });
    if (
      lease === null ||
      lease.leaseId !== claimedLease.leaseId ||
      lease.role !== role ||
      lease.status !== "running" ||
      lease.executionTurnId === undefined ||
      lease.executionTurnId !== claimedLease.executionTurnId ||
      Date.parse(this.#clock.now()) >= Date.parse(lease.expiresAt) ||
      !bootstrapTargetsEqual(lease.target, claimedLease.target)
    ) {
      return {
        ok: false,
        error: { code: "BOOTSTRAP_REQUIRED", message: "A matching active role lease is required" },
      };
    }
    if (lease.target.kind !== "draft") {
      return {
        ok: false,
        error: { code: "TARGET_CHANGED", message: "Role lease does not target a draft" },
      };
    }
    return { ok: true, target: lease.target };
  }
}

function sameOwner(left: ExecutionLeaseRecord["owner"], right: ExecutionLeaseRecord["owner"]): boolean {
  return left.tenantKey === right.tenantKey && left.ownerKey === right.ownerKey;
}

export function createRoleScopedAgentBuilderService(input: {
  readonly service: AgentBuilderService;
  readonly capabilities: RunnerCapabilityService;
  readonly store: AgentBuilderStore;
  readonly clock?: AgentBuilderClock;
}): RoleScopedAgentBuilderService {
  return new RoleScopedAgentBuilderService(input);
}
