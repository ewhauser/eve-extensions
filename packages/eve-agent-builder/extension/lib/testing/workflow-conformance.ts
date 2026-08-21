import { createHash } from "node:crypto";

import type {
  ExecutionCapabilityPlan,
  ExecutionLeaseRecord,
  ExecutionRole,
} from "../bootstrap.js";
import {
  agentIdSchema,
  canonicalizeAgentName,
  capabilityIdSchema,
  draftIdSchema,
  operationIdSchema,
  ownerScopeSchema,
  specIdSchema,
  timestampSchema,
  triggerIdSchema,
  type OwnerScope,
  type SavedAgentEditableFields,
  type SavedAgentFamily,
} from "../domain.js";
import type { TestCapabilityStepScope } from "../test-policy.js";
import type {
  AgentBuilderStore,
  AgentBuilderStoreCommand,
  AgentBuilderStoreError,
  AgentBuilderStoreFactory,
  AgentBuilderStoreMutationResult,
  SubmitBuildRoleStoreCommand,
} from "../store.js";
import {
  buildWorkflowRecordSchema,
  buildWorkflowIdSchema,
  testRunIdSchema,
  type BuildWorkflowRecord,
} from "../workflow.js";

export interface BuildWorkflowStoreConformanceCase {
  readonly name: string;
  readonly run: (store: AgentBuilderStore) => Promise<void>;
}

export interface BuildWorkflowStoreConformanceReport {
  readonly passed: number;
  readonly caseNames: readonly string[];
}

export interface BuildWorkflowStoreConformanceOptions {
  readonly createStore: AgentBuilderStoreFactory;
  readonly disposeStore?: (store: AgentBuilderStore) => Promise<void> | void;
}

const OWNER_A = ownerScopeSchema.parse({ tenantKey: "tenant", ownerKey: "owner-a" });
const OWNER_B = ownerScopeSchema.parse({ tenantKey: "tenant", ownerKey: "owner-b" });
const REQUIRED_CAPABILITY = capabilityIdSchema.parse("capability-read");
const OPTIONAL_CAPABILITY = capabilityIdSchema.parse("capability-optional");
const REQUIRED_SCHEMA = "sha256:required-schema-v1";

const BASE_FIELDS: SavedAgentEditableFields = {
  name: "Build target",
  kind: "agent",
  description: "",
  pmBrief: "",
  instructions: "",
  toolRequirements: [],
  triggers: [],
  testChecklist: [],
  qaFindings: [],
};

function timestamp(second: number) {
  return timestampSchema.parse(new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString());
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function mutation(operation: string, requestFingerprint = `fingerprint-${operation}`) {
  return {
    operationId: operationIdSchema.parse(operation),
    requestFingerprint,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function expectSuccess<Type extends Extract<AgentBuilderStoreMutationResult, { ok: true }>["type"]>(
  result: AgentBuilderStoreMutationResult,
  type: Type,
): Extract<AgentBuilderStoreMutationResult, { ok: true; type: Type }> {
  if (!result.ok) throw new Error(`Expected ${type}, received ${result.error.code}`);
  if (result.type !== type) throw new Error(`Expected ${type}, received ${result.type}`);
  return result as Extract<AgentBuilderStoreMutationResult, { ok: true; type: Type }>;
}

function expectError(result: AgentBuilderStoreMutationResult, code: AgentBuilderStoreError["code"]): void {
  if (result.ok) throw new Error(`Expected ${code}, received ${result.type}`);
  equal(result.error.code, code, "Mutation returned the wrong error");
}

function expectBootstrapSuccess<Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: unknown },
  message: string,
): Value {
  if (!result.ok) throw new Error(message);
  return result.value;
}

function changedFields(
  current: SavedAgentEditableFields,
  field: keyof SavedAgentEditableFields,
): SavedAgentEditableFields {
  switch (field) {
    case "name":
      return { ...current, name: `${current.name} changed` };
    case "kind":
      return { ...current, kind: current.kind === "agent" ? "skill" : "agent" };
    case "description":
      return { ...current, description: `${current.description} changed` };
    case "pmBrief":
      return { ...current, pmBrief: `${current.pmBrief} changed` };
    case "instructions":
      return { ...current, instructions: `${current.instructions} changed` };
    case "toolRequirements":
      return {
        ...current,
        toolRequirements: [
          {
            capabilityId: REQUIRED_CAPABILITY,
            level: "required",
            displayNameSnapshot: "Read capability",
            schemaFingerprint: REQUIRED_SCHEMA,
            consequential: false,
          },
        ],
      };
    case "triggers":
      return {
        ...current,
        triggers: [
          {
            kind: "event",
            triggerId: triggerIdSchema.parse("trigger-a"),
            sourceId: "source-a",
            filter: { kind: "example" },
            destination: { channelKind: "slack", address: "channel-a" },
          },
        ],
      };
    case "testChecklist":
      return { ...current, testChecklist: ["Exercise the declared behavior"] };
    case "qaFindings":
      return { ...current, qaFindings: ["No blocking findings"] };
  }
}

function editableFields(family: SavedAgentFamily): SavedAgentEditableFields {
  const draft = family.draft;
  assert(draft !== undefined, "Expected a current draft");
  return {
    name: draft.name,
    kind: draft.kind,
    description: draft.description,
    pmBrief: draft.pmBrief,
    instructions: draft.instructions,
    toolRequirements: draft.toolRequirements,
    triggers: draft.triggers,
    testChecklist: draft.testChecklist,
    qaFindings: draft.qaFindings,
  };
}

async function allocate(
  store: AgentBuilderStore,
  key = "a",
  owner: OwnerScope = OWNER_A,
  fields: SavedAgentEditableFields = BASE_FIELDS,
) {
  return expectSuccess(
    await store.mutate({
      type: "allocate_build_workflow",
      owner,
      mutation: mutation(`allocate-${key}`),
      occurredAt: timestamp(1),
      workflowId: buildWorkflowIdSchema.parse(`workflow-${key}`),
      agentId: agentIdSchema.parse(`agent-${key}`),
      draftId: draftIdSchema.parse(`draft-${key}`),
      maxFamilies: 25,
      canonicalName: canonicalizeAgentName(fields.name),
      fields,
    }),
    "workflow_allocated",
  );
}

async function runningLease(input: {
  readonly store: AgentBuilderStore;
  readonly workflow: BuildWorkflowRecord;
  readonly role: ExecutionRole;
  readonly key: string;
  readonly second: number;
  readonly capabilityPlan?: ExecutionCapabilityPlan;
}): Promise<ExecutionLeaseRecord> {
  const family = await input.store.getFamily({
    owner: input.workflow.owner,
    agentId: input.workflow.agentId,
  });
  assert(family?.draft !== undefined, "Workflow lease target draft was unavailable");
  const tokenHash = sha256(`bootstrap-${input.key}`);
  const target = {
    kind: "draft" as const,
    agentId: input.workflow.agentId,
    draftId: family.draft.draftId,
    draftRevision: family.draft.draftRevision,
  };
  const workflowScope = {
    workflowId: input.workflow.workflowId,
    workflowRevision: input.workflow.revision,
    ...(input.workflow.testRunId === undefined ? {} : { testRunId: input.workflow.testRunId }),
  };
  expectBootstrapSuccess(
    await input.store.createBootstrapGrant({
      grant: {
        grantId: `grant-${input.key}`,
        tokenHash,
        owner: input.workflow.owner,
        role: input.role,
        target,
        workflow: workflowScope,
        parentSessionId: `parent-${input.key}`,
        parentTurnId: `parent-turn-${input.key}`,
        parentCallId: `parent-call-${input.key}`,
        issuedAt: timestamp(input.second),
        expiresAt: timestamp(input.second + 900),
      },
    }),
    "Unable to create exact workflow bootstrap grant",
  );
  const childSessionId = `child-${input.key}`;
  const leaseId = `lease-${input.key}`;
  expectBootstrapSuccess(
    await input.store.redeemBootstrapGrant({
      tokenHash,
      owner: input.workflow.owner,
      role: input.role,
      expectedTarget: target,
      expectedWorkflow: workflowScope,
      parentSessionId: `parent-${input.key}`,
      parentTurnId: `parent-turn-${input.key}`,
      parentCallId: `parent-call-${input.key}`,
      childSessionId,
      bootstrapTurnId: `bootstrap-turn-${input.key}`,
      leaseId,
      occurredAt: timestamp(input.second + 1),
      leaseExpiresAt: timestamp(input.second + 800),
    }),
    "Unable to redeem exact workflow bootstrap grant",
  );
  return expectBootstrapSuccess(
    await input.store.beginExecutionLease({
      owner: input.workflow.owner,
      childSessionId,
      executionTurnId: `execution-turn-${input.key}`,
      occurredAt: timestamp(input.second + 2),
      ...(input.capabilityPlan === undefined ? {} : { capabilityPlan: input.capabilityPlan }),
    }),
    "Unable to claim exact workflow execution lease",
  );
}

function roleCommand(input: {
  readonly workflow: BuildWorkflowRecord;
  readonly family: SavedAgentFamily;
  readonly lease: ExecutionLeaseRecord;
  readonly role: SubmitBuildRoleStoreCommand["role"];
  readonly result: SubmitBuildRoleStoreCommand["result"];
  readonly fields: SavedAgentEditableFields;
  readonly operation: string;
  readonly second: number;
  readonly testRunId?: SubmitBuildRoleStoreCommand["testRunId"];
}): SubmitBuildRoleStoreCommand {
  const draft = input.family.draft;
  assert(draft !== undefined, "Role submission requires a draft");
  return {
    type: "submit_build_role",
    owner: input.workflow.owner,
    mutation: mutation(input.operation),
    occurredAt: timestamp(input.second),
    workflowId: input.workflow.workflowId,
    expectedWorkflowRevision: input.workflow.revision,
    role: input.role,
    leaseId: input.lease.leaseId,
    childSessionId: input.lease.childSessionId,
    executionTurnId: input.lease.executionTurnId ?? "missing-execution-turn",
    expectedRevision: input.family.revision,
    expectedDraftRevision: draft.draftRevision,
    canonicalName: canonicalizeAgentName(input.fields.name),
    fields: input.fields,
    result: input.result,
    ...(input.testRunId === undefined ? {} : { testRunId: input.testRunId }),
  };
}

async function submitRole(input: Parameters<typeof roleCommand>[0] & { readonly store: AgentBuilderStore }) {
  const command = roleCommand(input);
  const result = expectSuccess(await input.store.mutate(command), "workflow_role_submitted");
  const replay = expectSuccess(await input.store.mutate(command), "workflow_role_submitted");
  equal(JSON.stringify(replay), JSON.stringify(result), "Exact role submission did not replay");
  return { workflow: result.workflow, family: result.family };
}

async function advanceRole(input: {
  readonly store: AgentBuilderStore;
  readonly workflow: BuildWorkflowRecord;
  readonly family: SavedAgentFamily;
  readonly role: SubmitBuildRoleStoreCommand["role"];
  readonly result: SubmitBuildRoleStoreCommand["result"];
  readonly fields: SavedAgentEditableFields;
  readonly key: string;
  readonly second: number;
  readonly testRunId?: SubmitBuildRoleStoreCommand["testRunId"];
}) {
  const lease = await runningLease({
    store: input.store,
    workflow: input.workflow,
    role: input.role,
    key: input.key,
    second: input.second,
  });
  return submitRole({
    ...input,
    lease,
    operation: `submit-${input.key}`,
    second: input.second + 3,
  });
}

function implementedFields(family: SavedAgentFamily, withCapabilities = false): SavedAgentEditableFields {
  return {
    ...editableFields(family),
    instructions: "Use only the selected read capability.",
    ...(withCapabilities
      ? {
          toolRequirements: [
            {
              capabilityId: REQUIRED_CAPABILITY,
              level: "required" as const,
              displayNameSnapshot: "Read capability",
              schemaFingerprint: REQUIRED_SCHEMA,
              consequential: false,
            },
            {
              capabilityId: OPTIONAL_CAPABILITY,
              level: "optional" as const,
              displayNameSnapshot: "Optional capability",
              schemaFingerprint: "sha256:optional-schema-v1",
              consequential: false,
            },
          ],
        }
      : {}),
  };
}

async function driveToQa(input: {
  readonly store: AgentBuilderStore;
  readonly key: string;
  readonly capabilities?: boolean;
}) {
  const allocated = await allocate(input.store, input.key);
  const pm = await advanceRole({
    store: input.store,
    workflow: allocated.workflow,
    family: allocated.family,
    role: "pm",
    result: "completed_handoff",
    fields: {
      ...editableFields(allocated.family),
      description: "A PM-authored description",
      pmBrief: "A PM-authored requirement",
    },
    key: `${input.key}-pm`,
    second: 10,
  });
  const implementor = await advanceRole({
    store: input.store,
    workflow: pm.workflow,
    family: pm.family,
    role: "implementor",
    result: "completed_handoff",
    fields: implementedFields(pm.family, input.capabilities === true),
    key: `${input.key}-implementor`,
    second: 20,
  });
  return implementor;
}

async function requestTest(input: {
  readonly store: AgentBuilderStore;
  readonly workflow: BuildWorkflowRecord;
  readonly family: SavedAgentFamily;
  readonly key: string;
  readonly second: number;
}) {
  return advanceRole({
    store: input.store,
    workflow: input.workflow,
    family: input.family,
    role: "qa",
    result: "needs_test",
    fields: {
      ...editableFields(input.family),
      testChecklist: ["Required capability succeeds in test mode"],
      qaFindings: ["Pending isolated test evidence"],
    },
    key: `${input.key}-qa-request`,
    second: input.second,
    testRunId: testRunIdSchema.parse(`test-run-${input.key}`),
  });
}

function testPlan(): ExecutionCapabilityPlan {
  return {
    mode: "test",
    selected: [
      {
        capabilityId: REQUIRED_CAPABILITY,
        modelToolName: "read_capability",
        schemaFingerprint: REQUIRED_SCHEMA,
        consequential: false,
      },
    ],
    optionalOmissions: [
      {
        capabilityId: OPTIONAL_CAPABILITY,
        displayNameSnapshot: "Optional capability",
        reason: "missing",
      },
    ],
  };
}

async function recordPassingTest(input: {
  readonly store: AgentBuilderStore;
  readonly workflow: BuildWorkflowRecord;
  readonly key: string;
  readonly second: number;
}) {
  const testRunId = input.workflow.testRunId;
  assert(testRunId !== undefined, "Test-pending workflow lacked a test run ID");
  const lease = await runningLease({
    store: input.store,
    workflow: input.workflow,
    role: "test_runner",
    key: `${input.key}-runner`,
    second: input.second,
    capabilityPlan: testPlan(),
  });
  const draft = (await input.store.getFamily({
    owner: input.workflow.owner,
    agentId: input.workflow.agentId,
  }))?.draft;
  assert(draft !== undefined, "Test target draft disappeared");
  const step: TestCapabilityStepScope = {
    owner: input.workflow.owner,
    workflowId: input.workflow.workflowId,
    workflowRevision: input.workflow.revision,
    testRunId,
    agentId: input.workflow.agentId,
    draftId: draft.draftId,
    draftRevision: draft.draftRevision,
    leaseId: lease.leaseId,
    childSessionId: lease.childSessionId,
    executionTurnId: lease.executionTurnId ?? "missing-execution-turn",
    capabilityId: REQUIRED_CAPABILITY,
    schemaFingerprint: REQUIRED_SCHEMA,
    modelToolName: "read_capability",
    callId: `call-${input.key}`,
    stepFingerprint: sha256(`step-${input.key}`),
    expiresAt: lease.expiresAt,
  };
  const started = await input.store.beginTestCapabilityExecution({
    step,
    consequential: false,
    occurredAt: timestamp(input.second + 3),
  });
  assert(started.ok && started.value.status === "started", "Required test step did not start");
  const completed = await input.store.completeTestCapabilityExecution({
    owner: step.owner,
    workflowId: step.workflowId,
    testRunId: step.testRunId,
    leaseId: step.leaseId,
    childSessionId: step.childSessionId,
    executionTurnId: step.executionTurnId,
    callId: step.callId,
    status: "succeeded",
    occurredAt: timestamp(input.second + 4),
  });
  assert(completed.ok && completed.value.status === "succeeded", "Required test step did not complete");
  const command: Extract<AgentBuilderStoreCommand, { type: "record_build_test" }> = {
      type: "record_build_test",
      owner: input.workflow.owner,
      mutation: mutation(`record-test-${input.key}`),
      occurredAt: timestamp(input.second + 5),
      workflowId: input.workflow.workflowId,
      expectedWorkflowRevision: input.workflow.revision,
      testRunId,
      leaseId: lease.leaseId,
      childSessionId: lease.childSessionId,
      executionTurnId: step.executionTurnId,
      status: "passed",
      errorCodes: [],
    };
  const recorded = expectSuccess(
    await input.store.mutate(command),
    "workflow_test_recorded",
  );
  const replay = expectSuccess(await input.store.mutate(command), "workflow_test_recorded");
  equal(JSON.stringify(replay), JSON.stringify(recorded), "Exact test result did not replay");
  equal(recorded.workflow.testEvidence?.status, "passed", "Passing test evidence was not stored");
  return { workflow: recorded.workflow, family: recorded.family };
}

async function driveToPublishReady(store: AgentBuilderStore, key: string) {
  const qa = await driveToQa({ store, key, capabilities: true });
  const requested = await requestTest({
    store,
    workflow: qa.workflow,
    family: qa.family,
    key,
    second: 30,
  });
  const tested = await recordPassingTest({
    store,
    workflow: requested.workflow,
    key,
    second: 40,
  });
  const approved = await advanceRole({
    store,
    workflow: tested.workflow,
    family: tested.family,
    role: "qa",
    result: "approved",
    fields: editableFields(tested.family),
    key: `${key}-qa-approve`,
    second: 50,
  });
  equal(approved.workflow.phase, "publish_ready", "QA approval did not reach publish-ready");
  return approved;
}

const roleOwnedFields = {
  pm: ["name", "kind", "description", "pmBrief"],
  implementor: ["instructions", "toolRequirements", "triggers"],
  qa: ["testChecklist", "qaFindings"],
} as const satisfies Readonly<
  Record<SubmitBuildRoleStoreCommand["role"], readonly (keyof SavedAgentEditableFields)[]>
>;

const allFields = [
  "name",
  "kind",
  "description",
  "pmBrief",
  "instructions",
  "toolRequirements",
  "triggers",
  "testChecklist",
  "qaFindings",
] as const satisfies readonly (keyof SavedAgentEditableFields)[];

async function assertForbiddenFields(input: {
  readonly store: AgentBuilderStore;
  readonly workflow: BuildWorkflowRecord;
  readonly family: SavedAgentFamily;
  readonly role: SubmitBuildRoleStoreCommand["role"];
  readonly lease: ExecutionLeaseRecord;
  readonly key: string;
}): Promise<void> {
  const current = editableFields(input.family);
  const forbidden = allFields.filter((field) => !roleOwnedFields[input.role].includes(field as never));
  for (const [index, field] of forbidden.entries()) {
    const changed = changedFields(current, field);
    expectError(
      await input.store.mutate(
        roleCommand({
          workflow: input.workflow,
          family: input.family,
          lease: input.lease,
          role: input.role,
          result: "needs_user_input",
          fields: changed,
          operation: `forbidden-${input.key}-${field}-${index}`,
          second: 70 + index,
        }),
      ),
      "ROLE_FORBIDDEN",
    );
  }
  const persisted = await input.store.getFamily({
    owner: input.workflow.owner,
    agentId: input.workflow.agentId,
  });
  equal(JSON.stringify(persisted), JSON.stringify(input.family), `${input.role} forbidden fields mutated family`);
  const workflow = await input.store.getBuildWorkflow({
    owner: input.workflow.owner,
    agentId: input.workflow.agentId,
  });
  equal(
    JSON.stringify(workflow),
    JSON.stringify(input.workflow),
    `${input.role} forbidden fields advanced workflow`,
  );
}

export const buildWorkflowStoreConformanceCases: readonly BuildWorkflowStoreConformanceCase[] = [
  {
    name: "allocation atomically creates one owner-scoped family and PM workflow",
    run: async (store) => {
      const allocated = await allocate(store);
      equal(allocated.workflow.phase, "pm_work", "Allocation did not start in PM work");
      equal(allocated.workflow.revision, 1, "Allocation workflow revision was not one");
      equal(allocated.workflow.draftRevision, 1, "Allocation draft revision was not one");
      equal(allocated.workflow.transitions[0]?.result, "allocated", "Allocation transition missing");
      equal(allocated.workflow.transitions[0]?.role, "system", "Allocation was not system-owned");
      equal(allocated.family.agentId, allocated.workflow.agentId, "Family/workflow agent mismatch");
      equal(allocated.family.draft?.draftId, allocated.workflow.draftId, "Family/workflow draft mismatch");
      equal(
        await store.getBuildWorkflow({ owner: OWNER_B, agentId: allocated.family.agentId }),
        null,
        "Cross-owner workflow read disclosed state",
      );

      const conflicting = await store.mutate({
        type: "allocate_build_workflow",
        owner: OWNER_A,
        mutation: mutation("allocate-conflicting-name"),
        occurredAt: timestamp(2),
        workflowId: buildWorkflowIdSchema.parse("workflow-conflict"),
        agentId: agentIdSchema.parse("agent-conflict"),
        draftId: draftIdSchema.parse("draft-conflict"),
        maxFamilies: 25,
        canonicalName: canonicalizeAgentName(BASE_FIELDS.name),
        fields: BASE_FIELDS,
      });
      expectError(conflicting, "NAME_CONFLICT");
      equal(
        await store.getFamily({ owner: OWNER_A, agentId: agentIdSchema.parse("agent-conflict") }),
        null,
        "Failed allocation left a partial family",
      );
      equal(
        await store.getBuildWorkflow({ owner: OWNER_A, agentId: agentIdSchema.parse("agent-conflict") }),
        null,
        "Failed allocation left a partial workflow",
      );
    },
  },
  {
    name: "PM, implementor, and QA reject every foreign field and invalid outcome",
    run: async (store) => {
      const allocated = await allocate(store, "matrix");
      const pmLease = await runningLease({
        store,
        workflow: allocated.workflow,
        role: "pm",
        key: "matrix-pm",
        second: 10,
      });
      await assertForbiddenFields({
        store,
        workflow: allocated.workflow,
        family: allocated.family,
        role: "pm",
        lease: pmLease,
        key: "pm",
      });
      expectError(
        await store.mutate(
          roleCommand({
            workflow: allocated.workflow,
            family: allocated.family,
            lease: pmLease,
            role: "pm",
            result: "approved",
            fields: editableFields(allocated.family),
            operation: "pm-invalid-outcome",
            second: 80,
          }),
        ),
        "WORKFLOW_INVALID_TRANSITION",
      );
      const pm = await submitRole({
        store,
        workflow: allocated.workflow,
        family: allocated.family,
        lease: pmLease,
        role: "pm",
        result: "completed_handoff",
        fields: { ...editableFields(allocated.family), pmBrief: "PM requirements" },
        operation: "matrix-pm-allowed",
        second: 81,
      });

      const implementorLease = await runningLease({
        store,
        workflow: pm.workflow,
        role: "implementor",
        key: "matrix-implementor",
        second: 90,
      });
      await assertForbiddenFields({
        store,
        workflow: pm.workflow,
        family: pm.family,
        role: "implementor",
        lease: implementorLease,
        key: "implementor",
      });
      expectError(
        await store.mutate(
          roleCommand({
            workflow: pm.workflow,
            family: pm.family,
            lease: implementorLease,
            role: "implementor",
            result: "needs_test",
            fields: editableFields(pm.family),
            operation: "implementor-invalid-outcome",
            second: 100,
            testRunId: testRunIdSchema.parse("implementor-forged-test-run"),
          }),
        ),
        "WORKFLOW_INVALID_TRANSITION",
      );
      const implementor = await submitRole({
        store,
        workflow: pm.workflow,
        family: pm.family,
        lease: implementorLease,
        role: "implementor",
        result: "completed_handoff",
        fields: { ...editableFields(pm.family), instructions: "Implementation instructions" },
        operation: "matrix-implementor-allowed",
        second: 101,
      });

      const qaLease = await runningLease({
        store,
        workflow: implementor.workflow,
        role: "qa",
        key: "matrix-qa",
        second: 110,
      });
      await assertForbiddenFields({
        store,
        workflow: implementor.workflow,
        family: implementor.family,
        role: "qa",
        lease: qaLease,
        key: "qa",
      });
      expectError(
        await store.mutate(
          roleCommand({
            workflow: implementor.workflow,
            family: implementor.family,
            lease: qaLease,
            role: "qa",
            result: "completed_handoff",
            fields: editableFields(implementor.family),
            operation: "qa-invalid-outcome",
            second: 120,
          }),
        ),
        "WORKFLOW_INVALID_TRANSITION",
      );
    },
  },
  {
    name: "stale handoffs, draft revisions, leases, and owner switches fail closed",
    run: async (store) => {
      const allocated = await allocate(store, "stale");
      const pmLease = await runningLease({
        store,
        workflow: allocated.workflow,
        role: "pm",
        key: "stale-pm",
        second: 10,
      });
      const pmCommand = roleCommand({
        workflow: allocated.workflow,
        family: allocated.family,
        lease: pmLease,
        role: "pm",
        result: "completed_handoff",
        fields: { ...editableFields(allocated.family), pmBrief: "Current requirements" },
        operation: "stale-pm-current",
        second: 13,
      });
      const pm = expectSuccess(await store.mutate(pmCommand), "workflow_role_submitted");

      expectError(
        await store.mutate({
          ...pmCommand,
          mutation: mutation("stale-pm-late"),
          occurredAt: timestamp(14),
        }),
        "WORKFLOW_CONFLICT",
      );
      const implementorLease = await runningLease({
        store,
        workflow: pm.workflow,
        role: "implementor",
        key: "stale-implementor",
        second: 20,
      });
      const currentFields = editableFields(pm.family);
      expectError(
        await store.mutate({
          ...roleCommand({
            workflow: pm.workflow,
            family: pm.family,
            lease: implementorLease,
            role: "implementor",
            result: "completed_handoff",
            fields: { ...currentFields, instructions: "stale draft attempt" },
            operation: "stale-draft-revision",
            second: 23,
          }),
          expectedDraftRevision: (pm.family.draft?.draftRevision ?? 1) - 1,
        }),
        "REVISION_CONFLICT",
      );
      expectError(
        await store.mutate({
          ...roleCommand({
            workflow: pm.workflow,
            family: pm.family,
            lease: implementorLease,
            role: "implementor",
            result: "completed_handoff",
            fields: { ...currentFields, instructions: "owner switch attempt" },
            operation: "owner-switch",
            second: 24,
          }),
          owner: OWNER_B,
        }),
        "WORKFLOW_NOT_FOUND",
      );
      const driftedFields = { ...currentFields, instructions: "new current draft instructions" };
      const driftedFamily = expectSuccess(
        await store.mutate({
          type: "patch_draft",
          owner: OWNER_A,
          mutation: mutation("stale-lease-target-drift"),
          occurredAt: timestamp(25),
          agentId: pm.family.agentId,
          expectedRevision: pm.family.revision,
          expectedDraftRevision: pm.family.draft?.draftRevision ?? 0,
          canonicalName: canonicalizeAgentName(driftedFields.name),
          fields: driftedFields,
        }),
        "draft_patched",
      ).family;
      const driftedWorkflow = await store.getBuildWorkflow({
        owner: OWNER_A,
        agentId: pm.family.agentId,
      });
      assert(driftedWorkflow !== null, "Workflow disappeared after target drift");
      expectError(
        await store.mutate(
          roleCommand({
            workflow: driftedWorkflow,
            family: driftedFamily,
            lease: implementorLease,
            role: "implementor",
            result: "completed_handoff",
            fields: { ...editableFields(driftedFamily), instructions: "stale lease overwrite" },
            operation: "stale-authoritative-lease",
            second: 26,
          }),
        ),
        "ROLE_FORBIDDEN",
      );
      equal(
        await store.getBuildWorkflow({ owner: OWNER_B, agentId: pm.family.agentId }),
        null,
        "Owner switch disclosed the workflow",
      );
      const persisted = await store.getBuildWorkflow({ owner: OWNER_A, agentId: pm.family.agentId });
      equal(
        JSON.stringify(persisted),
        JSON.stringify(driftedWorkflow),
        "Rejected stale lease advanced workflow",
      );
    },
  },
  {
    name: "expired running leases cannot commit role handoffs or test evidence",
    run: async (store) => {
      const allocated = await allocate(store, "expired-role", OWNER_A, {
        ...BASE_FIELDS,
        name: "Expired role target",
      });
      const pmLease = await runningLease({
        store,
        workflow: allocated.workflow,
        role: "pm",
        key: "expired-role-pm",
        second: 10,
      });
      expectError(
        await store.mutate(
          roleCommand({
            workflow: allocated.workflow,
            family: allocated.family,
            lease: pmLease,
            role: "pm",
            result: "completed_handoff",
            fields: { ...editableFields(allocated.family), pmBrief: "Must not commit" },
            operation: "expired-role-submit",
            second: 810,
          }),
        ),
        "ROLE_FORBIDDEN",
      );
      equal(
        (await store.getBuildWorkflow({ owner: OWNER_A, agentId: allocated.family.agentId }))?.phase,
        "pm_work",
        "Expired role lease advanced the workflow",
      );

      const qa = await driveToQa({
        store,
        key: "expired-test",
        capabilities: true,
      });
      const requested = await requestTest({
        store,
        workflow: qa.workflow,
        family: qa.family,
        key: "expired-test",
        second: 30,
      });
      const runner = await runningLease({
        store,
        workflow: requested.workflow,
        role: "test_runner",
        key: "expired-test-runner",
        second: 40,
        capabilityPlan: testPlan(),
      });
      const testRunId = requested.workflow.testRunId;
      assert(testRunId !== undefined, "Expired test workflow lacked a test run ID");
      expectError(
        await store.mutate({
          type: "record_build_test",
          owner: OWNER_A,
          mutation: mutation("expired-test-submit"),
          occurredAt: timestamp(840),
          workflowId: requested.workflow.workflowId,
          expectedWorkflowRevision: requested.workflow.revision,
          testRunId,
          leaseId: runner.leaseId,
          childSessionId: runner.childSessionId,
          executionTurnId: runner.executionTurnId ?? "missing-execution-turn",
          status: "passed",
          errorCodes: [],
        }),
        "TEST_EVIDENCE_REQUIRED",
      );
      equal(
        (await store.getBuildWorkflow({ owner: OWNER_A, agentId: requested.family.agentId }))
          ?.testEvidence,
        undefined,
        "Expired test lease recorded evidence",
      );
    },
  },
  {
    name: "QA approval requires passing evidence for the exact run and required plan",
    run: async (store) => {
      const qa = await driveToQa({ store, key: "gate", capabilities: true });
      const prematureLease = await runningLease({
        store,
        workflow: qa.workflow,
        role: "qa",
        key: "gate-premature-qa",
        second: 30,
      });
      expectError(
        await store.mutate(
          roleCommand({
            workflow: qa.workflow,
            family: qa.family,
            lease: prematureLease,
            role: "qa",
            result: "approved",
            fields: editableFields(qa.family),
            operation: "gate-premature-approval",
            second: 33,
          }),
        ),
        "TEST_EVIDENCE_REQUIRED",
      );
      const requested = await submitRole({
        store,
        workflow: qa.workflow,
        family: qa.family,
        lease: prematureLease,
        role: "qa",
        result: "needs_test",
        fields: editableFields(qa.family),
        operation: "gate-request-test",
        second: 34,
        testRunId: testRunIdSchema.parse("test-run-gate"),
      });
      const runner = await runningLease({
        store,
        workflow: requested.workflow,
        role: "test_runner",
        key: "gate-runner",
        second: 40,
        capabilityPlan: testPlan(),
      });
      expectError(
        await store.mutate({
          type: "record_build_test",
          owner: OWNER_A,
          mutation: mutation("gate-wrong-test-run"),
          occurredAt: timestamp(43),
          workflowId: requested.workflow.workflowId,
          expectedWorkflowRevision: requested.workflow.revision,
          testRunId: testRunIdSchema.parse("test-run-wrong"),
          leaseId: runner.leaseId,
          childSessionId: runner.childSessionId,
          executionTurnId: runner.executionTurnId ?? "missing-execution-turn",
          status: "passed",
          errorCodes: [],
        }),
        "WORKFLOW_INVALID_TRANSITION",
      );
      const incomplete = expectSuccess(
        await store.mutate({
          type: "record_build_test",
          owner: OWNER_A,
          mutation: mutation("gate-missing-required-execution"),
          occurredAt: timestamp(44),
          workflowId: requested.workflow.workflowId,
          expectedWorkflowRevision: requested.workflow.revision,
          testRunId: requested.workflow.testRunId ?? testRunIdSchema.parse("missing-test-run"),
          leaseId: runner.leaseId,
          childSessionId: runner.childSessionId,
          executionTurnId: runner.executionTurnId ?? "missing-execution-turn",
          status: "passed",
          errorCodes: [],
        }),
        "workflow_test_recorded",
      );
      equal(incomplete.workflow.testEvidence?.status, "failed", "Missing required execution passed");
      const approvalLease = await runningLease({
        store,
        workflow: incomplete.workflow,
        role: "qa",
        key: "gate-approval-after-failure",
        second: 50,
      });
      expectError(
        await store.mutate(
          roleCommand({
            workflow: incomplete.workflow,
            family: incomplete.family,
            lease: approvalLease,
            role: "qa",
            result: "approved",
            fields: editableFields(incomplete.family),
            operation: "gate-approval-after-failed-test",
            second: 53,
          }),
        ),
        "TEST_EVIDENCE_REQUIRED",
      );
    },
  },
  {
    name: "test evidence includes executions only from the submitting exact lease",
    run: async (store) => {
      const qa = await driveToQa({ store, key: "lease-evidence", capabilities: true });
      const requested = await requestTest({
        store,
        workflow: qa.workflow,
        family: qa.family,
        key: "lease-evidence",
        second: 30,
      });
      const first = await runningLease({
        store,
        workflow: requested.workflow,
        role: "test_runner",
        key: "lease-evidence-first",
        second: 40,
        capabilityPlan: testPlan(),
      });
      const second = await runningLease({
        store,
        workflow: requested.workflow,
        role: "test_runner",
        key: "lease-evidence-second",
        second: 45,
        capabilityPlan: testPlan(),
      });
      const testRunId = requested.workflow.testRunId;
      const draft = requested.family.draft;
      assert(testRunId !== undefined && draft !== undefined, "Exact test target disappeared");
      const secondStep: TestCapabilityStepScope = {
        owner: OWNER_A,
        workflowId: requested.workflow.workflowId,
        workflowRevision: requested.workflow.revision,
        testRunId,
        agentId: requested.family.agentId,
        draftId: draft.draftId,
        draftRevision: draft.draftRevision,
        leaseId: second.leaseId,
        childSessionId: second.childSessionId,
        executionTurnId: second.executionTurnId ?? "missing-execution-turn",
        capabilityId: REQUIRED_CAPABILITY,
        schemaFingerprint: REQUIRED_SCHEMA,
        modelToolName: "read_capability",
        callId: "lease-evidence-second-call",
        stepFingerprint: sha256("lease-evidence-second-step"),
        expiresAt: second.expiresAt,
      };
      const started = await store.beginTestCapabilityExecution({
        step: secondStep,
        consequential: false,
        occurredAt: timestamp(48),
      });
      assert(started.ok, "Second lease test step did not start");
      const completed = await store.completeTestCapabilityExecution({
        owner: OWNER_A,
        workflowId: secondStep.workflowId,
        testRunId,
        leaseId: second.leaseId,
        childSessionId: second.childSessionId,
        executionTurnId: secondStep.executionTurnId,
        callId: secondStep.callId,
        status: "succeeded",
        occurredAt: timestamp(49),
      });
      assert(completed.ok, "Second lease test step did not complete");
      const recorded = expectSuccess(
        await store.mutate({
          type: "record_build_test",
          owner: OWNER_A,
          mutation: mutation("lease-evidence-first-submit"),
          occurredAt: timestamp(50),
          workflowId: requested.workflow.workflowId,
          expectedWorkflowRevision: requested.workflow.revision,
          testRunId,
          leaseId: first.leaseId,
          childSessionId: first.childSessionId,
          executionTurnId: first.executionTurnId ?? "missing-execution-turn",
          status: "passed",
          errorCodes: [],
        }),
        "workflow_test_recorded",
      );
      equal(recorded.workflow.testEvidence?.status, "failed", "Foreign lease execution passed the test");
      equal(recorded.workflow.testEvidence?.usedCapabilityIds.length, 0, "Foreign lease execution was credited");
    },
  },
  {
    name: "publish-ready workflow reopens atomically and later edits keep publication blocked",
    run: async (store) => {
      const ready = await driveToPublishReady(store, "invalidate");
      const draft = ready.family.draft;
      assert(draft !== undefined, "Publish-ready workflow lost its draft");
      const reopenCommand: Extract<AgentBuilderStoreCommand, { type: "reopen_build_workflow" }> = {
        type: "reopen_build_workflow",
        owner: OWNER_A,
        mutation: mutation("reopen-after-approval"),
        occurredAt: timestamp(60),
        workflowId: ready.workflow.workflowId,
        agentId: ready.family.agentId,
        expectedWorkflowRevision: ready.workflow.revision,
        expectedRevision: ready.family.revision,
        expectedDraftRevision: draft.draftRevision,
      };
      const reopened = expectSuccess(await store.mutate(reopenCommand), "workflow_reopened");
      const replay = expectSuccess(await store.mutate(reopenCommand), "workflow_reopened");
      equal(JSON.stringify(replay), JSON.stringify(reopened), "Exact reopen did not replay");
      equal(reopened.workflow.phase, "pm_work", "Reopened workflow did not return to PM work");
      equal(reopened.workflow.qaApproval, undefined, "Reopen retained QA approval");
      equal(reopened.workflow.testEvidence, undefined, "Reopen retained test evidence");
      equal(
        reopened.workflow.transitions.at(-1)?.result,
        "approval_invalidated",
        "Approval invalidation transition missing",
      );
      equal(
        reopened.family.draft?.draftRevision,
        draft.draftRevision,
        "Reopen mutated the draft before PM authored an edit",
      );
      const pmLease = await runningLease({
        store,
        workflow: reopened.workflow,
        role: "pm",
        key: "reopened-pm",
        second: 62,
      });
      const edited = await submitRole({
        store,
        workflow: reopened.workflow,
        family: reopened.family,
        lease: pmLease,
        role: "pm",
        result: "completed_handoff",
        fields: {
          ...editableFields(reopened.family),
          pmBrief: "User-requested requirements after QA approval",
        },
        operation: "reopened-pm-edit",
        second: 65,
      });
      equal(edited.workflow.phase, "implementation_work", "PM edit did not restart implementation");
      equal(
        edited.workflow.draftRevision,
        draft.draftRevision + 1,
        "PM edit did not create an exact new draft revision",
      );
      expectError(
        await store.mutate({
          type: "publish_build_workflow",
          owner: OWNER_A,
          mutation: mutation("invalidated-publish"),
          occurredAt: timestamp(66),
          workflowId: edited.workflow.workflowId,
          expectedWorkflowRevision: edited.workflow.revision,
          agentId: edited.family.agentId,
          expectedRevision: edited.family.revision,
          expectedDraftRevision: edited.family.draft?.draftRevision ?? 0,
          specId: specIdSchema.parse("spec-invalidated"),
          publishedBy: "principal-user-a",
        }),
        "PUBLISH_NOT_READY",
      );
      equal((await store.listVersions({ owner: OWNER_A, agentId: ready.family.agentId })).length, 0, "Failed publish appended a version");
      equal((await store.listActiveFamilies(OWNER_A)).length, 0, "Failed publish moved the active pointer");
      assert(
        (await store.getFamily({ owner: OWNER_A, agentId: ready.family.agentId }))?.draft !== undefined,
        "Failed publish cleared the draft",
      );
    },
  },
  {
    name: "workflow operations replay exactly and reject changed operation identities",
    run: async (store) => {
      const command: Extract<AgentBuilderStoreCommand, { type: "allocate_build_workflow" }> = {
        type: "allocate_build_workflow",
        owner: OWNER_A,
        mutation: mutation("replay-allocation"),
        occurredAt: timestamp(1),
        workflowId: buildWorkflowIdSchema.parse("workflow-replay"),
        agentId: agentIdSchema.parse("agent-replay"),
        draftId: draftIdSchema.parse("draft-replay"),
        maxFamilies: 25,
        canonicalName: canonicalizeAgentName(BASE_FIELDS.name),
        fields: BASE_FIELDS,
      };
      const first = expectSuccess(await store.mutate(command), "workflow_allocated");
      const replay = expectSuccess(await store.mutate(command), "workflow_allocated");
      equal(JSON.stringify(replay), JSON.stringify(first), "Exact workflow allocation did not replay");
      expectError(
        await store.mutate({
          ...command,
          mutation: { ...command.mutation, requestFingerprint: "changed-request" },
        }),
        "OPERATION_ID_REUSED",
      );
      const lookup = await store.getMutationReplay({ owner: OWNER_A, mutation: command.mutation });
      equal(lookup.status, "replay", "Successful workflow mutation was not durably replayable");
      equal(
        (await store.getBuildWorkflow({ owner: OWNER_A, agentId: first.family.agentId }))?.transitions.length,
        1,
        "Allocation replay duplicated its transition",
      );
    },
  },
  {
    name: "publication atomically exposes the exact immutable version and exact retry result",
    run: async (store) => {
      const ready = await driveToPublishReady(store, "publish");
      const draft = ready.family.draft;
      assert(draft !== undefined, "Publish-ready workflow lost its draft");
      const command: Extract<AgentBuilderStoreCommand, { type: "publish_build_workflow" }> = {
        type: "publish_build_workflow",
        owner: OWNER_A,
        mutation: mutation("publish-exact-version"),
        occurredAt: timestamp(60),
        workflowId: ready.workflow.workflowId,
        expectedWorkflowRevision: ready.workflow.revision,
        agentId: ready.family.agentId,
        expectedRevision: ready.family.revision,
        expectedDraftRevision: draft.draftRevision,
        specId: specIdSchema.parse("spec-published-exact"),
        publishedBy: "principal-user-a",
      };
      const published = expectSuccess(await store.mutate(command), "workflow_published");
      const replay = expectSuccess(await store.mutate(command), "workflow_published");
      equal(JSON.stringify(replay), JSON.stringify(published), "Lost publish response did not replay exactly");
      equal(published.workflow.phase, "published", "Workflow did not become published");
      equal(published.workflow.published?.specId, command.specId, "Published evidence spec mismatch");
      equal(published.family.activeSpecId, command.specId, "Active pointer did not move atomically");
      equal(published.family.activeVersion, 1, "Active pointer version mismatch");
      equal(published.family.draft, undefined, "Published family retained its draft");
      equal(published.publishedVersion.version, 1, "Immutable version was not max-history plus one");
      equal(published.publishedVersion.instructions, draft.instructions, "Published wrong draft content");
      equal(
        published.workflow.testEvidence?.optionalOmissions[0]?.capabilityId,
        OPTIONAL_CAPABILITY,
        "Optional omission was not retained in minimal QA evidence",
      );
      equal(
        published.workflow.qaApproval?.capabilityPlanFingerprint,
        published.workflow.testEvidence?.capabilityPlanFingerprint,
        "QA approval was not bound to the exact tested plan",
      );
      const publishedEvidence = published.workflow.published;
      assert(publishedEvidence !== undefined, "Published workflow omitted publication evidence");
      for (const changedBinding of [
        { owner: OWNER_B },
        { workflowId: buildWorkflowIdSchema.parse("workflow-foreign-published-evidence") },
        { agentId: agentIdSchema.parse("agent-foreign-published-evidence") },
      ]) {
        assert(
          !buildWorkflowRecordSchema.safeParse({
            ...published.workflow,
            published: { ...publishedEvidence, ...changedBinding },
          }).success,
          "Workflow schema accepted publication evidence bound to another target",
        );
      }

      const exact = await store.getVersion({
        owner: OWNER_A,
        agentId: command.agentId,
        specId: command.specId,
        version: 1,
      });
      equal(JSON.stringify(exact), JSON.stringify(published.publishedVersion), "Current get saw wrong version");
      const versions = await store.listVersions({ owner: OWNER_A, agentId: command.agentId });
      equal(versions.length, 1, "Publish retry appended a duplicate version");
      const active = await store.listActiveFamilies(OWNER_A);
      equal(active.length, 1, "Published family was not active");
      equal(
        JSON.stringify(active[0]?.activeVersion),
        JSON.stringify(published.publishedVersion),
        "Active roster saw a different immutable version",
      );
      equal(
        (await store.getBuildWorkflow({ owner: OWNER_A, agentId: command.agentId }))?.published?.specId,
        command.specId,
        "Workflow publication evidence was not committed with the version",
      );
    },
  },
];

export async function runBuildWorkflowStoreConformanceSuite(
  factoryOrOptions: AgentBuilderStoreFactory | BuildWorkflowStoreConformanceOptions,
): Promise<BuildWorkflowStoreConformanceReport> {
  const options =
    typeof factoryOrOptions === "function"
      ? { createStore: factoryOrOptions }
      : factoryOrOptions;
  const passed: string[] = [];
  for (const testCase of buildWorkflowStoreConformanceCases) {
    const store = await options.createStore();
    try {
      await testCase.run(store);
      passed.push(testCase.name);
    } catch (cause) {
      throw new Error(`Build workflow store conformance failed: ${testCase.name}`, { cause });
    } finally {
      await options.disposeStore?.(store);
    }
  }
  return Object.freeze({ passed: passed.length, caseNames: Object.freeze(passed) });
}
