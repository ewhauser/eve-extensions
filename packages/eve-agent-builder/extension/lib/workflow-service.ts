import { z } from "zod";

import {
  agentIdSchema,
  canonicalizeAgentName,
  draftIdSchema,
  operationIdSchema,
  savedAgentEditableFieldsSchema,
  savedAgentKindSchema,
  savedToolRequirementSchema,
  savedTriggerDefinitionSchema,
  specIdSchema,
  timestampSchema,
  type AgentId,
  type OwnerResolutionInput,
  type OwnerScope,
  type ResolveOwner,
  type SavedAgentDraft,
  type SavedAgentEditableFields,
  type SavedAgentFamily,
  type Timestamp,
  type TrustedMutationIdentity,
} from "./domain.js";
import {
  buildExecutionScopesEqual,
  bootstrapTargetsEqual,
  type BootstrapError,
  type BootstrapService,
  type ExecutionLeaseRecord,
  type ExecutionRole,
  type IssuedBootstrapGrant,
} from "./bootstrap.js";
import type { RunnerCapabilityMode } from "./capabilities.js";
import {
  fingerprintMutationRequest,
  resolveCurrentOwner,
  type AgentBuilderClock,
  type AgentBuilderError,
  type AgentBuilderIdFactory,
} from "./service.js";
import type {
  AgentBuilderStore,
  AgentBuilderStoreMutationSuccess,
} from "./store.js";
import {
  buildWorkflowIdSchema,
  implementorSubmissionResultSchema,
  pmSubmissionResultSchema,
  qaSubmissionResultSchema,
  testRunIdSchema,
  type BuildWorkflowIdFactory,
  type BuildWorkflowRecord,
} from "./workflow.js";

export interface BuildWorkflowCoordinatorIdFactory
  extends AgentBuilderIdFactory,
    BuildWorkflowIdFactory {}

export interface BuildWorkflowCoordinatorOptions {
  readonly store: AgentBuilderStore;
  readonly resolveOwner: ResolveOwner;
  readonly bootstrap: Pick<BootstrapService, "issue">;
  readonly clock?: AgentBuilderClock;
  readonly ids?: BuildWorkflowCoordinatorIdFactory;
  readonly maxAgentFamiliesPerOwner?: number;
}

/** Trusted host/runtime context. None of these fields belong in model-authored input. */
export interface BuildWorkflowMutationContext {
  readonly ownerResolution: OwnerResolutionInput;
  readonly operationId: string;
}

/** Trusted selection made by the host from a prior typed workflow result. */
export interface BuildWorkflowTargetContext {
  readonly ownerResolution: OwnerResolutionInput;
  readonly agentId: AgentId;
}

/** Trusted root-turn lineage used only to bind a fresh bootstrap grant. */
export interface BuildWorkflowPrepareContext extends BuildWorkflowTargetContext {
  readonly parentSessionId: string;
  readonly parentTurnId?: string;
  readonly parentCallId?: string;
}

/** Trusted child execution identity, normally derived directly from Eve ToolContext. */
export interface BuildWorkflowExecutionContext extends BuildWorkflowMutationContext {
  readonly childSessionId: string;
  readonly executionTurnId: string;
}

export type BuildWorkflowCoordinatorError =
  | AgentBuilderError
  | BootstrapError
  | Readonly<{
      readonly code: "WORKFLOW_NOT_FOUND" | "DEPENDENCY_CONTRACT_VIOLATION";
      readonly message: string;
    }>;

export type BuildWorkflowCoordinatorResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: BuildWorkflowCoordinatorError };

type BuildWorkflowCoordinatorFailure = Extract<
  BuildWorkflowCoordinatorResult<never>,
  { readonly ok: false }
>;

export const allocateBuildWorkflowInputSchema = z.object({}).strict();
export const getBuildWorkflowNextInputSchema = z.object({}).strict();
export const prepareBuildWorkflowNextInputSchema = z.object({}).strict();

const pmPatchSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    kind: savedAgentKindSchema.optional(),
    description: z.string().max(8_000).optional(),
    pmBrief: z.string().max(32_000).optional(),
  })
  .strict();

const implementorPatchSchema = z
  .object({
    instructions: z.string().max(128_000).optional(),
    toolRequirements: z.array(savedToolRequirementSchema).max(256).readonly().optional(),
    triggers: z.array(savedTriggerDefinitionSchema).max(256).readonly().optional(),
  })
  .strict();

const qaPatchSchema = z
  .object({
    testChecklist: z.array(z.string().min(1).max(4_000)).max(256).readonly().optional(),
    qaFindings: z.array(z.string().min(1).max(8_000)).max(256).readonly().optional(),
  })
  .strict();

export const pmBuildSubmissionInputSchema = z
  .object({ patch: pmPatchSchema, result: pmSubmissionResultSchema })
  .strict();

export const implementorBuildSubmissionInputSchema = z
  .object({ patch: implementorPatchSchema, result: implementorSubmissionResultSchema })
  .strict();

export const qaBuildSubmissionInputSchema = z
  .object({ patch: qaPatchSchema, result: qaSubmissionResultSchema })
  .strict();

export const recordBuildTestInputSchema = z
  .object({
    status: z.enum(["passed", "input_required", "failed"]),
    errorCodes: z.array(z.string().min(1).max(256)).max(256).readonly().default([]),
  })
  .strict();

export const reopenBuildWorkflowInputSchema = z.object({}).strict();
export const publishBuildWorkflowInputSchema = z.object({}).strict();

export type PmBuildSubmissionInput = z.output<typeof pmBuildSubmissionInputSchema>;
export type ImplementorBuildSubmissionInput = z.output<
  typeof implementorBuildSubmissionInputSchema
>;
export type QaBuildSubmissionInput = z.output<typeof qaBuildSubmissionInputSchema>;
export type RecordBuildTestInput = z.output<typeof recordBuildTestInputSchema>;

export interface BuildWorkflowSnapshot {
  readonly workflow: BuildWorkflowRecord;
  readonly family: SavedAgentFamily;
}

export type BuildWorkflowNextStep =
  | (BuildWorkflowSnapshot & {
      readonly status: "role_required";
      readonly role: "pm" | "implementor" | "qa";
      readonly mode: "direct";
    })
  | (BuildWorkflowSnapshot & {
      readonly status: "test_required";
      readonly role: "test_runner";
      readonly mode: "test";
    })
  | (BuildWorkflowSnapshot & { readonly status: "publish_ready" })
  | (BuildWorkflowSnapshot & { readonly status: "published" })
  | (BuildWorkflowSnapshot & { readonly status: "terminal_failure" });

export type PreparedBuildWorkflowStep =
  | (BuildWorkflowSnapshot & {
      readonly status: "bootstrap_required";
      readonly role: "pm" | "implementor" | "qa" | "test_runner";
      readonly mode: "direct" | "test";
      readonly grant: IssuedBootstrapGrant;
    })
  | Extract<
      BuildWorkflowNextStep,
      { readonly status: "publish_ready" | "published" | "terminal_failure" }
    >;

type WorkflowMutationSuccess = Extract<
  AgentBuilderStoreMutationSuccess,
  {
    readonly type:
      | "workflow_allocated"
      | "workflow_role_submitted"
      | "workflow_test_recorded"
      | "workflow_reopened"
      | "workflow_published";
  }
>;

type PreparedMutationResult =
  | {
      readonly ok: true;
      readonly owner: OwnerScope;
      readonly principalId: string;
      readonly mutation: TrustedMutationIdentity;
    }
  | {
      readonly ok: false;
      readonly error: BuildWorkflowCoordinatorError;
    };

const DEFAULT_MAX_FAMILIES = 25;
const defaultClock: AgentBuilderClock = { now: () => new Date().toISOString() };

function randomId(namespace: string): string {
  return `${namespace}_${globalThis.crypto.randomUUID()}`;
}

const defaultIds: BuildWorkflowCoordinatorIdFactory = {
  agentId: () => randomId("agent"),
  draftId: () => randomId("draft"),
  specId: () => randomId("spec"),
  workflowId: () => randomId("workflow"),
  testRunId: () => randomId("test"),
};

function invalidInput(error: z.ZodError): BuildWorkflowCoordinatorFailure {
  return {
    ok: false,
    error: {
      code: "INVALID_INPUT",
      message: "Input validation failed",
      issues: error.issues.map((issue) => {
        const path = issue.path.length === 0 ? "input" : issue.path.join(".");
        return `${path}: ${issue.message}`;
      }),
    },
  };
}

function sameOwner(left: OwnerScope, right: OwnerScope): boolean {
  return left.tenantKey === right.tenantKey && left.ownerKey === right.ownerKey;
}

function fieldsFromDraft(draft: SavedAgentDraft): SavedAgentEditableFields {
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

function applyRolePatch(
  draft: SavedAgentDraft,
  patch: Partial<SavedAgentEditableFields>,
): SavedAgentEditableFields {
  const current = fieldsFromDraft(draft);
  return {
    name: patch.name ?? current.name,
    kind: patch.kind ?? current.kind,
    description: patch.description ?? current.description,
    pmBrief: patch.pmBrief ?? current.pmBrief,
    instructions: patch.instructions ?? current.instructions,
    toolRequirements: patch.toolRequirements ?? current.toolRequirements,
    triggers: patch.triggers ?? current.triggers,
    testChecklist: patch.testChecklist ?? current.testChecklist,
    qaFindings: patch.qaFindings ?? current.qaFindings,
  };
}

function nextRole(phase: BuildWorkflowRecord["phase"]): {
  readonly role: Extract<ExecutionRole, "pm" | "implementor" | "qa" | "test_runner">;
  readonly mode: RunnerCapabilityMode;
} | null {
  switch (phase) {
    case "pm_work":
    case "pm_input":
      return { role: "pm", mode: "direct" };
    case "implementation_work":
    case "implementation_input":
      return { role: "implementor", mode: "direct" };
    case "qa_review":
    case "qa_input":
      return { role: "qa", mode: "direct" };
    case "test_pending":
      return { role: "test_runner", mode: "test" };
    case "publish_ready":
    case "published":
    case "terminal_failure":
      return null;
  }
}

/**
 * Durable PM -> implementor -> QA coordinator.
 *
 * Public raw inputs contain only role-owned patches and closed outcomes. All
 * authorization and lifecycle identity comes from authenticated runtime
 * context plus authoritative store state.
 */
export class BuildWorkflowCoordinator {
  readonly #store: AgentBuilderStore;
  readonly #resolveOwner: ResolveOwner;
  readonly #bootstrap: Pick<BootstrapService, "issue">;
  readonly #clock: AgentBuilderClock;
  readonly #ids: BuildWorkflowCoordinatorIdFactory;
  readonly #maxFamilies: number;

  constructor(options: BuildWorkflowCoordinatorOptions) {
    this.#store = options.store;
    this.#resolveOwner = options.resolveOwner;
    this.#bootstrap = options.bootstrap;
    this.#clock = options.clock ?? defaultClock;
    this.#ids = options.ids ?? defaultIds;
    this.#maxFamilies = options.maxAgentFamiliesPerOwner ?? DEFAULT_MAX_FAMILIES;
    if (!Number.isSafeInteger(this.#maxFamilies) || this.#maxFamilies < 1) {
      throw new TypeError("maxAgentFamiliesPerOwner must be a positive safe integer");
    }
  }

  async allocate(
    context: BuildWorkflowMutationContext,
    rawInput: unknown,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: "workflow_allocated" }>>> {
    const input = allocateBuildWorkflowInputSchema.safeParse(rawInput);
    if (!input.success) return invalidInput(input.error);
    const prepared = await this.#prepareMutation(context, "workflow_allocate", input.data);
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation, "workflow_allocated");
    if (replay !== null) return replay;

    const occurredAt = this.#now();
    if (!occurredAt.ok) return occurredAt;
    const agentId = this.#id("agent", this.#ids.agentId(), agentIdSchema);
    if (!agentId.ok) return agentId;
    const draftId = this.#id("draft", this.#ids.draftId(), draftIdSchema);
    if (!draftId.ok) return draftId;
    const workflowId = this.#id(
      "workflow",
      this.#ids.workflowId(),
      buildWorkflowIdSchema,
    );
    if (!workflowId.ok) return workflowId;
    const placeholderDigest = await fingerprintMutationRequest({
      agentId: agentId.value,
      draftId: draftId.value,
      workflowId: workflowId.value,
    });
    const fields = savedAgentEditableFieldsSchema.parse({
      name: `Untitled build ${placeholderDigest.slice(-16)}`,
      kind: "agent",
      description: "",
      pmBrief: "",
      instructions: "",
      toolRequirements: [],
      triggers: [],
      testChecklist: [],
      qaFindings: [],
    });
    return this.#mutate(
      {
        type: "allocate_build_workflow",
        owner: prepared.owner,
        mutation: prepared.mutation,
        occurredAt: occurredAt.value,
        workflowId: workflowId.value,
        agentId: agentId.value,
        draftId: draftId.value,
        maxFamilies: this.#maxFamilies,
        canonicalName: canonicalizeAgentName(fields.name),
        fields,
      },
      "workflow_allocated",
    );
  }

  async getNext(
    context: BuildWorkflowTargetContext,
    rawInput: unknown = {},
  ): Promise<BuildWorkflowCoordinatorResult<BuildWorkflowNextStep>> {
    const empty = getBuildWorkflowNextInputSchema.safeParse(rawInput);
    if (!empty.success) return invalidInput(empty.error);
    const snapshot = await this.#snapshot(context);
    if (!snapshot.ok) return snapshot;
    return { ok: true, value: this.#next(snapshot.value) };
  }

  async prepareNext(
    context: BuildWorkflowPrepareContext,
    rawInput: unknown = {},
  ): Promise<BuildWorkflowCoordinatorResult<PreparedBuildWorkflowStep>> {
    const empty = prepareBuildWorkflowNextInputSchema.safeParse(rawInput);
    if (!empty.success) return invalidInput(empty.error);
    const snapshot = await this.#snapshot(context);
    if (!snapshot.ok) return snapshot;
    const next = this.#next(snapshot.value);
    if (
      next.status === "publish_ready" ||
      next.status === "published" ||
      next.status === "terminal_failure"
    ) {
      return { ok: true, value: next };
    }
    const draft = next.family.draft;
    if (draft === undefined) return this.#targetChanged("Current workflow draft is unavailable");
    const workflowScope = {
      workflowId: next.workflow.workflowId,
      workflowRevision: next.workflow.revision,
      ...(next.workflow.testRunId === undefined
        ? {}
        : { testRunId: next.workflow.testRunId }),
    };
    const grant = await this.#bootstrap.issue({
      owner: next.workflow.owner,
      role: next.role,
      target: {
        kind: "draft",
        agentId: next.family.agentId,
        draftId: draft.draftId,
        draftRevision: draft.draftRevision,
      },
      workflow: workflowScope,
      parentSessionId: context.parentSessionId,
      ...(context.parentTurnId === undefined ? {} : { parentTurnId: context.parentTurnId }),
    });
    if (!grant.ok) return grant;
    return {
      ok: true,
      value: {
        status: "bootstrap_required",
        role: next.role,
        mode: next.mode,
        workflow: next.workflow,
        family: next.family,
        grant: grant.value,
      },
    };
  }

  submitPm(
    context: BuildWorkflowExecutionContext,
    rawInput: unknown,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: "workflow_role_submitted" }>>> {
    return this.#submitRole("pm", context, rawInput, pmBuildSubmissionInputSchema);
  }

  submitImplementor(
    context: BuildWorkflowExecutionContext,
    rawInput: unknown,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: "workflow_role_submitted" }>>> {
    return this.#submitRole(
      "implementor",
      context,
      rawInput,
      implementorBuildSubmissionInputSchema,
    );
  }

  submitQa(
    context: BuildWorkflowExecutionContext,
    rawInput: unknown,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: "workflow_role_submitted" }>>> {
    return this.#submitRole("qa", context, rawInput, qaBuildSubmissionInputSchema);
  }

  async recordTestResult(
    context: BuildWorkflowExecutionContext,
    rawInput: unknown,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: "workflow_test_recorded" }>>> {
    const input = recordBuildTestInputSchema.safeParse(rawInput);
    if (!input.success) return invalidInput(input.error);
    const prepared = await this.#prepareMutation(
      context,
      "workflow_test_result",
      input.data,
      {
        childSessionId: context.childSessionId,
        executionTurnId: context.executionTurnId,
      },
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(
      prepared.owner,
      prepared.mutation,
      "workflow_test_recorded",
    );
    if (replay !== null) return replay;
    const exact = await this.#execution(
      prepared.owner,
      context,
      "test_runner",
    );
    if (!exact.ok) return exact;
    if (exact.value.workflow.testRunId === undefined) {
      return this.#targetChanged("Workflow has no authoritative test run");
    }
    const occurredAt = this.#now();
    if (!occurredAt.ok) return occurredAt;
    return this.#mutate(
      {
        type: "record_build_test",
        owner: prepared.owner,
        mutation: prepared.mutation,
        occurredAt: occurredAt.value,
        workflowId: exact.value.workflow.workflowId,
        expectedWorkflowRevision: exact.value.workflow.revision,
        testRunId: exact.value.workflow.testRunId,
        leaseId: exact.value.lease.leaseId,
        childSessionId: exact.value.lease.childSessionId,
        executionTurnId: context.executionTurnId,
        status: input.data.status,
        errorCodes: input.data.errorCodes,
      },
      "workflow_test_recorded",
    );
  }

  async publish(
    context: BuildWorkflowMutationContext & { readonly agentId: AgentId },
    rawInput: unknown,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: "workflow_published" }>>> {
    const input = publishBuildWorkflowInputSchema.safeParse(rawInput);
    if (!input.success) return invalidInput(input.error);
    const prepared = await this.#prepareMutation(
      context,
      "workflow_publish",
      input.data,
      { agentId: context.agentId },
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation, "workflow_published");
    if (replay !== null) return replay;
    const snapshot = await this.#snapshot({
      ownerResolution: context.ownerResolution,
      agentId: context.agentId,
    });
    if (!snapshot.ok) return snapshot;
    const draft = snapshot.value.family.draft;
    if (draft === undefined) return this.#targetChanged("Publish-ready draft is unavailable");
    const occurredAt = this.#now();
    if (!occurredAt.ok) return occurredAt;
    const specId = this.#id("spec", this.#ids.specId(), specIdSchema);
    if (!specId.ok) return specId;
    const publishedBy = prepared.principalId;
    if (publishedBy.length < 1 || publishedBy.length > 1_024) {
      return this.#dependencyViolation("Current principal ID cannot be stored as publishedBy");
    }
    return this.#mutate(
      {
        type: "publish_build_workflow",
        owner: prepared.owner,
        mutation: prepared.mutation,
        occurredAt: occurredAt.value,
        workflowId: snapshot.value.workflow.workflowId,
        expectedWorkflowRevision: snapshot.value.workflow.revision,
        agentId: snapshot.value.family.agentId,
        expectedRevision: snapshot.value.family.revision,
        expectedDraftRevision: draft.draftRevision,
        specId: specId.value,
        publishedBy,
      },
      "workflow_published",
    );
  }

  async reopen(
    context: BuildWorkflowMutationContext & { readonly agentId: AgentId },
    rawInput: unknown,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: "workflow_reopened" }>>> {
    const input = reopenBuildWorkflowInputSchema.safeParse(rawInput);
    if (!input.success) return invalidInput(input.error);
    const prepared = await this.#prepareMutation(
      context,
      "workflow_reopen",
      input.data,
      { agentId: context.agentId },
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation, "workflow_reopened");
    if (replay !== null) return replay;
    const snapshot = await this.#snapshot({
      ownerResolution: context.ownerResolution,
      agentId: context.agentId,
    });
    if (!snapshot.ok) return snapshot;
    const draft = snapshot.value.family.draft;
    if (draft === undefined) return this.#targetChanged("Publish-ready draft is unavailable");
    const occurredAt = this.#now();
    if (!occurredAt.ok) return occurredAt;
    return this.#mutate(
      {
        type: "reopen_build_workflow",
        owner: prepared.owner,
        mutation: prepared.mutation,
        occurredAt: occurredAt.value,
        workflowId: snapshot.value.workflow.workflowId,
        expectedWorkflowRevision: snapshot.value.workflow.revision,
        agentId: snapshot.value.family.agentId,
        expectedRevision: snapshot.value.family.revision,
        expectedDraftRevision: draft.draftRevision,
      },
      "workflow_reopened",
    );
  }

  async #submitRole<
    Role extends "pm" | "implementor" | "qa",
  >(
    role: Role,
    context: BuildWorkflowExecutionContext,
    rawInput: unknown,
    schema: z.ZodType,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: "workflow_role_submitted" }>>> {
    const input = schema.safeParse(rawInput);
    if (!input.success) return invalidInput(input.error);
    const submission = input.data as Readonly<{
      patch: Partial<SavedAgentEditableFields>;
      result:
        | "completed_handoff"
        | "needs_user_input"
        | "needs_test"
        | "changes_requested"
        | "approved"
        | "failed";
    }>;
    const prepared = await this.#prepareMutation(
      context,
      `workflow_role_submit:${role}`,
      submission,
      {
        childSessionId: context.childSessionId,
        executionTurnId: context.executionTurnId,
      },
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(
      prepared.owner,
      prepared.mutation,
      "workflow_role_submitted",
    );
    if (replay !== null) return replay;
    const exact = await this.#execution(prepared.owner, context, role);
    if (!exact.ok) return exact;
    const draft = exact.value.family.draft;
    if (draft === undefined) return this.#targetChanged("Workflow draft is unavailable");
    const fields = savedAgentEditableFieldsSchema.safeParse(
      applyRolePatch(draft, submission.patch),
    );
    if (!fields.success) return invalidInput(fields.error);
    const occurredAt = this.#now();
    if (!occurredAt.ok) return occurredAt;
    const testRunId =
      role === "qa" && submission.result === "needs_test"
        ? this.#id("test run", this.#ids.testRunId(), testRunIdSchema)
        : null;
    if (testRunId !== null && !testRunId.ok) return testRunId;
    return this.#mutate(
      {
        type: "submit_build_role",
        owner: prepared.owner,
        mutation: prepared.mutation,
        occurredAt: occurredAt.value,
        workflowId: exact.value.workflow.workflowId,
        expectedWorkflowRevision: exact.value.workflow.revision,
        role,
        leaseId: exact.value.lease.leaseId,
        childSessionId: exact.value.lease.childSessionId,
        executionTurnId: context.executionTurnId,
        expectedRevision: exact.value.family.revision,
        expectedDraftRevision: draft.draftRevision,
        canonicalName: canonicalizeAgentName(fields.data.name),
        fields: fields.data,
        result: submission.result,
        ...(testRunId === null ? {} : { testRunId: testRunId.value }),
      },
      "workflow_role_submitted",
    );
  }

  async #snapshot(
    context: BuildWorkflowTargetContext,
  ): Promise<BuildWorkflowCoordinatorResult<BuildWorkflowSnapshot>> {
    const owner = await resolveCurrentOwner(context.ownerResolution, this.#resolveOwner);
    if (!owner.ok) return owner;
    const agentId = agentIdSchema.safeParse(context.agentId);
    if (!agentId.success) return invalidInput(agentId.error);
    const [workflow, family] = await Promise.all([
      this.#store.getBuildWorkflow({ owner: owner.owner, agentId: agentId.data }),
      this.#store.getFamily({ owner: owner.owner, agentId: agentId.data }),
    ]);
    if (workflow === null) {
      return {
        ok: false,
        error: { code: "WORKFLOW_NOT_FOUND", message: "Build workflow was not found" },
      };
    }
    if (family === null || family.lifecycle === "deleted") {
      return { ok: false, error: { code: "NOT_FOUND", message: "Saved agent family was not found" } };
    }
    if (workflow.phase !== "published") {
      if (
        family.draft === undefined ||
        family.draft.draftId !== workflow.draftId ||
        family.draft.draftRevision !== workflow.draftRevision
      ) {
        return this.#targetChanged("Workflow does not target the exact current draft");
      }
    }
    return { ok: true, value: { workflow, family } };
  }

  #next(snapshot: BuildWorkflowSnapshot): BuildWorkflowNextStep {
    const required = nextRole(snapshot.workflow.phase);
    if (required !== null) {
      return required.role === "test_runner"
        ? { ...snapshot, status: "test_required", role: required.role, mode: "test" }
        : {
            ...snapshot,
            status: "role_required",
            role: required.role,
            mode: "direct",
          };
    }
    return {
      ...snapshot,
      status:
        snapshot.workflow.phase === "publish_ready"
          ? "publish_ready"
          : snapshot.workflow.phase === "published"
            ? "published"
            : "terminal_failure",
    } as BuildWorkflowNextStep;
  }

  async #execution(
    owner: OwnerScope,
    context: BuildWorkflowExecutionContext,
    role: Extract<ExecutionRole, "pm" | "implementor" | "qa" | "test_runner">,
  ): Promise<
    BuildWorkflowCoordinatorResult<
      BuildWorkflowSnapshot & { readonly lease: ExecutionLeaseRecord }
    >
  > {
    const lease = await this.#store.getExecutionLease({
      owner,
      childSessionId: context.childSessionId,
    });
    if (
      lease === null ||
      !sameOwner(owner, lease.owner) ||
      lease.role !== role ||
      lease.status !== "running" ||
      lease.executionTurnId !== context.executionTurnId ||
      lease.workflow === undefined ||
      lease.target.kind !== "draft"
    ) {
      return {
        ok: false,
        error: { code: "BOOTSTRAP_REQUIRED", message: "Exact running workflow lease required" },
      };
    }
    const occurredAt = this.#now();
    if (!occurredAt.ok) return occurredAt;
    if (Date.parse(occurredAt.value) >= Date.parse(lease.expiresAt)) {
      return { ok: false, error: { code: "LEASE_EXPIRED", message: "Execution lease expired" } };
    }
    const [workflow, family] = await Promise.all([
      this.#store.getBuildWorkflow({ owner, agentId: lease.target.agentId }),
      this.#store.getFamily({ owner, agentId: lease.target.agentId }),
    ]);
    if (
      workflow === null ||
      family?.draft === undefined ||
      !bootstrapTargetsEqual(lease.target, {
        kind: "draft",
        agentId: family.agentId,
        draftId: family.draft.draftId,
        draftRevision: family.draft.draftRevision,
      }) ||
      !buildExecutionScopesEqual(lease.workflow, {
        workflowId: workflow.workflowId,
        workflowRevision: workflow.revision,
        ...(workflow.testRunId === undefined ? {} : { testRunId: workflow.testRunId }),
      })
    ) {
      return this.#targetChanged("Execution lease no longer targets the current workflow");
    }
    return { ok: true, value: { workflow, family, lease } };
  }

  async #prepareMutation(
    context: BuildWorkflowMutationContext,
    action: string,
    input: unknown,
    trustedTarget: unknown = {},
  ): Promise<PreparedMutationResult> {
    const owner = await resolveCurrentOwner(context.ownerResolution, this.#resolveOwner);
    if (!owner.ok) return owner;
    const operationId = operationIdSchema.safeParse(context.operationId);
    if (!operationId.success) return invalidInput(operationId.error);
    let requestFingerprint: string;
    try {
      requestFingerprint = await fingerprintMutationRequest({
        action,
        actor: owner.principal.principalId,
        input,
        trustedTarget,
        schema: "pr04-workflow-v2",
      });
    } catch {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Mutation input cannot be fingerprinted",
          issues: ["input: expected finite acyclic JSON-compatible data"],
        },
      };
    }
    return {
      ok: true,
      owner: owner.owner,
      principalId: owner.principal.principalId,
      mutation: { operationId: operationId.data, requestFingerprint },
    };
  }

  async #replay<Type extends WorkflowMutationSuccess["type"]>(
    owner: OwnerScope,
    mutation: TrustedMutationIdentity,
    expectedType: Type,
  ): Promise<
    | BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: Type }>>
    | null
  > {
    const replay = await this.#store.getMutationReplay({ owner, mutation });
    if (replay.status === "miss") return null;
    if (replay.status === "operation_id_reused") {
      return {
        ok: false,
        error: {
          code: "OPERATION_ID_REUSED",
          message: "Operation ID was already committed for a different request",
          priorResultType: replay.priorResultType,
        },
      };
    }
    if (replay.result.type !== expectedType) {
      return this.#dependencyViolation("Mutation replay returned the wrong workflow result type");
    }
    return {
      ok: true,
      value: replay.result as Extract<WorkflowMutationSuccess, { type: Type }>,
    };
  }

  async #mutate<Type extends WorkflowMutationSuccess["type"]>(
    command: Parameters<AgentBuilderStore["mutate"]>[0],
    expectedType: Type,
  ): Promise<BuildWorkflowCoordinatorResult<Extract<WorkflowMutationSuccess, { type: Type }>>> {
    const result = await this.#store.mutate(command);
    if (!result.ok) return result;
    if (result.type !== expectedType) {
      return this.#dependencyViolation("Store returned the wrong workflow mutation result type");
    }
    return {
      ok: true,
      value: result as Extract<WorkflowMutationSuccess, { type: Type }>,
    };
  }

  #now(): BuildWorkflowCoordinatorResult<Timestamp> {
    const parsed = timestampSchema.safeParse(this.#clock.now());
    return parsed.success
      ? { ok: true, value: parsed.data }
      : this.#dependencyViolation("AgentBuilderClock returned a non-canonical timestamp");
  }

  #id<Value>(
    kind: string,
    raw: string,
    schema: z.ZodType<Value>,
  ): BuildWorkflowCoordinatorResult<Value> {
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : this.#dependencyViolation(`BuildWorkflowCoordinatorIdFactory returned an invalid ${kind} ID`);
  }

  #targetChanged(message: string): BuildWorkflowCoordinatorFailure {
    return { ok: false, error: { code: "TARGET_CHANGED", message } };
  }

  #dependencyViolation(message: string): BuildWorkflowCoordinatorFailure {
    return { ok: false, error: { code: "DEPENDENCY_CONTRACT_VIOLATION", message } };
  }
}

export function createBuildWorkflowCoordinator(
  options: BuildWorkflowCoordinatorOptions,
): BuildWorkflowCoordinator {
  return new BuildWorkflowCoordinator(options);
}
