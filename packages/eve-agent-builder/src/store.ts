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

/**
 * Complete trusted command set for one durable store transaction.
 *
 * Commands are constructed by `AgentBuilderService`, not from model-authored
 * payloads. Adapters must atomically compare/store the mutation identity with
 * the successful result before returning.
 */
export type AgentBuilderStoreCommand =
  | ActivateVersionStoreCommand
  | ArchiveFamilyStoreCommand
  | BeginRevisionStoreCommand
  | CreateFamilyStoreCommand
  | DeleteFamilyStoreCommand
  | PatchDraftStoreCommand
  | PublishDraftStoreCommand
  | RestoreFamilyStoreCommand;

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
      ]),
    })
    .strict(),
  z
    .object({ code: z.literal("STORE_INVARIANT_VIOLATION"), message: z.string() })
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
  mutate(command: AgentBuilderStoreCommand): Promise<AgentBuilderStoreMutationResult>;
}

export type AgentBuilderStoreFactory = () => AgentBuilderStore | Promise<AgentBuilderStore>;
