import { createHash } from "node:crypto";

import {
  canonicalizeAgentName,
  capabilityIdSchema,
  publishedAgentVersionSchema,
  savedAgentEditableFieldsSchema,
  savedAgentFamilySchema,
  timestampSchema,
  type AgentId,
  type OwnerScope,
  type PublishedAgentVersion,
  type SavedAgentEditableFields,
  type SavedAgentDraft,
  type SavedAgentFamily,
} from "../domain.js";
import {
  bootstrapGrantRecordSchema,
  bootstrapTargetsEqual,
  buildExecutionScopesEqual,
  DEFAULT_BOOTSTRAP_GRANT_TTL_MS,
  equalTokenHashes,
  executionCapabilityPlanSchema,
  executionLeaseRecordSchema,
  type BeginExecutionLeaseStoreCommand,
  type BootstrapGrantRecord,
  type BootstrapStoreError,
  type BootstrapStoreResult,
  type CloseExecutionLeaseStoreCommand,
  type CloseParentTurnLeasesStoreCommand,
  type CreateBootstrapGrantStoreCommand,
  type ExecutionLeaseQuery,
  type ExecutionLeaseRecord,
  type RedeemBootstrapGrantStoreCommand,
} from "../bootstrap.js";
import {
  testCapabilityExecutionRecordSchema,
  testCapabilityStepScopeSchema,
  testInputGrantRecordSchema,
  type AuthorizeTestInputStoreCommand,
  type BeginTestCapabilityExecutionStoreCommand,
  type CompleteTestCapabilityExecutionStoreCommand,
  type TestCapabilityExecutionQuery,
  type TestCapabilityExecutionRecord,
  type TestInputGrantRecord,
  type TestPolicyError,
  type TestPolicyResult,
} from "../test-policy.js";
import {
  buildTestEvidenceSchema,
  buildWorkflowRecordSchema,
  type BuildWorkflowPhase,
  type BuildWorkflowQuery,
  type BuildWorkflowRecord,
  type BuildWorkflowResult,
  type BuildWorkflowRole,
  type BuildWorkflowTransition,
} from "../workflow.js";
import type {
  ActiveFamilyStoreRecord,
  AgentBuilderStore,
  AgentBuilderStoreCommand,
  AgentBuilderStoreError,
  AgentBuilderStoreMutationResult,
  AgentBuilderStoreMutationSuccess,
  AllocateBuildWorkflowStoreCommand,
  FamilyStoreQuery,
  MutationReplayQuery,
  MutationReplayResult,
  PublishBuildWorkflowStoreCommand,
  RecordBuildTestStoreCommand,
  ReopenBuildWorkflowStoreCommand,
  SubmitBuildRoleStoreCommand,
  VersionStoreQuery,
} from "../store.js";

interface FamilyRecord {
  family: SavedAgentFamily;
  versions: PublishedAgentVersion[];
}

interface OperationRecord {
  readonly requestFingerprint: string;
  readonly result: AgentBuilderStoreMutationSuccess;
}

interface OwnerBucket {
  readonly allocatedDraftIds: Set<string>;
  readonly closedParentTurns: Map<string, string>;
  readonly families: Map<AgentId, FamilyRecord>;
  readonly grants: Map<string, BootstrapGrantRecord>;
  readonly leases: Map<string, ExecutionLeaseRecord>;
  readonly operations: Map<string, OperationRecord>;
  readonly workflows: Map<AgentId, BuildWorkflowRecord>;
  readonly testInputGrants: Map<string, TestInputGrantRecord>;
  readonly testExecutions: Map<string, TestCapabilityExecutionRecord>;
}

function testStepKey(input: {
  readonly workflowId: string;
  readonly testRunId: string;
  readonly childSessionId: string;
  readonly executionTurnId: string;
  readonly callId: string;
}): string {
  return JSON.stringify([
    input.workflowId,
    input.testRunId,
    input.childSessionId,
    input.executionTurnId,
    input.callId,
  ]);
}

function parentTurnKey(parentSessionId: string, parentTurnId: string): string {
  return JSON.stringify([parentSessionId, parentTurnId]);
}

function pruneClosedParentTurns(bucket: OwnerBucket, occurredAt: string): void {
  const cutoff = Date.parse(occurredAt) - DEFAULT_BOOTSTRAP_GRANT_TTL_MS;
  for (const [key, closedAt] of bucket.closedParentTurns) {
    if (Date.parse(closedAt) <= cutoff) bucket.closedParentTurns.delete(key);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function publicClone<T>(value: T): T {
  return deepFreeze(clone(value));
}

function failure(error: AgentBuilderStoreError): AgentBuilderStoreMutationResult {
  return { ok: false, error };
}

function notFound(): AgentBuilderStoreMutationResult {
  return failure({ code: "NOT_FOUND", message: "Saved agent family was not found" });
}

function bootstrapFailure<Value = never>(
  error: BootstrapStoreError,
): BootstrapStoreResult<Value> {
  return { ok: false, error };
}

function testPolicyFailure<Value = never>(error: TestPolicyError): TestPolicyResult<Value> {
  return { ok: false, error };
}

function editableFieldsFromVersion(version: PublishedAgentVersion): SavedAgentEditableFields {
  return {
    name: version.name,
    kind: version.kind,
    description: version.description,
    pmBrief: version.pmBrief,
    instructions: version.instructions,
    toolRequirements: version.toolRequirements,
    triggers: version.triggers,
    testChecklist: version.testChecklist,
    qaFindings: [],
  };
}

/**
 * In-process adapter for tests and local development only.
 *
 * It intentionally serializes all operations to model a transaction, but it
 * is neither durable nor safe across processes. Production hosts must provide
 * a durable `AgentBuilderStore` implementation.
 */
export class MemoryAgentBuilderStore implements AgentBuilderStore {
  readonly #tenants = new Map<string, Map<string, OwnerBucket>>();
  #lockTail: Promise<void> = Promise.resolve();

  async getMutationReplay(query: MutationReplayQuery): Promise<MutationReplayResult> {
    return this.#locked(() => {
      const operation = this.#bucket(query.owner)?.operations.get(query.mutation.operationId);
      if (operation === undefined) return { status: "miss" };
      if (operation.requestFingerprint !== query.mutation.requestFingerprint) {
        return {
          status: "operation_id_reused",
          priorResultType: operation.result.type,
        };
      }
      return { status: "replay", result: publicClone(operation.result) };
    });
  }

  async getFamily(query: FamilyStoreQuery): Promise<SavedAgentFamily | null> {
    return this.#locked(() => {
      const family = this.#bucket(query.owner)?.families.get(query.agentId)?.family;
      return family === undefined ? null : publicClone(family);
    });
  }

  async getVersion(query: VersionStoreQuery): Promise<PublishedAgentVersion | null> {
    return this.#locked(() => {
      const record = this.#bucket(query.owner)?.families.get(query.agentId);
      const version = record?.versions.find(
        (candidate) =>
          candidate.specId === query.specId && candidate.version === query.version,
      );
      return version === undefined ? null : publicClone(version);
    });
  }

  async listVersions(query: FamilyStoreQuery): Promise<readonly PublishedAgentVersion[]> {
    return this.#locked(() => {
      const versions = this.#bucket(query.owner)?.families.get(query.agentId)?.versions ?? [];
      return publicClone([...versions].sort((left, right) => left.version - right.version));
    });
  }

  async listActiveFamilies(owner: OwnerScope): Promise<readonly ActiveFamilyStoreRecord[]> {
    return this.#locked(() => {
      const records: ActiveFamilyStoreRecord[] = [];
      for (const record of this.#bucket(owner)?.families.values() ?? []) {
        const family = record.family;
        if (
          family.lifecycle !== "active" ||
          family.activeSpecId === undefined ||
          family.activeVersion === undefined
        ) {
          continue;
        }
        const activeVersion = record.versions.find(
          (version) =>
            version.specId === family.activeSpecId &&
            version.version === family.activeVersion,
        );
        if (activeVersion === undefined) {
          throw new Error("Active family points to a missing published version");
        }
        records.push({ family: clone(family), activeVersion: clone(activeVersion) });
      }
      return publicClone(records);
    });
  }

  async getBuildWorkflow(query: BuildWorkflowQuery): Promise<BuildWorkflowRecord | null> {
    return this.#locked(() => {
      const workflow = this.#bucket(query.owner)?.workflows.get(query.agentId);
      return workflow === undefined ? null : publicClone(workflow);
    });
  }

  async createBootstrapGrant(
    command: CreateBootstrapGrantStoreCommand,
  ): Promise<BootstrapStoreResult<BootstrapGrantRecord>> {
    return this.#locked(() => {
      const parsed = bootstrapGrantRecordSchema.safeParse(command.grant);
      if (
        !parsed.success ||
        parsed.data.redeemedAt !== undefined ||
        Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.issuedAt)
      ) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Bootstrap grant is invalid",
        });
      }
      if (this.#findGrant(parsed.data.tokenHash) !== null) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Bootstrap token hash is already allocated",
        });
      }
      const bucket = this.#bucket(parsed.data.owner, true);
      if (bucket === undefined) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Unable to allocate owner bucket",
        });
      }
      if (
        !this.#targetIsCurrent(bucket, parsed.data.target) ||
        (parsed.data.workflow !== undefined &&
          !this.#workflowScopeIsCurrent(bucket, parsed.data.target, parsed.data.workflow))
      ) {
        return bootstrapFailure({
          code: "TARGET_CHANGED",
          message: "The exact bootstrap target or workflow is no longer current",
        });
      }
      pruneClosedParentTurns(bucket, parsed.data.issuedAt);
      if (
        parsed.data.parentTurnId !== undefined &&
        bucket.closedParentTurns.has(
          parentTurnKey(parsed.data.parentSessionId, parsed.data.parentTurnId),
        )
      ) {
        return bootstrapFailure({
          code: "BOOTSTRAP_BINDING_MISMATCH",
          message: "Bootstrap parent turn is already terminal",
        });
      }
      bucket.grants.set(parsed.data.tokenHash, clone(parsed.data));
      return { ok: true, value: publicClone(parsed.data) };
    });
  }

  async redeemBootstrapGrant(
    command: RedeemBootstrapGrantStoreCommand,
  ): Promise<BootstrapStoreResult<ExecutionLeaseRecord>> {
    return this.#locked(() => {
      const found = this.#findGrant(command.tokenHash);
      if (found === null) {
        return bootstrapFailure({
          code: "BOOTSTRAP_NOT_FOUND",
          message: "Bootstrap grant was not found",
        });
      }
      const { bucket, grant } = found;
      pruneClosedParentTurns(bucket, command.occurredAt);
      if (
        grant.owner.tenantKey !== command.owner.tenantKey ||
        grant.owner.ownerKey !== command.owner.ownerKey
      ) {
        return bootstrapFailure({
          code: "OWNER_MISMATCH",
          message: "Current user does not own the bootstrap grant",
        });
      }
      if (grant.redeemedAt !== undefined) {
        return bootstrapFailure({
          code: "BOOTSTRAP_REPLAYED",
          message: "Bootstrap grant was already redeemed",
        });
      }
      if (
        grant.parentTurnId !== undefined &&
        bucket.closedParentTurns.has(parentTurnKey(grant.parentSessionId, grant.parentTurnId))
      ) {
        return bootstrapFailure({
          code: "BOOTSTRAP_BINDING_MISMATCH",
          message: "Bootstrap parent turn is already terminal",
        });
      }
      if (!this.#targetIsCurrent(bucket, grant.target)) {
        return bootstrapFailure({
          code: "TARGET_CHANGED",
          message: "The exact bootstrap target is no longer current",
        });
      }
      if (
        grant.workflow !== undefined &&
        !this.#workflowScopeIsCurrent(bucket, grant.target, grant.workflow)
      ) {
        return bootstrapFailure({
          code: "TARGET_CHANGED",
          message: "The exact bootstrap workflow is no longer current",
        });
      }
      if (Date.parse(command.occurredAt) >= Date.parse(grant.expiresAt)) {
        return bootstrapFailure({
          code: "BOOTSTRAP_EXPIRED",
          message: "Bootstrap grant expired",
        });
      }
      const bindingMismatch =
        grant.role !== command.role ||
        grant.parentSessionId !== command.parentSessionId ||
        (grant.parentTurnId !== undefined && grant.parentTurnId !== command.parentTurnId) ||
        (grant.parentCallId !== undefined && grant.parentCallId !== command.parentCallId) ||
        (command.expectedTarget !== undefined &&
          !bootstrapTargetsEqual(grant.target, command.expectedTarget)) ||
        (command.expectedWorkflow !== undefined &&
          !buildExecutionScopesEqual(grant.workflow, command.expectedWorkflow));
      if (bindingMismatch) {
        return bootstrapFailure({
          code: "BOOTSTRAP_BINDING_MISMATCH",
          message: "Bootstrap grant binding did not match the child invocation",
        });
      }
      if (this.#findLease(command.childSessionId) !== null) {
        return bootstrapFailure({
          code: "CHILD_SESSION_MISMATCH",
          message: "Child session was already used by a bootstrap lease",
        });
      }
      if (
        !timestampSchema.safeParse(command.occurredAt).success ||
        !timestampSchema.safeParse(command.leaseExpiresAt).success ||
        Date.parse(command.leaseExpiresAt) <= Date.parse(command.occurredAt)
      ) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Bootstrap redemption timestamps are invalid",
        });
      }
      const lease: ExecutionLeaseRecord = {
        leaseId: command.leaseId,
        grantId: grant.grantId,
        owner: clone(grant.owner),
        role: grant.role,
        target: clone(grant.target),
        ...(grant.workflow === undefined ? {} : { workflow: clone(grant.workflow) }),
        parentSessionId: grant.parentSessionId,
        ...(grant.parentTurnId === undefined ? {} : { parentTurnId: grant.parentTurnId }),
        parentCallId: command.parentCallId,
        childSessionId: command.childSessionId,
        bootstrapTurnId: command.bootstrapTurnId,
        issuedAt: command.occurredAt,
        expiresAt: command.leaseExpiresAt,
        status: "ready",
      };
      if (!executionLeaseRecordSchema.safeParse(lease).success) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Bootstrap redemption would create an invalid lease",
        });
      }
      bucket.grants.set(grant.tokenHash, {
        ...grant,
        redeemedAt: command.occurredAt,
        childSessionId: command.childSessionId,
      });
      bucket.leases.set(command.childSessionId, clone(lease));
      return { ok: true, value: publicClone(lease) };
    });
  }

  async getExecutionLease(query: ExecutionLeaseQuery): Promise<ExecutionLeaseRecord | null> {
    return this.#locked(() => {
      const lease = this.#bucket(query.owner)?.leases.get(query.childSessionId);
      return lease === undefined ? null : publicClone(lease);
    });
  }

  async beginExecutionLease(
    command: BeginExecutionLeaseStoreCommand,
  ): Promise<BootstrapStoreResult<ExecutionLeaseRecord>> {
    return this.#locked(() => {
      const found = this.#findLease(command.childSessionId);
      if (found === null) {
        return bootstrapFailure({ code: "LEASE_NOT_FOUND", message: "Lease was not found" });
      }
      if (
        found.lease.owner.tenantKey !== command.owner.tenantKey ||
        found.lease.owner.ownerKey !== command.owner.ownerKey
      ) {
        return bootstrapFailure({
          code: "OWNER_MISMATCH",
          message: "Current user does not own the execution lease",
        });
      }
      const lease = found.lease;
      if (Date.parse(command.occurredAt) >= Date.parse(lease.expiresAt)) {
        const expired: ExecutionLeaseRecord = {
          ...lease,
          status: "expired",
          closedAt: command.occurredAt,
          terminalCode: "LEASE_EXPIRED",
        };
        found.bucket.leases.set(command.childSessionId, expired);
        return bootstrapFailure({ code: "LEASE_EXPIRED", message: "Execution lease expired" });
      }
      if (lease.status === "running" && lease.executionTurnId === command.executionTurnId) {
        if (
          JSON.stringify(lease.capabilityPlan) !== JSON.stringify(command.capabilityPlan)
        ) {
          return bootstrapFailure({
            code: "TARGET_CHANGED",
            message: "The resolved capability plan changed during execution",
          });
        }
        return { ok: true, value: publicClone(lease) };
      }
      if (lease.status !== "ready") {
        return bootstrapFailure({
          code: "LEASE_CLOSED",
          message: "Execution lease is not reusable",
        });
      }
      if (!this.#targetIsCurrent(found.bucket, lease.target)) {
        return bootstrapFailure({
          code: "TARGET_CHANGED",
          message: "The exact execution target is no longer current",
        });
      }
      if (
        lease.workflow !== undefined &&
        !this.#workflowScopeIsCurrent(found.bucket, lease.target, lease.workflow)
      ) {
        return bootstrapFailure({
          code: "TARGET_CHANGED",
          message: "The exact execution workflow is no longer current",
        });
      }
      if (command.executionTurnId === lease.bootstrapTurnId) {
        return bootstrapFailure({
          code: "LEASE_NOT_READY",
          message: "Bootstrap turn cannot execute the saved task",
        });
      }
      if (
        command.capabilityPlan !== undefined &&
        !executionCapabilityPlanSchema.safeParse(command.capabilityPlan).success
      ) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Execution capability plan is invalid",
        });
      }
      const running: ExecutionLeaseRecord = {
        ...lease,
        status: "running",
        executionTurnId: command.executionTurnId,
        ...(command.capabilityPlan === undefined
          ? {}
          : { capabilityPlan: clone(command.capabilityPlan) }),
      };
      found.bucket.leases.set(command.childSessionId, clone(running));
      return { ok: true, value: publicClone(running) };
    });
  }

  async closeExecutionLease(
    command: CloseExecutionLeaseStoreCommand,
  ): Promise<BootstrapStoreResult<ExecutionLeaseRecord>> {
    return this.#locked(() => {
      const found = this.#findLease(command.childSessionId);
      if (found === null) {
        return bootstrapFailure({ code: "LEASE_NOT_FOUND", message: "Lease was not found" });
      }
      const lease = found.lease;
      if (
        lease.owner.tenantKey !== command.owner.tenantKey ||
        lease.owner.ownerKey !== command.owner.ownerKey
      ) {
        return bootstrapFailure({
          code: "OWNER_MISMATCH",
          message: "Current user does not own the execution lease",
        });
      }
      if (["succeeded", "failed", "cancelled", "expired"].includes(lease.status)) {
        return lease.status === command.status
          ? { ok: true, value: publicClone(lease) }
          : bootstrapFailure({
              code: "LEASE_CLOSED",
              message: "Execution lease is already terminal",
            });
      }
      if (Date.parse(command.occurredAt) >= Date.parse(lease.expiresAt)) {
        const expired: ExecutionLeaseRecord = {
          ...lease,
          ...(lease.executionTurnId === undefined
            ? { executionTurnId: command.executionTurnId }
            : {}),
          status: "expired",
          closedAt: command.occurredAt,
          terminalCode: "LEASE_EXPIRED",
        };
        found.bucket.leases.set(command.childSessionId, clone(expired));
        return { ok: true, value: publicClone(expired) };
      }
      if (
        lease.status === "running" &&
        lease.executionTurnId !== command.executionTurnId
      ) {
        return bootstrapFailure({
          code: "CHILD_SESSION_MISMATCH",
          message: "Terminal event does not belong to the execution turn",
        });
      }
      if (
        lease.status === "ready" &&
        command.status === "succeeded"
      ) {
        return bootstrapFailure({
          code: "LEASE_NOT_READY",
          message: "Bootstrap or unclaimed execution cannot complete successfully",
        });
      }
      const terminal: ExecutionLeaseRecord = {
        ...lease,
        ...(lease.executionTurnId === undefined
          ? { executionTurnId: command.executionTurnId }
          : {}),
        status: command.status,
        closedAt: command.occurredAt,
        ...(command.terminalCode === undefined ? {} : { terminalCode: command.terminalCode }),
      };
      if (!executionLeaseRecordSchema.safeParse(terminal).success) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Terminal lease is invalid",
        });
      }
      found.bucket.leases.set(command.childSessionId, clone(terminal));
      return { ok: true, value: publicClone(terminal) };
    });
  }

  async closeParentTurnExecutionLeases(
    command: CloseParentTurnLeasesStoreCommand,
  ): Promise<BootstrapStoreResult<readonly ExecutionLeaseRecord[]>> {
    return this.#locked(() => {
      if (!timestampSchema.safeParse(command.occurredAt).success) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Parent-turn close contains an invalid timestamp",
        });
      }
      const bucket = this.#bucket(command.owner, true);
      if (bucket === undefined) {
        return bootstrapFailure({
          code: "BOOTSTRAP_STORE_INVARIANT_VIOLATION",
          message: "Unable to allocate owner bucket for parent-turn close",
        });
      }
      pruneClosedParentTurns(bucket, command.occurredAt);
      bucket.closedParentTurns.set(
        parentTurnKey(command.parentSessionId, command.parentTurnId),
        command.occurredAt,
      );
      const closed: ExecutionLeaseRecord[] = [];
      for (const [childSessionId, lease] of bucket.leases) {
        if (
          !["ready", "running"].includes(lease.status) ||
          lease.parentSessionId !== command.parentSessionId ||
          lease.parentTurnId !== command.parentTurnId
        ) {
          continue;
        }
        const terminal: ExecutionLeaseRecord = {
          ...lease,
          status: command.status,
          closedAt: command.occurredAt,
          terminalCode: command.terminalCode,
        };
        bucket.leases.set(childSessionId, clone(terminal));
        closed.push(terminal);
      }
      return { ok: true, value: publicClone(closed) };
    });
  }

  async authorizeTestInput(
    command: AuthorizeTestInputStoreCommand,
  ): Promise<TestPolicyResult<TestInputGrantRecord>> {
    return this.#locked(() => {
      if (
        !testCapabilityStepScopeSchema.safeParse(command.step).success ||
        !timestampSchema.safeParse(command.occurredAt).success ||
        command.requestId.length < 1 ||
        command.requestId.length > 512 ||
        command.responder.principalType !== "user" ||
        command.responder.principalId.length < 1 ||
        command.responder.principalId.length > 1_024
      ) {
        return testPolicyFailure({
          code: "INPUT_MALFORMED",
          message: "Verified input response is malformed",
        });
      }
      const bucket = this.#bucket(command.step.owner);
      const exact = bucket === undefined ? null : this.#validateTestStep(bucket, command.step);
      if (exact !== null) return testPolicyFailure(exact);
      if (Date.parse(command.occurredAt) >= Date.parse(command.step.expiresAt)) {
        return testPolicyFailure({ code: "INPUT_STALE", message: "Input approval expired" });
      }
      const key = testStepKey(command.step);
      if (bucket?.testInputGrants.has(key) === true) {
        return testPolicyFailure({
          code: "INPUT_REPLAYED",
          message: "Input approval was already recorded for this exact step",
        });
      }
      if (bucket === undefined) {
        return testPolicyFailure({
          code: "WORKFLOW_CHANGED",
          message: "Build workflow is unavailable",
        });
      }
      const grant: TestInputGrantRecord = {
        ...command.step,
        requestId: command.requestId,
        responderPrincipalId: command.responder.principalId,
        authorizedAt: command.occurredAt,
      };
      if (!testInputGrantRecordSchema.safeParse(grant).success) {
        return testPolicyFailure({
          code: "TEST_POLICY_STORE_INVARIANT_VIOLATION",
          message: "Input approval record is invalid",
        });
      }
      bucket.testInputGrants.set(key, clone(grant));
      return { ok: true, value: publicClone(grant) };
    });
  }

  async beginTestCapabilityExecution(
    command: BeginTestCapabilityExecutionStoreCommand,
  ): Promise<TestPolicyResult<TestCapabilityExecutionRecord>> {
    return this.#locked(() => {
      if (
        !testCapabilityStepScopeSchema.safeParse(command.step).success ||
        !timestampSchema.safeParse(command.occurredAt).success
      ) {
        return testPolicyFailure({
          code: "TEST_POLICY_STORE_INVARIANT_VIOLATION",
          message: "Test execution start is invalid",
        });
      }
      const bucket = this.#bucket(command.step.owner);
      const exact = bucket === undefined ? null : this.#validateTestStep(bucket, command.step);
      if (exact !== null) return testPolicyFailure(exact);
      if (Date.parse(command.occurredAt) >= Date.parse(command.step.expiresAt)) {
        return testPolicyFailure({ code: "LEASE_EXPIRED", message: "Test lease expired" });
      }
      if (bucket === undefined) {
        return testPolicyFailure({ code: "WORKFLOW_CHANGED", message: "Workflow unavailable" });
      }
      const key = testStepKey(command.step);
      if (bucket.testExecutions.has(key)) {
        return testPolicyFailure({
          code: "TEST_STEP_REPLAYED",
          message: "Test capability step was already started",
        });
      }
      let approval: TestCapabilityExecutionRecord["approval"] = "not_required";
      if (command.consequential) {
        const grant = bucket.testInputGrants.get(key);
        if (grant === undefined) {
          return testPolicyFailure({
            code: "INPUT_REQUIRED",
            message: "Consequential test step requires verified user approval",
          });
        }
        if (grant.consumedAt !== undefined) {
          return testPolicyFailure({ code: "INPUT_REPLAYED", message: "Input was already used" });
        }
        if (
          grant.stepFingerprint !== command.step.stepFingerprint ||
          grant.capabilityId !== command.step.capabilityId ||
          grant.schemaFingerprint !== command.step.schemaFingerprint
        ) {
          return testPolicyFailure({ code: "INPUT_STALE", message: "Input scope changed" });
        }
        bucket.testInputGrants.set(key, { ...grant, consumedAt: command.occurredAt });
        approval = "verified";
      }
      const execution: TestCapabilityExecutionRecord = {
        ...command.step,
        approval,
        status: "started",
        startedAt: command.occurredAt,
      };
      if (!testCapabilityExecutionRecordSchema.safeParse(execution).success) {
        return testPolicyFailure({
          code: "TEST_POLICY_STORE_INVARIANT_VIOLATION",
          message: "Test execution record is invalid",
        });
      }
      bucket.testExecutions.set(key, clone(execution));
      return { ok: true, value: publicClone(execution) };
    });
  }

  async completeTestCapabilityExecution(
    command: CompleteTestCapabilityExecutionStoreCommand,
  ): Promise<TestPolicyResult<TestCapabilityExecutionRecord>> {
    return this.#locked(() => {
      const bucket = this.#bucket(command.owner);
      const key = testStepKey(command);
      const current = bucket?.testExecutions.get(key);
      if (current === undefined) {
        return testPolicyFailure({
          code: "TEST_POLICY_STORE_INVARIANT_VIOLATION",
          message: "Test execution was not started",
        });
      }
      if (current.leaseId !== command.leaseId) {
        return testPolicyFailure({
          code: "WORKFLOW_CHANGED",
          message: "Test execution lease changed before completion",
        });
      }
      if (current.status !== "started") {
        return current.status === command.status
          ? { ok: true, value: publicClone(current) }
          : testPolicyFailure({
              code: "TEST_STEP_REPLAYED",
              message: "Test execution already completed differently",
            });
      }
      const completed: TestCapabilityExecutionRecord = {
        ...current,
        status: command.status,
        completedAt: command.occurredAt,
        ...(command.errorCode === undefined ? {} : { errorCode: command.errorCode }),
      };
      if (!testCapabilityExecutionRecordSchema.safeParse(completed).success) {
        return testPolicyFailure({
          code: "TEST_POLICY_STORE_INVARIANT_VIOLATION",
          message: "Completed test execution record is invalid",
        });
      }
      bucket?.testExecutions.set(key, clone(completed));
      return { ok: true, value: publicClone(completed) };
    });
  }

  async listTestCapabilityExecutions(
    query: TestCapabilityExecutionQuery,
  ): Promise<readonly TestCapabilityExecutionRecord[]> {
    return this.#locked(() =>
      publicClone(
        [...(this.#bucket(query.owner)?.testExecutions.values() ?? [])]
          .filter(
            (record) =>
              record.workflowId === query.workflowId && record.testRunId === query.testRunId,
          )
          .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      ),
    );
  }

  async mutate(command: AgentBuilderStoreCommand): Promise<AgentBuilderStoreMutationResult> {
    return this.#locked(() => {
      const bucket = this.#bucket(command.owner, true);
      if (bucket === undefined) {
        return failure({
          code: "STORE_INVARIANT_VIOLATION",
          message: "Unable to allocate owner bucket",
        });
      }

      const replay = bucket.operations.get(command.mutation.operationId);
      if (replay !== undefined) {
        if (replay.requestFingerprint === command.mutation.requestFingerprint) {
          return publicClone(replay.result);
        }
        return failure({
          code: "OPERATION_ID_REUSED",
          message: "Operation ID was already committed for a different request",
          priorResultType: replay.result.type,
        });
      }

      if (!timestampSchema.safeParse(command.occurredAt).success) {
        return failure({
          code: "STORE_INVARIANT_VIOLATION",
          message: "Store command contains an invalid timestamp",
        });
      }

      const result = this.#apply(bucket, command);
      if (!result.ok) return result;
      bucket.operations.set(command.mutation.operationId, {
        requestFingerprint: command.mutation.requestFingerprint,
        result: clone(result),
      });
      return publicClone(result);
    });
  }

  #apply(
    bucket: OwnerBucket,
    command: AgentBuilderStoreCommand,
  ): AgentBuilderStoreMutationResult {
    switch (command.type) {
      case "allocate_build_workflow":
        return this.#allocateBuildWorkflow(bucket, command);
      case "create_family":
        return this.#createFamily(bucket, command);
      case "begin_revision":
        return this.#beginRevision(bucket, command);
      case "patch_draft":
        return this.#patchDraft(bucket, command);
      case "publish_draft":
        return this.#publishDraft(bucket, command);
      case "activate_version":
        return this.#activateVersion(bucket, command);
      case "archive_family":
        return this.#archiveFamily(bucket, command);
      case "restore_family":
        return this.#restoreFamily(bucket, command);
      case "delete_family":
        return this.#deleteFamily(bucket, command);
      case "submit_build_role":
        return this.#submitBuildRole(bucket, command);
      case "record_build_test":
        return this.#recordBuildTest(bucket, command);
      case "reopen_build_workflow":
        return this.#reopenBuildWorkflow(bucket, command);
      case "publish_build_workflow":
        return this.#publishBuildWorkflow(bucket, command);
    }
  }

  #allocateBuildWorkflow(
    bucket: OwnerBucket,
    command: AllocateBuildWorkflowStoreCommand,
  ): AgentBuilderStoreMutationResult {
    if ([...bucket.workflows.values()].some((item) => item.workflowId === command.workflowId)) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Build workflow ID is already allocated in this owner scope",
      });
    }
    const transition: BuildWorkflowTransition = {
      owner: clone(command.owner),
      workflowId: command.workflowId,
      agentId: command.agentId,
      draftId: command.draftId,
      draftRevision: 1,
      role: "system",
      operationId: command.mutation.operationId,
      fromPhase: "pm_work",
      toPhase: "pm_work",
      result: "allocated",
      occurredAt: command.occurredAt,
    };
    const workflow: BuildWorkflowRecord = {
      workflowId: command.workflowId,
      owner: clone(command.owner),
      agentId: command.agentId,
      draftId: command.draftId,
      draftRevision: 1,
      revision: 1,
      phase: "pm_work",
      transitions: [transition],
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
    };
    if (!buildWorkflowRecordSchema.safeParse(workflow).success) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Build allocation would create an invalid workflow",
      });
    }
    const familyResult = this.#createFamily(bucket, {
      ...command,
      type: "create_family",
    });
    if (!familyResult.ok || familyResult.type !== "family_created") return familyResult;
    bucket.workflows.set(command.agentId, clone(workflow));
    return {
      ok: true,
      type: "workflow_allocated",
      family: familyResult.family,
      workflow,
    };
  }

  #submitBuildRole(
    bucket: OwnerBucket,
    command: SubmitBuildRoleStoreCommand,
  ): AgentBuilderStoreMutationResult {
    const workflow = this.#workflowById(bucket, command.workflowId);
    if (workflow === null) {
      return failure({ code: "WORKFLOW_NOT_FOUND", message: "Build workflow was not found" });
    }
    if (workflow.revision !== command.expectedWorkflowRevision) {
      return failure({
        code: "WORKFLOW_CONFLICT",
        message: "Build workflow changed before role submission",
        currentWorkflowRevision: workflow.revision,
      });
    }
    const record = this.#liveRecord(bucket, workflow.agentId);
    if (record === null || record.family.draft === undefined) return notFound();
    const conflict = this.#checkRevision(
      record.family,
      command.expectedRevision,
      command.expectedDraftRevision,
    );
    if (conflict !== null) return conflict;
    if (
      workflow.draftId !== record.family.draft.draftId ||
      workflow.draftRevision !== record.family.draft.draftRevision
    ) {
      return failure({
        code: "WORKFLOW_CONFLICT",
        message: "Workflow does not target the current draft revision",
        currentWorkflowRevision: workflow.revision,
      });
    }
    const lease = bucket.leases.get(command.childSessionId);
    if (
      lease === undefined ||
      lease.leaseId !== command.leaseId ||
      lease.role !== command.role ||
      lease.status !== "running" ||
      Date.parse(command.occurredAt) >= Date.parse(lease.expiresAt) ||
      lease.executionTurnId !== command.executionTurnId ||
      lease.target.kind !== "draft" ||
      lease.target.agentId !== workflow.agentId ||
      lease.target.draftId !== workflow.draftId ||
      lease.target.draftRevision !== workflow.draftRevision ||
      lease.workflow?.workflowId !== workflow.workflowId ||
      lease.workflow.workflowRevision !== workflow.revision
    ) {
      return failure({ code: "ROLE_FORBIDDEN", message: "Authoritative role lease is invalid" });
    }
    const phaseAllowed =
      (command.role === "pm" && ["pm_work", "pm_input"].includes(workflow.phase)) ||
      (command.role === "implementor" &&
        ["implementation_work", "implementation_input"].includes(workflow.phase)) ||
      (command.role === "qa" && ["qa_review", "qa_input"].includes(workflow.phase));
    if (!phaseAllowed || !this.#roleResultAllowed(command.role, command.result)) {
      return failure({
        code: "WORKFLOW_INVALID_TRANSITION",
        message: `${command.role} cannot submit ${command.result} from ${workflow.phase}`,
        currentWorkflowRevision: workflow.revision,
      });
    }
    const checked = this.#checkFields(command.fields, command.canonicalName);
    if (checked !== null) return failure(checked);
    if (
      command.result === "completed_handoff" &&
      ((command.role === "pm" &&
        (command.fields.name.startsWith("Untitled build ") ||
          command.fields.pmBrief.trim().length === 0)) ||
        (command.role === "implementor" && command.fields.instructions.trim().length === 0))
    ) {
      return failure({
        code: "WORKFLOW_INVALID_TRANSITION",
        message: `${command.role} must complete its required authored fields before handoff`,
        currentWorkflowRevision: workflow.revision,
      });
    }
    if (!this.#onlyRoleFieldsChanged(command.role, record.family.draft, command.fields)) {
      return failure({
        code: "ROLE_FORBIDDEN",
        message: `${command.role} submission changed a field owned by another role`,
      });
    }
    const owner = this.#nameOwner(bucket, command.canonicalName);
    if (owner !== null && owner !== record.family.agentId) {
      return failure({
        code: "NAME_CONFLICT",
        message: "Canonical name is reserved by another family",
        canonicalName: command.canonicalName,
      });
    }
    const changed = JSON.stringify(command.fields) !== JSON.stringify(this.#draftFields(record.family.draft));
    if (command.role === "qa" && command.result === "approved" && changed) {
      return failure({
        code: "TEST_EVIDENCE_REQUIRED",
        message: "QA approval cannot mutate the exact tested draft revision",
      });
    }
    const finalDraftRevision = record.family.draft.draftRevision + (changed ? 1 : 0);
    const family: SavedAgentFamily = changed
      ? {
          ...record.family,
          draft: {
            draftId: record.family.draft.draftId,
            ...(record.family.draft.basedOnSpecId === undefined
              ? {}
              : {
                  basedOnSpecId: record.family.draft.basedOnSpecId,
                  basedOnVersion: record.family.draft.basedOnVersion,
                }),
            ...clone(command.fields),
            draftRevision: finalDraftRevision,
            createdAt: record.family.draft.createdAt,
            updatedAt: command.occurredAt,
          },
          revision: record.family.revision + 1,
          updatedAt: command.occurredAt,
        }
      : clone(record.family);
    const nextPhase = this.#nextRolePhase(command.role, command.result);
    if (command.role === "qa" && command.result === "needs_test" && command.testRunId === undefined) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "QA test request requires a system-owned test run ID",
      });
    }
    if (command.role === "qa" && command.result === "approved") {
      const evidence = workflow.testEvidence;
      const required = family.draft?.toolRequirements
        .filter((item) => item.level === "required")
        .map((item) => item.capabilityId) ?? [];
      if (
        evidence === undefined ||
        evidence.status !== "passed" ||
        evidence.draftRevision !== finalDraftRevision ||
        evidence.draftId !== workflow.draftId ||
        evidence.failedCapabilityIds.length > 0 ||
        evidence.errorCodes.length > 0 ||
        required.some((id) => !evidence.usedCapabilityIds.includes(id))
      ) {
        return failure({
          code: "TEST_EVIDENCE_REQUIRED",
          message: "Exact passing evidence for every required capability is required",
        });
      }
    }
    const transition = this.#workflowTransition({
      workflow,
      draftRevision: finalDraftRevision,
      role: command.role,
      result: command.result,
      toPhase: nextPhase,
      operationId: command.mutation.operationId,
      occurredAt: command.occurredAt,
    });
    const clearEvidence =
      command.role !== "qa" ||
      command.result === "needs_test" ||
      command.result === "changes_requested" ||
      changed;
    const {
      testRunId: _testRunId,
      testEvidence: _testEvidence,
      qaApproval: _qaApproval,
      ...withoutEvidence
    } = workflow;
    const common = {
      draftRevision: finalDraftRevision,
      revision: workflow.revision + 1,
      phase: nextPhase,
      transitions: [...workflow.transitions, transition],
      updatedAt: command.occurredAt,
    } as const;
    let normalizedWorkflow: BuildWorkflowRecord;
    if (command.role === "qa" && command.result === "needs_test") {
      normalizedWorkflow = {
        ...withoutEvidence,
        ...common,
        testRunId: command.testRunId as NonNullable<typeof command.testRunId>,
      };
    } else if (
      command.role === "qa" &&
      command.result === "approved" &&
      workflow.testEvidence !== undefined
    ) {
      normalizedWorkflow = {
        ...workflow,
        ...common,
        qaApproval: {
          owner: clone(workflow.owner),
          workflowId: workflow.workflowId,
          agentId: workflow.agentId,
          draftId: workflow.draftId,
          draftRevision: finalDraftRevision,
          testRunId: workflow.testEvidence.testRunId,
          capabilityPlanFingerprint: workflow.testEvidence.capabilityPlanFingerprint,
          requiredCapabilityIds: clone(workflow.testEvidence.requiredCapabilityIds),
          operationId: command.mutation.operationId,
          approvedAt: command.occurredAt,
        },
      };
    } else {
      normalizedWorkflow = clearEvidence
        ? { ...withoutEvidence, ...common }
        : { ...workflow, ...common };
    }
    if (
      !savedAgentFamilySchema.safeParse(family).success ||
      !buildWorkflowRecordSchema.safeParse(normalizedWorkflow).success
    ) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Role submission would persist invalid state",
      });
    }
    record.family = clone(family);
    bucket.workflows.set(workflow.agentId, clone(normalizedWorkflow));
    return {
      ok: true,
      type: "workflow_role_submitted",
      family,
      workflow: normalizedWorkflow,
    };
  }

  #recordBuildTest(
    bucket: OwnerBucket,
    command: RecordBuildTestStoreCommand,
  ): AgentBuilderStoreMutationResult {
    const workflow = this.#workflowById(bucket, command.workflowId);
    if (workflow === null) {
      return failure({ code: "WORKFLOW_NOT_FOUND", message: "Build workflow was not found" });
    }
    if (workflow.revision !== command.expectedWorkflowRevision) {
      return failure({
        code: "WORKFLOW_CONFLICT",
        message: "Build workflow changed before test completion",
        currentWorkflowRevision: workflow.revision,
      });
    }
    if (workflow.phase !== "test_pending" || workflow.testRunId !== command.testRunId) {
      return failure({
        code: "WORKFLOW_INVALID_TRANSITION",
        message: "Workflow is not awaiting this exact test run",
        currentWorkflowRevision: workflow.revision,
      });
    }
    const record = this.#liveRecord(bucket, workflow.agentId);
    const draft = record?.family.draft;
    const lease = bucket.leases.get(command.childSessionId);
    if (
      record === null ||
      draft === undefined ||
      draft.draftId !== workflow.draftId ||
      draft.draftRevision !== workflow.draftRevision ||
      lease === undefined ||
      lease.leaseId !== command.leaseId ||
      lease.role !== "test_runner" ||
      lease.status !== "running" ||
      Date.parse(command.occurredAt) >= Date.parse(lease.expiresAt) ||
      lease.executionTurnId !== command.executionTurnId ||
      lease.workflow?.workflowId !== workflow.workflowId ||
      lease.workflow.testRunId !== command.testRunId ||
      lease.workflow.workflowRevision !== workflow.revision ||
      lease.capabilityPlan?.mode !== "test"
    ) {
      return failure({
        code: "TEST_EVIDENCE_REQUIRED",
        message: "Authoritative exact-revision test lease is unavailable",
      });
    }
    if (
      command.errorCodes.length > 256 ||
      command.errorCodes.some((code) => code.length < 1 || code.length > 256)
    ) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Test error codes are invalid",
      });
    }
    const executions = [...bucket.testExecutions.values()].filter(
      (item) =>
        item.workflowId === workflow.workflowId &&
        item.testRunId === command.testRunId &&
        item.leaseId === command.leaseId &&
        item.childSessionId === command.childSessionId &&
        item.executionTurnId === command.executionTurnId,
    );
    const succeeded = executions
      .filter((item) => item.status === "succeeded")
      .map((item) => item.capabilityId);
    const failed = executions
      .filter((item) => item.status === "failed" || item.status === "started")
      .map((item) => item.capabilityId);
    const required = draft.toolRequirements
      .filter((item) => item.level === "required")
      .map((item) => item.capabilityId);
    const selectedIds = lease.capabilityPlan.selected.map((item) => item.capabilityId);
    const effectiveStatus =
      command.status === "passed" &&
      required.every((id) => selectedIds.includes(id) && succeeded.includes(id)) &&
      failed.length === 0 &&
      command.errorCodes.length === 0
        ? "passed"
        : command.status === "input_required"
          ? "input_required"
          : "failed";
    const capabilityPlanFingerprint = `sha256:${createHash("sha256")
      .update(JSON.stringify(lease.capabilityPlan))
      .digest("hex")}`;
    const evidence = {
      testRunId: command.testRunId,
      owner: clone(workflow.owner),
      workflowId: workflow.workflowId,
      agentId: workflow.agentId,
      draftId: workflow.draftId,
      draftRevision: workflow.draftRevision,
      leaseId: lease.leaseId,
      childSessionId: lease.childSessionId,
      executionTurnId: command.executionTurnId,
      status: effectiveStatus,
      capabilityPlanFingerprint,
      requiredCapabilityIds: required,
      usedCapabilityIds: [...new Set(succeeded)],
      failedCapabilityIds: [...new Set(failed)],
      optionalOmissions: lease.capabilityPlan.optionalOmissions.map((item) => ({
        capabilityId: capabilityIdSchema.parse(item.capabilityId),
        reason: item.reason,
      })),
      errorCodes: clone(command.errorCodes),
      startedAt: executions[0]?.startedAt ?? lease.issuedAt,
      completedAt: command.occurredAt,
    } as const;
    if (!buildTestEvidenceSchema.safeParse(evidence).success) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Test completion would persist invalid evidence",
      });
    }
    const result: BuildWorkflowResult =
      effectiveStatus === "passed"
        ? "test_passed"
        : effectiveStatus === "input_required"
          ? "test_input_required"
          : "test_failed";
    const transition = this.#workflowTransition({
      workflow,
      draftRevision: workflow.draftRevision,
      role: "test_runner",
      result,
      toPhase: "qa_review",
      operationId: command.mutation.operationId,
      occurredAt: command.occurredAt,
    });
    const nextWorkflow: BuildWorkflowRecord = {
      ...workflow,
      revision: workflow.revision + 1,
      phase: "qa_review",
      testEvidence: evidence,
      transitions: [...workflow.transitions, transition],
      updatedAt: command.occurredAt,
    };
    if (!buildWorkflowRecordSchema.safeParse(nextWorkflow).success) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Test completion would persist an invalid workflow",
      });
    }
    bucket.workflows.set(workflow.agentId, clone(nextWorkflow));
    return {
      ok: true,
      type: "workflow_test_recorded",
      family: record.family,
      workflow: nextWorkflow,
    };
  }

  #reopenBuildWorkflow(
    bucket: OwnerBucket,
    command: ReopenBuildWorkflowStoreCommand,
  ): AgentBuilderStoreMutationResult {
    const workflow = this.#workflowById(bucket, command.workflowId);
    if (workflow === null || workflow.agentId !== command.agentId) {
      return failure({ code: "WORKFLOW_NOT_FOUND", message: "Build workflow was not found" });
    }
    if (workflow.revision !== command.expectedWorkflowRevision) {
      return failure({
        code: "WORKFLOW_CONFLICT",
        message: "Build workflow changed before it could be reopened",
        currentWorkflowRevision: workflow.revision,
      });
    }
    const record = this.#liveRecord(bucket, command.agentId);
    const draft = record?.family.draft;
    if (record === null || draft === undefined) return notFound();
    const conflict = this.#checkRevision(
      record.family,
      command.expectedRevision,
      command.expectedDraftRevision,
    );
    if (conflict !== null) return conflict;
    if (
      workflow.phase !== "publish_ready" ||
      workflow.draftId !== draft.draftId ||
      workflow.draftRevision !== draft.draftRevision ||
      workflow.testEvidence === undefined ||
      workflow.qaApproval === undefined
    ) {
      return failure({
        code: "PUBLISH_NOT_READY",
        message: "Only the exact current QA-approved draft can be reopened for edits",
      });
    }
    const transition = this.#workflowTransition({
      workflow,
      draftRevision: draft.draftRevision,
      role: "root",
      result: "approval_invalidated",
      toPhase: "pm_work",
      operationId: command.mutation.operationId,
      occurredAt: command.occurredAt,
    });
    const {
      testRunId: _testRunId,
      testEvidence: _testEvidence,
      qaApproval: _qaApproval,
      published: _published,
      ...retained
    } = workflow;
    const reopened: BuildWorkflowRecord = {
      ...retained,
      revision: workflow.revision + 1,
      phase: "pm_work",
      transitions: [...workflow.transitions, transition],
      updatedAt: command.occurredAt,
    };
    if (!buildWorkflowRecordSchema.safeParse(reopened).success) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Workflow reopen would persist invalid state",
      });
    }
    bucket.workflows.set(workflow.agentId, clone(reopened));
    return {
      ok: true,
      type: "workflow_reopened",
      family: record.family,
      workflow: reopened,
    };
  }

  #publishBuildWorkflow(
    bucket: OwnerBucket,
    command: PublishBuildWorkflowStoreCommand,
  ): AgentBuilderStoreMutationResult {
    const workflow = this.#workflowById(bucket, command.workflowId);
    if (workflow === null || workflow.agentId !== command.agentId) {
      return failure({ code: "WORKFLOW_NOT_FOUND", message: "Build workflow was not found" });
    }
    if (workflow.revision !== command.expectedWorkflowRevision) {
      return failure({
        code: "WORKFLOW_CONFLICT",
        message: "Build workflow changed before publication",
        currentWorkflowRevision: workflow.revision,
      });
    }
    const record = this.#liveRecord(bucket, command.agentId);
    const draft = record?.family.draft;
    if (record === null || draft === undefined) return notFound();
    const conflict = this.#checkRevision(
      record.family,
      command.expectedRevision,
      command.expectedDraftRevision,
    );
    if (conflict !== null) return conflict;
    if (
      workflow.phase !== "publish_ready" ||
      workflow.draftId !== draft.draftId ||
      workflow.draftRevision !== draft.draftRevision ||
      workflow.qaApproval?.draftRevision !== draft.draftRevision ||
      workflow.qaApproval.testRunId !== workflow.testEvidence?.testRunId ||
      workflow.qaApproval.capabilityPlanFingerprint !==
        workflow.testEvidence?.capabilityPlanFingerprint
    ) {
      return failure({
        code: "PUBLISH_NOT_READY",
        message: "Exact current draft is not QA-approved and publish-ready",
      });
    }
    if (
      [...bucket.families.values()].some(({ versions }) =>
        versions.some((version) => version.specId === command.specId),
      )
    ) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Spec ID is already allocated in this owner scope",
      });
    }
    const maximum = record.versions.reduce(
      (value, version) => Math.max(value, version.version),
      0,
    );
    if (!Number.isSafeInteger(maximum + 1)) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Published version counter is exhausted",
      });
    }
    const publishedVersion: PublishedAgentVersion = {
      specId: command.specId,
      agentId: record.family.agentId,
      version: maximum + 1,
      name: draft.name,
      kind: draft.kind,
      description: draft.description,
      pmBrief: draft.pmBrief,
      instructions: draft.instructions,
      toolRequirements: clone(draft.toolRequirements),
      triggers: clone(draft.triggers),
      testChecklist: clone(draft.testChecklist),
      publishedAt: command.occurredAt,
      publishedBy: command.publishedBy,
    };
    const family: SavedAgentFamily = {
      agentId: record.family.agentId,
      owner: record.family.owner,
      lifecycle: "active",
      activeSpecId: publishedVersion.specId,
      activeVersion: publishedVersion.version,
      revision: record.family.revision + 1,
      createdAt: record.family.createdAt,
      updatedAt: command.occurredAt,
    };
    const transition = this.#workflowTransition({
      workflow,
      draftRevision: workflow.draftRevision,
      role: "root",
      result: "published",
      toPhase: "published",
      operationId: command.mutation.operationId,
      occurredAt: command.occurredAt,
    });
    const nextWorkflow: BuildWorkflowRecord = {
      ...workflow,
      revision: workflow.revision + 1,
      phase: "published",
      published: {
        owner: clone(workflow.owner),
        workflowId: workflow.workflowId,
        agentId: workflow.agentId,
        specId: publishedVersion.specId,
        specVersion: publishedVersion.version,
        operationId: command.mutation.operationId,
        publishedAt: command.occurredAt,
      },
      transitions: [...workflow.transitions, transition],
      updatedAt: command.occurredAt,
    };
    if (
      !publishedAgentVersionSchema.safeParse(publishedVersion).success ||
      !savedAgentFamilySchema.safeParse(family).success ||
      !buildWorkflowRecordSchema.safeParse(nextWorkflow).success
    ) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Workflow publication would persist invalid state",
      });
    }
    record.family = clone(family);
    record.versions.push(clone(publishedVersion));
    bucket.workflows.set(workflow.agentId, clone(nextWorkflow));
    return {
      ok: true,
      type: "workflow_published",
      family,
      workflow: nextWorkflow,
      publishedVersion,
    };
  }

  #createFamily(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "create_family" }>,
  ): AgentBuilderStoreMutationResult {
    const checked = this.#checkFields(command.fields, command.canonicalName);
    if (checked !== null) return failure(checked);
    if (!Number.isSafeInteger(command.maxFamilies) || command.maxFamilies < 1) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Family quota must be a positive safe integer",
      });
    }
    if (bucket.families.has(command.agentId)) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Agent ID is already allocated in this owner scope",
      });
    }
    if (bucket.allocatedDraftIds.has(command.draftId)) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Draft ID is already allocated in this owner scope",
      });
    }
    const current = [...bucket.families.values()].filter(
      ({ family }) => family.lifecycle !== "deleted",
    ).length;
    if (current >= command.maxFamilies) {
      return failure({
        code: "QUOTA_EXCEEDED",
        message: "Owner family quota is exhausted",
        limit: command.maxFamilies,
        current,
      });
    }
    if (this.#nameOwner(bucket, command.canonicalName) !== null) {
      return failure({
        code: "NAME_CONFLICT",
        message: "Canonical name is reserved by another family",
        canonicalName: command.canonicalName,
      });
    }

    const family: SavedAgentFamily = {
      agentId: command.agentId,
      owner: clone(command.owner),
      lifecycle: "draft_only",
      draft: {
        draftId: command.draftId,
        ...clone(command.fields),
        draftRevision: 1,
        createdAt: command.occurredAt,
        updatedAt: command.occurredAt,
      },
      revision: 1,
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
    };
    const invalid = this.#validateFamily(family);
    if (invalid !== null) return failure(invalid);
    bucket.families.set(command.agentId, { family: clone(family), versions: [] });
    bucket.allocatedDraftIds.add(command.draftId);
    return { ok: true, type: "family_created", family };
  }

  #beginRevision(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "begin_revision" }>,
  ): AgentBuilderStoreMutationResult {
    const record = this.#liveRecord(bucket, command.agentId);
    if (record === null) return notFound();
    const conflict = this.#checkRevision(record.family, command.expectedRevision);
    if (conflict !== null) return conflict;
    if (
      record.family.lifecycle !== "active" ||
      record.family.draft !== undefined ||
      record.family.activeSpecId !== command.basedOnSpecId ||
      record.family.activeVersion !== command.basedOnVersion
    ) {
      return this.#invalidTransition(record.family, command.type);
    }
    const base = record.versions.find(
      (version) =>
        version.specId === command.basedOnSpecId &&
        version.version === command.basedOnVersion,
    );
    if (base === undefined) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Active version is missing from published history",
      });
    }
    const checked = savedAgentEditableFieldsSchema.safeParse(command.fields);
    if (!checked.success) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Revision command contains invalid editable fields",
      });
    }
    if (bucket.allocatedDraftIds.has(command.draftId)) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Draft ID is already allocated in this owner scope",
      });
    }
    const expected = editableFieldsFromVersion(base);
    if (JSON.stringify(command.fields) !== JSON.stringify(expected)) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Revision command does not copy the exact active version",
      });
    }
    const family: SavedAgentFamily = {
      ...record.family,
      draft: {
        draftId: command.draftId,
        basedOnSpecId: command.basedOnSpecId,
        basedOnVersion: command.basedOnVersion,
        ...clone(command.fields),
        draftRevision: 1,
        createdAt: command.occurredAt,
        updatedAt: command.occurredAt,
      },
      revision: record.family.revision + 1,
      updatedAt: command.occurredAt,
    };
    const result = this.#saveFamily(record, family, {
      ok: true,
      type: "revision_begun",
      family,
    });
    if (result.ok) bucket.allocatedDraftIds.add(command.draftId);
    return result;
  }

  #patchDraft(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "patch_draft" }>,
  ): AgentBuilderStoreMutationResult {
    const record = this.#liveRecord(bucket, command.agentId);
    if (record === null) return notFound();
    const conflict = this.#checkRevision(
      record.family,
      command.expectedRevision,
      command.expectedDraftRevision,
    );
    if (conflict !== null) return conflict;
    if (record.family.draft === undefined || record.family.lifecycle === "archived") {
      return this.#invalidTransition(record.family, command.type);
    }
    const checked = this.#checkFields(command.fields, command.canonicalName);
    if (checked !== null) return failure(checked);
    const owner = this.#nameOwner(bucket, command.canonicalName);
    if (owner !== null && owner !== record.family.agentId) {
      return failure({
        code: "NAME_CONFLICT",
        message: "Canonical name is reserved by another family",
        canonicalName: command.canonicalName,
      });
    }

    const family: SavedAgentFamily = {
      ...record.family,
      draft: {
        draftId: record.family.draft.draftId,
        ...(record.family.draft.basedOnSpecId === undefined
          ? {}
          : {
              basedOnSpecId: record.family.draft.basedOnSpecId,
              basedOnVersion: record.family.draft.basedOnVersion,
            }),
        ...clone(command.fields),
        draftRevision: record.family.draft.draftRevision + 1,
        createdAt: record.family.draft.createdAt,
        updatedAt: command.occurredAt,
      },
      revision: record.family.revision + 1,
      updatedAt: command.occurredAt,
    };
    const workflow = bucket.workflows.get(command.agentId);
    let invalidatedWorkflow: BuildWorkflowRecord | undefined;
    if (
      workflow !== undefined &&
      workflow.draftId === record.family.draft.draftId &&
      workflow.draftRevision === record.family.draft.draftRevision
    ) {
      const before = this.#draftFields(record.family.draft);
      const pmChanged = (["name", "kind", "description", "pmBrief"] as const).some(
        (field) => JSON.stringify(before[field]) !== JSON.stringify(command.fields[field]),
      );
      const implementationChanged = (["instructions", "toolRequirements", "triggers"] as const).some(
        (field) => JSON.stringify(before[field]) !== JSON.stringify(command.fields[field]),
      );
      const nextPhase: BuildWorkflowPhase = pmChanged
        ? "pm_work"
        : implementationChanged
          ? "implementation_work"
          : "qa_review";
      const transition = this.#workflowTransition({
        workflow,
        draftRevision: family.draft?.draftRevision ?? workflow.draftRevision,
        role: "root",
        result: workflow.qaApproval === undefined ? "draft_edited" : "approval_invalidated",
        toPhase: nextPhase,
        operationId: command.mutation.operationId,
        occurredAt: command.occurredAt,
      });
      const {
        testRunId: _testRunId,
        testEvidence: _testEvidence,
        qaApproval: _qaApproval,
        published: _published,
        ...retained
      } = workflow;
      invalidatedWorkflow = {
        ...retained,
        draftRevision: family.draft?.draftRevision ?? workflow.draftRevision,
        revision: workflow.revision + 1,
        phase: nextPhase,
        transitions: [...workflow.transitions, transition],
        updatedAt: command.occurredAt,
      };
      if (!buildWorkflowRecordSchema.safeParse(invalidatedWorkflow).success) {
        return failure({
          code: "STORE_INVARIANT_VIOLATION",
          message: "Draft edit would persist an invalid workflow invalidation",
        });
      }
    }
    const result = this.#saveFamily(record, family, {
      ok: true,
      type: "draft_patched",
      family,
    });
    if (result.ok && invalidatedWorkflow !== undefined) {
      bucket.workflows.set(command.agentId, clone(invalidatedWorkflow));
    }
    return result;
  }

  #publishDraft(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "publish_draft" }>,
  ): AgentBuilderStoreMutationResult {
    const record = this.#liveRecord(bucket, command.agentId);
    if (record === null) return notFound();
    if (bucket.workflows.has(command.agentId)) {
      return failure({
        code: "PUBLISH_NOT_READY",
        message: "Workflow-managed drafts require atomic QA-gated workflow publication",
      });
    }
    const conflict = this.#checkRevision(
      record.family,
      command.expectedRevision,
      command.expectedDraftRevision,
    );
    if (conflict !== null) return conflict;
    const draft = record.family.draft;
    if (draft === undefined || record.family.lifecycle === "archived") {
      return this.#invalidTransition(record.family, command.type);
    }
    if (
      [...bucket.families.values()].some(({ versions }) =>
        versions.some((version) => version.specId === command.specId),
      )
    ) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Spec ID is already allocated in this owner scope",
      });
    }
    const maximum = record.versions.reduce(
      (value, version) => Math.max(value, version.version),
      0,
    );
    if (!Number.isSafeInteger(maximum + 1)) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Published version counter is exhausted",
      });
    }
    const publishedVersion: PublishedAgentVersion = {
      specId: command.specId,
      agentId: record.family.agentId,
      version: maximum + 1,
      name: draft.name,
      kind: draft.kind,
      description: draft.description,
      pmBrief: draft.pmBrief,
      instructions: draft.instructions,
      toolRequirements: clone(draft.toolRequirements),
      triggers: clone(draft.triggers),
      testChecklist: clone(draft.testChecklist),
      publishedAt: command.occurredAt,
      publishedBy: command.publishedBy,
    };
    if (!publishedAgentVersionSchema.safeParse(publishedVersion).success) {
      return failure({
        code: "STORE_INVARIANT_VIOLATION",
        message: "Publication command would append an invalid version",
      });
    }
    const family: SavedAgentFamily = {
      agentId: record.family.agentId,
      owner: record.family.owner,
      lifecycle: "active",
      activeSpecId: publishedVersion.specId,
      activeVersion: publishedVersion.version,
      revision: record.family.revision + 1,
      createdAt: record.family.createdAt,
      updatedAt: command.occurredAt,
    };
    const result = this.#saveFamily(record, family, {
      ok: true,
      type: "draft_published",
      family,
      publishedVersion,
    });
    if (result.ok) record.versions.push(clone(publishedVersion));
    return result;
  }

  #activateVersion(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "activate_version" }>,
  ): AgentBuilderStoreMutationResult {
    const record = this.#liveRecord(bucket, command.agentId);
    if (record === null) return notFound();
    const conflict = this.#checkRevision(record.family, command.expectedRevision);
    if (conflict !== null) return conflict;
    if (record.family.lifecycle !== "active") {
      return this.#invalidTransition(record.family, command.type);
    }
    const version = record.versions.find(
      (candidate) =>
        candidate.specId === command.specId && candidate.version === command.version,
    );
    if (version === undefined) {
      return failure({ code: "VERSION_NOT_FOUND", message: "Published version was not found" });
    }
    const family: SavedAgentFamily = {
      ...record.family,
      activeSpecId: version.specId,
      activeVersion: version.version,
      revision: record.family.revision + 1,
      updatedAt: command.occurredAt,
    };
    return this.#saveFamily(record, family, {
      ok: true,
      type: "version_activated",
      family,
      activeVersion: version,
    });
  }

  #archiveFamily(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "archive_family" }>,
  ): AgentBuilderStoreMutationResult {
    const record = this.#liveRecord(bucket, command.agentId);
    if (record === null) return notFound();
    const conflict = this.#checkRevision(record.family, command.expectedRevision);
    if (conflict !== null) return conflict;
    if (record.family.lifecycle !== "active" && record.family.lifecycle !== "draft_only") {
      return this.#invalidTransition(record.family, command.type);
    }
    const family: SavedAgentFamily = {
      ...record.family,
      lifecycle: "archived",
      archivedAt: command.occurredAt,
      revision: record.family.revision + 1,
      updatedAt: command.occurredAt,
    };
    return this.#saveFamily(record, family, { ok: true, type: "family_archived", family });
  }

  #restoreFamily(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "restore_family" }>,
  ): AgentBuilderStoreMutationResult {
    const record = this.#liveRecord(bucket, command.agentId);
    if (record === null) return notFound();
    const conflict = this.#checkRevision(record.family, command.expectedRevision);
    if (conflict !== null) return conflict;
    if (record.family.lifecycle !== "archived") {
      return this.#invalidTransition(record.family, command.type);
    }
    const { archivedAt: _archivedAt, ...retained } = record.family;
    const family: SavedAgentFamily = {
      ...retained,
      lifecycle: record.family.activeSpecId === undefined ? "draft_only" : "active",
      revision: record.family.revision + 1,
      updatedAt: command.occurredAt,
    };
    return this.#saveFamily(record, family, { ok: true, type: "family_restored", family });
  }

  #deleteFamily(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "delete_family" }>,
  ): AgentBuilderStoreMutationResult {
    const record = this.#liveRecord(bucket, command.agentId);
    if (record === null) return notFound();
    const conflict = this.#checkRevision(record.family, command.expectedRevision);
    if (conflict !== null) return conflict;
    if (record.family.lifecycle === "deleted") return notFound();
    const previousLifecycle = record.family.lifecycle;
    const { archivedAt: _archivedAt, ...retained } = record.family;
    const family: SavedAgentFamily = {
      ...retained,
      lifecycle: "deleted",
      deletedAt: command.occurredAt,
      revision: record.family.revision + 1,
      updatedAt: command.occurredAt,
    };
    return this.#saveFamily(record, family, {
      ok: true,
      type: "family_deleted",
      family,
      previousLifecycle,
    });
  }

  #saveFamily(
    record: FamilyRecord,
    family: SavedAgentFamily,
    success: AgentBuilderStoreMutationSuccess,
  ): AgentBuilderStoreMutationResult {
    const invalid = this.#validateFamily(family);
    if (invalid !== null) return failure(invalid);
    record.family = clone(family);
    return success;
  }

  #workflowById(bucket: OwnerBucket, workflowId: string): BuildWorkflowRecord | null {
    for (const workflow of bucket.workflows.values()) {
      if (workflow.workflowId === workflowId) return workflow;
    }
    return null;
  }

  #workflowScopeIsCurrent(
    bucket: OwnerBucket,
    target: ExecutionLeaseRecord["target"],
    scope: NonNullable<ExecutionLeaseRecord["workflow"]>,
  ): boolean {
    if (target.kind !== "draft") return false;
    const workflow = bucket.workflows.get(target.agentId);
    return (
      workflow !== undefined &&
      workflow.workflowId === scope.workflowId &&
      workflow.revision === scope.workflowRevision &&
      workflow.draftId === target.draftId &&
      workflow.draftRevision === target.draftRevision &&
      workflow.testRunId === scope.testRunId
    );
  }

  #draftFields(draft: SavedAgentDraft): SavedAgentEditableFields {
    return {
      name: draft.name,
      kind: draft.kind,
      description: draft.description,
      pmBrief: draft.pmBrief,
      instructions: draft.instructions,
      toolRequirements: clone(draft.toolRequirements),
      triggers: clone(draft.triggers),
      testChecklist: clone(draft.testChecklist),
      qaFindings: clone(draft.qaFindings),
    };
  }

  #roleResultAllowed(
    role: "pm" | "implementor" | "qa",
    result: SubmitBuildRoleStoreCommand["result"],
  ): boolean {
    return role === "qa"
      ? ["needs_test", "changes_requested", "approved", "needs_user_input", "failed"].includes(
          result,
        )
      : ["completed_handoff", "needs_user_input", "failed"].includes(result);
  }

  #onlyRoleFieldsChanged(
    role: "pm" | "implementor" | "qa",
    current: SavedAgentDraft,
    next: SavedAgentEditableFields,
  ): boolean {
    const owned: Readonly<Record<typeof role, readonly (keyof SavedAgentEditableFields)[]>> = {
      pm: ["name", "kind", "description", "pmBrief"],
      implementor: ["instructions", "toolRequirements", "triggers"],
      qa: ["testChecklist", "qaFindings"],
    };
    const allowed = new Set<keyof SavedAgentEditableFields>(owned[role]);
    const before = this.#draftFields(current);
    return (Object.keys(before) as (keyof SavedAgentEditableFields)[]).every(
      (field) => allowed.has(field) || JSON.stringify(before[field]) === JSON.stringify(next[field]),
    );
  }

  #nextRolePhase(
    role: "pm" | "implementor" | "qa",
    result: SubmitBuildRoleStoreCommand["result"],
  ): BuildWorkflowPhase {
    if (result === "failed") return "terminal_failure";
    if (result === "needs_user_input") {
      return role === "pm" ? "pm_input" : role === "implementor" ? "implementation_input" : "qa_input";
    }
    if (role === "pm") return "implementation_work";
    if (role === "implementor") return "qa_review";
    if (result === "needs_test") return "test_pending";
    if (result === "changes_requested") return "implementation_work";
    return "publish_ready";
  }

  #workflowTransition(input: {
    readonly workflow: BuildWorkflowRecord;
    readonly draftRevision: number;
    readonly role: BuildWorkflowRole;
    readonly result: BuildWorkflowResult;
    readonly toPhase: BuildWorkflowPhase;
    readonly operationId: BuildWorkflowTransition["operationId"];
    readonly occurredAt: BuildWorkflowTransition["occurredAt"];
  }): BuildWorkflowTransition {
    return {
      owner: clone(input.workflow.owner),
      workflowId: input.workflow.workflowId,
      agentId: input.workflow.agentId,
      draftId: input.workflow.draftId,
      draftRevision: input.draftRevision,
      role: input.role,
      operationId: input.operationId,
      fromPhase: input.workflow.phase,
      toPhase: input.toPhase,
      result: input.result,
      occurredAt: input.occurredAt,
    };
  }

  #withoutUndefined<T>(value: T): T {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined),
    ) as T;
  }

  #validateTestStep(
    bucket: OwnerBucket,
    step: import("../test-policy.js").TestCapabilityStepScope,
  ): TestPolicyError | null {
    const workflow = this.#workflowById(bucket, step.workflowId);
    if (
      workflow === null ||
      workflow.owner.tenantKey !== step.owner.tenantKey ||
      workflow.owner.ownerKey !== step.owner.ownerKey
    ) {
      return { code: "OWNER_MISMATCH", message: "Current owner does not own the test step" };
    }
    if (
      workflow.revision !== step.workflowRevision ||
      workflow.phase !== "test_pending" ||
      workflow.testRunId !== step.testRunId ||
      workflow.agentId !== step.agentId ||
      workflow.draftId !== step.draftId ||
      workflow.draftRevision !== step.draftRevision
    ) {
      return { code: "WORKFLOW_CHANGED", message: "Exact test workflow changed" };
    }
    const record = this.#liveRecord(bucket, step.agentId);
    if (
      record?.family.draft?.draftId !== step.draftId ||
      record.family.draft.draftRevision !== step.draftRevision
    ) {
      return { code: "TARGET_CHANGED", message: "Exact tested draft changed" };
    }
    const lease = bucket.leases.get(step.childSessionId);
    if (lease === undefined || lease.leaseId !== step.leaseId) {
      return { code: "BOOTSTRAP_REQUIRED", message: "Exact test lease was not found" };
    }
    if (lease.status !== "running") {
      return { code: "LEASE_CLOSED", message: "Test lease is not running" };
    }
    if (
      lease.role !== "test_runner" ||
      lease.executionTurnId !== step.executionTurnId ||
      lease.expiresAt !== step.expiresAt ||
      !buildExecutionScopesEqual(lease.workflow, {
        workflowId: step.workflowId,
        workflowRevision: step.workflowRevision,
        testRunId: step.testRunId,
      })
    ) {
      return { code: "WORKFLOW_CHANGED", message: "Test lease scope changed" };
    }
    const capability = lease.capabilityPlan?.selected.find(
      (entry) => entry.capabilityId === step.capabilityId,
    );
    if (capability === undefined || lease.capabilityPlan?.mode !== "test") {
      return { code: "CAPABILITY_NOT_SELECTED", message: "Capability is not in the test plan" };
    }
    if (
      capability.schemaFingerprint !== step.schemaFingerprint ||
      capability.modelToolName !== step.modelToolName
    ) {
      return { code: "CAPABILITY_SCHEMA_CHANGED", message: "Capability schema changed" };
    }
    return null;
  }

  #checkFields(
    fields: SavedAgentEditableFields,
    canonicalName: string,
  ): AgentBuilderStoreError | null {
    if (!savedAgentEditableFieldsSchema.safeParse(fields).success) {
      return {
        code: "STORE_INVARIANT_VIOLATION",
        message: "Store command contains invalid editable fields",
      };
    }
    if (canonicalizeAgentName(fields.name) !== canonicalName) {
      return {
        code: "STORE_INVARIANT_VIOLATION",
        message: "Store command canonical name does not match the shared canonicalization rule",
      };
    }
    return null;
  }

  #validateFamily(family: SavedAgentFamily): AgentBuilderStoreError | null {
    if (!savedAgentFamilySchema.safeParse(family).success) {
      return {
        code: "STORE_INVARIANT_VIOLATION",
        message: "Store mutation would persist an invalid family",
      };
    }
    return null;
  }

  #checkRevision(
    family: SavedAgentFamily,
    expectedRevision: number,
    expectedDraftRevision?: number,
  ): AgentBuilderStoreMutationResult | null {
    if (
      family.revision === expectedRevision &&
      (expectedDraftRevision === undefined ||
        family.draft?.draftRevision === expectedDraftRevision)
    ) {
      return null;
    }
    return failure({
      code: "REVISION_CONFLICT",
      message: "The saved agent family changed before this transaction",
      currentRevision: family.revision,
      ...(family.draft === undefined
        ? {}
        : { currentDraftRevision: family.draft.draftRevision }),
    });
  }

  #invalidTransition(
    family: SavedAgentFamily,
    operation: AgentBuilderStoreCommand["type"],
  ): AgentBuilderStoreMutationResult {
    return failure({
      code: "INVALID_TRANSITION",
      message: `Lifecycle ${family.lifecycle} cannot perform ${operation}`,
      lifecycle: family.lifecycle,
      operation,
    });
  }

  #liveRecord(bucket: OwnerBucket, agentId: AgentId): FamilyRecord | null {
    const record = bucket.families.get(agentId);
    return record === undefined || record.family.lifecycle === "deleted" ? null : record;
  }

  #nameOwner(bucket: OwnerBucket, canonicalName: string): AgentId | null {
    for (const { family, versions } of bucket.families.values()) {
      if (
        family.draft !== undefined &&
        canonicalizeAgentName(family.draft.name) === canonicalName
      ) {
        return family.agentId;
      }
      if (versions.some((version) => canonicalizeAgentName(version.name) === canonicalName)) {
        return family.agentId;
      }
    }
    return null;
  }

  #bucket(owner: OwnerScope, create = false): OwnerBucket | undefined {
    let owners = this.#tenants.get(owner.tenantKey);
    if (owners === undefined && create) {
      owners = new Map();
      this.#tenants.set(owner.tenantKey, owners);
    }
    let bucket = owners?.get(owner.ownerKey);
    if (bucket === undefined && create && owners !== undefined) {
      bucket = {
        allocatedDraftIds: new Set(),
        closedParentTurns: new Map(),
        families: new Map(),
        grants: new Map(),
        leases: new Map(),
        operations: new Map(),
        workflows: new Map(),
        testInputGrants: new Map(),
        testExecutions: new Map(),
      };
      owners.set(owner.ownerKey, bucket);
    }
    return bucket;
  }

  #findGrant(
    tokenHash: string,
  ): { readonly bucket: OwnerBucket; readonly grant: BootstrapGrantRecord } | null {
    for (const owners of this.#tenants.values()) {
      for (const bucket of owners.values()) {
        for (const grant of bucket.grants.values()) {
          if (equalTokenHashes(grant.tokenHash, tokenHash)) return { bucket, grant };
        }
      }
    }
    return null;
  }

  #findLease(
    childSessionId: string,
  ): { readonly bucket: OwnerBucket; readonly lease: ExecutionLeaseRecord } | null {
    for (const owners of this.#tenants.values()) {
      for (const bucket of owners.values()) {
        const lease = bucket.leases.get(childSessionId);
        if (lease !== undefined) return { bucket, lease };
      }
    }
    return null;
  }

  #targetIsCurrent(bucket: OwnerBucket, target: ExecutionLeaseRecord["target"]): boolean {
    const record = bucket.families.get(target.agentId);
    if (record === undefined || record.family.lifecycle === "deleted") return false;
    if (target.kind === "draft") {
      return (
        record.family.lifecycle !== "archived" &&
        record.family.draft?.draftId === target.draftId &&
        record.family.draft.draftRevision === target.draftRevision
      );
    }
    return (
      record.family.lifecycle === "active" &&
      record.family.activeSpecId === target.specId &&
      record.family.activeVersion === target.specVersion &&
      record.versions.some(
        (version) =>
          version.specId === target.specId && version.version === target.specVersion,
      )
    );
  }

  async #locked<Value>(operation: () => Value): Promise<Value> {
    const previous = this.#lockTail;
    let release: (() => void) | undefined;
    this.#lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release?.();
    }
  }
}

export function createMemoryAgentBuilderStore(): AgentBuilderStore {
  return new MemoryAgentBuilderStore();
}

export default createMemoryAgentBuilderStore;
