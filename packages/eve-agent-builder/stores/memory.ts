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
} from "../src/domain.js";
import type {
  AgentBuilderStore,
  AgentBuilderStoreCommand,
  AgentBuilderStoreError,
  AgentBuilderStoreMutationResult,
  AgentBuilderStoreMutationSuccess,
  FamilyStoreQuery,
  MutationReplayQuery,
  MutationReplayResult,
  VersionStoreQuery,
} from "../src/store.js";

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
  readonly families: Map<AgentId, FamilyRecord>;
  readonly operations: Map<string, OperationRecord>;
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
      bucket = { allocatedDraftIds: new Set(), families: new Map(), operations: new Map() };
      owners.set(owner.ownerKey, bucket);
    }
    return bucket;
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
