import type { SessionAuthContext } from "eve/context";
import { describe, expect, it } from "vitest";

import {
  capabilityIdSchema,
  triggerIdSchema,
  type AgentId,
  type OwnerResolutionInput,
  type OwnerScope,
  type SpecId,
} from "../src/domain.js";
import {
  AgentBuilderService,
  fingerprintMutationRequest,
  type AgentBuilderIdFactory,
  type AgentBuilderMutationContext,
  type AgentBuilderResult,
} from "../src/service.js";
import type { AgentBuilderStoreMutationSuccess } from "../src/store.js";
import { createMemoryAgentBuilderStore } from "../stores/memory.js";

function principal(principalType: string, principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "test",
    principalId,
    principalType,
  };
}

const userA = principal("user", "user-a");
const userB = principal("user", "user-b");

function ownerInput(
  current: SessionAuthContext | null,
  initiator: SessionAuthContext | null = current,
): OwnerResolutionInput {
  return { current, initiator, channel: { kind: "slack" } };
}

function mutation(
  operationId: string,
  current: SessionAuthContext = userA,
): AgentBuilderMutationContext {
  return { ownerResolution: ownerInput(current), operationId };
}

function unwrap<Value>(result: AgentBuilderResult<Value>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${result.error.code}`);
  return result.value;
}

function mutationSuccess(
  result: AgentBuilderResult<AgentBuilderStoreMutationSuccess>,
  type: AgentBuilderStoreMutationSuccess["type"],
): AgentBuilderStoreMutationSuccess {
  const value = unwrap(result);
  expect(value.type).toBe(type);
  return value;
}

function deterministicIds(): AgentBuilderIdFactory & { readonly counts: () => readonly number[] } {
  let agent = 0;
  let draft = 0;
  let spec = 0;
  return {
    agentId: () => `agent-${++agent}`,
    draftId: () => `draft-${++draft}`,
    specId: () => `spec-${++spec}`,
    counts: () => [agent, draft, spec],
  };
}

function testService(options: {
  readonly maxFamilies?: number;
  readonly resolveOwner?: (input: OwnerResolutionInput) => OwnerScope | null;
} = {}) {
  const store = createMemoryAgentBuilderStore();
  const ids = deterministicIds();
  let tick = 0;
  const service = new AgentBuilderService({
    store,
    ids,
    clock: {
      now: () => `2026-01-01T00:00:${String(++tick).padStart(2, "0")}.000Z`,
    },
    ...(options.maxFamilies === undefined
      ? {}
      : { maxAgentFamiliesPerOwner: options.maxFamilies }),
    resolveOwner:
      options.resolveOwner ??
      ((input) => {
        if (input.current?.principalId === "user-a") {
          return { tenantKey: "Tenant", ownerKey: "Owner" };
        }
        if (input.current?.principalId === "user-b") {
          return { tenantKey: "Tenant", ownerKey: "owner" };
        }
        return null;
      }),
  });
  return { service, store, ids, ticks: () => tick };
}

describe("AgentBuilderService owner boundary", () => {
  it("requires a current user, never falls back to initiator, and applies host policy", async () => {
    let resolverCalls = 0;
    const { service } = testService({
      resolveOwner: (input) => {
        resolverCalls += 1;
        return input.current?.principalId === "allowed"
          ? { tenantKey: " Tenant ", ownerKey: "Owner" }
          : null;
      },
    });

    for (const input of [
      ownerInput(null, principal("user", "allowed")),
      ownerInput(principal("app", "allowed"), principal("user", "allowed")),
      ownerInput(principal("runtime", "allowed"), principal("user", "allowed")),
      ownerInput(principal("service", "allowed"), principal("user", "allowed")),
      ownerInput(principal("anonymous", "allowed"), principal("user", "allowed")),
    ]) {
      const result = await service.resolveOwner(input);
      expect(result).toMatchObject({ ok: false, error: { code: "USER_PRINCIPAL_REQUIRED" } });
    }
    expect(resolverCalls).toBe(0);

    const rejected = await service.resolveOwner(ownerInput(principal("user", "rejected")));
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "USER_PRINCIPAL_REQUIRED" },
    });
    expect(resolverCalls).toBe(1);

    const allowed = await service.resolveOwner(ownerInput(principal("user", "allowed")));
    expect(allowed).toEqual({
      ok: true,
      owner: { tenantKey: " Tenant ", ownerKey: "Owner" },
      principal: principal("user", "allowed"),
    });
  });

  it("keeps case-sensitive owner scopes isolated for reads and mutations", async () => {
    const { service } = testService();
    const created = mutationSuccess(
      await service.createDraft(mutation("create-owner-a"), { name: "Agent", kind: "agent" }),
      "family_created",
    );
    expect(created.type).toBe("family_created");
    if (created.type !== "family_created") return;

    expect(await service.getFamily(ownerInput(userB), { agentId: created.family.agentId })).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Saved agent family was not found" },
    });
    expect(
      await service.archiveFamily(mutation("archive-owner-b", userB), {
        agentId: created.family.agentId,
        expectedRevision: created.family.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(
      await service.getFamily(ownerInput(userA), { agentId: created.family.agentId }),
    ).toMatchObject({ ok: true, value: { lifecycle: "draft_only" } });
  });
});

describe("AgentBuilderService validation and field ownership", () => {
  it("rejects system-owned patch/create fields and derives IDs, revisions, time, and publisher", async () => {
    const { service } = testService();
    expect(
      await service.createDraft(mutation("create-forbidden"), {
        name: "Agent",
        kind: "agent",
        owner: { tenantKey: "attacker", ownerKey: "attacker" },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

    const created = mutationSuccess(
      await service.createDraft(mutation("create-valid"), { name: "Agent", kind: "agent" }),
      "family_created",
    );
    expect(created.type).toBe("family_created");
    if (created.type !== "family_created" || created.family.draft === undefined) return;
    expect(created.family).toMatchObject({
      agentId: "agent-1",
      revision: 1,
      createdAt: "2026-01-01T00:00:01.000Z",
      draft: { draftId: "draft-1", draftRevision: 1 },
    });

    const forbiddenPatch = await service.patchDraft(mutation("patch-forbidden"), {
      agentId: created.family.agentId,
      expectedRevision: created.family.revision,
      expectedDraftRevision: created.family.draft.draftRevision,
      patch: {
        name: "Changed",
        agentId: "model-agent",
        draftId: "model-draft",
        lifecycle: "active",
        revision: 99,
        updatedAt: "2020-01-01T00:00:00.000Z",
        publishedBy: "model",
      },
    });
    expect(forbiddenPatch).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await service.getFamily(ownerInput(userA), { agentId: created.family.agentId }),
    ).toMatchObject({ ok: true, value: { revision: 1, draft: { name: "Agent" } } });

    const published = mutationSuccess(
      await service.publishDraft(mutation("publish-valid"), {
        agentId: created.family.agentId,
        expectedRevision: created.family.revision,
        expectedDraftRevision: created.family.draft.draftRevision,
      }),
      "draft_published",
    );
    expect(published.type).toBe("draft_published");
    if (published.type !== "draft_published") return;
    expect(published.publishedVersion).toMatchObject({
      specId: "spec-1",
      version: 1,
      publishedAt: "2026-01-01T00:00:02.000Z",
      publishedBy: "user-a",
    });
  });

  it("validates skills, duplicate capability/trigger IDs, and resulting patch state", async () => {
    const { service } = testService();
    const requirement = {
      capabilityId: capabilityIdSchema.parse("capability-a"),
      level: "required" as const,
      displayNameSnapshot: "Capability A",
      schemaFingerprint: "schema-a",
      consequential: false,
    };
    const trigger = {
      kind: "event" as const,
      triggerId: triggerIdSchema.parse("trigger-a"),
      sourceId: "source-a",
      filter: {},
      destination: { channelKind: "slack", address: "C123" },
    };
    expect(
      await service.createDraft(mutation("invalid-skill"), {
        name: "Skill",
        kind: "skill",
        toolRequirements: [requirement],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await service.createDraft(mutation("duplicate-capability"), {
        name: "Agent A",
        kind: "agent",
        toolRequirements: [requirement, requirement],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await service.createDraft(mutation("duplicate-trigger"), {
        name: "Agent B",
        kind: "agent",
        triggers: [trigger, trigger],
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

    const created = mutationSuccess(
      await service.createDraft(mutation("agent-with-capability"), {
        name: "Capable",
        kind: "agent",
        toolRequirements: [requirement],
      }),
      "family_created",
    );
    if (created.type !== "family_created" || created.family.draft === undefined) return;
    expect(
      await service.patchDraft(mutation("invalid-conversion"), {
        agentId: created.family.agentId,
        expectedRevision: created.family.revision,
        expectedDraftRevision: created.family.draft.draftRevision,
        patch: { kind: "skill" },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("rejects undefined-only patches without consuming revisions", async () => {
    const { service } = testService();
    const created = mutationSuccess(
      await service.createDraft(mutation("undefined-patch-create"), {
        name: "Agent",
        kind: "agent",
      }),
      "family_created",
    );
    if (created.type !== "family_created" || created.family.draft === undefined) return;

    expect(
      await service.patchDraft(mutation("undefined-patch"), {
        agentId: created.family.agentId,
        expectedRevision: created.family.revision,
        expectedDraftRevision: created.family.draft.draftRevision,
        patch: { name: undefined },
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(
      await service.getFamily(ownerInput(userA), { agentId: created.family.agentId }),
    ).toMatchObject({
      ok: true,
      value: {
        revision: created.family.revision,
        draft: { draftRevision: created.family.draft.draftRevision, name: "Agent" },
      },
    });
  });

  it("returns a typed error for over-depth trigger JSON", async () => {
    const { service, ids, ticks } = testService();
    let filter: unknown = {};
    for (let depth = 0; depth < 5_000; depth += 1) filter = { next: filter };

    await expect(
      service.createDraft(mutation("deep-trigger"), {
        name: "Agent",
        kind: "agent",
        triggers: [
          {
            kind: "event",
            triggerId: "deep-trigger-id",
            sourceId: "source",
            filter,
            destination: { channelKind: "slack", address: "C123" },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(ids.counts()).toEqual([0, 0, 0]);
    expect(ticks()).toBe(0);
  });

  it("validates injected time and identifier factories", async () => {
    const store = createMemoryAgentBuilderStore();
    const invalidTime = new AgentBuilderService({
      store,
      resolveOwner: () => ({ tenantKey: "Tenant", ownerKey: "Owner" }),
      clock: { now: () => "2026-01-01T00:00:00Z" },
      ids: { agentId: () => "agent", draftId: () => "draft", specId: () => "spec" },
    });
    expect(
      await invalidTime.createDraft(mutation("bad-time"), { name: "Agent", kind: "agent" }),
    ).toMatchObject({ ok: false, error: { code: "DEPENDENCY_CONTRACT_VIOLATION" } });

    const invalidId = new AgentBuilderService({
      store: createMemoryAgentBuilderStore(),
      resolveOwner: () => ({ tenantKey: "Tenant", ownerKey: "Owner" }),
      clock: { now: () => "2026-01-01T00:00:00.000Z" },
      ids: { agentId: () => "", draftId: () => "draft", specId: () => "spec" },
    });
    expect(
      await invalidId.createDraft(mutation("bad-id"), { name: "Agent", kind: "agent" }),
    ).toMatchObject({ ok: false, error: { code: "DEPENDENCY_CONTRACT_VIOLATION" } });
  });
});

describe("AgentBuilderService ambiguous retry handling", () => {
  it("fingerprints canonical requests without retaining request content", async () => {
    const first = await fingerprintMutationRequest({ z: 1, a: "private instructions" });
    const reordered = await fingerprintMutationRequest({ a: "private instructions", z: 1 });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first).not.toContain("private instructions");
  });

  it("replays create, publish, activate, archive, restore, and delete exactly once", async () => {
    const { service, store, ids, ticks } = testService();
    const createInput = { name: "Agent", kind: "agent" as const };
    const createContext = mutation("retry-create");
    const created = mutationSuccess(
      await service.createDraft(createContext, createInput),
      "family_created",
    );
    const createdRetry = mutationSuccess(
      await service.createDraft(createContext, createInput),
      "family_created",
    );
    expect(createdRetry).toEqual(created);
    expect(ids.counts()).toEqual([1, 1, 0]);
    expect(ticks()).toBe(1);
    if (created.type !== "family_created" || created.family.draft === undefined) return;

    const publishInput = {
      agentId: created.family.agentId,
      expectedRevision: created.family.revision,
      expectedDraftRevision: created.family.draft.draftRevision,
    };
    const publishContext = mutation("retry-publish-v1");
    const v1 = mutationSuccess(
      await service.publishDraft(publishContext, publishInput),
      "draft_published",
    );
    const v1Retry = mutationSuccess(
      await service.publishDraft(publishContext, publishInput),
      "draft_published",
    );
    expect(v1Retry).toEqual(v1);
    expect(ids.counts()).toEqual([1, 1, 1]);
    if (v1.type !== "draft_published") return;

    const begun = mutationSuccess(
      await service.beginRevision(mutation("retry-begin-v2"), {
        agentId: created.family.agentId,
        expectedRevision: v1.family.revision,
      }),
      "revision_begun",
    );
    if (begun.type !== "revision_begun" || begun.family.draft === undefined) return;
    const patched = mutationSuccess(
      await service.patchDraft(mutation("retry-patch-v2"), {
        agentId: created.family.agentId,
        expectedRevision: begun.family.revision,
        expectedDraftRevision: begun.family.draft.draftRevision,
        patch: { instructions: "version two" },
      }),
      "draft_patched",
    );
    if (patched.type !== "draft_patched" || patched.family.draft === undefined) return;
    const v2 = mutationSuccess(
      await service.publishDraft(mutation("retry-publish-v2"), {
        agentId: created.family.agentId,
        expectedRevision: patched.family.revision,
        expectedDraftRevision: patched.family.draft.draftRevision,
      }),
      "draft_published",
    );
    if (v2.type !== "draft_published") return;

    const activateInput = {
      agentId: created.family.agentId,
      expectedRevision: v2.family.revision,
      specId: v1.publishedVersion.specId,
      version: v1.publishedVersion.version,
    };
    const activateContext = mutation("retry-activate");
    const activated = mutationSuccess(
      await service.activateVersion(activateContext, activateInput),
      "version_activated",
    );
    expect(
      mutationSuccess(
        await service.activateVersion(activateContext, activateInput),
        "version_activated",
      ),
    ).toEqual(activated);
    if (activated.type !== "version_activated") return;

    const archiveInput = {
      agentId: created.family.agentId,
      expectedRevision: activated.family.revision,
    };
    const archiveContext = mutation("retry-archive");
    const archived = mutationSuccess(
      await service.archiveFamily(archiveContext, archiveInput),
      "family_archived",
    );
    expect(
      mutationSuccess(
        await service.archiveFamily(archiveContext, archiveInput),
        "family_archived",
      ),
    ).toEqual(archived);
    if (archived.type !== "family_archived") return;

    const restoreInput = {
      agentId: created.family.agentId,
      expectedRevision: archived.family.revision,
    };
    const restoreContext = mutation("retry-restore");
    const restored = mutationSuccess(
      await service.restoreFamily(restoreContext, restoreInput),
      "family_restored",
    );
    expect(
      mutationSuccess(
        await service.restoreFamily(restoreContext, restoreInput),
        "family_restored",
      ),
    ).toEqual(restored);
    if (restored.type !== "family_restored") return;

    const deleteInput = {
      agentId: created.family.agentId,
      expectedRevision: restored.family.revision,
    };
    const deleteContext = mutation("retry-delete");
    const deleted = mutationSuccess(
      await service.deleteFamily(deleteContext, deleteInput),
      "family_deleted",
    );
    expect(
      mutationSuccess(
        await service.deleteFamily(deleteContext, deleteInput),
        "family_deleted",
      ),
    ).toEqual(deleted);
    if (deleted.type !== "family_deleted") return;

    expect(deleted.family.revision).toBe(restored.family.revision + 1);
    expect(await service.getFamily(ownerInput(userA), { agentId: created.family.agentId })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(
      await store.listVersions({
        owner: { tenantKey: "Tenant", ownerKey: "Owner" },
        agentId: created.family.agentId,
      }),
    ).toHaveLength(2);
  });

  it("rejects an operation ID reused with a different request", async () => {
    const { service } = testService();
    mutationSuccess(
      await service.createDraft(mutation("reused-operation"), {
        name: "Agent A",
        kind: "agent",
      }),
      "family_created",
    );
    expect(
      await service.createDraft(mutation("reused-operation"), {
        name: "Agent B",
        kind: "agent",
      }),
    ).toMatchObject({ ok: false, error: { code: "OPERATION_ID_REUSED" } });
  });
});
