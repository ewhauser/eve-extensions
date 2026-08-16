import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  agentIdSchema,
  draftIdSchema,
  ownerScopeSchema,
  positiveRevisionSchema,
  positiveVersionSchema,
  specIdSchema,
  timestampSchema,
  type AgentId,
  type DraftId,
  type OwnerScope,
  type SpecId,
  type Timestamp,
} from "./domain.js";
import type { AgentBuilderStore } from "./store.js";

export const AGENT_BUILDER_BOOTSTRAP_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_BOOTSTRAP_GRANT_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_EXECUTION_LEASE_TTL_MS = 15 * 60 * 1_000;
export const MINIMUM_BOOTSTRAP_TOKEN_BYTES = 16;

export type ExecutionRole =
  | "pm"
  | "implementor"
  | "qa"
  | "test_runner"
  | "active_runner";

export const executionRoleSchema = z.enum([
  "pm",
  "implementor",
  "qa",
  "test_runner",
  "active_runner",
]);

export type BootstrapTarget =
  | Readonly<{
      kind: "draft";
      agentId: AgentId;
      draftId: DraftId;
      draftRevision: number;
    }>
  | Readonly<{
      kind: "published";
      agentId: AgentId;
      specId: SpecId;
      specVersion: number;
    }>;

export const bootstrapTargetSchema: z.ZodType<BootstrapTarget> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("draft"),
        agentId: agentIdSchema,
        draftId: draftIdSchema,
        draftRevision: positiveRevisionSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("published"),
        agentId: agentIdSchema,
        specId: specIdSchema,
        specVersion: positiveVersionSchema,
      })
      .strict(),
  ],
);

export interface BootstrapGrantRecord {
  readonly grantId: string;
  readonly tokenHash: string;
  readonly owner: OwnerScope;
  readonly role: ExecutionRole;
  readonly target: BootstrapTarget;
  readonly parentSessionId: string;
  readonly parentTurnId?: string;
  readonly parentCallId?: string;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly redeemedAt?: Timestamp;
  readonly childSessionId?: string;
}

export const bootstrapGrantRecordSchema = z
  .object({
    grantId: z.string().min(1).max(512),
    tokenHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    owner: ownerScopeSchema,
    role: executionRoleSchema,
    target: bootstrapTargetSchema,
    parentSessionId: z.string().min(1).max(512),
    parentTurnId: z.string().min(1).max(512).optional(),
    parentCallId: z.string().min(1).max(512).optional(),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    redeemedAt: timestampSchema.optional(),
    childSessionId: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.redeemedAt === undefined) !== (value.childSessionId === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "redeemedAt and childSessionId must be present or absent together",
      });
    }
  }) as unknown as z.ZodType<BootstrapGrantRecord>;

export type CapabilityUnavailableReason =
  | "missing"
  | "unauthorized"
  | "disabled"
  | "incompatible";

export interface ExecutionCapabilityPlanEntry {
  readonly capabilityId: string;
  readonly modelToolName: string;
  readonly schemaFingerprint: string;
  readonly consequential: boolean;
}

export interface ExecutionCapabilityOmission {
  readonly capabilityId: string;
  readonly displayNameSnapshot: string;
  readonly reason: CapabilityUnavailableReason;
}

export interface ExecutionCapabilityPlan {
  readonly mode: "test" | "direct" | "unattended";
  readonly selected: readonly ExecutionCapabilityPlanEntry[];
  readonly optionalOmissions: readonly ExecutionCapabilityOmission[];
}

const executionCapabilityPlanEntrySchema: z.ZodType<ExecutionCapabilityPlanEntry> = z
  .object({
    capabilityId: z.string().min(1).max(512),
    modelToolName: z.string().min(1).max(256),
    schemaFingerprint: z.string().min(1).max(512),
    consequential: z.boolean(),
  })
  .strict();

const executionCapabilityOmissionSchema: z.ZodType<ExecutionCapabilityOmission> = z
  .object({
    capabilityId: z.string().min(1).max(512),
    displayNameSnapshot: z.string().min(1).max(256),
    reason: z.enum(["missing", "unauthorized", "disabled", "incompatible"]),
  })
  .strict();

export const executionCapabilityPlanSchema: z.ZodType<ExecutionCapabilityPlan> = z
  .object({
    mode: z.enum(["test", "direct", "unattended"]),
    selected: z.array(executionCapabilityPlanEntrySchema).max(256).readonly(),
    optionalOmissions: z.array(executionCapabilityOmissionSchema).max(256).readonly(),
  })
  .strict();

export type ExecutionLeaseStatus =
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export const executionLeaseStatusSchema = z.enum([
  "ready",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export interface ExecutionLeaseRecord {
  readonly leaseId: string;
  readonly grantId: string;
  readonly owner: OwnerScope;
  readonly role: ExecutionRole;
  readonly target: BootstrapTarget;
  readonly parentSessionId: string;
  readonly parentTurnId?: string;
  readonly parentCallId: string;
  readonly childSessionId: string;
  readonly bootstrapTurnId: string;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly status: ExecutionLeaseStatus;
  readonly executionTurnId?: string;
  readonly capabilityPlan?: ExecutionCapabilityPlan;
  readonly closedAt?: Timestamp;
  readonly terminalCode?: string;
}

export const executionLeaseRecordSchema = z
  .object({
    leaseId: z.string().min(1).max(512),
    grantId: z.string().min(1).max(512),
    owner: ownerScopeSchema,
    role: executionRoleSchema,
    target: bootstrapTargetSchema,
    parentSessionId: z.string().min(1).max(512),
    parentTurnId: z.string().min(1).max(512).optional(),
    parentCallId: z.string().min(1).max(512),
    childSessionId: z.string().min(1).max(512),
    bootstrapTurnId: z.string().min(1).max(512),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    status: executionLeaseStatusSchema,
    executionTurnId: z.string().min(1).max(512).optional(),
    capabilityPlan: executionCapabilityPlanSchema.optional(),
    closedAt: timestampSchema.optional(),
    terminalCode: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const terminal = ["succeeded", "failed", "cancelled", "expired"].includes(
      value.status,
    );
    if (terminal !== (value.closedAt !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "closedAt is present exactly for terminal leases",
      });
    }
    if (value.status === "running" && value.executionTurnId === undefined) {
      ctx.addIssue({ code: "custom", message: "running leases require executionTurnId" });
    }
  }) as unknown as z.ZodType<ExecutionLeaseRecord>;

export type BootstrapStoreErrorCode =
  | "BOOTSTRAP_NOT_FOUND"
  | "BOOTSTRAP_REPLAYED"
  | "BOOTSTRAP_EXPIRED"
  | "BOOTSTRAP_BINDING_MISMATCH"
  | "OWNER_MISMATCH"
  | "CHILD_SESSION_MISMATCH"
  | "LEASE_NOT_FOUND"
  | "LEASE_NOT_READY"
  | "LEASE_CLOSED"
  | "LEASE_EXPIRED"
  | "TARGET_CHANGED"
  | "BOOTSTRAP_STORE_INVARIANT_VIOLATION";

export interface BootstrapStoreError {
  readonly code: BootstrapStoreErrorCode;
  readonly message: string;
}

export type BootstrapStoreResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: BootstrapStoreError };

export interface CreateBootstrapGrantStoreCommand {
  readonly grant: BootstrapGrantRecord;
}

export interface RedeemBootstrapGrantStoreCommand {
  readonly tokenHash: string;
  readonly owner: OwnerScope;
  readonly role: ExecutionRole;
  readonly expectedTarget?: BootstrapTarget;
  readonly parentSessionId: string;
  readonly parentTurnId?: string;
  readonly parentCallId: string;
  readonly childSessionId: string;
  readonly bootstrapTurnId: string;
  readonly leaseId: string;
  readonly occurredAt: Timestamp;
  readonly leaseExpiresAt: Timestamp;
}

export interface ExecutionLeaseQuery {
  readonly owner: OwnerScope;
  readonly childSessionId: string;
}

export interface BeginExecutionLeaseStoreCommand extends ExecutionLeaseQuery {
  readonly executionTurnId: string;
  readonly occurredAt: Timestamp;
  readonly capabilityPlan?: ExecutionCapabilityPlan;
}

export interface CloseExecutionLeaseStoreCommand extends ExecutionLeaseQuery {
  readonly executionTurnId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly occurredAt: Timestamp;
  readonly terminalCode?: string;
}

export interface CloseParentTurnLeasesStoreCommand {
  readonly owner: OwnerScope;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly status: "failed" | "cancelled";
  readonly occurredAt: Timestamp;
  readonly terminalCode: string;
}

export type BootstrapError =
  | BootstrapStoreError
  | Readonly<{
      code:
        | "INVALID_INPUT"
        | "DEPENDENCY_CONTRACT_VIOLATION"
        | "BOOTSTRAP_REQUIRED"
        | "REQUIRED_CAPABILITY_UNAVAILABLE"
        | "CAPABILITY_REGISTRY_CONTRACT_VIOLATION";
      message: string;
      capabilityId?: string;
      displayNameSnapshot?: string;
      reason?: CapabilityUnavailableReason;
    }>;

export type BootstrapResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: BootstrapError };

export interface BootstrapClock {
  now(): string;
}

export interface BootstrapIdFactory {
  grantId(): string;
  leaseId(): string;
}

export interface BootstrapTokenSource {
  bytes(length: number): Uint8Array;
}

export interface BootstrapServiceOptions {
  readonly store: AgentBuilderStore;
  readonly clock?: BootstrapClock;
  readonly ids?: BootstrapIdFactory;
  readonly tokenSource?: BootstrapTokenSource;
  readonly maxGrantTtlMs?: number;
  readonly executionLeaseTtlMs?: number;
}

export interface IssueBootstrapGrantInput {
  readonly owner: OwnerScope;
  readonly role: ExecutionRole;
  readonly target: BootstrapTarget;
  readonly parentSessionId: string;
  readonly parentTurnId?: string;
  readonly parentCallId?: string;
  readonly ttlMs?: number;
}

export interface IssuedBootstrapGrant {
  readonly protocolVersion: typeof AGENT_BUILDER_BOOTSTRAP_PROTOCOL_VERSION;
  readonly token: string;
  readonly role: ExecutionRole;
  readonly target: BootstrapTarget;
  readonly expiresAt: Timestamp;
}

export interface RedeemBootstrapGrantInput {
  readonly token: string;
  readonly owner: OwnerScope;
  readonly role: ExecutionRole;
  readonly expectedTarget?: BootstrapTarget;
  readonly parentSessionId: string;
  readonly parentTurnId?: string;
  readonly parentCallId: string;
  readonly childSessionId: string;
  readonly bootstrapTurnId: string;
}

export interface BootstrapReadyReceipt {
  readonly status: "ready";
  readonly protocolVersion: typeof AGENT_BUILDER_BOOTSTRAP_PROTOCOL_VERSION;
  readonly leaseId: string;
  readonly role: ExecutionRole;
  readonly target: BootstrapTarget;
  readonly childSessionId: string;
  readonly expiresAt: Timestamp;
}

const defaultClock: BootstrapClock = { now: () => new Date().toISOString() };
const defaultIds: BootstrapIdFactory = {
  grantId: () => `grant_${globalThis.crypto.randomUUID()}`,
  leaseId: () => `lease_${globalThis.crypto.randomUUID()}`,
};
const defaultTokenSource: BootstrapTokenSource = {
  bytes(length) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
};

function asTimestamp(epoch: number): Timestamp {
  return timestampSchema.parse(new Date(epoch).toISOString());
}

function parseNow(clock: BootstrapClock): BootstrapResult<Timestamp> {
  const parsed = timestampSchema.safeParse(clock.now());
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: {
          code: "DEPENDENCY_CONTRACT_VIOLATION",
          message: "BootstrapClock returned a non-canonical timestamp",
        },
      };
}

function validOpaqueId(value: string): boolean {
  return value.length >= 1 && value.length <= 512 && !value.includes("\u0000");
}

function targetsEqual(left: BootstrapTarget, right: BootstrapTarget): boolean {
  if (left.kind !== right.kind || left.agentId !== right.agentId) return false;
  return left.kind === "draft" && right.kind === "draft"
    ? left.draftId === right.draftId && left.draftRevision === right.draftRevision
    : left.kind === "published" && right.kind === "published"
      ? left.specId === right.specId && left.specVersion === right.specVersion
      : false;
}

/** Constant-time comparison for already-normalized SHA-256 digest strings. */
export function equalTokenHashes(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** Hashes an opaque bootstrap token. The clear token is never persisted. */
export async function hashBootstrapToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`eve-agent-builder-bootstrap-v1:${token}`),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function formatBootstrapMessage(token: string): string {
  return JSON.stringify({
    protocolVersion: AGENT_BUILDER_BOOTSTRAP_PROTOCOL_VERSION,
    token,
  });
}

/** Accepts only the two-field caller payload, even when Eve wraps a fresh child message. */
export function parseBootstrapMessage(message: string): { readonly token: string } | null {
  const callerMessageMarker = "Caller message:\n";
  const firstMarker = message.indexOf(callerMessageMarker);
  const isWrapped = firstMarker >= 0;
  if (isWrapped) {
    const fixedWrapper = /^You are the subagent "[^"\n]+"\.\n(?:Description: [^\n]*\n)?\nThe caller delegated the following task to you\. Complete it and return the (?:result directly\. The caller may send follow-up messages after you answer\.|final result directly\.)\n\nCaller message:\n/u;
    const match = fixedWrapper.exec(message);
    if (
      match === null ||
      match[0].length !== firstMarker + callerMessageMarker.length ||
      firstMarker !== message.lastIndexOf(callerMessageMarker)
    ) {
      return null;
    }
  }
  const candidate = isWrapped
    ? message.slice(firstMarker + callerMessageMarker.length)
    : message;
  try {
    const value: unknown = JSON.parse(candidate.trim());
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      record.protocolVersion !== AGENT_BUILDER_BOOTSTRAP_PROTOCOL_VERSION ||
      typeof record.token !== "string" ||
      !/^ab1_[A-Za-z0-9_-]{22,252}$/u.test(record.token)
    ) {
      return null;
    }
    return { token: record.token };
  } catch {
    return null;
  }
}

export class BootstrapService {
  readonly #store: AgentBuilderStore;
  readonly #clock: BootstrapClock;
  readonly #ids: BootstrapIdFactory;
  readonly #tokenSource: BootstrapTokenSource;
  readonly #maxGrantTtlMs: number;
  readonly #leaseTtlMs: number;

  constructor(options: BootstrapServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? defaultClock;
    this.#ids = options.ids ?? defaultIds;
    this.#tokenSource = options.tokenSource ?? defaultTokenSource;
    this.#maxGrantTtlMs = options.maxGrantTtlMs ?? DEFAULT_BOOTSTRAP_GRANT_TTL_MS;
    this.#leaseTtlMs = options.executionLeaseTtlMs ?? DEFAULT_EXECUTION_LEASE_TTL_MS;
    for (const [name, value] of [
      ["maxGrantTtlMs", this.#maxGrantTtlMs],
      ["executionLeaseTtlMs", this.#leaseTtlMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
    if (this.#maxGrantTtlMs > DEFAULT_BOOTSTRAP_GRANT_TTL_MS) {
      throw new TypeError("maxGrantTtlMs cannot exceed the five-minute protocol maximum");
    }
  }

  async issue(input: IssueBootstrapGrantInput): Promise<BootstrapResult<IssuedBootstrapGrant>> {
    const parsed = z
      .object({
        owner: ownerScopeSchema,
        role: executionRoleSchema,
        target: bootstrapTargetSchema,
        parentSessionId: z.string().min(1).max(512),
        parentTurnId: z.string().min(1).max(512).optional(),
        parentCallId: z.string().min(1).max(512).optional(),
        ttlMs: z.number().int().safe().positive().optional(),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Invalid grant input" } };
    }
    if (!this.#roleAcceptsTarget(parsed.data.role, parsed.data.target)) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Execution role does not accept the requested target kind",
        },
      };
    }
    const exact = await this.#targetExists(parsed.data.owner, parsed.data.target);
    if (!exact) {
      return {
        ok: false,
        error: { code: "TARGET_CHANGED", message: "The exact bootstrap target is unavailable" },
      };
    }
    const now = parseNow(this.#clock);
    if (!now.ok) return now;
    const ttlMs = parsed.data.ttlMs ?? this.#maxGrantTtlMs;
    if (ttlMs > this.#maxGrantTtlMs) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Bootstrap grant lifetime exceeds the configured maximum",
        },
      };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tokenBytes = this.#tokenSource.bytes(32);
      if (!(tokenBytes instanceof Uint8Array) || tokenBytes.byteLength < MINIMUM_BOOTSTRAP_TOKEN_BYTES) {
        return {
          ok: false,
          error: {
            code: "DEPENDENCY_CONTRACT_VIOLATION",
            message: "BootstrapTokenSource returned fewer than 128 bits",
          },
        };
      }
      const token = `ab1_${Buffer.from(tokenBytes).toString("base64url")}`;
      const tokenHash = await hashBootstrapToken(token);
      const grantId = this.#ids.grantId();
      if (!validOpaqueId(grantId)) {
        return {
          ok: false,
          error: {
            code: "DEPENDENCY_CONTRACT_VIOLATION",
            message: "BootstrapIdFactory returned an invalid grant ID",
          },
        };
      }
      const expiresAt = asTimestamp(Date.parse(now.value) + ttlMs);
      const grant: BootstrapGrantRecord = {
        grantId,
        tokenHash,
        owner: parsed.data.owner,
        role: parsed.data.role,
        target: parsed.data.target,
        parentSessionId: parsed.data.parentSessionId,
        ...(parsed.data.parentTurnId === undefined
          ? {}
          : { parentTurnId: parsed.data.parentTurnId }),
        ...(parsed.data.parentCallId === undefined
          ? {}
          : { parentCallId: parsed.data.parentCallId }),
        issuedAt: now.value,
        expiresAt,
      };
      const created = await this.#store.createBootstrapGrant({ grant });
      if (created.ok) {
        return {
          ok: true,
          value: {
            protocolVersion: AGENT_BUILDER_BOOTSTRAP_PROTOCOL_VERSION,
            token,
            role: grant.role,
            target: grant.target,
            expiresAt,
          },
        };
      }
      if (created.error.code !== "BOOTSTRAP_STORE_INVARIANT_VIOLATION") return created;
    }
    return {
      ok: false,
      error: {
        code: "DEPENDENCY_CONTRACT_VIOLATION",
        message: "Unable to allocate a unique bootstrap grant",
      },
    };
  }

  async redeem(
    input: RedeemBootstrapGrantInput,
  ): Promise<BootstrapResult<BootstrapReadyReceipt>> {
    const parsed = z
      .object({
        token: z.string().min(24).max(256),
        owner: ownerScopeSchema,
        role: executionRoleSchema,
        expectedTarget: bootstrapTargetSchema.optional(),
        parentSessionId: z.string().min(1).max(512),
        parentTurnId: z.string().min(1).max(512).optional(),
        parentCallId: z.string().min(1).max(512),
        childSessionId: z.string().min(1).max(512),
        bootstrapTurnId: z.string().min(1).max(512),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Invalid bootstrap redemption input" },
      };
    }
    const now = parseNow(this.#clock);
    if (!now.ok) return now;
    const leaseId = this.#ids.leaseId();
    if (!validOpaqueId(leaseId)) {
      return {
        ok: false,
        error: {
          code: "DEPENDENCY_CONTRACT_VIOLATION",
          message: "BootstrapIdFactory returned an invalid lease ID",
        },
      };
    }
    const result = await this.#store.redeemBootstrapGrant({
      tokenHash: await hashBootstrapToken(parsed.data.token),
      owner: parsed.data.owner,
      role: parsed.data.role,
      ...(parsed.data.expectedTarget === undefined
        ? {}
        : { expectedTarget: parsed.data.expectedTarget }),
      parentSessionId: parsed.data.parentSessionId,
      ...(parsed.data.parentTurnId === undefined
        ? {}
        : { parentTurnId: parsed.data.parentTurnId }),
      parentCallId: parsed.data.parentCallId,
      childSessionId: parsed.data.childSessionId,
      bootstrapTurnId: parsed.data.bootstrapTurnId,
      leaseId,
      occurredAt: now.value,
      leaseExpiresAt: asTimestamp(Date.parse(now.value) + this.#leaseTtlMs),
    });
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        status: "ready",
        protocolVersion: AGENT_BUILDER_BOOTSTRAP_PROTOCOL_VERSION,
        leaseId: result.value.leaseId,
        role: result.value.role,
        target: result.value.target,
        childSessionId: result.value.childSessionId,
        expiresAt: result.value.expiresAt,
      },
    };
  }

  async getLease(query: ExecutionLeaseQuery): Promise<BootstrapResult<ExecutionLeaseRecord>> {
    const lease = await this.#store.getExecutionLease(query);
    return lease === null
      ? {
          ok: false,
          error: { code: "BOOTSTRAP_REQUIRED", message: "BOOTSTRAP_REQUIRED" },
        }
      : { ok: true, value: lease };
  }

  async beginExecution(
    input: BeginExecutionLeaseStoreCommand,
  ): Promise<BootstrapResult<ExecutionLeaseRecord>> {
    return this.#store.beginExecutionLease(input);
  }

  closeExecution(
    input: CloseExecutionLeaseStoreCommand,
  ): Promise<BootstrapStoreResult<ExecutionLeaseRecord>> {
    return this.#store.closeExecutionLease(input);
  }

  closeParentTurn(
    input: CloseParentTurnLeasesStoreCommand,
  ): Promise<BootstrapStoreResult<readonly ExecutionLeaseRecord[]>> {
    return this.#store.closeParentTurnExecutionLeases(input);
  }

  async #targetExists(owner: OwnerScope, target: BootstrapTarget): Promise<boolean> {
    const family = await this.#store.getFamily({ owner, agentId: target.agentId });
    if (family === null || family.lifecycle === "deleted") return false;
    if (target.kind === "draft") {
      return (
        family.draft?.draftId === target.draftId &&
        family.draft.draftRevision === target.draftRevision &&
        family.lifecycle !== "archived"
      );
    }
    if (family.lifecycle !== "active") return false;
    const version = await this.#store.getVersion({
      owner,
      agentId: target.agentId,
      specId: target.specId,
      version: target.specVersion,
    });
    return (
      version !== null &&
      family.activeSpecId === target.specId &&
      family.activeVersion === target.specVersion
    );
  }

  #roleAcceptsTarget(role: ExecutionRole, target: BootstrapTarget): boolean {
    return role === "active_runner" ? target.kind === "published" : target.kind === "draft";
  }
}

export function createBootstrapService(options: BootstrapServiceOptions): BootstrapService {
  return new BootstrapService(options);
}

export function bootstrapTargetsEqual(left: BootstrapTarget, right: BootstrapTarget): boolean {
  return targetsEqual(left, right);
}
