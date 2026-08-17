import {
  type ExecutionCapabilityPlan,
  type ExecutionLeaseRecord,
  type ExecutionRole,
} from "../bootstrap.js";
import {
  agentIdSchema,
  canonicalizeAgentName,
  capabilityIdSchema,
  draftIdSchema,
  operationIdSchema,
  ownerScopeSchema,
  timestampSchema,
  type OwnerScope,
  type SavedAgentEditableFields,
} from "../domain.js";
import type { AgentBuilderStore, AgentBuilderStoreFactory } from "../store.js";
import {
  type TestCapabilityStepScope,
  type TestPolicyErrorCode,
  type TestPolicyResult,
} from "../test-policy.js";
import { buildWorkflowIdSchema, testRunIdSchema } from "../workflow.js";

export interface TestPolicyStoreConformanceCase {
  readonly name: string;
  readonly run: (store: AgentBuilderStore) => Promise<void>;
}

export interface TestPolicyStoreConformanceReport {
  readonly passed: number;
  readonly caseNames: readonly string[];
}

export interface TestPolicyStoreConformanceOptions {
  readonly createStore: AgentBuilderStoreFactory;
  readonly disposeStore?: (store: AgentBuilderStore) => Promise<void> | void;
}

const OWNER_A = ownerScopeSchema.parse({ tenantKey: "tenant", ownerKey: "owner-a" });
const OWNER_B = ownerScopeSchema.parse({ tenantKey: "tenant", ownerKey: "owner-b" });
const AGENT_ID = agentIdSchema.parse("test-policy-agent");
const DRAFT_ID = draftIdSchema.parse("test-policy-draft");
const WORKFLOW_ID = buildWorkflowIdSchema.parse("test-policy-workflow");
const OTHER_WORKFLOW_ID = buildWorkflowIdSchema.parse("other-test-policy-workflow");
const TEST_RUN_ID = testRunIdSchema.parse("test-policy-run");
const CONSEQUENTIAL_CAPABILITY_ID = capabilityIdSchema.parse("consequential-capability");
const READ_ONLY_CAPABILITY_ID = capabilityIdSchema.parse("read-only-capability");
const CONSEQUENTIAL_SCHEMA = "consequential-schema-v1";
const READ_ONLY_SCHEMA = "read-only-schema-v1";
const LEASE_EXPIRES_AT = timestamp(300);

const FIELDS: SavedAgentEditableFields = {
  name: "Test policy conformance",
  kind: "agent",
  description: "Exercises exact interactive test execution policy.",
  pmBrief: "Test the declared capabilities without production execution.",
  instructions: "Use only the isolated test capability plan.",
  toolRequirements: [
    {
      capabilityId: CONSEQUENTIAL_CAPABILITY_ID,
      level: "required",
      displayNameSnapshot: "Consequential capability",
      schemaFingerprint: CONSEQUENTIAL_SCHEMA,
      consequential: true,
    },
    {
      capabilityId: READ_ONLY_CAPABILITY_ID,
      level: "required",
      displayNameSnapshot: "Read-only capability",
      schemaFingerprint: READ_ONLY_SCHEMA,
      consequential: false,
    },
  ],
  triggers: [],
  testChecklist: ["Exercise both selected capabilities."],
  qaFindings: [],
};

const TEST_CAPABILITY_PLAN: ExecutionCapabilityPlan = {
  mode: "test",
  selected: [
    {
      capabilityId: CONSEQUENTIAL_CAPABILITY_ID,
      modelToolName: "test_consequential",
      schemaFingerprint: CONSEQUENTIAL_SCHEMA,
      consequential: true,
    },
    {
      capabilityId: READ_ONLY_CAPABILITY_ID,
      modelToolName: "test_read_only",
      schemaFingerprint: READ_ONLY_SCHEMA,
      consequential: false,
    },
  ],
  optionalOmissions: [],
};

function timestamp(second: number) {
  return timestampSchema.parse(new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString());
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectPolicyError<Value>(
  result: TestPolicyResult<Value>,
  expected: TestPolicyErrorCode | readonly TestPolicyErrorCode[],
): void {
  assert(!result.ok, `Expected ${String(expected)}, received success`);
  const codes = typeof expected === "string" ? [expected] : expected;
  assert(
    codes.includes(result.error.code),
    `Expected ${codes.join(" or ")}, received ${result.error.code}`,
  );
}

function hashFor(role: ExecutionRole): string {
  const character =
    role === "pm" ? "a" : role === "implementor" ? "b" : role === "qa" ? "c" : "d";
  return `sha256:${character.repeat(64)}`;
}

async function startRoleLease(input: {
  readonly store: AgentBuilderStore;
  readonly role: "pm" | "implementor" | "qa" | "test_runner";
  readonly workflowRevision: number;
  readonly baseSecond: number;
  readonly capabilityPlan?: ExecutionCapabilityPlan;
  readonly testRun?: boolean;
}): Promise<ExecutionLeaseRecord> {
  const suffix = input.role.replace("_", "-");
  const workflow = {
    workflowId: WORKFLOW_ID,
    workflowRevision: input.workflowRevision,
    ...(input.testRun === true ? { testRunId: TEST_RUN_ID } : {}),
  };
  const target = {
    kind: "draft" as const,
    agentId: AGENT_ID,
    draftId: DRAFT_ID,
    draftRevision: 1,
  };
  const grant = await input.store.createBootstrapGrant({
    grant: {
      grantId: `grant-${suffix}`,
      tokenHash: hashFor(input.role),
      owner: OWNER_A,
      role: input.role,
      target,
      workflow,
      parentSessionId: `parent-${suffix}`,
      parentTurnId: `parent-turn-${suffix}`,
      parentCallId: `parent-call-${suffix}`,
      issuedAt: timestamp(input.baseSecond),
      expiresAt: timestamp(input.baseSecond + 20),
    },
  });
  assert(grant.ok, `Unable to create ${input.role} bootstrap grant`);
  const redeemed = await input.store.redeemBootstrapGrant({
    tokenHash: hashFor(input.role),
    owner: OWNER_A,
    role: input.role,
    expectedTarget: target,
    expectedWorkflow: workflow,
    parentSessionId: `parent-${suffix}`,
    parentTurnId: `parent-turn-${suffix}`,
    parentCallId: `parent-call-${suffix}`,
    childSessionId: `child-${suffix}`,
    bootstrapTurnId: `bootstrap-turn-${suffix}`,
    leaseId: `lease-${suffix}`,
    occurredAt: timestamp(input.baseSecond + 1),
    leaseExpiresAt: LEASE_EXPIRES_AT,
  });
  assert(redeemed.ok, `Unable to redeem ${input.role} bootstrap grant`);
  const running = await input.store.beginExecutionLease({
    owner: OWNER_A,
    childSessionId: `child-${suffix}`,
    executionTurnId: `execution-turn-${suffix}`,
    occurredAt: timestamp(input.baseSecond + 2),
    ...(input.capabilityPlan === undefined ? {} : { capabilityPlan: input.capabilityPlan }),
  });
  assert(running.ok, `Unable to start ${input.role} execution lease`);
  return running.value;
}

async function submitRole(input: {
  readonly store: AgentBuilderStore;
  readonly role: "pm" | "implementor" | "qa";
  readonly workflowRevision: number;
  readonly result: "completed_handoff" | "needs_test";
  readonly baseSecond: number;
}): Promise<void> {
  const lease = await startRoleLease({
    store: input.store,
    role: input.role,
    workflowRevision: input.workflowRevision,
    baseSecond: input.baseSecond,
  });
  const submitted = await input.store.mutate({
    type: "submit_build_role",
    owner: OWNER_A,
    mutation: {
      operationId: operationIdSchema.parse(`submit-${input.role}`),
      requestFingerprint: `submit-${input.role}`,
    },
    occurredAt: timestamp(input.baseSecond + 3),
    workflowId: WORKFLOW_ID,
    expectedWorkflowRevision: input.workflowRevision,
    role: input.role,
    leaseId: lease.leaseId,
    childSessionId: lease.childSessionId,
    executionTurnId: lease.executionTurnId ?? "missing-execution-turn",
    expectedRevision: 1,
    expectedDraftRevision: 1,
    canonicalName: canonicalizeAgentName(FIELDS.name),
    fields: FIELDS,
    result: input.result,
    ...(input.role === "qa" ? { testRunId: TEST_RUN_ID } : {}),
  });
  assert(
    submitted.ok && submitted.type === "workflow_role_submitted",
    `Unable to submit ${input.role} workflow result`,
  );
}

interface SeededTestPolicyState {
  readonly consequentialStep: TestCapabilityStepScope;
  readonly readOnlyStep: TestCapabilityStepScope;
  readonly lease: ExecutionLeaseRecord;
}

async function seedTestPolicyState(store: AgentBuilderStore): Promise<SeededTestPolicyState> {
  const allocated = await store.mutate({
    type: "allocate_build_workflow",
    owner: OWNER_A,
    mutation: {
      operationId: operationIdSchema.parse("allocate-test-policy-workflow"),
      requestFingerprint: "allocate-test-policy-workflow",
    },
    occurredAt: timestamp(0),
    workflowId: WORKFLOW_ID,
    agentId: AGENT_ID,
    draftId: DRAFT_ID,
    maxFamilies: 25,
    canonicalName: canonicalizeAgentName(FIELDS.name),
    fields: FIELDS,
  });
  assert(
    allocated.ok && allocated.type === "workflow_allocated",
    "Unable to allocate test-policy workflow",
  );
  await submitRole({
    store,
    role: "pm",
    workflowRevision: 1,
    result: "completed_handoff",
    baseSecond: 5,
  });
  await submitRole({
    store,
    role: "implementor",
    workflowRevision: 2,
    result: "completed_handoff",
    baseSecond: 30,
  });
  await submitRole({
    store,
    role: "qa",
    workflowRevision: 3,
    result: "needs_test",
    baseSecond: 55,
  });
  const lease = await startRoleLease({
    store,
    role: "test_runner",
    workflowRevision: 4,
    baseSecond: 80,
    capabilityPlan: TEST_CAPABILITY_PLAN,
    testRun: true,
  });
  assert(lease.executionTurnId !== undefined, "Running test lease has no execution turn");

  const common = {
    owner: OWNER_A,
    workflowId: WORKFLOW_ID,
    workflowRevision: 4,
    testRunId: TEST_RUN_ID,
    agentId: AGENT_ID,
    draftId: DRAFT_ID,
    draftRevision: 1,
    leaseId: lease.leaseId,
    childSessionId: lease.childSessionId,
    executionTurnId: lease.executionTurnId,
    expiresAt: lease.expiresAt,
  } as const;
  return {
    lease,
    consequentialStep: {
      ...common,
      capabilityId: CONSEQUENTIAL_CAPABILITY_ID,
      schemaFingerprint: CONSEQUENTIAL_SCHEMA,
      modelToolName: "test_consequential",
      callId: "consequential-call",
      stepFingerprint: `sha256:${"1".repeat(64)}`,
    },
    readOnlyStep: {
      ...common,
      capabilityId: READ_ONLY_CAPABILITY_ID,
      schemaFingerprint: READ_ONLY_SCHEMA,
      modelToolName: "test_read_only",
      callId: "read-only-call",
      stepFingerprint: `sha256:${"2".repeat(64)}`,
    },
  };
}

async function authorize(
  store: AgentBuilderStore,
  step: TestCapabilityStepScope,
  requestId = "approval-request",
) {
  return store.authorizeTestInput({
    step,
    requestId,
    responder: { principalId: OWNER_A.ownerKey, principalType: "user" },
    occurredAt: timestamp(110),
  });
}

async function assertNoExecutions(store: AgentBuilderStore): Promise<void> {
  for (const owner of [OWNER_A, OWNER_B]) {
    const executions = await store.listTestCapabilityExecutions({
      owner,
      workflowId: WORKFLOW_ID,
      testRunId: TEST_RUN_ID,
    });
    assert(executions.length === 0, "Rejected policy operation created an execution record");
  }
}

function completionInput(
  step: TestCapabilityStepScope,
  status: "succeeded" | "failed",
  occurredAt: number,
) {
  return {
    owner: step.owner,
    workflowId: step.workflowId,
    testRunId: step.testRunId,
    leaseId: step.leaseId,
    childSessionId: step.childSessionId,
    executionTurnId: step.executionTurnId,
    callId: step.callId,
    status,
    occurredAt: timestamp(occurredAt),
  } as const;
}

export const testPolicyStoreConformanceCases: readonly TestPolicyStoreConformanceCase[] = [
  {
    name: "consequential execution rejects absent, stale, schema-changed, and expired approval without starting",
    run: async (store) => {
      const { consequentialStep } = await seedTestPolicyState(store);
      expectPolicyError(
        await store.beginTestCapabilityExecution({
          step: consequentialStep,
          consequential: true,
          occurredAt: timestamp(109),
        }),
        "INPUT_REQUIRED",
      );
      const grant = await authorize(store, consequentialStep);
      assert(grant.ok, "Expected exact approval grant");
      expectPolicyError(
        await store.beginTestCapabilityExecution({
          step: { ...consequentialStep, schemaFingerprint: "changed-schema" },
          consequential: true,
          occurredAt: timestamp(111),
        }),
        "CAPABILITY_SCHEMA_CHANGED",
      );
      expectPolicyError(
        await store.beginTestCapabilityExecution({
          step: {
            ...consequentialStep,
            stepFingerprint: `sha256:${"3".repeat(64)}`,
          },
          consequential: true,
          occurredAt: timestamp(112),
        }),
        "INPUT_STALE",
      );
      expectPolicyError(
        await store.beginTestCapabilityExecution({
          step: consequentialStep,
          consequential: true,
          occurredAt: consequentialStep.expiresAt,
        }),
        "LEASE_EXPIRED",
      );
      await assertNoExecutions(store);
    },
  },
  {
    name: "owner, workflow, and lease mismatches cannot authorize or start a consequential step",
    run: async (store) => {
      const { consequentialStep } = await seedTestPolicyState(store);
      const ownerMismatch = await authorize(store, { ...consequentialStep, owner: OWNER_B });
      expectPolicyError(ownerMismatch, ["OWNER_MISMATCH", "WORKFLOW_CHANGED"]);
      expectPolicyError(
        await authorize(store, {
          ...consequentialStep,
          workflowId: OTHER_WORKFLOW_ID,
        }),
        ["OWNER_MISMATCH", "WORKFLOW_CHANGED"],
      );
      expectPolicyError(
        await authorize(store, {
          ...consequentialStep,
          workflowRevision: consequentialStep.workflowRevision + 1,
        }),
        "WORKFLOW_CHANGED",
      );
      expectPolicyError(
        await authorize(store, { ...consequentialStep, leaseId: "wrong-lease" }),
        "BOOTSTRAP_REQUIRED",
      );
      expectPolicyError(
        await authorize(store, { ...consequentialStep, childSessionId: "wrong-child" }),
        "BOOTSTRAP_REQUIRED",
      );
      await assertNoExecutions(store);
    },
  },
  {
    name: "approval and execution races consume one consequential grant exactly once",
    run: async (store) => {
      const { consequentialStep } = await seedTestPolicyState(store);
      const granted = await authorize(store, consequentialStep);
      assert(granted.ok, "Expected approval grant");
      expectPolicyError(
        await authorize(store, consequentialStep, "replayed-approval-request"),
        "INPUT_REPLAYED",
      );
      await assertNoExecutions(store);

      const attempts = await Promise.all([
        store.beginTestCapabilityExecution({
          step: consequentialStep,
          consequential: true,
          occurredAt: timestamp(111),
        }),
        store.beginTestCapabilityExecution({
          step: consequentialStep,
          consequential: true,
          occurredAt: timestamp(111),
        }),
      ]);
      assert(attempts.filter((result) => result.ok).length === 1, "Grant started more than once");
      const rejected = attempts.find((result) => !result.ok);
      assert(rejected !== undefined, "Concurrent replay was not rejected");
      expectPolicyError(rejected, "TEST_STEP_REPLAYED");
      const executions = await store.listTestCapabilityExecutions({
        owner: OWNER_A,
        workflowId: WORKFLOW_ID,
        testRunId: TEST_RUN_ID,
      });
      assert(executions.length === 1, "Concurrent start wrote more than one execution");
      assert(executions[0]?.approval === "verified", "Consequential start lost approval evidence");
    },
  },
  {
    name: "read-only capability starts without approval and records one successful execution",
    run: async (store) => {
      const { readOnlyStep } = await seedTestPolicyState(store);
      const started = await store.beginTestCapabilityExecution({
        step: readOnlyStep,
        consequential: false,
        occurredAt: timestamp(109),
      });
      assert(started.ok, "Read-only capability unexpectedly required approval");
      assert(started.value.approval === "not_required", "Read-only approval status was incorrect");
      assert(started.value.status === "started", "Read-only execution was not started");
      const completed = await store.completeTestCapabilityExecution(
        completionInput(readOnlyStep, "succeeded", 110),
      );
      assert(completed.ok && completed.value.status === "succeeded", "Completion was not recorded");
      const replayed = await store.completeTestCapabilityExecution(
        completionInput(readOnlyStep, "succeeded", 111),
      );
      assert(replayed.ok, "Exact completion retry was not idempotent");
      expectPolicyError(
        await store.completeTestCapabilityExecution(completionInput(readOnlyStep, "failed", 112)),
        "TEST_STEP_REPLAYED",
      );
      const executions = await store.listTestCapabilityExecutions({
        owner: OWNER_A,
        workflowId: WORKFLOW_ID,
        testRunId: TEST_RUN_ID,
      });
      assert(executions.length === 1, "Read-only execution record count was incorrect");
      assert(executions[0]?.status === "succeeded", "Successful record was not retained");
      assert(executions[0]?.completedAt === timestamp(110), "Exact completion timestamp changed");
    },
  },
  {
    name: "verified consequential capability records exact successful execution evidence",
    run: async (store) => {
      const { consequentialStep } = await seedTestPolicyState(store);
      const grant = await authorize(store, consequentialStep);
      assert(grant.ok, "Expected approval grant");
      assert(grant.value.requestId === "approval-request", "Grant lost exact request identity");
      assert(
        grant.value.responderPrincipalId === OWNER_A.ownerKey,
        "Grant lost authenticated responder identity",
      );
      const started = await store.beginTestCapabilityExecution({
        step: consequentialStep,
        consequential: true,
        occurredAt: timestamp(111),
      });
      assert(started.ok && started.value.approval === "verified", "Verified start failed");
      const completed = await store.completeTestCapabilityExecution(
        completionInput(consequentialStep, "succeeded", 112),
      );
      assert(completed.ok && completed.value.status === "succeeded", "Success was not recorded");
      const executions = await store.listTestCapabilityExecutions({
        owner: OWNER_A,
        workflowId: WORKFLOW_ID,
        testRunId: TEST_RUN_ID,
      });
      assert(executions.length === 1, "Consequential execution record count was incorrect");
      const record = executions[0];
      assert(record?.stepFingerprint === consequentialStep.stepFingerprint, "Step identity changed");
      assert(record?.schemaFingerprint === CONSEQUENTIAL_SCHEMA, "Schema identity changed");
      assert(record?.startedAt === timestamp(111), "Start timestamp changed");
      assert(record?.completedAt === timestamp(112), "Completion timestamp changed");
    },
  },
];

export async function runTestPolicyStoreConformanceSuite(
  factoryOrOptions: AgentBuilderStoreFactory | TestPolicyStoreConformanceOptions,
): Promise<TestPolicyStoreConformanceReport> {
  const options =
    typeof factoryOrOptions === "function"
      ? { createStore: factoryOrOptions }
      : factoryOrOptions;
  const passed: string[] = [];
  for (const testCase of testPolicyStoreConformanceCases) {
    const store = await options.createStore();
    try {
      await testCase.run(store);
      passed.push(testCase.name);
    } catch (cause) {
      throw new Error(`Test-policy store conformance failed: ${testCase.name}`, { cause });
    } finally {
      await options.disposeStore?.(store);
    }
  }
  return Object.freeze({ passed: passed.length, caseNames: Object.freeze(passed) });
}
