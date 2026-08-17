import { z } from "zod";

import {
  agentLifecycleSchema,
  publishedAgentVersionSchema,
  savedAgentFamilySchema,
} from "./domain.js";
import type {
  AgentId,
  AgentLifecycle,
  DraftId,
  OwnerScope,
  PublishedAgentVersion,
  SavedAgentEditableFields,
  SavedAgentFamily,
  SpecId,
  Timestamp,
  TrustedMutationIdentity,
} from "./domain.js";
import type {
  BeginExecutionLeaseStoreCommand,
  BootstrapGrantRecord,
  BootstrapStoreResult,
  CloseExecutionLeaseStoreCommand,
  CloseParentTurnLeasesStoreCommand,
  CreateBootstrapGrantStoreCommand,
  ExecutionLeaseQuery,
  ExecutionLeaseRecord,
  RedeemBootstrapGrantStoreCommand,
} from "./bootstrap.js";
import type {
  AuthorizeTestInputStoreCommand,
  BeginTestCapabilityExecutionStoreCommand,
  CompleteTestCapabilityExecutionStoreCommand,
  TestCapabilityExecutionQuery,
  TestCapabilityExecutionRecord,
  TestInputGrantRecord,
  TestPolicyResult,
} from "./test-policy.js";
import {
  buildWorkflowRecordSchema,
  type BuildWorkflowId,
  type BuildWorkflowQuery,
  type BuildWorkflowRecord,
  type ImplementorSubmissionResult,
  type PmSubmissionResult,
  type QaSubmissionResult,
  type TestRunId,
} from "./workflow.js";

interface StoreMutationBase {
  readonly owner: OwnerScope;
  readonly mutation: TrustedMutationIdentity;
  readonly occurredAt: Timestamp;
}

export interface CreateFamilyStoreCommand extends StoreMutationBase {
  readonly type: "create_family";
  readonly agentId: AgentId;
  readonly draftId: DraftId;
  readonly maxFamilies: number;
  readonly canonicalName: string;
  readonly fields: SavedAgentEditableFields;
}

export interface BeginRevisionStoreCommand extends StoreMutationBase {
  readonly type: "begin_revision";
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly draftId: DraftId;
  readonly basedOnSpecId: SpecId;
  readonly basedOnVersion: number;
  readonly fields: SavedAgentEditableFields;
}

export interface PatchDraftStoreCommand extends StoreMutationBase {
  readonly type: "patch_draft";
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly expectedDraftRevision: number;
  readonly canonicalName: string;
  readonly fields: SavedAgentEditableFields;
}

export interface PublishDraftStoreCommand extends StoreMutationBase {
  readonly type: "publish_draft";
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly expectedDraftRevision: number;
  readonly specId: SpecId;
  /** Derived from the authenticated current principal, never draft input. */
  readonly publishedBy: string;
}

export interface ActivateVersionStoreCommand extends StoreMutationBase {
  readonly type: "activate_version";
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly specId: SpecId;
  readonly version: number;
}

export interface ArchiveFamilyStoreCommand extends StoreMutationBase {
  readonly type: "archive_family";
  readonly agentId: AgentId;
  readonly expectedRevision: number;
}

export interface RestoreFamilyStoreCommand extends StoreMutationBase {
  readonly type: "restore_family";
  readonly agentId: AgentId;
  readonly expectedRevision: number;
}

export interface DeleteFamilyStoreCommand extends StoreMutationBase {
  readonly type: "delete_family";
  readonly agentId: AgentId;
  readonly expectedRevision: number;
}

export interface AllocateBuildWorkflowStoreCommand extends StoreMutationBase {
  readonly type: "allocate_build_workflow";
  readonly workflowId: BuildWorkflowId;
  readonly agentId: AgentId;
  readonly draftId: DraftId;
  readonly maxFamilies: number;
  readonly canonicalName: string;
  readonly fields: SavedAgentEditableFields;
}

export interface SubmitBuildRoleStoreCommand extends StoreMutationBase {
  readonly type: "submit_build_role";
  readonly workflowId: BuildWorkflowId;
  readonly expectedWorkflowRevision: number;
  readonly role: "pm" | "implementor" | "qa";
  readonly leaseId: string;
  readonly childSessionId: string;
  readonly executionTurnId: string;
  readonly expectedRevision: number;
  readonly expectedDraftRevision: number;
  readonly canonicalName: string;
  readonly fields: SavedAgentEditableFields;
  readonly result: PmSubmissionResult | ImplementorSubmissionResult | QaSubmissionResult;
  readonly testRunId?: TestRunId;
}

export interface RecordBuildTestStoreCommand extends StoreMutationBase {
  readonly type: "record_build_test";
  readonly workflowId: BuildWorkflowId;
  readonly expectedWorkflowRevision: number;
  readonly testRunId: TestRunId;
  readonly leaseId: string;
  readonly childSessionId: string;
  readonly executionTurnId: string;
  readonly status: "passed" | "input_required" | "failed";
  readonly errorCodes: readonly string[];
}

export interface ReopenBuildWorkflowStoreCommand extends StoreMutationBase {
  readonly type: "reopen_build_workflow";
  readonly workflowId: BuildWorkflowId;
  readonly expectedWorkflowRevision: number;
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly expectedDraftRevision: number;
}

export interface PublishBuildWorkflowStoreCommand extends StoreMutationBase {
  readonly type: "publish_build_workflow";
  readonly workflowId: BuildWorkflowId;
  readonly expectedWorkflowRevision: number;
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly expectedDraftRevision: number;
  readonly specId: SpecId;
  readonly publishedBy: string;
}

/**
 * Complete trusted command set for one durable store transaction.
 *
 * Commands are constructed by `AgentBuilderService`, not from model-authored
 * payloads. Adapters must atomically compare/store the mutation identity with
 * the successful result before returning.
 */
export type AgentBuilderStoreCommand =
  | ActivateVersionStoreCommand
  | AllocateBuildWorkflowStoreCommand
  | ArchiveFamilyStoreCommand
  | BeginRevisionStoreCommand
  | CreateFamilyStoreCommand
  | DeleteFamilyStoreCommand
  | PatchDraftStoreCommand
  | PublishBuildWorkflowStoreCommand
  | PublishDraftStoreCommand
  | RecordBuildTestStoreCommand
  | ReopenBuildWorkflowStoreCommand
  | RestoreFamilyStoreCommand
  | SubmitBuildRoleStoreCommand;

export type AgentBuilderStoreMutationSuccess =
  | {
      readonly ok: true;
      readonly type: "family_created";
      readonly family: SavedAgentFamily;
    }
  | {
      readonly ok: true;
      readonly type: "revision_begun";
      readonly family: SavedAgentFamily;
    }
  | {
      readonly ok: true;
      readonly type: "draft_patched";
      readonly family: SavedAgentFamily;
    }
  | {
      readonly ok: true;
      readonly type: "draft_published";
      readonly family: SavedAgentFamily;
      readonly publishedVersion: PublishedAgentVersion;
    }
  | {
      readonly ok: true;
      readonly type: "version_activated";
      readonly family: SavedAgentFamily;
      readonly activeVersion: PublishedAgentVersion;
    }
  | {
      readonly ok: true;
      readonly type: "family_archived";
      readonly family: SavedAgentFamily;
    }
  | {
      readonly ok: true;
      readonly type: "family_restored";
      readonly family: SavedAgentFamily;
    }
  | {
      readonly ok: true;
      readonly type: "family_deleted";
      readonly family: SavedAgentFamily;
      readonly previousLifecycle: Exclude<AgentLifecycle, "deleted">;
    }
  | {
      readonly ok: true;
      readonly type: "workflow_allocated";
      readonly family: SavedAgentFamily;
      readonly workflow: BuildWorkflowRecord;
    }
  | {
      readonly ok: true;
      readonly type: "workflow_role_submitted";
      readonly family: SavedAgentFamily;
      readonly workflow: BuildWorkflowRecord;
    }
  | {
      readonly ok: true;
      readonly type: "workflow_test_recorded";
      readonly family: SavedAgentFamily;
      readonly workflow: BuildWorkflowRecord;
    }
  | {
      readonly ok: true;
      readonly type: "workflow_reopened";
      readonly family: SavedAgentFamily;
      readonly workflow: BuildWorkflowRecord;
    }
  | {
      readonly ok: true;
      readonly type: "workflow_published";
      readonly family: SavedAgentFamily;
      readonly workflow: BuildWorkflowRecord;
      readonly publishedVersion: PublishedAgentVersion;
    };

export type AgentBuilderStoreError =
  | Readonly<{
      code: "NOT_FOUND";
      message: string;
    }>
  | Readonly<{
      code: "REVISION_CONFLICT";
      message: string;
      currentRevision: number;
      currentDraftRevision?: number;
    }>
  | Readonly<{
      code: "NAME_CONFLICT";
      message: string;
      canonicalName: string;
    }>
  | Readonly<{
      code: "QUOTA_EXCEEDED";
      message: string;
      limit: number;
      current: number;
    }>
  | Readonly<{
      code: "INVALID_TRANSITION";
      message: string;
      lifecycle: AgentLifecycle;
      operation: AgentBuilderStoreCommand["type"];
    }>
  | Readonly<{
      code: "VERSION_NOT_FOUND";
      message: string;
    }>
  | Readonly<{
      code: "OPERATION_ID_REUSED";
      message: string;
      priorResultType: AgentBuilderStoreMutationSuccess["type"];
    }>
  | Readonly<{
      code: "STORE_INVARIANT_VIOLATION";
      message: string;
    }>
  | Readonly<{
      code:
        | "WORKFLOW_NOT_FOUND"
        | "WORKFLOW_CONFLICT"
        | "WORKFLOW_INVALID_TRANSITION"
        | "ROLE_FORBIDDEN"
        | "TEST_EVIDENCE_REQUIRED"
        | "PUBLISH_NOT_READY";
      message: string;
      currentWorkflowRevision?: number;
    }>;

export type AgentBuilderStoreMutationResult =
  | AgentBuilderStoreMutationSuccess
  | {
      readonly ok: false;
      readonly error: AgentBuilderStoreError;
    };

const storeOperationSchema = z.enum([
  "create_family",
  "begin_revision",
  "patch_draft",
  "publish_draft",
  "activate_version",
  "archive_family",
  "restore_family",
  "delete_family",
  "allocate_build_workflow",
  "submit_build_role",
  "record_build_test",
  "reopen_build_workflow",
  "publish_build_workflow",
]);

export const agentBuilderStoreErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("NOT_FOUND"), message: z.string() }).strict(),
  z
    .object({
      code: z.literal("REVISION_CONFLICT"),
      message: z.string(),
      currentRevision: z.number().int().safe().positive(),
      currentDraftRevision: z.number().int().safe().positive().optional(),
    })
    .strict(),
  z
    .object({
      code: z.literal("NAME_CONFLICT"),
      message: z.string(),
      canonicalName: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("QUOTA_EXCEEDED"),
      message: z.string(),
      limit: z.number().int().safe().positive(),
      current: z.number().int().safe().nonnegative(),
    })
    .strict(),
  z
    .object({
      code: z.literal("INVALID_TRANSITION"),
      message: z.string(),
      lifecycle: agentLifecycleSchema,
      operation: storeOperationSchema,
    })
    .strict(),
  z.object({ code: z.literal("VERSION_NOT_FOUND"), message: z.string() }).strict(),
  z
    .object({
      code: z.literal("OPERATION_ID_REUSED"),
      message: z.string(),
      priorResultType: z.enum([
        "family_created",
        "revision_begun",
        "draft_patched",
        "draft_published",
        "version_activated",
        "family_archived",
        "family_restored",
        "family_deleted",
        "workflow_allocated",
        "workflow_role_submitted",
        "workflow_test_recorded",
        "workflow_reopened",
        "workflow_published",
      ]),
    })
    .strict(),
  z
    .object({ code: z.literal("STORE_INVARIANT_VIOLATION"), message: z.string() })
    .strict(),
  z
    .object({
      code: z.enum([
        "WORKFLOW_NOT_FOUND",
        "WORKFLOW_CONFLICT",
        "WORKFLOW_INVALID_TRANSITION",
        "ROLE_FORBIDDEN",
        "TEST_EVIDENCE_REQUIRED",
        "PUBLISH_NOT_READY",
      ]),
      message: z.string(),
      currentWorkflowRevision: z.number().int().safe().positive().optional(),
    })
    .strict(),
]) as unknown as z.ZodType<AgentBuilderStoreError>;

export const agentBuilderStoreMutationSuccessSchema = z.discriminatedUnion("type", [
  z
    .object({ ok: z.literal(true), type: z.literal("family_created"), family: savedAgentFamilySchema })
    .strict(),
  z
    .object({ ok: z.literal(true), type: z.literal("revision_begun"), family: savedAgentFamilySchema })
    .strict(),
  z
    .object({ ok: z.literal(true), type: z.literal("draft_patched"), family: savedAgentFamilySchema })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal("draft_published"),
      family: savedAgentFamilySchema,
      publishedVersion: publishedAgentVersionSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal("version_activated"),
      family: savedAgentFamilySchema,
      activeVersion: publishedAgentVersionSchema,
    })
    .strict(),
  z
    .object({ ok: z.literal(true), type: z.literal("family_archived"), family: savedAgentFamilySchema })
    .strict(),
  z
    .object({ ok: z.literal(true), type: z.literal("family_restored"), family: savedAgentFamilySchema })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal("family_deleted"),
      family: savedAgentFamilySchema,
      previousLifecycle: z.enum(["draft_only", "active", "archived"]),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal("workflow_allocated"),
      family: savedAgentFamilySchema,
      workflow: buildWorkflowRecordSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal("workflow_role_submitted"),
      family: savedAgentFamilySchema,
      workflow: buildWorkflowRecordSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal("workflow_test_recorded"),
      family: savedAgentFamilySchema,
      workflow: buildWorkflowRecordSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal("workflow_reopened"),
      family: savedAgentFamilySchema,
      workflow: buildWorkflowRecordSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      type: z.literal("workflow_published"),
      family: savedAgentFamilySchema,
      workflow: buildWorkflowRecordSchema,
      publishedVersion: publishedAgentVersionSchema,
    })
    .strict(),
]) as unknown as z.ZodType<AgentBuilderStoreMutationSuccess>;

export const agentBuilderStoreMutationResultSchema: z.ZodType<AgentBuilderStoreMutationResult> =
  z.union([
    agentBuilderStoreMutationSuccessSchema,
    z.object({ ok: z.literal(false), error: agentBuilderStoreErrorSchema }).strict(),
  ]);

export interface MutationReplayQuery {
  readonly owner: OwnerScope;
  readonly mutation: TrustedMutationIdentity;
}

export type MutationReplayResult =
  | { readonly status: "miss" }
  | {
      readonly status: "replay";
      readonly result: AgentBuilderStoreMutationSuccess;
    }
  | {
      readonly status: "operation_id_reused";
      readonly priorResultType: AgentBuilderStoreMutationSuccess["type"];
    };

export interface FamilyStoreQuery {
  readonly owner: OwnerScope;
  readonly agentId: AgentId;
}

export interface VersionStoreQuery extends FamilyStoreQuery {
  readonly specId: SpecId;
  readonly version: number;
}

export interface ActiveFamilyStoreRecord {
  readonly family: SavedAgentFamily;
  readonly activeVersion: PublishedAgentVersion;
}

/**
 * Durable persistence boundary for PR 02.
 *
 * A SQL adapter normally implements `mutate` as one serializable transaction;
 * a Durable Object adapter can execute it in one storage transaction; and a
 * KV-style adapter needs an equivalent single-owner transactional primitive.
 * The interface intentionally exposes no Map, row, or query-builder details.
 *
 * Trusted reads include tombstones and retained versions so later control
 * plane code can reconcile them. The public service hides deleted families.
 */
export interface AgentBuilderStore {
  getMutationReplay(query: MutationReplayQuery): Promise<MutationReplayResult>;
  getFamily(query: FamilyStoreQuery): Promise<SavedAgentFamily | null>;
  getVersion(query: VersionStoreQuery): Promise<PublishedAgentVersion | null>;
  listVersions(query: FamilyStoreQuery): Promise<readonly PublishedAgentVersion[]>;
  /** Returns only active families for exactly one opaque owner scope. */
  listActiveFamilies(owner: OwnerScope): Promise<readonly ActiveFamilyStoreRecord[]>;
  getBuildWorkflow(query: BuildWorkflowQuery): Promise<BuildWorkflowRecord | null>;
  mutate(command: AgentBuilderStoreCommand): Promise<AgentBuilderStoreMutationResult>;

  /** Atomically reserves a hash-only, unredeemed bootstrap grant. */
  createBootstrapGrant(
    command: CreateBootstrapGrantStoreCommand,
  ): Promise<BootstrapStoreResult<BootstrapGrantRecord>>;
  /**
   * Atomically validates the exact current draft/active version, consumes one
   * grant, and creates one child-session lease.
   */
  redeemBootstrapGrant(
    command: RedeemBootstrapGrantStoreCommand,
  ): Promise<BootstrapStoreResult<ExecutionLeaseRecord>>;
  getExecutionLease(query: ExecutionLeaseQuery): Promise<ExecutionLeaseRecord | null>;
  /** Atomically revalidates the exact target and claims the sole execution turn. */
  beginExecutionLease(
    command: BeginExecutionLeaseStoreCommand,
  ): Promise<BootstrapStoreResult<ExecutionLeaseRecord>>;
  /** Idempotently closes the execution turn; terminal leases cannot be reused. */
  closeExecutionLease(
    command: CloseExecutionLeaseStoreCommand,
  ): Promise<BootstrapStoreResult<ExecutionLeaseRecord>>;
  /**
   * Atomically records terminal parent lineage and closes every ready/running
   * child. Implementations may prune the lineage tombstone after the maximum
   * bootstrap-grant lifetime, once every grant it can race is necessarily expired.
   */
  closeParentTurnExecutionLeases(
    command: CloseParentTurnLeasesStoreCommand,
  ): Promise<BootstrapStoreResult<readonly ExecutionLeaseRecord[]>>;

  authorizeTestInput(
    command: AuthorizeTestInputStoreCommand,
  ): Promise<TestPolicyResult<TestInputGrantRecord>>;
  beginTestCapabilityExecution(
    command: BeginTestCapabilityExecutionStoreCommand,
  ): Promise<TestPolicyResult<TestCapabilityExecutionRecord>>;
  completeTestCapabilityExecution(
    command: CompleteTestCapabilityExecutionStoreCommand,
  ): Promise<TestPolicyResult<TestCapabilityExecutionRecord>>;
  listTestCapabilityExecutions(
    query: TestCapabilityExecutionQuery,
  ): Promise<readonly TestCapabilityExecutionRecord[]>;
}

export type AgentBuilderStoreFactory = () => AgentBuilderStore | Promise<AgentBuilderStore>;
