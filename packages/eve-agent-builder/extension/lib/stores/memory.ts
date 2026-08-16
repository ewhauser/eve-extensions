import {
  canonicalizeAgentName,
  publishedAgentVersionSchema,
  savedAgentEditableFieldsSchema,
  savedAgentFamilySchema,
  timestampSchema,
  type AgentId,
  type OwnerScope,
  type PublishedAgentVersion,
  type SavedAgentEditableFields,
  type SavedAgentFamily,
} from "../domain.js";
import {
  bootstrapGrantRecordSchema,
  bootstrapTargetsEqual,
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
import type {
  ActiveFamilyStoreRecord,
  AgentBuilderStore,
  AgentBuilderStoreCommand,
  AgentBuilderStoreError,
  AgentBuilderStoreMutationResult,
  AgentBuilderStoreMutationSuccess,
  FamilyStoreQuery,
  MutationReplayQuery,
  MutationReplayResult,
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
          !bootstrapTargetsEqual(grant.target, command.expectedTarget));
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
    }
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
    return this.#saveFamily(record, family, { ok: true, type: "draft_patched", family });
  }

  #publishDraft(
    bucket: OwnerBucket,
    command: Extract<AgentBuilderStoreCommand, { type: "publish_draft" }>,
  ): AgentBuilderStoreMutationResult {
    const record = this.#liveRecord(bucket, command.agentId);
    if (record === null) return notFound();
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
