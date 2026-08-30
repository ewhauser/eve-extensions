import type {
  Approval,
  ApprovalContext,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalStatus,
} from "eve/tools/approval";
import { z } from "zod";

import {
  agentIdSchema,
  capabilityIdSchema,
  draftIdSchema,
  ownerScopeSchema,
  timestampSchema,
  type CapabilityId,
  type OwnerScope,
  type Timestamp,
} from "./domain.js";
import type { ExecutionLeaseRecord } from "./bootstrap.js";
import {
  buildWorkflowIdSchema,
  testRunIdSchema,
  type BuildWorkflowId,
  type TestRunId,
} from "./workflow.js";

export type TestInputUnavailableCode =
  | "INPUT_REQUIRED"
  | "INPUT_UNAVAILABLE"
  | "INPUT_DENIED"
  | "INPUT_CANCELLED"
  | "INPUT_TIMEOUT"
  | "INPUT_STALE"
  | "INPUT_MALFORMED"
  | "INPUT_AMBIGUOUS"
  | "UNATTENDED_INPUT_FORBIDDEN";

export interface TestCapabilityStepScope {
  readonly owner: OwnerScope;
  readonly workflowId: BuildWorkflowId;
  readonly workflowRevision: number;
  readonly testRunId: TestRunId;
  readonly agentId: ExecutionLeaseRecord["target"]["agentId"];
  readonly draftId: string;
  readonly draftRevision: number;
  readonly leaseId: string;
  readonly childSessionId: string;
  readonly executionTurnId: string;
  readonly capabilityId: CapabilityId;
  readonly schemaFingerprint: string;
  readonly modelToolName: string;
  readonly callId: string;
  /** SHA-256 over the exact capability/input/turn identity; never the raw input. */
  readonly stepFingerprint: string;
  readonly expiresAt: Timestamp;
}

const testCapabilityStepScopeObjectSchema = z.object({
    owner: ownerScopeSchema,
    workflowId: buildWorkflowIdSchema,
    workflowRevision: z.number().int().safe().positive(),
    testRunId: testRunIdSchema,
    agentId: agentIdSchema,
    draftId: draftIdSchema,
    draftRevision: z.number().int().safe().positive(),
    leaseId: z.string().min(1).max(512),
    childSessionId: z.string().min(1).max(512),
    executionTurnId: z.string().min(1).max(512),
    capabilityId: capabilityIdSchema,
    schemaFingerprint: z.string().min(1).max(512),
    modelToolName: z.string().min(1).max(256),
    callId: z.string().min(1).max(512),
    stepFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    expiresAt: timestampSchema,
  }).strict();

export const testCapabilityStepScopeSchema: z.ZodType<TestCapabilityStepScope> =
  testCapabilityStepScopeObjectSchema;

export type TestInputAvailability =
  | { readonly status: "available" }
  | {
      readonly status: "unavailable";
      readonly code: TestInputUnavailableCode;
      readonly message: string;
    };

/**
 * Host boundary for channel/runtime facts Eve does not expose to dynamic
 * approval callbacks (for example `requestInput:false` or task mode).
 *
 * It never returns an answer or bearer token. Eve's exact call-bound approval
 * request remains the only human decision; the store independently binds and
 * consumes that decision once.
 */
export interface VerifiedTestInputPolicy {
  availability(
    input: TestCapabilityStepScope,
  ): Promise<TestInputAvailability> | TestInputAvailability;
  authorizeResponse?(input: {
    readonly step: TestCapabilityStepScope;
    readonly response: ApprovalResponseContext<unknown>;
  }): Promise<ApprovalResponseDecision> | ApprovalResponseDecision;
}

export interface TestInputGrantRecord extends TestCapabilityStepScope {
  readonly requestId: string;
  readonly responderPrincipalId: string;
  readonly authorizedAt: Timestamp;
  readonly consumedAt?: Timestamp | undefined;
}

export const testInputGrantRecordSchema: z.ZodType<TestInputGrantRecord> =
  testCapabilityStepScopeObjectSchema.extend({
    requestId: z.string().min(1).max(512),
    responderPrincipalId: z.string().min(1).max(1_024),
    authorizedAt: timestampSchema,
    consumedAt: timestampSchema.optional(),
  });

export interface TestCapabilityExecutionRecord extends TestCapabilityStepScope {
  readonly approval: "not_required" | "verified";
  readonly status: "started" | "succeeded" | "failed";
  readonly startedAt: Timestamp;
  readonly completedAt?: Timestamp | undefined;
  readonly errorCode?: string | undefined;
}

export const testCapabilityExecutionRecordSchema: z.ZodType<TestCapabilityExecutionRecord> =
  testCapabilityStepScopeObjectSchema
    .extend({
      approval: z.enum(["not_required", "verified"]),
      status: z.enum(["started", "succeeded", "failed"]),
      startedAt: timestampSchema,
      completedAt: timestampSchema.optional(),
      errorCode: z.string().min(1).max(256).optional(),
    })
    .superRefine((value, ctx) => {
      if ((value.status === "started") === (value.completedAt !== undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "completedAt is absent exactly while capability execution is started",
        });
      }
    });

export type TestPolicyErrorCode =
  | TestInputUnavailableCode
  | "OWNER_MISMATCH"
  | "BOOTSTRAP_REQUIRED"
  | "LEASE_CLOSED"
  | "LEASE_EXPIRED"
  | "TARGET_CHANGED"
  | "WORKFLOW_CHANGED"
  | "CAPABILITY_NOT_SELECTED"
  | "CAPABILITY_SCHEMA_CHANGED"
  | "INPUT_REPLAYED"
  | "TEST_STEP_REPLAYED"
  | "TEST_POLICY_STORE_INVARIANT_VIOLATION";

export interface TestPolicyError {
  readonly code: TestPolicyErrorCode;
  readonly message: string;
}

export type TestPolicyResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: TestPolicyError };

export interface AuthorizeTestInputStoreCommand {
  readonly step: TestCapabilityStepScope;
  readonly requestId: string;
  readonly responder: Readonly<{
    readonly principalId: string;
    readonly principalType: string;
  }>;
  readonly occurredAt: Timestamp;
}

export interface BeginTestCapabilityExecutionStoreCommand {
  readonly step: TestCapabilityStepScope;
  readonly consequential: boolean;
  readonly occurredAt: Timestamp;
}

export interface CompleteTestCapabilityExecutionStoreCommand {
  readonly owner: OwnerScope;
  readonly workflowId: BuildWorkflowId;
  readonly testRunId: TestRunId;
  readonly leaseId: string;
  readonly childSessionId: string;
  readonly executionTurnId: string;
  readonly callId: string;
  readonly status: "succeeded" | "failed";
  readonly occurredAt: Timestamp;
  readonly errorCode?: string;
}

export interface TestCapabilityExecutionQuery {
  readonly owner: OwnerScope;
  readonly workflowId: BuildWorkflowId;
  readonly testRunId: TestRunId;
}

function requestPolicy(approval: Approval<unknown> | undefined) {
  if (approval === undefined) return undefined;
  return typeof approval === "function" ? approval : approval.request;
}

function responsePolicy(approval: Approval<unknown> | undefined) {
  return typeof approval === "object" && approval !== null
    ? approval.response
    : undefined;
}

function isDenied(status: ApprovalStatus): boolean {
  return (
    status === false ||
    status === "denied" ||
    (typeof status === "object" && status.type === "denied")
  );
}

/** Preserve the real host policy while adding one exact-call Builder approval. */
export function composeConsequentialTestApproval(input: {
  readonly hostApproval?: Approval<unknown>;
  readonly getStep: (
    ctx: ApprovalContext<unknown>,
  ) => Promise<TestPolicyResult<TestCapabilityStepScope>>;
  readonly getResponseStep: (
    ctx: ApprovalResponseContext<unknown>,
  ) => Promise<TestPolicyResult<TestCapabilityStepScope>>;
  readonly inputPolicy?: VerifiedTestInputPolicy;
  readonly authorize: (
    step: TestCapabilityStepScope,
    ctx: ApprovalResponseContext<unknown>,
  ) => Promise<TestPolicyResult<TestInputGrantRecord>>;
}): Approval<unknown> {
  const hostRequest = requestPolicy(input.hostApproval);
  const hostResponse = responsePolicy(input.hostApproval);
  return {
    request: async (ctx) => {
      const original = await hostRequest?.(ctx);
      if (isDenied(original)) return original;
      const step = await input.getStep(ctx);
      if (!step.ok) return { type: "denied", reason: step.error.code };
      if (input.inputPolicy === undefined) {
        return { type: "denied", reason: "INPUT_UNAVAILABLE" };
      }
      let availability: TestInputAvailability;
      try {
        availability = await input.inputPolicy.availability(step.value);
      } catch {
        return { type: "denied", reason: "INPUT_UNAVAILABLE" };
      }
      return availability.status === "available"
        ? "user-approval"
        : { type: "denied", reason: availability.code };
    },
    response: async (ctx) => {
      if (hostResponse !== undefined) {
        const original = await hostResponse(ctx);
        if (original.status === "rejected") return original;
      }
      const step = await input.getResponseStep(ctx);
      if (!step.ok) return { status: "rejected", reason: step.error.code };
      if (input.inputPolicy?.authorizeResponse !== undefined) {
        const decision = await input.inputPolicy.authorizeResponse({
          step: step.value,
          response: ctx,
        });
        if (decision.status === "rejected") return decision;
      }
      const authorized = await input.authorize(step.value, ctx);
      return authorized.ok
        ? { status: "allowed" }
        : { status: "rejected", reason: authorized.error.code };
    },
  };
}

export async function fingerprintTestStep(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}
