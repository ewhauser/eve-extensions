import { z } from "zod";

import {
  agentIdSchema,
  capabilityIdSchema,
  draftIdSchema,
  operationIdSchema,
  ownerScopeSchema,
  positiveRevisionSchema,
  positiveVersionSchema,
  specIdSchema,
  timestampSchema,
  type AgentId,
  type CapabilityId,
  type DraftId,
  type OpaqueIdentifier,
  type OperationId,
  type OwnerScope,
  type SpecId,
  type Timestamp,
} from "./domain.js";

export type BuildWorkflowId = OpaqueIdentifier<"BuildWorkflowId">;
export type TestRunId = OpaqueIdentifier<"TestRunId">;

export type VerifiedPublishApprovalDecision =
  | { readonly status: "allowed" }
  | { readonly status: "rejected"; readonly code: string };

/**
 * Host-enforced fallback for channels/runtimes that cannot settle Eve's
 * call-level approval lifecycle. `userInput` is never persisted by Agent Builder.
 */
export interface VerifiedPublishApprovalPolicy {
  authorize(input: {
    readonly owner: OwnerScope;
    readonly agentId: AgentId;
    readonly sessionId: string;
    readonly turnId: string;
    readonly callId: string;
    readonly userInput: string;
  }): Promise<VerifiedPublishApprovalDecision> | VerifiedPublishApprovalDecision;
}

function workflowIdentifierSchema<Tag extends string>(): z.ZodType<OpaqueIdentifier<Tag>> {
  return z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !value.includes("\u0000"), "Identifiers must not contain NUL")
    .transform((value) => value as OpaqueIdentifier<Tag>) as z.ZodType<
    OpaqueIdentifier<Tag>
  >;
}

export const buildWorkflowIdSchema = workflowIdentifierSchema<"BuildWorkflowId">();
export const testRunIdSchema = workflowIdentifierSchema<"TestRunId">();

export type BuildWorkflowPhase =
  | "pm_work"
  | "pm_input"
  | "implementation_work"
  | "implementation_input"
  | "qa_review"
  | "qa_input"
  | "test_pending"
  | "publish_ready"
  | "published"
  | "terminal_failure";

export const buildWorkflowPhaseSchema = z.enum([
  "pm_work",
  "pm_input",
  "implementation_work",
  "implementation_input",
  "qa_review",
  "qa_input",
  "test_pending",
  "publish_ready",
  "published",
  "terminal_failure",
]);

export type BuildWorkflowRole = "system" | "pm" | "implementor" | "qa" | "test_runner" | "root";

export const buildWorkflowRoleSchema = z.enum([
  "system",
  "pm",
  "implementor",
  "qa",
  "test_runner",
  "root",
]);

export type BuildWorkflowResult =
  | "allocated"
  | "completed_handoff"
  | "needs_user_input"
  | "needs_test"
  | "test_passed"
  | "test_input_required"
  | "test_failed"
  | "changes_requested"
  | "approved"
  | "published"
  | "failed"
  | "draft_edited"
  | "approval_invalidated";

export const buildWorkflowResultSchema = z.enum([
  "allocated",
  "completed_handoff",
  "needs_user_input",
  "needs_test",
  "test_passed",
  "test_input_required",
  "test_failed",
  "changes_requested",
  "approved",
  "published",
  "failed",
  "draft_edited",
  "approval_invalidated",
]);

export interface BuildWorkflowTransition {
  readonly owner: OwnerScope;
  readonly workflowId: BuildWorkflowId;
  readonly agentId: AgentId;
  readonly draftId: DraftId;
  readonly draftRevision: number;
  readonly role: BuildWorkflowRole;
  readonly operationId: OperationId;
  readonly fromPhase: BuildWorkflowPhase;
  readonly toPhase: BuildWorkflowPhase;
  readonly result: BuildWorkflowResult;
  readonly occurredAt: Timestamp;
}

export const buildWorkflowTransitionSchema: z.ZodType<BuildWorkflowTransition> = z
  .object({
    owner: ownerScopeSchema,
    workflowId: buildWorkflowIdSchema,
    agentId: agentIdSchema,
    draftId: draftIdSchema,
    draftRevision: positiveRevisionSchema,
    role: buildWorkflowRoleSchema,
    operationId: operationIdSchema,
    fromPhase: buildWorkflowPhaseSchema,
    toPhase: buildWorkflowPhaseSchema,
    result: buildWorkflowResultSchema,
    occurredAt: timestampSchema,
  })
  .strict();

export interface BuildTestCapabilityOmission {
  readonly capabilityId: CapabilityId;
  readonly reason: "missing" | "unauthorized" | "disabled" | "incompatible";
}

const buildTestCapabilityOmissionSchema: z.ZodType<BuildTestCapabilityOmission> = z
  .object({
    capabilityId: capabilityIdSchema,
    reason: z.enum(["missing", "unauthorized", "disabled", "incompatible"]),
  })
  .strict();

export interface BuildTestEvidence {
  readonly testRunId: TestRunId;
  readonly owner: OwnerScope;
  readonly workflowId: BuildWorkflowId;
  readonly agentId: AgentId;
  readonly draftId: DraftId;
  readonly draftRevision: number;
  readonly leaseId: string;
  readonly childSessionId: string;
  readonly executionTurnId: string;
  readonly status: "passed" | "input_required" | "failed";
  readonly capabilityPlanFingerprint: string;
  readonly requiredCapabilityIds: readonly CapabilityId[];
  readonly usedCapabilityIds: readonly CapabilityId[];
  readonly failedCapabilityIds: readonly CapabilityId[];
  readonly optionalOmissions: readonly BuildTestCapabilityOmission[];
  readonly errorCodes: readonly string[];
  readonly startedAt: Timestamp;
  readonly completedAt: Timestamp;
}

export const buildTestEvidenceSchema: z.ZodType<BuildTestEvidence> = z
  .object({
    testRunId: testRunIdSchema,
    owner: ownerScopeSchema,
    workflowId: buildWorkflowIdSchema,
    agentId: agentIdSchema,
    draftId: draftIdSchema,
    draftRevision: positiveRevisionSchema,
    leaseId: z.string().min(1).max(512),
    childSessionId: z.string().min(1).max(512),
    executionTurnId: z.string().min(1).max(512),
    status: z.enum(["passed", "input_required", "failed"]),
    capabilityPlanFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    requiredCapabilityIds: z.array(capabilityIdSchema).max(256).readonly(),
    usedCapabilityIds: z.array(capabilityIdSchema).max(256).readonly(),
    failedCapabilityIds: z.array(capabilityIdSchema).max(256).readonly(),
    optionalOmissions: z.array(buildTestCapabilityOmissionSchema).max(256).readonly(),
    errorCodes: z.array(z.string().min(1).max(256)).max(256).readonly(),
    startedAt: timestampSchema,
    completedAt: timestampSchema,
  })
  .strict();

export interface QaApprovalEvidence {
  readonly owner: OwnerScope;
  readonly workflowId: BuildWorkflowId;
  readonly agentId: AgentId;
  readonly draftId: DraftId;
  readonly draftRevision: number;
  readonly testRunId: TestRunId;
  readonly capabilityPlanFingerprint: string;
  readonly requiredCapabilityIds: readonly CapabilityId[];
  readonly operationId: OperationId;
  readonly approvedAt: Timestamp;
}

export const qaApprovalEvidenceSchema: z.ZodType<QaApprovalEvidence> = z
  .object({
    owner: ownerScopeSchema,
    workflowId: buildWorkflowIdSchema,
    agentId: agentIdSchema,
    draftId: draftIdSchema,
    draftRevision: positiveRevisionSchema,
    testRunId: testRunIdSchema,
    capabilityPlanFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    requiredCapabilityIds: z.array(capabilityIdSchema).max(256).readonly(),
    operationId: operationIdSchema,
    approvedAt: timestampSchema,
  })
  .strict();

export interface PublishedBuildEvidence {
  readonly owner: OwnerScope;
  readonly workflowId: BuildWorkflowId;
  readonly agentId: AgentId;
  readonly specId: SpecId;
  readonly specVersion: number;
  readonly operationId: OperationId;
  readonly publishedAt: Timestamp;
}

export const publishedBuildEvidenceSchema: z.ZodType<PublishedBuildEvidence> = z
  .object({
    owner: ownerScopeSchema,
    workflowId: buildWorkflowIdSchema,
    agentId: agentIdSchema,
    specId: specIdSchema,
    specVersion: positiveVersionSchema,
    operationId: operationIdSchema,
    publishedAt: timestampSchema,
  })
  .strict();

export interface BuildWorkflowRecord {
  readonly workflowId: BuildWorkflowId;
  readonly owner: OwnerScope;
  readonly agentId: AgentId;
  readonly draftId: DraftId;
  readonly draftRevision: number;
  readonly revision: number;
  readonly phase: BuildWorkflowPhase;
  readonly testRunId?: TestRunId;
  readonly testEvidence?: BuildTestEvidence;
  readonly qaApproval?: QaApprovalEvidence;
  readonly published?: PublishedBuildEvidence;
  readonly transitions: readonly BuildWorkflowTransition[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const buildWorkflowRecordSchema: z.ZodType<BuildWorkflowRecord> = z
  .object({
    workflowId: buildWorkflowIdSchema,
    owner: ownerScopeSchema,
    agentId: agentIdSchema,
    draftId: draftIdSchema,
    draftRevision: positiveRevisionSchema,
    revision: positiveRevisionSchema,
    phase: buildWorkflowPhaseSchema,
    testRunId: testRunIdSchema.optional(),
    testEvidence: buildTestEvidenceSchema.optional(),
    qaApproval: qaApprovalEvidenceSchema.optional(),
    published: publishedBuildEvidenceSchema.optional(),
    transitions: z.array(buildWorkflowTransitionSchema).min(1).max(256).readonly(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const sameOwner = (owner: OwnerScope) =>
      owner.tenantKey === value.owner.tenantKey && owner.ownerKey === value.owner.ownerKey;
    value.transitions.forEach((transition, index) => {
      if (
        !sameOwner(transition.owner) ||
        transition.workflowId !== value.workflowId ||
        transition.agentId !== value.agentId ||
        transition.draftId !== value.draftId
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Every transition must carry the complete workflow ownership binding",
          path: ["transitions", index],
        });
      }
    });
    const latest = value.transitions.at(-1);
    if (
      latest === undefined ||
      latest.toPhase !== value.phase ||
      latest.draftRevision !== value.draftRevision
    ) {
      ctx.addIssue({ code: "custom", message: "Latest transition must describe current state" });
    }
    if (value.testEvidence !== undefined && value.testRunId !== value.testEvidence.testRunId) {
      ctx.addIssue({ code: "custom", message: "Test evidence must match the workflow test run" });
    }
    if (
      value.testEvidence !== undefined &&
      (!sameOwner(value.testEvidence.owner) ||
        value.testEvidence.workflowId !== value.workflowId ||
        value.testEvidence.agentId !== value.agentId ||
        value.testEvidence.draftId !== value.draftId ||
        value.testEvidence.draftRevision !== value.draftRevision)
    ) {
      ctx.addIssue({ code: "custom", message: "Test evidence must bind the exact workflow draft" });
    }
    if (value.qaApproval !== undefined && value.testEvidence === undefined) {
      ctx.addIssue({ code: "custom", message: "QA approval requires test evidence" });
    }
    if (
      value.qaApproval !== undefined &&
      (!sameOwner(value.qaApproval.owner) ||
        value.qaApproval.workflowId !== value.workflowId ||
        value.qaApproval.agentId !== value.agentId ||
        value.qaApproval.draftId !== value.draftId ||
        value.qaApproval.draftRevision !== value.draftRevision ||
        value.qaApproval.testRunId !== value.testEvidence?.testRunId ||
        value.qaApproval.capabilityPlanFingerprint !==
          value.testEvidence?.capabilityPlanFingerprint)
    ) {
      ctx.addIssue({ code: "custom", message: "QA approval must bind the exact tested plan" });
    }
    if ((value.phase === "test_pending") !== (value.testRunId !== undefined && value.testEvidence === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Pending test phase has an uncompleted test run and no other phase does",
      });
    }
    if ((value.phase === "published") !== (value.published !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Published evidence is present exactly in published phase" });
    }
    if (
      value.published !== undefined &&
      (!sameOwner(value.published.owner) ||
        value.published.workflowId !== value.workflowId ||
        value.published.agentId !== value.agentId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Published evidence must bind the exact owner, workflow, and agent",
        path: ["published"],
      });
    }
    if (value.phase === "publish_ready" && value.qaApproval === undefined) {
      ctx.addIssue({ code: "custom", message: "Publish-ready workflow requires QA approval" });
    }
  }) as unknown as z.ZodType<BuildWorkflowRecord>;

export type PmSubmissionResult = "completed_handoff" | "needs_user_input" | "failed";
export type ImplementorSubmissionResult = PmSubmissionResult;
export type QaSubmissionResult =
  | "needs_test"
  | "changes_requested"
  | "approved"
  | "needs_user_input"
  | "failed";

export const pmSubmissionResultSchema = z.enum([
  "completed_handoff",
  "needs_user_input",
  "failed",
]);
export const implementorSubmissionResultSchema = pmSubmissionResultSchema;
export const qaSubmissionResultSchema = z.enum([
  "needs_test",
  "changes_requested",
  "approved",
  "needs_user_input",
  "failed",
]);

export interface BuildWorkflowQuery {
  readonly owner: OwnerScope;
  readonly agentId: AgentId;
}

export interface BuildWorkflowIdFactory {
  workflowId(): string;
  testRunId(): string;
}
