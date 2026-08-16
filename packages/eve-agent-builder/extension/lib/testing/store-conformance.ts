import {
  agentIdSchema,
  canonicalizeAgentName,
  capabilityIdSchema,
  draftIdSchema,
  operationIdSchema,
  specIdSchema,
  timestampSchema,
  triggerIdSchema,
  type AgentId,
  type OwnerScope,
  type SavedAgentEditableFields,
} from "../domain.js";
import type {
  AgentBuilderStore,
  AgentBuilderStoreCommand,
  AgentBuilderStoreFactory,
  AgentBuilderStoreMutationResult,
  AgentBuilderStoreMutationSuccess,
  CreateFamilyStoreCommand,
} from "../store.js";

export interface AgentBuilderStoreConformanceCase {
  readonly name: string;
  readonly run: (store: AgentBuilderStore) => Promise<void>;
}

export interface AgentBuilderStoreConformanceReport {
  readonly passed: number;
  readonly caseNames: readonly string[];
}

export interface AgentBuilderStoreConformanceOptions {
  readonly createStore: AgentBuilderStoreFactory;
  readonly disposeStore?: (store: AgentBuilderStore) => Promise<void> | void;
}

const OWNER_A: OwnerScope = { tenantKey: "Tenant", ownerKey: "Owner" };
const OWNER_B: OwnerScope = { tenantKey: "Tenant", ownerKey: "Other" };

function agentId(value: string) {
  return agentIdSchema.parse(value);
}

function draftId(value: string) {
  return draftIdSchema.parse(value);
}

function specId(value: string) {
  return specIdSchema.parse(value);
}

function operationId(value: string) {
  return operationIdSchema.parse(value);
}

function timestamp(second: number) {
  return timestampSchema.parse(`2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`);
}

function fields(
  name: string,
  overrides: Partial<SavedAgentEditableFields> = {},
): SavedAgentEditableFields {
  return {
    name,
    kind: "agent",
    description: "description",
    pmBrief: "brief",
    instructions: "instructions",
    toolRequirements: [],
    triggers: [],
    testChecklist: [],
    qaFindings: [],
    ...overrides,
  };
}

function createCommand(input: {
  readonly owner?: OwnerScope;
  readonly agent?: string;
  readonly draft?: string;
  readonly operation?: string;
  readonly fingerprint?: string;
  readonly name?: string;
  readonly maxFamilies?: number;
  readonly occurredAt?: number;
  readonly fields?: SavedAgentEditableFields;
} = {}): CreateFamilyStoreCommand {
  const editable = input.fields ?? fields(input.name ?? "Alpha");
  return {
    type: "create_family",
    owner: input.owner ?? OWNER_A,
    mutation: {
      operationId: operationId(input.operation ?? "operation-create"),
      requestFingerprint: input.fingerprint ?? `fingerprint-${input.operation ?? "create"}`,
    },
    occurredAt: timestamp(input.occurredAt ?? 1),
    agentId: agentId(input.agent ?? "agent-alpha"),
    draftId: draftId(input.draft ?? "draft-alpha"),
    maxFamilies: input.maxFamilies ?? 25,
    canonicalName: canonicalizeAgentName(editable.name),
    fields: editable,
  };
}

function baseCommand<Type extends AgentBuilderStoreCommand["type"]>(
  type: Type,
  operation: string,
  occurredAt: number,
) {
  return {
    type,
    owner: OWNER_A,
    mutation: {
      operationId: operationId(operation),
      requestFingerprint: `fingerprint-${type}-${operation}`,
    },
    occurredAt: timestamp(occurredAt),
  } as const;
}

function expectSuccess(
  result: AgentBuilderStoreMutationResult,
  type?: AgentBuilderStoreMutationSuccess["type"],
): AgentBuilderStoreMutationSuccess {
  if (!result.ok) {
    throw new Error(`Expected mutation success, received ${result.error.code}`);
  }
  if (type !== undefined && result.type !== type) {
    throw new Error(`Expected ${type}, received ${result.type}`);
  }
  return result;
}

function expectError(
  result: AgentBuilderStoreMutationResult,
  code: Exclude<AgentBuilderStoreMutationResult, { ok: true }>["error"]["code"],
) {
  if (result.ok) throw new Error(`Expected ${code}, received ${result.type}`);
  if (result.error.code !== code) {
    throw new Error(`Expected ${code}, received ${result.error.code}`);
  }
  return result.error;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

async function createFamily(
  store: AgentBuilderStore,
  command: CreateFamilyStoreCommand = createCommand(),
) {
  const created = expectSuccess(await store.mutate(command), "family_created");
  assert(created.type === "family_created", "Expected a family_created result");
  return created.family;
}

async function publish(
  store: AgentBuilderStore,
  input: {
    readonly agent: AgentId;
    readonly familyRevision: number;
    readonly draftRevision: number;
    readonly spec: string;
    readonly operation: string;
    readonly occurredAt: number;
  },
) {
  const result = expectSuccess(
    await store.mutate({
      ...baseCommand("publish_draft", input.operation, input.occurredAt),
      agentId: input.agent,
      expectedRevision: input.familyRevision,
      expectedDraftRevision: input.draftRevision,
      specId: specId(input.spec),
      publishedBy: "principal-user-a",
    }),
    "draft_published",
  );
  assert(result.type === "draft_published", "Expected a draft_published result");
  return result;
}

async function beginRevision(
  store: AgentBuilderStore,
  input: {
    readonly agent: AgentId;
    readonly familyRevision: number;
    readonly spec: string;
    readonly version: number;
    readonly draft: string;
    readonly operation: string;
    readonly occurredAt: number;
    readonly fields: SavedAgentEditableFields;
  },
) {
  const result = expectSuccess(
    await store.mutate({
      ...baseCommand("begin_revision", input.operation, input.occurredAt),
      agentId: input.agent,
      expectedRevision: input.familyRevision,
      draftId: draftId(input.draft),
      basedOnSpecId: specId(input.spec),
      basedOnVersion: input.version,
      fields: input.fields,
    }),
    "revision_begun",
  );
  assert(result.type === "revision_begun", "Expected a revision_begun result");
  return result.family;
}

const cases: readonly AgentBuilderStoreConformanceCase[] = [
  {
    name: "opaque case-sensitive owner scopes and indistinguishable cross-owner access",
    run: async (store) => {
      const created = await createFamily(store);
      assert(created.draft !== undefined, "Created family must have a draft");
      const published = await publish(store, {
        agent: created.agentId,
        familyRevision: created.revision,
        draftRevision: created.draft.draftRevision,
        spec: "owner-scope-v1",
        operation: "owner-scope-publish",
        occurredAt: 2,
      });
      const family = published.family;
      equal(
        (await store.getFamily({ owner: OWNER_A, agentId: family.agentId }))?.agentId,
        family.agentId,
        "Exact owner must read its family",
      );
      equal(
        (await store.listVersions({ owner: OWNER_A, agentId: family.agentId })).length,
        1,
        "Exact owner must list published history",
      );
      equal(
        (
          await store.getVersion({
            owner: OWNER_A,
            agentId: family.agentId,
            specId: published.publishedVersion.specId,
            version: published.publishedVersion.version,
          })
        )?.specId,
        published.publishedVersion.specId,
        "Exact owner must read a published version",
      );
      for (const owner of [
        OWNER_B,
        { tenantKey: "tenant", ownerKey: "Owner" },
        { tenantKey: "Tenant", ownerKey: "owner" },
      ]) {
        equal(
          await store.getFamily({ owner, agentId: family.agentId }),
          null,
          "Cross-owner reads must be not-found",
        );
        equal(
          (await store.listVersions({ owner, agentId: family.agentId })).length,
          0,
          "Cross-owner history must be empty",
        );
        equal(
          await store.getVersion({
            owner,
            agentId: family.agentId,
            specId: published.publishedVersion.specId,
            version: published.publishedVersion.version,
          }),
          null,
          "Cross-owner version reads must be not-found",
        );
        const mutation = await store.mutate({
          ...baseCommand("archive_family", `cross-${owner.tenantKey}-${owner.ownerKey}`, 3),
          owner,
          agentId: family.agentId,
          expectedRevision: family.revision,
        });
        expectError(mutation, "NOT_FOUND");
      }
    },
  },
  {
    name: "family and draft CAS conflicts contain current revision metadata",
    run: async (store) => {
      const created = await createFamily(store);
      assert(created.draft !== undefined, "Created family must have a draft");
      const patched = expectSuccess(
        await store.mutate({
          ...baseCommand("patch_draft", "patch-one", 2),
          agentId: created.agentId,
          expectedRevision: created.revision,
          expectedDraftRevision: created.draft.draftRevision,
          canonicalName: canonicalizeAgentName("Beta"),
          fields: fields("Beta"),
        }),
        "draft_patched",
      );
      assert(patched.type === "draft_patched", "Expected a patched draft");
      assert(patched.family.draft !== undefined, "Patched family must have a draft");

      const staleFamily = expectError(
        await store.mutate({
          ...baseCommand("patch_draft", "patch-stale-family", 3),
          agentId: created.agentId,
          expectedRevision: created.revision,
          expectedDraftRevision: patched.family.draft.draftRevision,
          canonicalName: canonicalizeAgentName("Gamma"),
          fields: fields("Gamma"),
        }),
        "REVISION_CONFLICT",
      );
      assert(staleFamily.code === "REVISION_CONFLICT", "Expected a revision conflict");
      equal(staleFamily.currentRevision, patched.family.revision, "Current family revision");
      equal(
        staleFamily.currentDraftRevision,
        patched.family.draft.draftRevision,
        "Current draft revision",
      );

      const staleDraft = expectError(
        await store.mutate({
          ...baseCommand("patch_draft", "patch-stale-draft", 4),
          agentId: created.agentId,
          expectedRevision: patched.family.revision,
          expectedDraftRevision: created.draft.draftRevision,
          canonicalName: canonicalizeAgentName("Gamma"),
          fields: fields("Gamma"),
        }),
        "REVISION_CONFLICT",
      );
      assert(staleDraft.code === "REVISION_CONFLICT", "Expected a draft revision conflict");
      equal(staleDraft.currentRevision, patched.family.revision, "Draft conflict family revision");
      equal(
        staleDraft.currentDraftRevision,
        patched.family.draft.draftRevision,
        "Draft conflict current revision",
      );
    },
  },
  {
    name: "operation identity replays exact success and rejects identity reuse",
    run: async (store) => {
      const command = createCommand();
      const first = expectSuccess(await store.mutate(command), "family_created");
      const second = expectSuccess(await store.mutate(command), "family_created");
      assert(first.type === "family_created" && second.type === "family_created", "Create results");
      equal(second.family.agentId, first.family.agentId, "Replay agent ID");
      equal(second.family.draft?.draftId, first.family.draft?.draftId, "Replay draft ID");

      const replay = await store.getMutationReplay({ owner: OWNER_A, mutation: command.mutation });
      equal(replay.status, "replay", "Replay ledger lookup");
      const mismatchedFingerprint = await store.getMutationReplay({
        owner: OWNER_A,
        mutation: { ...command.mutation, requestFingerprint: "different" },
      });
      equal(
        mismatchedFingerprint.status,
        "operation_id_reused",
        "Replay lookup must reject a different fingerprint",
      );
      if (mismatchedFingerprint.status === "operation_id_reused") {
        equal(
          mismatchedFingerprint.priorResultType,
          "family_created",
          "Replay lookup prior result type",
        );
      }
      equal(
        (await store.getMutationReplay({ owner: OWNER_B, mutation: command.mutation })).status,
        "miss",
        "Replay lookup must remain owner-scoped",
      );
      const reused = expectError(
        await store.mutate({
          ...command,
          mutation: { ...command.mutation, requestFingerprint: "different" },
          agentId: agentId("agent-different"),
        }),
        "OPERATION_ID_REUSED",
      );
      assert(reused.code === "OPERATION_ID_REUSED", "Expected reused operation identity");
      equal(reused.priorResultType, "family_created", "Prior replay result type");
    },
  },
  {
    name: "every lifecycle command replays without a duplicate transition",
    run: async (store) => {
      const create = createCommand({ operation: "replay-all-create" });
      const created = expectSuccess(await store.mutate(create), "family_created");
      expectSuccess(await store.mutate(create), "family_created");
      assert(created.type === "family_created" && created.family.draft !== undefined, "Created draft");

      const publishV1 = {
        ...baseCommand("publish_draft", "replay-all-publish-v1", 2),
        agentId: created.family.agentId,
        expectedRevision: created.family.revision,
        expectedDraftRevision: created.family.draft.draftRevision,
        specId: specId("replay-all-v1"),
        publishedBy: "principal-user-a",
      } as const;
      const v1 = expectSuccess(await store.mutate(publishV1), "draft_published");
      expectSuccess(await store.mutate(publishV1), "draft_published");
      assert(v1.type === "draft_published", "Published v1");

      const begin = {
        ...baseCommand("begin_revision", "replay-all-begin", 3),
        agentId: created.family.agentId,
        expectedRevision: v1.family.revision,
        draftId: draftId("replay-all-draft-v2"),
        basedOnSpecId: v1.publishedVersion.specId,
        basedOnVersion: v1.publishedVersion.version,
        fields: fields("Alpha"),
      } as const;
      const begun = expectSuccess(await store.mutate(begin), "revision_begun");
      expectSuccess(await store.mutate(begin), "revision_begun");
      assert(begun.type === "revision_begun" && begun.family.draft !== undefined, "Began v2");

      const patch = {
        ...baseCommand("patch_draft", "replay-all-patch", 4),
        agentId: created.family.agentId,
        expectedRevision: begun.family.revision,
        expectedDraftRevision: begun.family.draft.draftRevision,
        canonicalName: canonicalizeAgentName("Alpha"),
        fields: fields("Alpha", { instructions: "v2" }),
      } as const;
      const patched = expectSuccess(await store.mutate(patch), "draft_patched");
      expectSuccess(await store.mutate(patch), "draft_patched");
      assert(patched.type === "draft_patched" && patched.family.draft !== undefined, "Patched v2");

      const publishV2 = {
        ...baseCommand("publish_draft", "replay-all-publish-v2", 5),
        agentId: created.family.agentId,
        expectedRevision: patched.family.revision,
        expectedDraftRevision: patched.family.draft.draftRevision,
        specId: specId("replay-all-v2"),
        publishedBy: "principal-user-a",
      } as const;
      const v2 = expectSuccess(await store.mutate(publishV2), "draft_published");
      expectSuccess(await store.mutate(publishV2), "draft_published");
      assert(v2.type === "draft_published", "Published v2");

      const activate = {
        ...baseCommand("activate_version", "replay-all-activate", 6),
        agentId: created.family.agentId,
        expectedRevision: v2.family.revision,
        specId: v1.publishedVersion.specId,
        version: v1.publishedVersion.version,
      } as const;
      const activated = expectSuccess(await store.mutate(activate), "version_activated");
      expectSuccess(await store.mutate(activate), "version_activated");
      assert(activated.type === "version_activated", "Activated v1");

      const archive = {
        ...baseCommand("archive_family", "replay-all-archive", 7),
        agentId: created.family.agentId,
        expectedRevision: activated.family.revision,
      } as const;
      const archived = expectSuccess(await store.mutate(archive), "family_archived");
      expectSuccess(await store.mutate(archive), "family_archived");
      assert(archived.type === "family_archived", "Archived family");

      const restore = {
        ...baseCommand("restore_family", "replay-all-restore", 8),
        agentId: created.family.agentId,
        expectedRevision: archived.family.revision,
      } as const;
      const restored = expectSuccess(await store.mutate(restore), "family_restored");
      expectSuccess(await store.mutate(restore), "family_restored");
      assert(restored.type === "family_restored", "Restored family");

      const remove = {
        ...baseCommand("delete_family", "replay-all-delete", 9),
        agentId: created.family.agentId,
        expectedRevision: restored.family.revision,
      } as const;
      const deleted = expectSuccess(await store.mutate(remove), "family_deleted");
      expectSuccess(await store.mutate(remove), "family_deleted");
      assert(deleted.type === "family_deleted", "Deleted family");
      equal(deleted.family.revision, 9, "Retries must not bump revisions twice");
      equal(
        (await store.listVersions({ owner: OWNER_A, agentId: created.family.agentId })).length,
        2,
        "Retries must not append duplicate versions",
      );
    },
  },
  {
    name: "concurrent quota, name, and exact-create races commit atomically",
    run: async (store) => {
      const quotaResults = await Promise.all([
        store.mutate(
          createCommand({
            agent: "agent-quota-a",
            draft: "draft-quota-a",
            operation: "quota-a",
            name: "Quota A",
            maxFamilies: 1,
          }),
        ),
        store.mutate(
          createCommand({
            agent: "agent-quota-b",
            draft: "draft-quota-b",
            operation: "quota-b",
            name: "Quota B",
            maxFamilies: 1,
          }),
        ),
      ]);
      equal(quotaResults.filter((result) => result.ok).length, 1, "Exactly one quota create");
      equal(
        quotaResults.filter((result) => !result.ok && result.error.code === "QUOTA_EXCEEDED")
          .length,
        1,
        "Exactly one quota rejection",
      );

      const secondOwner: OwnerScope = { tenantKey: "Race", ownerKey: "Names" };
      const nameResults = await Promise.all([
        store.mutate(
          createCommand({
            owner: secondOwner,
            agent: "agent-name-a",
            draft: "draft-name-a",
            operation: "name-a",
            name: "Ａlpha\tName",
          }),
        ),
        store.mutate(
          createCommand({
            owner: secondOwner,
            agent: "agent-name-b",
            draft: "draft-name-b",
            operation: "name-b",
            name: "alpha name",
          }),
        ),
      ]);
      equal(nameResults.filter((result) => result.ok).length, 1, "Exactly one name create");
      equal(
        nameResults.filter((result) => !result.ok && result.error.code === "NAME_CONFLICT")
          .length,
        1,
        "Exactly one name conflict",
      );

      const retryOwner: OwnerScope = { tenantKey: "Race", ownerKey: "Retry" };
      const retryCommand = createCommand({ owner: retryOwner, operation: "same-create" });
      const retryResults = await Promise.all([
        store.mutate(retryCommand),
        store.mutate(retryCommand),
      ]);
      equal(retryResults.filter((result) => result.ok).length, 2, "Both retries succeed");
      const agentIds = retryResults.map((result) =>
        result.ok && result.type === "family_created" ? result.family.agentId : "",
      );
      equal(agentIds[0], agentIds[1], "Concurrent retry returns one committed family");
    },
  },
  {
    name: "publish appends immutable max+1 version and atomically advances the pointer",
    run: async (store) => {
      const created = await createFamily(store);
      assert(created.draft !== undefined, "Created family must have a draft");
      const v1 = await publish(store, {
        agent: created.agentId,
        familyRevision: created.revision,
        draftRevision: created.draft.draftRevision,
        spec: "spec-v1",
        operation: "publish-v1",
        occurredAt: 2,
      });
      equal(v1.publishedVersion.version, 1, "First version number");
      equal(v1.family.activeSpecId, v1.publishedVersion.specId, "Active spec pointer");
      equal(v1.family.activeVersion, 1, "Active version pointer");
      equal(v1.family.draft, undefined, "Publish clears the draft");
      equal(v1.family.revision, created.revision + 1, "Publish bumps family revision once");

      const revision = await beginRevision(store, {
        agent: created.agentId,
        familyRevision: v1.family.revision,
        spec: "spec-v1",
        version: 1,
        draft: "draft-v2",
        operation: "begin-v2",
        occurredAt: 3,
        fields: fields("Alpha"),
      });
      assert(revision.draft !== undefined, "Revision must create a draft");
      const patched = expectSuccess(
        await store.mutate({
          ...baseCommand("patch_draft", "patch-v2", 4),
          agentId: created.agentId,
          expectedRevision: revision.revision,
          expectedDraftRevision: revision.draft.draftRevision,
          canonicalName: canonicalizeAgentName("Beta"),
          fields: fields("Beta", { instructions: "v2 instructions" }),
        }),
        "draft_patched",
      );
      assert(patched.type === "draft_patched" && patched.family.draft !== undefined, "Patched v2");
      const v2 = await publish(store, {
        agent: created.agentId,
        familyRevision: patched.family.revision,
        draftRevision: patched.family.draft.draftRevision,
        spec: "spec-v2",
        operation: "publish-v2",
        occurredAt: 5,
      });
      equal(v2.publishedVersion.version, 2, "Second version number");
      const persistedV1 = await store.getVersion({
        owner: OWNER_A,
        agentId: created.agentId,
        specId: specId("spec-v1"),
        version: 1,
      });
      assert(persistedV1 !== null, "First version must remain readable");
      equal(persistedV1.name, "Alpha", "First version name remains immutable");
      equal(persistedV1.instructions, "instructions", "First version content remains immutable");
      equal(
        (await store.listVersions({ owner: OWNER_A, agentId: created.agentId })).length,
        2,
        "History length",
      );

      const revisionV3 = await beginRevision(store, {
        agent: created.agentId,
        familyRevision: v2.family.revision,
        spec: "spec-v2",
        version: 2,
        draft: "draft-v3",
        operation: "begin-v3",
        occurredAt: 6,
        fields: fields("Beta", { instructions: "v2 instructions" }),
      });
      assert(revisionV3.draft !== undefined, "v3 revision must create a draft");
      const publishRace = await Promise.all([
        store.mutate({
          ...baseCommand("publish_draft", "publish-v3-a", 7),
          agentId: created.agentId,
          expectedRevision: revisionV3.revision,
          expectedDraftRevision: revisionV3.draft.draftRevision,
          specId: specId("spec-v3-a"),
          publishedBy: "principal-user-a",
        }),
        store.mutate({
          ...baseCommand("publish_draft", "publish-v3-b", 8),
          agentId: created.agentId,
          expectedRevision: revisionV3.revision,
          expectedDraftRevision: revisionV3.draft.draftRevision,
          specId: specId("spec-v3-b"),
          publishedBy: "principal-user-a",
        }),
      ]);
      equal(publishRace.filter((result) => result.ok).length, 1, "One concurrent publish commits");
      equal(
        publishRace.filter((result) => !result.ok && result.error.code === "REVISION_CONFLICT")
          .length,
        1,
        "One concurrent publish conflicts",
      );
      const winner = publishRace.find(
        (result): result is Extract<AgentBuilderStoreMutationSuccess, { type: "draft_published" }> =>
          result.ok && result.type === "draft_published",
      );
      assert(winner !== undefined, "Concurrent publish winner must be typed");
      const afterRace = await store.getFamily({ owner: OWNER_A, agentId: created.agentId });
      equal(afterRace?.activeSpecId, winner.publishedVersion.specId, "Winner advances exact pointer");
      equal(
        (await store.listVersions({ owner: OWNER_A, agentId: created.agentId })).length,
        3,
        "Concurrent publish appends exactly one version",
      );
    },
  },
  {
    name: "rollback preserves a draft base and later publication uses max historical version",
    run: async (store) => {
      const created = await createFamily(store);
      assert(created.draft !== undefined, "Created family must have a draft");
      const v1 = await publish(store, {
        agent: created.agentId,
        familyRevision: 1,
        draftRevision: 1,
        spec: "rollback-v1",
        operation: "rollback-publish-v1",
        occurredAt: 2,
      });
      const draftV2 = await beginRevision(store, {
        agent: created.agentId,
        familyRevision: v1.family.revision,
        spec: "rollback-v1",
        version: 1,
        draft: "rollback-draft-v2",
        operation: "rollback-begin-v2",
        occurredAt: 3,
        fields: fields("Alpha"),
      });
      assert(draftV2.draft !== undefined, "v2 draft");
      const patchedV2 = expectSuccess(
        await store.mutate({
          ...baseCommand("patch_draft", "rollback-patch-v2", 4),
          agentId: created.agentId,
          expectedRevision: draftV2.revision,
          expectedDraftRevision: 1,
          canonicalName: canonicalizeAgentName("Alpha"),
          fields: fields("Alpha", { instructions: "version two" }),
        }),
      );
      assert(patchedV2.type === "draft_patched" && patchedV2.family.draft !== undefined, "v2 patch");
      const v2 = await publish(store, {
        agent: created.agentId,
        familyRevision: patchedV2.family.revision,
        draftRevision: patchedV2.family.draft.draftRevision,
        spec: "rollback-v2",
        operation: "rollback-publish-v2",
        occurredAt: 5,
      });
      const draftV3 = await beginRevision(store, {
        agent: created.agentId,
        familyRevision: v2.family.revision,
        spec: "rollback-v2",
        version: 2,
        draft: "rollback-draft-v3",
        operation: "rollback-begin-v3",
        occurredAt: 6,
        fields: fields("Alpha", { instructions: "version two" }),
      });
      assert(draftV3.draft !== undefined, "v3 draft");
      const rollback = expectSuccess(
        await store.mutate({
          ...baseCommand("activate_version", "rollback-activate-v1", 7),
          agentId: created.agentId,
          expectedRevision: draftV3.revision,
          specId: specId("rollback-v1"),
          version: 1,
        }),
        "version_activated",
      );
      assert(rollback.type === "version_activated", "Rollback result");
      equal(rollback.family.activeVersion, 1, "Rollback changes active pointer");
      equal(rollback.family.draft?.basedOnVersion, 2, "Rollback preserves explicit draft base");
      equal(rollback.family.draft?.draftId, draftV3.draft.draftId, "Rollback preserves draft identity");
      const v3 = await publish(store, {
        agent: created.agentId,
        familyRevision: rollback.family.revision,
        draftRevision: rollback.family.draft?.draftRevision ?? 0,
        spec: "rollback-v3",
        operation: "rollback-publish-v3",
        occurredAt: 8,
      });
      equal(v3.publishedVersion.version, 3, "Publish after rollback uses maximum history plus one");
      equal(v3.family.activeSpecId, specId("rollback-v3"), "New publication becomes active");
    },
  },
  {
    name: "archive, restore, delete, quota accounting, and retained history",
    run: async (store) => {
      const draftOwner: OwnerScope = { tenantKey: "Lifecycle", ownerKey: "Draft" };
      const draftOnly = await createFamily(
        store,
        createCommand({
          owner: draftOwner,
          agent: "draft-only-agent",
          draft: "draft-only-draft",
          operation: "draft-only-create",
          name: "Draft only",
        }),
      );
      const draftArchived = expectSuccess(
        await store.mutate({
          ...baseCommand("archive_family", "draft-only-archive", 2),
          owner: draftOwner,
          agentId: draftOnly.agentId,
          expectedRevision: draftOnly.revision,
        }),
        "family_archived",
      );
      assert(draftArchived.type === "family_archived", "Draft-only archive result");
      const draftRestored = expectSuccess(
        await store.mutate({
          ...baseCommand("restore_family", "draft-only-restore", 3),
          owner: draftOwner,
          agentId: draftOnly.agentId,
          expectedRevision: draftArchived.family.revision,
        }),
        "family_restored",
      );
      assert(draftRestored.type === "family_restored", "Draft-only restore result");
      equal(draftRestored.family.lifecycle, "draft_only", "Draft-only restore lifecycle");
      equal(
        draftRestored.family.draft?.draftId,
        draftOnly.draft?.draftId,
        "Draft-only restore retains the draft",
      );

      const created = await createFamily(
        store,
        createCommand({ maxFamilies: 1, name: "Reserved", operation: "retention-create" }),
      );
      assert(created.draft !== undefined, "Created family must have a draft");
      const published = await publish(store, {
        agent: created.agentId,
        familyRevision: 1,
        draftRevision: 1,
        spec: "retention-v1",
        operation: "retention-publish",
        occurredAt: 2,
      });
      const archived = expectSuccess(
        await store.mutate({
          ...baseCommand("archive_family", "retention-archive", 3),
          agentId: created.agentId,
          expectedRevision: published.family.revision,
        }),
        "family_archived",
      );
      assert(archived.type === "family_archived", "Archive result");
      equal(archived.family.lifecycle, "archived", "Archived lifecycle");
      equal(archived.family.activeVersion, 1, "Archive retains active pointer");
      expectError(
        await store.mutate(
          createCommand({
            agent: "quota-after-archive",
            draft: "quota-after-archive-draft",
            operation: "quota-after-archive",
            name: "Other",
            maxFamilies: 1,
          }),
        ),
        "QUOTA_EXCEEDED",
      );
      const restored = expectSuccess(
        await store.mutate({
          ...baseCommand("restore_family", "retention-restore", 4),
          agentId: created.agentId,
          expectedRevision: archived.family.revision,
        }),
        "family_restored",
      );
      assert(restored.type === "family_restored", "Restore result");
      equal(restored.family.lifecycle, "active", "Published family restores active");
      const deleted = expectSuccess(
        await store.mutate({
          ...baseCommand("delete_family", "retention-delete", 5),
          agentId: created.agentId,
          expectedRevision: restored.family.revision,
        }),
        "family_deleted",
      );
      assert(deleted.type === "family_deleted", "Delete result");
      equal(deleted.family.lifecycle, "deleted", "Delete tombstones family");
      expectError(
        await store.mutate({
          ...baseCommand("restore_family", "retention-resurrect", 6),
          agentId: created.agentId,
          expectedRevision: deleted.family.revision,
        }),
        "NOT_FOUND",
      );
      const retained = await store.getFamily({ owner: OWNER_A, agentId: created.agentId });
      equal(retained?.lifecycle, "deleted", "Trusted store read retains tombstone");
      equal(
        (await store.listVersions({ owner: OWNER_A, agentId: created.agentId })).length,
        1,
        "Published history remains after delete",
      );
      await createFamily(
        store,
        createCommand({
          agent: "after-delete-agent",
          draft: "after-delete-draft",
          operation: "after-delete-create",
          name: "Other",
          maxFamilies: 1,
        }),
      );
      expectError(
        await store.mutate(
          createCommand({
            agent: "reuse-deleted-name",
            draft: "reuse-deleted-name-draft",
            operation: "reuse-deleted-name",
            name: " reserved ",
            maxFamilies: 2,
          }),
        ),
        "NAME_CONFLICT",
      );
    },
  },
  {
    name: "historical aliases stay reserved to one family across rename and archive",
    run: async (store) => {
      const unpublished = await createFamily(
        store,
        createCommand({
          agent: "unpublished-agent",
          draft: "unpublished-draft",
          operation: "unpublished-create",
          name: "Temporary",
        }),
      );
      assert(unpublished.draft !== undefined, "Unpublished draft");
      expectSuccess(
        await store.mutate({
          ...baseCommand("patch_draft", "unpublished-rename", 2),
          agentId: unpublished.agentId,
          expectedRevision: unpublished.revision,
          expectedDraftRevision: unpublished.draft.draftRevision,
          canonicalName: canonicalizeAgentName("Permanent"),
          fields: fields("Permanent"),
        }),
        "draft_patched",
      );
      await createFamily(
        store,
        createCommand({
          agent: "released-unpublished-agent",
          draft: "released-unpublished-draft",
          operation: "released-unpublished-create",
          name: "temporary",
        }),
      );

      const created = await createFamily(store);
      assert(created.draft !== undefined, "Created draft");
      const v1 = await publish(store, {
        agent: created.agentId,
        familyRevision: 1,
        draftRevision: 1,
        spec: "name-v1",
        operation: "name-publish-v1",
        occurredAt: 2,
      });
      const revision = await beginRevision(store, {
        agent: created.agentId,
        familyRevision: v1.family.revision,
        spec: "name-v1",
        version: 1,
        draft: "name-draft-v2",
        operation: "name-begin-v2",
        occurredAt: 3,
        fields: fields("Alpha"),
      });
      assert(revision.draft !== undefined, "Name revision draft");
      const renamed = expectSuccess(
        await store.mutate({
          ...baseCommand("patch_draft", "name-patch-v2", 4),
          agentId: created.agentId,
          expectedRevision: revision.revision,
          expectedDraftRevision: revision.draft.draftRevision,
          canonicalName: canonicalizeAgentName("Beta"),
          fields: fields("Beta"),
        }),
        "draft_patched",
      );
      assert(renamed.type === "draft_patched" && renamed.family.draft !== undefined, "Rename result");
      const v2 = await publish(store, {
        agent: created.agentId,
        familyRevision: renamed.family.revision,
        draftRevision: renamed.family.draft.draftRevision,
        spec: "name-v2",
        operation: "name-publish-v2",
        occurredAt: 5,
      });
      for (const [name, suffix] of [
        ["alpha", "alpha"],
        ["ＢＥＴＡ", "beta"],
      ] as const) {
        expectError(
          await store.mutate(
            createCommand({
              agent: `name-conflict-${suffix}`,
              draft: `name-conflict-draft-${suffix}`,
              operation: `name-conflict-${suffix}`,
              name,
            }),
          ),
          "NAME_CONFLICT",
        );
      }
      const archived = expectSuccess(
        await store.mutate({
          ...baseCommand("archive_family", "name-archive", 6),
          agentId: created.agentId,
          expectedRevision: v2.family.revision,
        }),
      );
      assert(archived.type === "family_archived", "Archived family");
      expectError(
        await store.mutate(
          createCommand({
            agent: "name-conflict-archived",
            draft: "name-conflict-archived-draft",
            operation: "name-conflict-archived",
            name: "Alpha",
          }),
        ),
        "NAME_CONFLICT",
      );
    },
  },
  {
    name: "skill, duplicate identifier, canonical-name, and timestamp invariants fail closed",
    run: async (store) => {
      await createFamily(
        store,
        createCommand({
          agent: "allocated-id-agent",
          draft: "allocated-draft",
          operation: "allocated-id-create",
          name: "Allocated",
        }),
      );
      expectError(
        await store.mutate(
          createCommand({
            agent: "duplicate-draft-agent",
            draft: "allocated-draft",
            operation: "duplicate-draft-create",
            name: "Different",
          }),
        ),
        "STORE_INVARIANT_VIOLATION",
      );
      const capability = capabilityIdSchema.parse("capability-one");
      expectError(
        await store.mutate(
          createCommand({
            operation: "invalid-skill-capability",
            fields: fields("Skill", {
              kind: "skill",
              toolRequirements: [
                {
                  capabilityId: capability,
                  level: "required",
                  displayNameSnapshot: "Capability",
                  schemaFingerprint: "schema-v1",
                  consequential: false,
                },
              ],
            }),
          }),
        ),
        "STORE_INVARIANT_VIOLATION",
      );
      const trigger = {
        kind: "event" as const,
        triggerId: triggerIdSchema.parse("trigger-one"),
        sourceId: "source",
        filter: {},
        destination: { channelKind: "slack", address: "C123" },
      };
      expectError(
        await store.mutate(
          createCommand({
            operation: "invalid-duplicates",
            fields: fields("Duplicates", {
              triggers: [trigger, trigger],
            }),
          }),
        ),
        "STORE_INVARIANT_VIOLATION",
      );
      const mismatch = createCommand({ operation: "invalid-canonical" });
      expectError(
        await store.mutate({ ...mismatch, canonicalName: "not-the-name" }),
        "STORE_INVARIANT_VIOLATION",
      );
      const invalidTimestamp = createCommand({ operation: "invalid-time" });
      expectError(
        await store.mutate({
          ...invalidTimestamp,
          occurredAt: "2026-01-01T00:00:00Z" as typeof invalidTimestamp.occurredAt,
        }),
        "STORE_INVARIANT_VIOLATION",
      );
    },
  },
  {
    name: "active-family listing is owner scoped, excludes non-active state, and returns exact immutable versions",
    run: async (store) => {
      const created = await createFamily(store);
      assert(created.draft !== undefined, "Created family must have a draft");
      equal((await store.listActiveFamilies(OWNER_A)).length, 0, "Draft-only family leaked");
      const published = await publish(store, {
        agent: created.agentId,
        familyRevision: created.revision,
        draftRevision: created.draft.draftRevision,
        spec: "active-list-v1",
        operation: "active-list-publish",
        occurredAt: 2,
      });
      const listed = await store.listActiveFamilies(OWNER_A);
      equal(listed.length, 1, "Active family was not listed");
      equal(listed[0]?.family.agentId, created.agentId, "Wrong active family listed");
      equal(
        listed[0]?.activeVersion.specId,
        published.publishedVersion.specId,
        "Listing did not include exact active version",
      );
      equal((await store.listActiveFamilies(OWNER_B)).length, 0, "Cross-owner active family leaked");
      try {
        (listed[0]?.activeVersion as { name: string }).name = "tampered";
      } catch {
        // Runtime freezing is allowed; durable reference isolation is required.
      }
      equal(
        (await store.listActiveFamilies(OWNER_A))[0]?.activeVersion.name,
        "Alpha",
        "Active listing exposed a mutable durable reference",
      );
      expectSuccess(
        await store.mutate({
          ...baseCommand("archive_family", "active-list-archive", 4),
          agentId: created.agentId,
          expectedRevision: published.family.revision,
        }),
        "family_archived",
      );
      equal((await store.listActiveFamilies(OWNER_A)).length, 0, "Archived family leaked");
    },
  },
  {
    name: "exact spec/version pairs are required and returned values do not leak mutable references",
    run: async (store) => {
      const created = await createFamily(store);
      assert(created.draft !== undefined, "Created family draft");
      try {
        (created.draft as { name: string }).name = "tampered";
      } catch {
        // Runtime freezing is allowed but not required; the durable state must be isolated.
      }
      equal(
        (await store.getFamily({ owner: OWNER_A, agentId: created.agentId }))?.draft?.name,
        "Alpha",
        "Returned draft must not expose a mutable store reference",
      );
      const published = await publish(store, {
        agent: created.agentId,
        familyRevision: 1,
        draftRevision: 1,
        spec: "pair-v1",
        operation: "pair-publish",
        occurredAt: 2,
      });
      const wrongPair = await store.getVersion({
        owner: OWNER_A,
        agentId: created.agentId,
        specId: published.publishedVersion.specId,
        version: 2,
      });
      equal(wrongPair, null, "Mismatched spec/version pair must not resolve");
      expectError(
        await store.mutate({
          ...baseCommand("activate_version", "pair-activate-wrong", 3),
          agentId: created.agentId,
          expectedRevision: published.family.revision,
          specId: published.publishedVersion.specId,
          version: 2,
        }),
        "VERSION_NOT_FOUND",
      );
      const persisted = await store.getVersion({
        owner: OWNER_A,
        agentId: created.agentId,
        specId: published.publishedVersion.specId,
        version: 1,
      });
      assert(persisted !== null, "Published version must remain readable");
      try {
        (persisted as { name: string }).name = "tampered version";
      } catch {
        // Runtime freezing is allowed but not required; the durable state must be isolated.
      }
      equal(
        (
          await store.getVersion({
            owner: OWNER_A,
            agentId: created.agentId,
            specId: published.publishedVersion.specId,
            version: 1,
          })
        )?.name,
        "Alpha",
        "Returned version must not expose a mutable store reference",
      );
    },
  },
];

export const agentBuilderStoreConformanceCases = cases;

/** Runs every PR-02 durability case against a fresh adapter instance. */
export async function runAgentBuilderStoreConformanceSuite(
  factoryOrOptions: AgentBuilderStoreFactory | AgentBuilderStoreConformanceOptions,
): Promise<AgentBuilderStoreConformanceReport> {
  const options =
    typeof factoryOrOptions === "function"
      ? { createStore: factoryOrOptions }
      : factoryOrOptions;
  const passed: string[] = [];
  for (const testCase of cases) {
    const store = await options.createStore();
    try {
      await testCase.run(store);
      passed.push(testCase.name);
    } catch (cause) {
      throw new Error(`AgentBuilderStore conformance failed: ${testCase.name}`, { cause });
    } finally {
      await options.disposeStore?.(store);
    }
  }
  return Object.freeze({ passed: passed.length, caseNames: Object.freeze(passed) });
}
