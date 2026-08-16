import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

declare const opaqueIdentifier: unique symbol;

/** A string whose semantic namespace is carried by its TypeScript type. */
export type OpaqueIdentifier<Tag extends string> = string & {
  readonly [opaqueIdentifier]: Tag;
};

export type AgentId = OpaqueIdentifier<"AgentId">;
export type DraftId = OpaqueIdentifier<"DraftId">;
export type SpecId = OpaqueIdentifier<"SpecId">;
export type TriggerId = OpaqueIdentifier<"TriggerId">;
export type CapabilityId = OpaqueIdentifier<"CapabilityId">;
export type OperationId = OpaqueIdentifier<"OperationId">;
export type Timestamp = OpaqueIdentifier<"Timestamp">;

function identifierSchema<Tag extends string>(): z.ZodType<OpaqueIdentifier<Tag>> {
  return z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !value.includes("\u0000"), "Identifiers must not contain NUL")
    .transform((value) => value as OpaqueIdentifier<Tag>) as z.ZodType<
    OpaqueIdentifier<Tag>
  >;
}

export const agentIdSchema = identifierSchema<"AgentId">();
export const draftIdSchema = identifierSchema<"DraftId">();
export const specIdSchema = identifierSchema<"SpecId">();
export const triggerIdSchema = identifierSchema<"TriggerId">();
export const capabilityIdSchema = identifierSchema<"CapabilityId">();
export const operationIdSchema = identifierSchema<"OperationId">();

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Canonical UTC RFC 3339 timestamp with exactly millisecond precision. */
export const timestampSchema = z
  .string()
  .regex(CANONICAL_TIMESTAMP)
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  }, "Timestamp must be a real canonical UTC instant")
  .transform((value) => value as Timestamp) as z.ZodType<Timestamp>;

export const positiveRevisionSchema = z.number().int().safe().positive();
export const positiveVersionSchema = z.number().int().safe().positive();

export interface OwnerScope {
  readonly tenantKey: string;
  readonly ownerKey: string;
}

/** Owner keys are validated for transport safety but otherwise remain opaque. */
export const ownerScopeSchema: z.ZodType<OwnerScope> = z
  .object({
    tenantKey: z.string().min(1).max(512).refine((value) => !value.includes("\u0000")),
    ownerKey: z.string().min(1).max(512).refine((value) => !value.includes("\u0000")),
  })
  .strict();

const authAttributeSchema = z.union([z.string(), z.array(z.string()).readonly()]);

export const sessionAuthContextSchema = z
  .object({
    attributes: z.record(z.string(), authAttributeSchema).readonly(),
    authenticator: z.string().min(1),
    issuer: z.string().optional(),
    principalId: z.string().min(1),
    principalType: z.string().min(1),
    subject: z.string().optional(),
  })
  .strict() as unknown as z.ZodType<SessionAuthContext>;

export interface OwnerResolutionInput {
  readonly current: SessionAuthContext | null;
  readonly initiator: SessionAuthContext | null;
  readonly channel: Readonly<{
    readonly kind?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }>;
}

export const ownerResolutionInputSchema = z
  .object({
    current: sessionAuthContextSchema.nullable(),
    initiator: sessionAuthContextSchema.nullable(),
    channel: z
      .object({
        kind: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).readonly().optional(),
      })
      .strict()
      .readonly(),
  })
  .strict() as unknown as z.ZodType<OwnerResolutionInput>;

export type ResolveOwner = (
  input: OwnerResolutionInput,
) => Promise<OwnerScope | null> | OwnerScope | null;

export type OwnerResolutionResult =
  | {
      readonly ok: true;
      readonly owner: OwnerScope;
      readonly principal: SessionAuthContext;
    }
  | {
      readonly ok: false;
      readonly error: Readonly<{
        readonly code:
          | "INVALID_OWNER_CONTEXT"
          | "OWNER_RESOLUTION_FAILED"
          | "USER_PRINCIPAL_REQUIRED";
        readonly message: string;
      }>;
    };

export const ownerResolutionResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      owner: ownerScopeSchema,
      principal: sessionAuthContextSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum([
            "INVALID_OWNER_CONTEXT",
            "OWNER_RESOLUTION_FAILED",
            "USER_PRINCIPAL_REQUIRED",
          ]),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]) as z.ZodType<OwnerResolutionResult>;

/**
 * Canonicalizes a private name alias without using the process locale.
 *
 * The rule is NFKC, Unicode White_Space collapse/trim, then JavaScript's
 * locale-independent Unicode lowercase mapping. This is deliberately not
 * full Unicode case folding (`ß` and `ss`, for example, stay distinct).
 */
export function canonicalizeAgentName(name: string): string {
  return name.normalize("NFKC").replace(/\p{White_Space}+/gu, " ").trim().toLowerCase();
}

export const savedAgentNameSchema = z.string().min(1).max(256).superRefine((value, ctx) => {
  const canonical = canonicalizeAgentName(value);
  if (canonical.length === 0) {
    ctx.addIssue({ code: "custom", message: "Name must contain a non-whitespace character" });
  } else if (canonical.length > 128) {
    ctx.addIssue({ code: "custom", message: "Canonical name must not exceed 128 characters" });
  }
});

export type SavedAgentKind = "agent" | "skill";
export type AgentLifecycle = "draft_only" | "active" | "archived" | "deleted";
export type RequirementLevel = "required" | "optional";

export const savedAgentKindSchema = z.enum(["agent", "skill"]);
export const agentLifecycleSchema = z.enum(["draft_only", "active", "archived", "deleted"]);
export const requirementLevelSchema = z.enum(["required", "optional"]);

export interface SavedToolRequirement {
  readonly capabilityId: CapabilityId;
  readonly level: RequirementLevel;
  readonly displayNameSnapshot: string;
  readonly schemaFingerprint: string;
  readonly consequential: boolean;
}

export const savedToolRequirementSchema: z.ZodType<SavedToolRequirement> = z
  .object({
    capabilityId: capabilityIdSchema,
    level: requirementLevelSchema,
    displayNameSnapshot: z.string().min(1).max(256),
    schemaFingerprint: z.string().min(1).max(512),
    consequential: z.boolean(),
  })
  .strict();

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const MAX_JSON_VALUE_DEPTH = 64;
export const MAX_JSON_VALUE_NODES = 10_000;

function isBoundedJsonValue(root: unknown): root is JsonValue {
  try {
    const seen = new WeakSet<object>();
    const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
      { value: root, depth: 0 },
    ];
    let nodes = 0;

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) return false;
      nodes += 1;
      if (nodes > MAX_JSON_VALUE_NODES || current.depth > MAX_JSON_VALUE_DEPTH) return false;

      const value = current.value;
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        continue;
      }
      if (typeof value !== "object" || seen.has(value)) return false;
      seen.add(value);

      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) return false;
        for (let index = value.length - 1; index >= 0; index -= 1) {
          if (!Object.hasOwn(value, index)) return false;
          pending.push({ value: value[index], depth: current.depth + 1 });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(value).length > 0) return false;
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable || !("value" in descriptor)) return false;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }

    return true;
  } catch {
    return false;
  }
}

const recursiveJsonValueSchema = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(recursiveJsonValueSchema),
    z.record(z.string(), recursiveJsonValueSchema),
  ]),
) as z.ZodType<JsonValue, JsonValue>;

const boundedJsonValueInputSchema = z.custom<JsonValue>(isBoundedJsonValue, {
  message: `JSON values may contain at most ${MAX_JSON_VALUE_NODES} nodes and depth ${MAX_JSON_VALUE_DEPTH}`,
});

export const jsonValueSchema = boundedJsonValueInputSchema.pipe(
  recursiveJsonValueSchema,
) as z.ZodType<JsonValue>;

export const jsonObjectSchema: z.ZodType<JsonObject> = z
  .custom<JsonObject>(
    (value) =>
      isBoundedJsonValue(value) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value),
    {
      message: `Expected a JSON object with at most ${MAX_JSON_VALUE_NODES} nodes and depth ${MAX_JSON_VALUE_DEPTH}`,
    },
  )
  .pipe(
    z.record(z.string(), recursiveJsonValueSchema) as z.ZodType<JsonObject, JsonObject>,
  ) as z.ZodType<JsonObject>;

export interface InvocationDestination {
  readonly channelKind: string;
  readonly address: string;
  readonly threadKey?: string;
}

export const invocationDestinationSchema = z
  .object({
    channelKind: z.string().min(1).max(128),
    address: z.string().min(1).max(2_048),
    threadKey: z.string().min(1).max(2_048).optional(),
  })
  .strict() as unknown as z.ZodType<InvocationDestination>;

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const ianaTimezoneSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isIanaTimezone, "Expected a supported IANA timezone");

export type SavedTriggerDefinition =
  | {
      readonly kind: "schedule";
      readonly triggerId: TriggerId;
      readonly displaySchedule: string;
      readonly timezone: string;
      readonly normalizedSchedule: JsonObject;
      readonly destination: InvocationDestination;
    }
  | {
      readonly kind: "event";
      readonly triggerId: TriggerId;
      readonly sourceId: string;
      readonly filter: JsonObject;
      readonly destination: InvocationDestination;
    };

const scheduleTriggerSchema = z
  .object({
    kind: z.literal("schedule"),
    triggerId: triggerIdSchema,
    displaySchedule: z.string().min(1).max(512),
    timezone: ianaTimezoneSchema,
    normalizedSchedule: jsonObjectSchema,
    destination: invocationDestinationSchema,
  })
  .strict();

const eventTriggerSchema = z
  .object({
    kind: z.literal("event"),
    triggerId: triggerIdSchema,
    sourceId: z.string().min(1).max(512),
    filter: jsonObjectSchema,
    destination: invocationDestinationSchema,
  })
  .strict();

export const savedTriggerDefinitionSchema: z.ZodType<SavedTriggerDefinition> =
  z.discriminatedUnion("kind", [scheduleTriggerSchema, eventTriggerSchema]);

export interface SavedAgentEditableFields {
  readonly name: string;
  readonly kind: SavedAgentKind;
  readonly description: string;
  readonly pmBrief: string;
  readonly instructions: string;
  readonly toolRequirements: readonly SavedToolRequirement[];
  readonly triggers: readonly SavedTriggerDefinition[];
  readonly testChecklist: readonly string[];
  readonly qaFindings: readonly string[];
}

function addUniqueIdIssues(
  value: Pick<SavedAgentEditableFields, "toolRequirements" | "triggers">,
  ctx: z.RefinementCtx,
): void {
  const capabilities = new Set<string>();
  value.toolRequirements.forEach((requirement, index) => {
    if (capabilities.has(requirement.capabilityId)) {
      ctx.addIssue({
        code: "custom",
        message: "Capability IDs must be unique",
        path: ["toolRequirements", index, "capabilityId"],
      });
    }
    capabilities.add(requirement.capabilityId);
  });

  const triggers = new Set<string>();
  value.triggers.forEach((trigger, index) => {
    if (triggers.has(trigger.triggerId)) {
      ctx.addIssue({
        code: "custom",
        message: "Trigger IDs must be unique",
        path: ["triggers", index, "triggerId"],
      });
    }
    triggers.add(trigger.triggerId);
  });
}

function addKindIssues(value: SavedAgentEditableFields, ctx: z.RefinementCtx): void {
  addUniqueIdIssues(value, ctx);
  if (value.kind === "skill" && value.toolRequirements.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "Saved skills cannot declare tool requirements",
      path: ["toolRequirements"],
    });
  }
  if (value.kind === "skill" && value.triggers.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "Saved skills cannot declare triggers",
      path: ["triggers"],
    });
  }
}

const editableFieldsObjectSchema = z
  .object({
    name: savedAgentNameSchema,
    kind: savedAgentKindSchema,
    description: z.string().max(8_000),
    pmBrief: z.string().max(32_000),
    instructions: z.string().max(128_000),
    toolRequirements: z.array(savedToolRequirementSchema).max(256).readonly(),
    triggers: z.array(savedTriggerDefinitionSchema).max(256).readonly(),
    testChecklist: z.array(z.string().min(1).max(4_000)).max(256).readonly(),
    qaFindings: z.array(z.string().min(1).max(8_000)).max(256).readonly(),
  })
  .strict();

export const savedAgentEditableFieldsSchema: z.ZodType<SavedAgentEditableFields> =
  editableFieldsObjectSchema.superRefine(addKindIssues);

export interface CreateSavedAgentDraftInput {
  readonly name: string;
  readonly kind: SavedAgentKind;
  readonly description?: string;
  readonly pmBrief?: string;
  readonly instructions?: string;
  readonly toolRequirements?: readonly SavedToolRequirement[];
  readonly triggers?: readonly SavedTriggerDefinition[];
  readonly testChecklist?: readonly string[];
  readonly qaFindings?: readonly string[];
}

export const createSavedAgentDraftInputSchema = z
  .object({
    name: savedAgentNameSchema,
    kind: savedAgentKindSchema,
    description: z.string().max(8_000).optional(),
    pmBrief: z.string().max(32_000).optional(),
    instructions: z.string().max(128_000).optional(),
    toolRequirements: z.array(savedToolRequirementSchema).max(256).readonly().optional(),
    triggers: z.array(savedTriggerDefinitionSchema).max(256).readonly().optional(),
    testChecklist: z
      .array(z.string().min(1).max(4_000))
      .max(256)
      .readonly()
      .optional(),
    qaFindings: z.array(z.string().min(1).max(8_000)).max(256).readonly().optional(),
  })
  .strict() as unknown as z.ZodType<CreateSavedAgentDraftInput>;

export type SavedAgentDraftPatch = Partial<SavedAgentEditableFields>;

export const savedAgentDraftPatchSchema = editableFieldsObjectSchema
  .partial()
  .strict()
  .superRefine((patch, ctx) => {
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "Patch fields must be omitted instead of set to undefined",
          path: [field],
        });
      }
    }
  }) as unknown as z.ZodType<SavedAgentDraftPatch>;

export interface SavedAgentDraft extends SavedAgentEditableFields {
  readonly draftId: DraftId;
  readonly basedOnSpecId?: SpecId;
  readonly basedOnVersion?: number;
  readonly draftRevision: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const savedAgentDraftSchema = z
  .object({
    draftId: draftIdSchema,
    basedOnSpecId: specIdSchema.optional(),
    basedOnVersion: positiveVersionSchema.optional(),
    ...editableFieldsObjectSchema.shape,
    draftRevision: positiveRevisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addKindIssues(value, ctx);
    if ((value.basedOnSpecId === undefined) !== (value.basedOnVersion === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "basedOnSpecId and basedOnVersion must be present or absent together",
      });
    }
  }) as unknown as z.ZodType<SavedAgentDraft>;

export interface PublishedAgentVersion
  extends Omit<SavedAgentEditableFields, "qaFindings"> {
  readonly specId: SpecId;
  readonly agentId: AgentId;
  readonly version: number;
  readonly publishedAt: Timestamp;
  readonly publishedBy: string;
}

export const publishedAgentVersionSchema: z.ZodType<PublishedAgentVersion> = z
  .object({
    specId: specIdSchema,
    agentId: agentIdSchema,
    version: positiveVersionSchema,
    name: savedAgentNameSchema,
    kind: savedAgentKindSchema,
    description: z.string().max(8_000),
    pmBrief: z.string().max(32_000),
    instructions: z.string().max(128_000),
    toolRequirements: z.array(savedToolRequirementSchema).max(256).readonly(),
    triggers: z.array(savedTriggerDefinitionSchema).max(256).readonly(),
    testChecklist: z.array(z.string().min(1).max(4_000)).max(256).readonly(),
    publishedAt: timestampSchema,
    publishedBy: z.string().min(1).max(1_024),
  })
  .strict()
  .superRefine((value, ctx) =>
    addKindIssues({ ...value, qaFindings: [] }, ctx),
  );

export interface SavedAgentFamily {
  readonly agentId: AgentId;
  readonly owner: OwnerScope;
  readonly lifecycle: AgentLifecycle;
  readonly activeSpecId?: SpecId;
  readonly activeVersion?: number;
  readonly draft?: SavedAgentDraft;
  readonly revision: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly archivedAt?: Timestamp;
  readonly deletedAt?: Timestamp;
}

export const savedAgentFamilySchema = z
  .object({
    agentId: agentIdSchema,
    owner: ownerScopeSchema,
    lifecycle: agentLifecycleSchema,
    activeSpecId: specIdSchema.optional(),
    activeVersion: positiveVersionSchema.optional(),
    draft: savedAgentDraftSchema.optional(),
    revision: positiveRevisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archivedAt: timestampSchema.optional(),
    deletedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasActiveSpec = value.activeSpecId !== undefined;
    const hasActiveVersion = value.activeVersion !== undefined;
    if (hasActiveSpec !== hasActiveVersion) {
      ctx.addIssue({
        code: "custom",
        message: "activeSpecId and activeVersion must be present or absent together",
      });
    }
    if (value.lifecycle === "draft_only" && (hasActiveSpec || value.draft === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "draft_only families require a draft and cannot have an active version",
      });
    }
    if (value.lifecycle === "active" && !hasActiveSpec) {
      ctx.addIssue({ code: "custom", message: "active families require an active version" });
    }
    if ((value.lifecycle === "archived") !== (value.archivedAt !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "archivedAt is present exactly while the family is archived",
      });
    }
    if ((value.lifecycle === "deleted") !== (value.deletedAt !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "deletedAt is present exactly while the family is deleted",
      });
    }
  }) as unknown as z.ZodType<SavedAgentFamily>;

export interface RevisionMetadata {
  readonly currentRevision: number;
  readonly currentDraftRevision?: number;
}

export const revisionMetadataSchema = z
  .object({
    currentRevision: positiveRevisionSchema,
    currentDraftRevision: positiveRevisionSchema.optional(),
  })
  .strict() as unknown as z.ZodType<RevisionMetadata>;

export interface TrustedMutationIdentity {
  readonly operationId: OperationId;
  /** Stable service-derived representation of the authorized request. */
  readonly requestFingerprint: string;
}

export const trustedMutationIdentitySchema: z.ZodType<TrustedMutationIdentity> = z
  .object({
    operationId: operationIdSchema,
    requestFingerprint: z.string().min(1).max(256_000),
  })
  .strict();
