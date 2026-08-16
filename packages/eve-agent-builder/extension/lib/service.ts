import { z } from "zod";
import type { SessionAuthContext } from "eve/context";

import {
  agentIdSchema,
  canonicalizeAgentName,
  createSavedAgentDraftInputSchema,
  draftIdSchema,
  operationIdSchema,
  ownerResolutionInputSchema,
  ownerScopeSchema,
  positiveRevisionSchema,
  positiveVersionSchema,
  savedAgentDraftPatchSchema,
  savedAgentEditableFieldsSchema,
  specIdSchema,
  timestampSchema,
  type AgentId,
  type CreateSavedAgentDraftInput,
  type OwnerResolutionInput,
  type OwnerResolutionResult,
  type OwnerScope,
  type PublishedAgentVersion,
  type ResolveOwner,
  type SavedAgentDraftPatch,
  type SavedAgentEditableFields,
  type SavedAgentFamily,
  type SpecId,
  type Timestamp,
  type TrustedMutationIdentity,
} from "./domain.js";
import { agentBuilderStoreErrorSchema } from "./store.js";
import type {
  AgentBuilderStore,
  AgentBuilderStoreCommand,
  AgentBuilderStoreError,
  AgentBuilderStoreMutationSuccess,
  FamilyStoreQuery,
} from "./store.js";

export const DEFAULT_MAX_AGENT_FAMILIES_PER_OWNER = 25;

export interface AgentBuilderClock {
  now(): string;
}

export interface AgentBuilderIdFactory {
  agentId(): string;
  draftId(): string;
  specId(): string;
}

export interface AgentBuilderServiceOptions {
  readonly store: AgentBuilderStore;
  readonly resolveOwner: ResolveOwner;
  readonly clock?: AgentBuilderClock;
  readonly ids?: AgentBuilderIdFactory;
  readonly maxAgentFamiliesPerOwner?: number;
}

export interface AgentBuilderMutationContext {
  readonly ownerResolution: OwnerResolutionInput;
  /** Trusted host/runtime identity. It must not come from a model patch. */
  readonly operationId: string;
}

export type AgentBuilderError =
  | Readonly<{
      code:
        | "INVALID_OWNER_CONTEXT"
        | "OWNER_RESOLUTION_FAILED"
        | "USER_PRINCIPAL_REQUIRED";
      message: string;
    }>
  | Readonly<{
      code: "INVALID_INPUT";
      message: string;
      issues: readonly string[];
    }>
  | Readonly<{
      code: "DEPENDENCY_CONTRACT_VIOLATION";
      message: string;
    }>
  | Readonly<{
      code: "OWNER_MISMATCH";
      message: string;
    }>
  | AgentBuilderStoreError;

export type AgentBuilderResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: AgentBuilderError };

type AgentBuilderFailure = Extract<AgentBuilderResult<never>, { readonly ok: false }>;

export const agentBuilderErrorSchema = z.union([
  agentBuilderStoreErrorSchema,
  z
    .object({
      code: z.enum([
        "INVALID_OWNER_CONTEXT",
        "OWNER_RESOLUTION_FAILED",
        "USER_PRINCIPAL_REQUIRED",
      ]),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("INVALID_INPUT"),
      message: z.string(),
      issues: z.array(z.string()).readonly(),
    })
    .strict(),
  z
    .object({ code: z.literal("DEPENDENCY_CONTRACT_VIOLATION"), message: z.string() })
    .strict(),
  z.object({ code: z.literal("OWNER_MISMATCH"), message: z.string() }).strict(),
]) as z.ZodType<AgentBuilderError>;

export function agentBuilderResultSchema<Value>(
  valueSchema: z.ZodType<Value>,
): z.ZodType<AgentBuilderResult<Value>> {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: valueSchema }).strict(),
    z.object({ ok: z.literal(false), error: agentBuilderErrorSchema }).strict(),
  ]) as z.ZodType<AgentBuilderResult<Value>>;
}

export interface GetFamilyInput {
  readonly agentId: AgentId;
}

export interface GetVersionInput {
  readonly agentId: AgentId;
  readonly specId: SpecId;
  readonly version: number;
}

export interface BeginRevisionInput {
  readonly agentId: AgentId;
  readonly expectedRevision: number;
}

export interface PatchDraftInput {
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly expectedDraftRevision: number;
  readonly patch: SavedAgentDraftPatch;
}

export interface PublishDraftInput {
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly expectedDraftRevision: number;
}

export interface ActivateVersionInput {
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly specId: SpecId;
  readonly version: number;
}

export interface FamilyLifecycleInput {
  readonly agentId: AgentId;
  readonly expectedRevision: number;
}

const getFamilyInputSchema: z.ZodType<GetFamilyInput> = z
  .object({ agentId: agentIdSchema })
  .strict();

const getVersionInputSchema: z.ZodType<GetVersionInput> = z
  .object({
    agentId: agentIdSchema,
    specId: specIdSchema,
    version: positiveVersionSchema,
  })
  .strict();

const beginRevisionInputSchema: z.ZodType<BeginRevisionInput> = z
  .object({
    agentId: agentIdSchema,
    expectedRevision: positiveRevisionSchema,
  })
  .strict();

const patchDraftInputSchema: z.ZodType<PatchDraftInput> = z
  .object({
    agentId: agentIdSchema,
    expectedRevision: positiveRevisionSchema,
    expectedDraftRevision: positiveRevisionSchema,
    patch: savedAgentDraftPatchSchema.refine((patch) => Object.keys(patch).length > 0, {
      message: "Patch must change at least one editable field",
    }),
  })
  .strict();

const publishDraftInputSchema: z.ZodType<PublishDraftInput> = z
  .object({
    agentId: agentIdSchema,
    expectedRevision: positiveRevisionSchema,
    expectedDraftRevision: positiveRevisionSchema,
  })
  .strict();

const activateVersionInputSchema: z.ZodType<ActivateVersionInput> = z
  .object({
    agentId: agentIdSchema,
    expectedRevision: positiveRevisionSchema,
    specId: specIdSchema,
    version: positiveVersionSchema,
  })
  .strict();

const familyLifecycleInputSchema: z.ZodType<FamilyLifecycleInput> = z
  .object({
    agentId: agentIdSchema,
    expectedRevision: positiveRevisionSchema,
  })
  .strict();

const defaultClock: AgentBuilderClock = {
  now: () => new Date().toISOString(),
};

function randomId(namespace: string): string {
  return `${namespace}_${globalThis.crypto.randomUUID()}`;
}

const defaultIds: AgentBuilderIdFactory = {
  agentId: () => randomId("agent"),
  draftId: () => randomId("draft"),
  specId: () => randomId("spec"),
};

function invalidInput(error: z.ZodError): AgentBuilderFailure {
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

function notFound(): AgentBuilderFailure {
  return {
    ok: false,
    error: { code: "NOT_FOUND", message: "Saved agent family was not found" },
  };
}

function revisionConflict(family: SavedAgentFamily): AgentBuilderFailure {
  return {
    ok: false,
    error: {
      code: "REVISION_CONFLICT",
      message: "The saved agent family changed before this mutation committed",
      currentRevision: family.revision,
      ...(family.draft === undefined
        ? {}
        : { currentDraftRevision: family.draft.draftRevision }),
    },
  };
}

function invalidTransition(
  family: SavedAgentFamily,
  operation: AgentBuilderStoreCommand["type"],
  message: string,
): AgentBuilderFailure {
  return {
    ok: false,
    error: {
      code: "INVALID_TRANSITION",
      message,
      lifecycle: family.lifecycle,
      operation,
    },
  };
}

/** Resolve one interactive operation from `current`; initiator is never used as fallback. */
export async function resolveCurrentOwner(
  rawInput: unknown,
  resolver: ResolveOwner,
): Promise<OwnerResolutionResult> {
  const parsed = ownerResolutionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_OWNER_CONTEXT",
        message: "The current owner context is malformed",
      },
    };
  }

  if (parsed.data.current?.principalType !== "user") {
    return {
      ok: false,
      error: {
        code: "USER_PRINCIPAL_REQUIRED",
        message: "An authenticated current user principal is required",
      },
    };
  }

  try {
    const rawOwner = await resolver(parsed.data);
    if (rawOwner === null) {
      return {
        ok: false,
        error: {
          code: "USER_PRINCIPAL_REQUIRED",
          message: "The current user principal is not accepted by host owner policy",
        },
      };
    }
    const owner = ownerScopeSchema.safeParse(rawOwner);
    if (!owner.success) {
      return {
        ok: false,
        error: {
          code: "OWNER_RESOLUTION_FAILED",
          message: "The host owner resolver returned an invalid owner scope",
        },
      };
    }
    return { ok: true, owner: owner.data, principal: parsed.data.current };
  } catch {
    return {
      ok: false,
      error: {
        code: "OWNER_RESOLUTION_FAILED",
        message: "The host owner resolver failed",
      },
    };
  }
}

function canonicalJson(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Mutation fingerprint contains non-finite data");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Mutation fingerprint contains a cycle");
    seen.add(value);
    const encoded = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return encoded;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new TypeError("Mutation fingerprint contains a cycle");
    seen.add(object);
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], seen)}`);
    seen.delete(object);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Mutation fingerprint contains unsupported data");
}

/** Stable SHA-256 identity used by the operation replay ledger. */
export async function fingerprintMutationRequest(value: unknown): Promise<string> {
  const canonical = `eve-agent-builder-mutation-v1:${canonicalJson(value)}`;
  if (canonical.length > 256_000) {
    throw new RangeError("Canonical mutation exceeds 256000 characters");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function editableFieldsFromCreate(input: CreateSavedAgentDraftInput): SavedAgentEditableFields {
  return {
    name: input.name,
    kind: input.kind,
    description: input.description ?? "",
    pmBrief: input.pmBrief ?? "",
    instructions: input.instructions ?? "",
    toolRequirements: input.toolRequirements ?? [],
    triggers: input.triggers ?? [],
    testChecklist: input.testChecklist ?? [],
    qaFindings: input.qaFindings ?? [],
  };
}

function editableFieldsFromVersion(version: PublishedAgentVersion): SavedAgentEditableFields {
  return {
    name: version.name,
    kind: version.kind,
    description: version.description,
    pmBrief: version.pmBrief,
    instructions: version.instructions,
    toolRequirements: version.toolRequirements,
    triggers: version.triggers,
    testChecklist: version.testChecklist,
    qaFindings: [],
  };
}

function applyPatch(
  fields: SavedAgentEditableFields,
  patch: SavedAgentDraftPatch,
): SavedAgentEditableFields {
  return {
    name: patch.name ?? fields.name,
    kind: patch.kind ?? fields.kind,
    description: patch.description ?? fields.description,
    pmBrief: patch.pmBrief ?? fields.pmBrief,
    instructions: patch.instructions ?? fields.instructions,
    toolRequirements: patch.toolRequirements ?? fields.toolRequirements,
    triggers: patch.triggers ?? fields.triggers,
    testChecklist: patch.testChecklist ?? fields.testChecklist,
    qaFindings: patch.qaFindings ?? fields.qaFindings,
  };
}

function publicFamily(family: SavedAgentFamily | null): SavedAgentFamily | null {
  return family?.lifecycle === "deleted" ? null : family;
}

/** Service boundary that owns owner resolution, validation, lifecycle policy, and IDs/time. */
export class AgentBuilderService {
  readonly #store: AgentBuilderStore;
  readonly #resolver: ResolveOwner;
  readonly #clock: AgentBuilderClock;
  readonly #ids: AgentBuilderIdFactory;
  readonly #maxFamilies: number;

  constructor(options: AgentBuilderServiceOptions) {
    this.#store = options.store;
    this.#resolver = options.resolveOwner;
    this.#clock = options.clock ?? defaultClock;
    this.#ids = options.ids ?? defaultIds;
    this.#maxFamilies =
      options.maxAgentFamiliesPerOwner ?? DEFAULT_MAX_AGENT_FAMILIES_PER_OWNER;
    if (!Number.isSafeInteger(this.#maxFamilies) || this.#maxFamilies < 1) {
      throw new TypeError("maxAgentFamiliesPerOwner must be a positive safe integer");
    }
  }

  resolveOwner(input: unknown): Promise<OwnerResolutionResult> {
    return resolveCurrentOwner(input, this.#resolver);
  }

  async getFamily(
    ownerInput: unknown,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<SavedAgentFamily>> {
    const resolved = await this.resolveOwner(ownerInput);
    if (!resolved.ok) return resolved;
    const input = getFamilyInputSchema.safeParse(rawInput);
    if (!input.success) return invalidInput(input.error);
    const family = publicFamily(
      await this.#store.getFamily({ owner: resolved.owner, agentId: input.data.agentId }),
    );
    return family === null ? notFound() : { ok: true, value: family };
  }

  async getVersion(
    ownerInput: unknown,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<PublishedAgentVersion>> {
    const resolved = await this.resolveOwner(ownerInput);
    if (!resolved.ok) return resolved;
    const input = getVersionInputSchema.safeParse(rawInput);
    if (!input.success) return invalidInput(input.error);
    const query: FamilyStoreQuery = {
      owner: resolved.owner,
      agentId: input.data.agentId,
    };
    const family = publicFamily(await this.#store.getFamily(query));
    if (family === null) return notFound();
    const version = await this.#store.getVersion({ ...query, ...input.data });
    return version === null ? notFound() : { ok: true, value: version };
  }

  async listVersions(
    ownerInput: unknown,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<readonly PublishedAgentVersion[]>> {
    const resolved = await this.resolveOwner(ownerInput);
    if (!resolved.ok) return resolved;
    const input = getFamilyInputSchema.safeParse(rawInput);
    if (!input.success) return invalidInput(input.error);
    const query = { owner: resolved.owner, agentId: input.data.agentId };
    const family = publicFamily(await this.#store.getFamily(query));
    if (family === null) return notFound();
    return { ok: true, value: await this.#store.listVersions(query) };
  }

  async createDraft(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    const prepared = await this.#prepareMutation(
      context,
      rawInput,
      createSavedAgentDraftInputSchema,
      "create_draft",
      (input) => {
        const fields = editableFieldsFromCreate(input);
        const checked = savedAgentEditableFieldsSchema.safeParse(fields);
        return checked.success
          ? { ok: true as const, value: checked.data }
          : invalidInput(checked.error);
      },
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation);
    if (replay !== null) return replay;

    const now = this.#now();
    if (!now.ok) return now;
    const agentId = this.#id("agent", this.#ids.agentId(), agentIdSchema);
    if (!agentId.ok) return agentId;
    const draftId = this.#id("draft", this.#ids.draftId(), draftIdSchema);
    if (!draftId.ok) return draftId;

    return this.#mutate({
      type: "create_family",
      owner: prepared.owner,
      mutation: prepared.mutation,
      occurredAt: now.value,
      agentId: agentId.value,
      draftId: draftId.value,
      maxFamilies: this.#maxFamilies,
      canonicalName: canonicalizeAgentName(prepared.value.name),
      fields: prepared.value,
    });
  }

  async beginRevision(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    const prepared = await this.#prepareMutation(
      context,
      rawInput,
      beginRevisionInputSchema,
      "begin_revision",
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation);
    if (replay !== null) return replay;
    const family = await this.#store.getFamily({
      owner: prepared.owner,
      agentId: prepared.value.agentId,
    });
    if (family === null || family.lifecycle === "deleted") return notFound();
    if (family.revision !== prepared.value.expectedRevision) return revisionConflict(family);
    if (family.lifecycle !== "active" || family.draft !== undefined) {
      return invalidTransition(
        family,
        "begin_revision",
        "A revision can begin only for an active family without a draft",
      );
    }
    if (family.activeSpecId === undefined || family.activeVersion === undefined) {
      return this.#dependencyViolation("Active family is missing its active version pair");
    }
    const version = await this.#store.getVersion({
      owner: prepared.owner,
      agentId: family.agentId,
      specId: family.activeSpecId,
      version: family.activeVersion,
    });
    if (version === null) {
      return this.#dependencyViolation("Active family points to a missing published version");
    }
    const now = this.#now();
    if (!now.ok) return now;
    const draftId = this.#id("draft", this.#ids.draftId(), draftIdSchema);
    if (!draftId.ok) return draftId;
    return this.#mutate({
      type: "begin_revision",
      owner: prepared.owner,
      mutation: prepared.mutation,
      occurredAt: now.value,
      agentId: family.agentId,
      expectedRevision: prepared.value.expectedRevision,
      draftId: draftId.value,
      basedOnSpecId: version.specId,
      basedOnVersion: version.version,
      fields: editableFieldsFromVersion(version),
    });
  }

  async patchDraft(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    const prepared = await this.#prepareMutation(
      context,
      rawInput,
      patchDraftInputSchema,
      "patch_draft",
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation);
    if (replay !== null) return replay;
    const family = await this.#store.getFamily({
      owner: prepared.owner,
      agentId: prepared.value.agentId,
    });
    if (family === null || family.lifecycle === "deleted") return notFound();
    if (
      family.revision !== prepared.value.expectedRevision ||
      family.draft?.draftRevision !== prepared.value.expectedDraftRevision
    ) {
      return revisionConflict(family);
    }
    if (family.draft === undefined || family.lifecycle === "archived") {
      return invalidTransition(
        family,
        "patch_draft",
        "A draft can be patched only on a non-archived family that has a draft",
      );
    }
    const fields = savedAgentEditableFieldsSchema.safeParse(
      applyPatch(family.draft, prepared.value.patch),
    );
    if (!fields.success) return invalidInput(fields.error);
    const now = this.#now();
    if (!now.ok) return now;
    return this.#mutate({
      type: "patch_draft",
      owner: prepared.owner,
      mutation: prepared.mutation,
      occurredAt: now.value,
      agentId: family.agentId,
      expectedRevision: prepared.value.expectedRevision,
      expectedDraftRevision: prepared.value.expectedDraftRevision,
      canonicalName: canonicalizeAgentName(fields.data.name),
      fields: fields.data,
    });
  }

  async publishDraft(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    const prepared = await this.#prepareMutation(
      context,
      rawInput,
      publishDraftInputSchema,
      "publish_draft",
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation);
    if (replay !== null) return replay;
    const family = await this.#store.getFamily({
      owner: prepared.owner,
      agentId: prepared.value.agentId,
    });
    if (family === null || family.lifecycle === "deleted") return notFound();
    if (
      family.revision !== prepared.value.expectedRevision ||
      family.draft?.draftRevision !== prepared.value.expectedDraftRevision
    ) {
      return revisionConflict(family);
    }
    if (family.draft === undefined || family.lifecycle === "archived") {
      return invalidTransition(
        family,
        "publish_draft",
        "A non-archived family with a draft is required for publication",
      );
    }
    const fields = savedAgentEditableFieldsSchema.safeParse(applyPatch(family.draft, {}));
    if (!fields.success) return invalidInput(fields.error);
    const publishedBy = prepared.principal.principalId;
    if (publishedBy.length === 0 || publishedBy.length > 1_024) {
      return this.#dependencyViolation("Current principal ID cannot be stored as publishedBy");
    }
    const now = this.#now();
    if (!now.ok) return now;
    const specId = this.#id("spec", this.#ids.specId(), specIdSchema);
    if (!specId.ok) return specId;
    return this.#mutate({
      type: "publish_draft",
      owner: prepared.owner,
      mutation: prepared.mutation,
      occurredAt: now.value,
      agentId: family.agentId,
      expectedRevision: prepared.value.expectedRevision,
      expectedDraftRevision: prepared.value.expectedDraftRevision,
      specId: specId.value,
      publishedBy,
    });
  }

  async activateVersion(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    const prepared = await this.#prepareMutation(
      context,
      rawInput,
      activateVersionInputSchema,
      "activate_version",
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation);
    if (replay !== null) return replay;
    const family = await this.#store.getFamily({
      owner: prepared.owner,
      agentId: prepared.value.agentId,
    });
    if (family === null || family.lifecycle === "deleted") return notFound();
    if (family.revision !== prepared.value.expectedRevision) return revisionConflict(family);
    if (family.lifecycle !== "active") {
      return invalidTransition(
        family,
        "activate_version",
        "Published versions can be activated only on an active family",
      );
    }
    const target = await this.#store.getVersion({ owner: prepared.owner, ...prepared.value });
    if (target === null) {
      return { ok: false, error: { code: "VERSION_NOT_FOUND", message: "Version not found" } };
    }
    const now = this.#now();
    if (!now.ok) return now;
    return this.#mutate({
      type: "activate_version",
      owner: prepared.owner,
      mutation: prepared.mutation,
      occurredAt: now.value,
      ...prepared.value,
    });
  }

  archiveFamily(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    return this.#lifecycleMutation(context, rawInput, "archive_family", ["draft_only", "active"]);
  }

  restoreFamily(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    return this.#lifecycleMutation(context, rawInput, "restore_family", ["archived"]);
  }

  deleteFamily(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    return this.#lifecycleMutation(context, rawInput, "delete_family", [
      "draft_only",
      "active",
      "archived",
    ]);
  }

  async #lifecycleMutation(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
    type: "archive_family" | "delete_family" | "restore_family",
    allowed: readonly SavedAgentFamily["lifecycle"][],
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    const prepared = await this.#prepareMutation(
      context,
      rawInput,
      familyLifecycleInputSchema,
      type,
    );
    if (!prepared.ok) return prepared;
    const replay = await this.#replay(prepared.owner, prepared.mutation);
    if (replay !== null) return replay;
    const family = await this.#store.getFamily({
      owner: prepared.owner,
      agentId: prepared.value.agentId,
    });
    if (family === null || family.lifecycle === "deleted") return notFound();
    if (family.revision !== prepared.value.expectedRevision) return revisionConflict(family);
    if (!allowed.includes(family.lifecycle)) {
      return invalidTransition(family, type, `Lifecycle ${family.lifecycle} cannot ${type}`);
    }
    const now = this.#now();
    if (!now.ok) return now;
    return this.#mutate({
      type,
      owner: prepared.owner,
      mutation: prepared.mutation,
      occurredAt: now.value,
      agentId: family.agentId,
      expectedRevision: prepared.value.expectedRevision,
    });
  }

  async #prepareMutation<Input, Prepared = Input>(
    context: AgentBuilderMutationContext,
    rawInput: unknown,
    schema: z.ZodType<Input>,
    action: string,
    prepare?: (input: Input) =>
      | { readonly ok: true; readonly value: Prepared }
      | AgentBuilderFailure,
  ): Promise<
    | {
        readonly ok: true;
        readonly owner: OwnerScope;
        readonly principal: SessionAuthContext;
        readonly mutation: TrustedMutationIdentity;
        readonly value: Prepared;
      }
    | AgentBuilderFailure
  > {
    const resolved = await this.resolveOwner(context.ownerResolution);
    if (!resolved.ok) return resolved;
    const operationId = operationIdSchema.safeParse(context.operationId);
    const input = schema.safeParse(rawInput);
    if (!operationId.success || !input.success) {
      const issues = [
        ...(operationId.success ? [] : operationId.error.issues),
        ...(input.success ? [] : input.error.issues),
      ];
      return invalidInput(new z.ZodError(issues));
    }
    const prepared = prepare?.(input.data) ?? ({ ok: true, value: input.data } as const);
    if (!prepared.ok) return prepared;
    let requestFingerprint: string;
    try {
      requestFingerprint = await fingerprintMutationRequest({
        action,
        actor: resolved.principal.principalId,
        input: prepared.value,
        schema: "pr02",
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
      owner: resolved.owner,
      principal: resolved.principal,
      mutation: { operationId: operationId.data, requestFingerprint },
      value: prepared.value as Prepared,
    };
  }

  async #replay(
    owner: OwnerScope,
    mutation: TrustedMutationIdentity,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess> | null> {
    const replay = await this.#store.getMutationReplay({ owner, mutation });
    if (replay.status === "miss") return null;
    if (replay.status === "replay") return { ok: true, value: replay.result };
    return {
      ok: false,
      error: {
        code: "OPERATION_ID_REUSED",
        message: "Operation ID was already committed for a different request",
        priorResultType: replay.priorResultType,
      },
    };
  }

  async #mutate(
    command: AgentBuilderStoreCommand,
  ): Promise<AgentBuilderResult<AgentBuilderStoreMutationSuccess>> {
    const result = await this.#store.mutate(command);
    return result.ok ? { ok: true, value: result } : result;
  }

  #now(): AgentBuilderResult<Timestamp> {
    const parsed = timestampSchema.safeParse(this.#clock.now());
    return parsed.success
      ? { ok: true, value: parsed.data }
      : this.#dependencyViolation("AgentBuilderClock returned a non-canonical timestamp");
  }

  #id<Value>(
    kind: string,
    raw: string,
    schema: z.ZodType<Value>,
  ): AgentBuilderResult<Value> {
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : this.#dependencyViolation(`AgentBuilderIdFactory returned an invalid ${kind} ID`);
  }

  #dependencyViolation(message: string): AgentBuilderFailure {
    return { ok: false, error: { code: "DEPENDENCY_CONTRACT_VIOLATION", message } };
  }
}

export function createAgentBuilderService(
  options: AgentBuilderServiceOptions,
): AgentBuilderService {
  return new AgentBuilderService(options);
}
