import {
  bootstrapTargetSchema,
  type BootstrapGrantRecord,
  type BootstrapStoreErrorCode,
  type RedeemBootstrapGrantStoreCommand,
} from "../bootstrap.js";
import {
  agentIdSchema,
  canonicalizeAgentName,
  draftIdSchema,
  operationIdSchema,
  ownerScopeSchema,
  specIdSchema,
  timestampSchema,
  type OwnerScope,
  type SavedAgentEditableFields,
} from "../domain.js";
import type { AgentBuilderStore, AgentBuilderStoreFactory } from "../store.js";

export interface BootstrapStoreConformanceCase {
  readonly name: string;
  readonly run: (store: AgentBuilderStore) => Promise<void>;
}

export interface BootstrapStoreConformanceReport {
  readonly passed: number;
  readonly caseNames: readonly string[];
}

const OWNER_A = ownerScopeSchema.parse({ tenantKey: "tenant", ownerKey: "owner-a" });
const OWNER_B = ownerScopeSchema.parse({ tenantKey: "tenant", ownerKey: "owner-b" });
const TARGET = bootstrapTargetSchema.parse({
  kind: "draft",
  agentId: "agent-a",
  draftId: "draft-a",
  draftRevision: 1,
}) as Extract<ReturnType<typeof bootstrapTargetSchema.parse>, { kind: "draft" }>;
const PUBLISHED_TARGET = bootstrapTargetSchema.parse({
  kind: "published",
  agentId: "agent-published",
  specId: "spec-published",
  specVersion: 1,
}) as Extract<ReturnType<typeof bootstrapTargetSchema.parse>, { kind: "published" }>;
const HASH_A = `sha256:${"a".repeat(64)}`;

function time(minute: number) {
  return timestampSchema.parse(`2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`);
}

function grant(overrides: Partial<BootstrapGrantRecord> = {}): BootstrapGrantRecord {
  return {
    grantId: "grant-a",
    tokenHash: HASH_A,
    owner: OWNER_A,
    role: "pm",
    target: TARGET,
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    parentCallId: "parent-call",
    issuedAt: time(0),
    expiresAt: time(5),
    ...overrides,
  };
}

function redemption(overrides: Partial<RedeemBootstrapGrantStoreCommand> = {}): RedeemBootstrapGrantStoreCommand {
  return {
    tokenHash: HASH_A,
    owner: OWNER_A,
    role: "pm",
    expectedTarget: TARGET,
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    parentCallId: "parent-call",
    childSessionId: "child-session",
    bootstrapTurnId: "bootstrap-turn",
    leaseId: "lease-a",
    occurredAt: time(1),
    leaseExpiresAt: time(4),
    ...overrides,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const TARGET_FIELDS: SavedAgentEditableFields = {
  name: "Bootstrap target",
  kind: "agent",
  description: "Conformance target",
  pmBrief: "",
  instructions: "target",
  toolRequirements: [],
  triggers: [],
  testChecklist: [],
  qaFindings: [],
};

async function seedTarget(
  store: AgentBuilderStore,
  owner: OwnerScope,
  target: BootstrapGrantRecord["target"],
): Promise<void> {
  if ((await store.getFamily({ owner, agentId: target.agentId })) !== null) return;
  const draftId =
    target.kind === "draft" ? target.draftId : draftIdSchema.parse("draft-published");
  const result = await store.mutate({
    type: "create_family",
    owner,
    mutation: {
      operationId: operationIdSchema.parse(`bootstrap-conformance-seed-${owner.ownerKey}`),
      requestFingerprint: `bootstrap-conformance-seed-${owner.ownerKey}`,
    },
    occurredAt: time(0),
    agentId: target.agentId,
    draftId,
    maxFamilies: 25,
    canonicalName: canonicalizeAgentName(TARGET_FIELDS.name),
    fields: TARGET_FIELDS,
  });
  assert(result.ok, "Unable to seed bootstrap target");
  if (target.kind === "published") {
    assert(
      result.type === "family_created" && result.family.draft !== undefined,
      "Published target draft was not created",
    );
    const published = await store.mutate({
      type: "publish_draft",
      owner,
      mutation: {
        operationId: operationIdSchema.parse(`bootstrap-conformance-publish-${owner.ownerKey}`),
        requestFingerprint: `bootstrap-conformance-publish-${owner.ownerKey}`,
      },
      occurredAt: time(0),
      agentId: target.agentId,
      expectedRevision: result.family.revision,
      expectedDraftRevision: result.family.draft.draftRevision,
      specId: specIdSchema.parse(target.specId),
      publishedBy: owner.ownerKey,
    });
    assert(published.ok && published.type === "draft_published", "Published target did not publish");
    const activated = await store.mutate({
      type: "activate_version",
      owner,
      mutation: {
        operationId: operationIdSchema.parse(`bootstrap-conformance-activate-${owner.ownerKey}`),
        requestFingerprint: `bootstrap-conformance-activate-${owner.ownerKey}`,
      },
      occurredAt: time(0),
      agentId: target.agentId,
      expectedRevision: published.family.revision,
      specId: target.specId,
      version: target.specVersion,
    });
    assert(activated.ok, "Published target did not activate");
  }
}

function expectError(
  result: Awaited<ReturnType<AgentBuilderStore["redeemBootstrapGrant"]>>,
  code: BootstrapStoreErrorCode,
): void {
  assert(!result.ok, `Expected ${code}, received success`);
  assert(result.error.code === code, `Expected ${code}, received ${result.error.code}`);
}

async function created(store: AgentBuilderStore, record = grant()): Promise<void> {
  await seedTarget(store, record.owner, record.target);
  const result = await store.createBootstrapGrant({ grant: record });
  assert(result.ok, "Expected grant creation");
}

async function advanceTargetDraft(store: AgentBuilderStore, operationId: string): Promise<void> {
  const family = await store.getFamily({ owner: OWNER_A, agentId: TARGET.agentId });
  assert(family?.draft !== undefined, "Bootstrap target draft missing");
  const fields: SavedAgentEditableFields = {
    name: family.draft.name,
    kind: family.draft.kind,
    description: `${family.draft.description} changed`,
    pmBrief: family.draft.pmBrief,
    instructions: family.draft.instructions,
    toolRequirements: family.draft.toolRequirements,
    triggers: family.draft.triggers,
    testChecklist: family.draft.testChecklist,
    qaFindings: family.draft.qaFindings,
  };
  const result = await store.mutate({
    type: "patch_draft",
    owner: OWNER_A,
    mutation: {
      operationId: operationIdSchema.parse(operationId),
      requestFingerprint: operationId,
    },
    occurredAt: time(1),
    agentId: family.agentId,
    expectedRevision: family.revision,
    expectedDraftRevision: family.draft.draftRevision,
    canonicalName: canonicalizeAgentName(fields.name),
    fields,
  });
  assert(result.ok, "Unable to advance bootstrap target draft");
}

export const bootstrapStoreConformanceCases: readonly BootstrapStoreConformanceCase[] = [
  {
    name: "hash-only grants redeem atomically once into the exact child lease",
    run: async (store) => {
      await created(store);
      const first = await store.redeemBootstrapGrant(redemption());
      assert(first.ok, "Expected redemption");
      assert(first.value.childSessionId === "child-session", "Lease must bind exact child");
      assert(JSON.stringify(first.value).includes("ab1_") === false, "Lease leaked a raw token");
      expectError(await store.redeemBootstrapGrant(redemption({ leaseId: "lease-replay" })), "BOOTSTRAP_REPLAYED");
    },
  },
  {
    name: "concurrent redemption admits exactly one child",
    run: async (store) => {
      await created(store);
      const results = await Promise.all([
        store.redeemBootstrapGrant(redemption()),
        store.redeemBootstrapGrant(
          redemption({ childSessionId: "child-racer", leaseId: "lease-racer" }),
        ),
      ]);
      assert(results.filter((result) => result.ok).length === 1, "Redemption race admitted multiple children");
      const rejected = results.find((result) => !result.ok);
      assert(rejected !== undefined && !rejected.ok && rejected.error.code === "BOOTSTRAP_REPLAYED", "Redemption race did not reject replay");
    },
  },
  {
    name: "redemption atomically rejects a changed exact draft",
    run: async (store) => {
      await created(store);
      await advanceTargetDraft(store, "advance-before-redeem");
      expectError(await store.redeemBootstrapGrant(redemption()), "TARGET_CHANGED");
    },
  },
  {
    name: "owner, role, target, and parent lineage mismatches fail closed",
    run: async (store) => {
      const variants: readonly [Partial<RedeemBootstrapGrantStoreCommand>, BootstrapStoreErrorCode][] = [
        [{ owner: OWNER_B }, "OWNER_MISMATCH"],
        [{ role: "qa" }, "BOOTSTRAP_BINDING_MISMATCH"],
        [{ expectedTarget: { ...TARGET, draftRevision: 4 } }, "BOOTSTRAP_BINDING_MISMATCH"],
        [{ expectedTarget: { ...TARGET, agentId: agentIdSchema.parse("agent-other") } }, "BOOTSTRAP_BINDING_MISMATCH"],
        [{ expectedTarget: { ...TARGET, draftId: draftIdSchema.parse("draft-other") } }, "BOOTSTRAP_BINDING_MISMATCH"],
        [{ parentSessionId: "parent-other" }, "BOOTSTRAP_BINDING_MISMATCH"],
        [{ parentTurnId: "turn-other" }, "BOOTSTRAP_BINDING_MISMATCH"],
        [{ parentCallId: "call-other" }, "BOOTSTRAP_BINDING_MISMATCH"],
      ];
      for (let index = 0; index < variants.length; index += 1) {
        const [override, code] = variants[index] as (typeof variants)[number];
        const tokenHash = `sha256:${(index + 1).toString(16).repeat(64).slice(0, 64)}`;
        await created(store, grant({ grantId: `grant-${index}`, tokenHash }));
        expectError(await store.redeemBootstrapGrant(redemption({ tokenHash, ...override })), code);
      }
    },
  },
  {
    name: "published redemption binds the exact agent, spec, and immutable version",
    run: async (store) => {
      const variants = [
        { ...PUBLISHED_TARGET, agentId: agentIdSchema.parse("agent-other") },
        { ...PUBLISHED_TARGET, specId: specIdSchema.parse("spec-other") },
        { ...PUBLISHED_TARGET, specVersion: 2 },
      ] as const;
      for (let index = 0; index < variants.length; index += 1) {
        const tokenHash = `sha256:${(index + 10).toString(16).repeat(64).slice(0, 64)}`;
        await created(
          store,
          grant({
            grantId: `published-grant-${index}`,
            tokenHash,
            role: "active_runner",
            target: PUBLISHED_TARGET,
          }),
        );
        expectError(
          await store.redeemBootstrapGrant(
            redemption({
              tokenHash,
              role: "active_runner",
              expectedTarget: variants[index]!,
              childSessionId: `published-child-${index}`,
              leaseId: `published-lease-${index}`,
            }),
          ),
          "BOOTSTRAP_BINDING_MISMATCH",
        );
      }
    },
  },
  {
    name: "expired and unknown grants disclose no token material",
    run: async (store) => {
      await created(store);
      const expired = await store.redeemBootstrapGrant(redemption({ occurredAt: time(5) }));
      expectError(expired, "BOOTSTRAP_EXPIRED");
      const unknown = await store.redeemBootstrapGrant(
        redemption({ tokenHash: `sha256:${"f".repeat(64)}` }),
      );
      expectError(unknown, "BOOTSTRAP_NOT_FOUND");
      assert(JSON.stringify([expired, unknown]).includes(HASH_A) === false, "Error leaked token hash");
    },
  },
  {
    name: "parked child IDs cannot be rebound across grants or owners",
    run: async (store) => {
      await created(store);
      const first = await store.redeemBootstrapGrant(redemption());
      assert(first.ok, "Expected first child redemption");
      const otherHash = `sha256:${"b".repeat(64)}`;
      await created(
        store,
        grant({ grantId: "grant-b", tokenHash: otherHash, owner: OWNER_B }),
      );
      expectError(
        await store.redeemBootstrapGrant(
          redemption({
            tokenHash: otherHash,
            owner: OWNER_B,
            parentCallId: "parent-call",
            leaseId: "lease-b",
          }),
        ),
        "CHILD_SESSION_MISMATCH",
      );
    },
  },
  {
    name: "lease execution is one turn and terminal closure is idempotent only for the same outcome",
    run: async (store) => {
      await created(store);
      const redeemed = await store.redeemBootstrapGrant(redemption());
      assert(redeemed.ok, "Expected redemption");
      const bootstrapClaim = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "bootstrap-turn",
        occurredAt: time(2),
      });
      assert(!bootstrapClaim.ok && bootstrapClaim.error.code === "LEASE_NOT_READY", "Bootstrap turn executed");
      const running = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "execution-turn",
        occurredAt: time(2),
        capabilityPlan: { mode: "direct", selected: [], optionalOmissions: [] },
      });
      assert(running.ok && running.value.status === "running", "Lease did not become running");
      const closed = await store.closeExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "execution-turn",
        status: "succeeded",
        occurredAt: time(3),
      });
      assert(closed.ok && closed.value.status === "succeeded", "Lease did not close");
      const replay = await store.closeExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "execution-turn",
        status: "succeeded",
        occurredAt: time(3),
      });
      assert(replay.ok, "Same terminal close must replay");
      const reuse = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "third-turn",
        occurredAt: time(3),
      });
      assert(!reuse.ok && reuse.error.code === "LEASE_CLOSED", "Terminal child was reused");
    },
  },
  {
    name: "a running lease expires closed and its parked child cannot resume",
    run: async (store) => {
      await created(store);
      const redeemed = await store.redeemBootstrapGrant(redemption());
      assert(redeemed.ok, "Expected redemption");
      const running = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "execution-turn",
        occurredAt: time(2),
      });
      assert(running.ok, "Expected running lease");
      const expired = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "third-turn",
        occurredAt: time(4),
      });
      assert(!expired.ok && expired.error.code === "LEASE_EXPIRED", "Expired lease resumed");
      const stored = await store.getExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
      });
      assert(stored?.status === "expired", "Expired lease was not closed durably");
    },
  },
  {
    name: "bootstrap completion preserves ready but bootstrap failure closes the child",
    run: async (store) => {
      await created(store);
      const redeemed = await store.redeemBootstrapGrant(redemption());
      assert(redeemed.ok, "Expected redemption");
      const completed = await store.closeExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "bootstrap-turn",
        status: "succeeded",
        occurredAt: time(2),
      });
      assert(
        !completed.ok && completed.error.code === "LEASE_NOT_READY",
        "Successful bootstrap incorrectly terminalized the ready lease",
      );
      const failed = await store.closeExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "bootstrap-turn",
        status: "failed",
        occurredAt: time(2),
        terminalCode: "BOOTSTRAP_TURN_FAILED",
      });
      assert(failed.ok && failed.value.status === "failed", "Failed bootstrap left a ready lease");
      const reuse = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "execution-turn",
        occurredAt: time(3),
      });
      assert(!reuse.ok && reuse.error.code === "LEASE_CLOSED", "Failed bootstrap child resumed");
    },
  },
  {
    name: "execution claim atomically rejects target drift and pre-model failure closes ready leases",
    run: async (store) => {
      await created(store);
      const redeemed = await store.redeemBootstrapGrant(redemption());
      assert(redeemed.ok, "Expected redemption");
      await advanceTargetDraft(store, "advance-before-claim");
      const claim = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "execution-turn",
        occurredAt: time(2),
      });
      assert(!claim.ok && claim.error.code === "TARGET_CHANGED", "Stale target was claimed");
      const failed = await store.closeExecutionLease({
        owner: OWNER_A,
        childSessionId: "child-session",
        executionTurnId: "execution-turn",
        status: "failed",
        occurredAt: time(2),
        terminalCode: "PRE_MODEL_FAILED",
      });
      assert(failed.ok && failed.value.status === "failed", "Ready lease survived pre-model failure");
    },
  },
  {
    name: "an ended parent turn cancels every abandoned ready lease",
    run: async (store) => {
      await created(store);
      const redeemed = await store.redeemBootstrapGrant(redemption());
      assert(redeemed.ok, "Expected redemption");
      const closed = await store.closeParentTurnExecutionLeases({
        owner: OWNER_A,
        parentSessionId: "parent-session",
        parentTurnId: "parent-turn",
        status: "cancelled",
        occurredAt: time(2),
        terminalCode: "PARENT_ENDED",
      });
      assert(
        closed.ok && closed.value.length === 1 && closed.value[0]?.status === "cancelled",
        "Parent turn left a reusable lease",
      );
    },
  },
  {
    name: "parent terminalization is atomic with redemption and closes running children",
    run: async (store) => {
      await created(store);
      const [redeemed, parentClosed] = await Promise.all([
        store.redeemBootstrapGrant(redemption()),
        store.closeParentTurnExecutionLeases({
          owner: OWNER_A,
          parentSessionId: "parent-session",
          parentTurnId: "parent-turn",
          status: "cancelled",
          occurredAt: time(2),
          terminalCode: "PARENT_CANCELLED",
        }),
      ]);
      assert(parentClosed.ok, "Parent close failed");
      if (redeemed.ok) {
        const lease = await store.getExecutionLease({
          owner: OWNER_A,
          childSessionId: "child-session",
        });
        assert(lease?.status === "cancelled", "Redemption race left a ready lease");
      } else {
        assert(
          redeemed.error.code === "BOOTSTRAP_BINDING_MISMATCH",
          "Closed parent turn produced the wrong redemption failure",
        );
      }

      const secondHash = `sha256:${"c".repeat(64)}`;
      await created(
        store,
        grant({
          grantId: "running-parent-grant",
          tokenHash: secondHash,
          parentSessionId: "running-parent",
          parentTurnId: "running-turn",
          parentCallId: "running-call",
        }),
      );
      const second = await store.redeemBootstrapGrant(
        redemption({
          tokenHash: secondHash,
          parentSessionId: "running-parent",
          parentTurnId: "running-turn",
          parentCallId: "running-call",
          childSessionId: "running-child",
          leaseId: "running-lease",
        }),
      );
      assert(second.ok, "Second redemption failed");
      const running = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: "running-child",
        executionTurnId: "running-execution",
        occurredAt: time(2),
      });
      assert(running.ok, "Second lease did not run");
      const closedRunning = await store.closeParentTurnExecutionLeases({
        owner: OWNER_A,
        parentSessionId: "running-parent",
        parentTurnId: "running-turn",
        status: "failed",
        occurredAt: time(3),
        terminalCode: "PARENT_FAILED",
      });
      assert(
        closedRunning.ok && closedRunning.value[0]?.status === "failed",
        "Parent failure left running child nonterminal",
      );
    },
  },
  {
    name: "lease reads and claims are exactly owner scoped",
    run: async (store) => {
      await created(store);
      const redeemed = await store.redeemBootstrapGrant(redemption());
      assert(redeemed.ok, "Expected redemption");
      assert(
        (await store.getExecutionLease({ owner: OWNER_B, childSessionId: "child-session" })) === null,
        "Cross-owner read disclosed a lease",
      );
      const claim = await store.beginExecutionLease({
        owner: OWNER_B,
        childSessionId: "child-session",
        executionTurnId: "execution-turn",
        occurredAt: time(2),
      });
      assert(!claim.ok && claim.error.code === "OWNER_MISMATCH", "Cross-owner claim was accepted");
    },
  },
];

export async function runBootstrapStoreConformanceSuite(
  createStore: AgentBuilderStoreFactory,
): Promise<BootstrapStoreConformanceReport> {
  const caseNames: string[] = [];
  for (const testCase of bootstrapStoreConformanceCases) {
    const store = await createStore();
    await testCase.run(store);
    caseNames.push(testCase.name);
  }
  return Object.freeze({ passed: caseNames.length, caseNames: Object.freeze(caseNames) });
}
