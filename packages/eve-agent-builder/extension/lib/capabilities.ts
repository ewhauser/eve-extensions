import type {
  Approval,
  DynamicToolEntry,
  DynamicToolSet,
  ToolContext,
  ToolDefinition,
} from "eve/tools";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  capabilityIdSchema,
  ownerScopeSchema,
  savedToolRequirementSchema,
  type CapabilityId,
  type OwnerScope,
  type SavedToolRequirement,
} from "./domain.js";
import type {
  CapabilityUnavailableReason,
  ExecutionCapabilityPlan,
} from "./bootstrap.js";

export type RunnerCapabilityClassification =
  | "read_only_side_effect_free"
  | "consequential"
  | "unknown";
export type RunnerCapabilityMode = "test" | "direct" | "unattended";

export interface RunnerCapabilityDescriptor {
  readonly capabilityId: CapabilityId;
  readonly displayName: string;
  readonly description: string;
  readonly schemaFingerprint: string;
  readonly classification: RunnerCapabilityClassification;
  readonly supportsUnattended: boolean;
}

export const runnerCapabilityDescriptorSchema: z.ZodType<RunnerCapabilityDescriptor> = z
  .object({
    capabilityId: capabilityIdSchema,
    displayName: z.string().min(1).max(256),
    description: z.string().min(1).max(8_000),
    schemaFingerprint: z.string().min(1).max(512),
    classification: z.enum([
      "read_only_side_effect_free",
      "consequential",
      "unknown",
    ]),
    supportsUnattended: z.boolean(),
  })
  .strict();

export interface ResolvedRunnerCapability {
  readonly status: "resolved";
  readonly descriptor: RunnerCapabilityDescriptor;
  /** Host-selected runtime name of the real tool. It is not the stable capability ID. */
  readonly modelToolName: string;
  /** Real host adapter, branded through Eve's public `defineTool` API. */
  readonly tool: RunnerToolAdapter;
  /** Prior fingerprints the host explicitly declares compatible with the current schema. */
  readonly compatibleSchemaFingerprints?: readonly string[];
}

export interface UnavailableRunnerCapability {
  readonly status: "unavailable";
  readonly capabilityId: CapabilityId;
  readonly reason: CapabilityUnavailableReason;
}

export type RunnerCapabilityResolution =
  | ResolvedRunnerCapability
  | UnavailableRunnerCapability;

export interface RunnerCapabilityRegistry {
  list(owner: OwnerScope): Promise<readonly RunnerCapabilityDescriptor[]>;
  resolve(input: {
    readonly owner: OwnerScope;
    readonly capabilityIds: readonly CapabilityId[];
    readonly mode: RunnerCapabilityMode;
  }): Promise<readonly RunnerCapabilityResolution[]>;
}

export interface DefineRunnerCapabilityInput {
  readonly descriptor: RunnerCapabilityDescriptor;
  readonly modelToolName: string;
  readonly tool: RunnerToolAdapter;
  readonly compatibleSchemaFingerprints?: readonly string[];
}

/**
 * Existential public view of a real Eve tool. The concrete schema/input/output
 * types remain on the host's value; the registry never invokes or rewrites it.
 */
export interface RunnerToolAdapter {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly approval?: unknown;
  readonly toModelOutput?: unknown;
  readonly execute: (...args: any[]) => unknown;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, seen, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return false;
  }
  return Object.values(value).every((entry) => isJsonValue(entry, seen, depth + 1));
}

function assertSerializableSchema(source: unknown, direction: "input" | "output"): void {
  if (source === undefined && direction === "output") return;
  if (typeof source !== "object" || source === null) {
    throw new TypeError(`Runner tool ${direction}Schema must be a JSON Schema or Standard Schema`);
  }
  const standard = (source as Record<string, unknown>)["~standard"];
  let emitted: unknown = source;
  if (typeof standard === "object" && standard !== null) {
    const jsonSchema = (standard as Record<string, unknown>).jsonSchema;
    const converter =
      typeof jsonSchema === "object" && jsonSchema !== null
        ? (jsonSchema as Record<string, unknown>)[direction]
        : undefined;
    if (typeof converter !== "function") {
      throw new TypeError(`Runner tool ${direction}Schema cannot emit JSON Schema`);
    }
    emitted = converter({ target: "draft-07" });
  }
  if (
    typeof emitted !== "object" ||
    emitted === null ||
    Array.isArray(emitted) ||
    !isJsonValue(emitted)
  ) {
    throw new TypeError(`Runner tool ${direction}Schema emitted invalid JSON Schema data`);
  }
}

function assertRunnerToolAdapter(tool: RunnerToolAdapter): void {
  if (
    typeof tool.description !== "string" ||
    tool.description.length === 0 ||
    typeof tool.execute !== "function"
  ) {
    throw new TypeError("Runner capability tool is not a valid Eve tool adapter");
  }
  assertSerializableSchema(tool.inputSchema, "input");
  assertSerializableSchema(tool.outputSchema, "output");
}

/**
 * Brands and freezes one host adapter without changing its schema, execute
 * closure, approval gate, credential access, or result projection.
 */
export function defineRunnerCapability<const TTool extends RunnerToolAdapter>(
  input: Omit<DefineRunnerCapabilityInput, "tool"> & { readonly tool: TTool },
): ResolvedRunnerCapability & { readonly tool: TTool } {
  const descriptor = Object.freeze(
    runnerCapabilityDescriptorSchema.parse(input.descriptor),
  );
  validateModelToolName(input.modelToolName, descriptor.capabilityId);
  assertRunnerToolAdapter(input.tool);
  const compatible = input.compatibleSchemaFingerprints?.map((value) => {
    if (value.length < 1 || value.length > 512) {
      throw new TypeError("Compatible schema fingerprints must contain 1-512 characters");
    }
    return value;
  });
  const resolution: ResolvedRunnerCapability & { readonly tool: TTool } = {
    status: "resolved",
    descriptor,
    modelToolName: input.modelToolName,
    tool: defineTool(input.tool as ToolDefinition<any, any>) as TTool,
    ...(compatible === undefined
      ? {}
      : { compatibleSchemaFingerprints: Object.freeze(compatible) }),
  };
  Object.defineProperty(resolution, Symbol.for("eve-agent-builder:runner-capability"), {
    value: true,
  });
  return Object.freeze(resolution);
}

export interface CapabilityPreparation {
  readonly plan: ExecutionCapabilityPlan;
  readonly resolved: readonly ResolvedRunnerCapability[];
  readonly optionalOmissionNote?: string;
  readonly disclosureRequired: boolean;
}

export type CapabilityPreparationError = Readonly<{
  readonly code:
    | "REQUIRED_CAPABILITY_UNAVAILABLE"
    | "CAPABILITY_REGISTRY_CONTRACT_VIOLATION";
  readonly message: string;
  readonly capabilityId?: CapabilityId;
  readonly displayNameSnapshot?: string;
  readonly reason?: CapabilityUnavailableReason;
}>;

export type CapabilityPreparationResult =
  | { readonly ok: true; readonly value: CapabilityPreparation }
  | { readonly ok: false; readonly error: CapabilityPreparationError };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateModelToolName(modelToolName: string, capabilityId: string): void {
  if (
    !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u.test(modelToolName) ||
    modelToolName.startsWith("agent_builder__")
  ) {
    throw new TypeError("modelToolName is invalid or reserved by eve-agent-builder");
  }
  if (modelToolName === capabilityId) {
    throw new TypeError("modelToolName must not reuse the stable capabilityId");
  }
}

function effectiveConsequential(
  descriptor: RunnerCapabilityDescriptor,
  requirement: SavedToolRequirement,
): boolean {
  return (
    requirement.consequential ||
    descriptor.classification !== "read_only_side_effect_free"
  );
}

function unavailable(
  requirement: SavedToolRequirement,
  reason: CapabilityUnavailableReason,
): CapabilityPreparationResult {
  return requirement.level === "required"
    ? {
        ok: false,
        error: {
          code: "REQUIRED_CAPABILITY_UNAVAILABLE",
          message: `Required capability ${requirement.displayNameSnapshot} is ${reason}`,
          capabilityId: requirement.capabilityId,
          displayNameSnapshot: requirement.displayNameSnapshot,
          reason,
        },
      }
    : {
        ok: true,
        value: {
          plan: {
            mode: "direct",
            selected: [],
            optionalOmissions: [
              {
                capabilityId: requirement.capabilityId,
                displayNameSnapshot: requirement.displayNameSnapshot,
                reason,
              },
            ],
          },
          resolved: [],
          optionalOmissionNote: "",
          disclosureRequired: true,
        },
      };
}

export class RunnerCapabilityService {
  readonly #registry: RunnerCapabilityRegistry;

  constructor(registry: RunnerCapabilityRegistry) {
    this.#registry = registry;
  }

  async list(owner: OwnerScope): Promise<readonly RunnerCapabilityDescriptor[]> {
    const parsedOwner = ownerScopeSchema.parse(owner);
    const raw = await this.#registry.list(parsedOwner);
    const seen = new Set<string>();
    const descriptors = raw.map((descriptor) => {
      const parsed = runnerCapabilityDescriptorSchema.parse(descriptor);
      if (seen.has(parsed.capabilityId)) {
        throw new TypeError(`Duplicate capabilityId from registry: ${parsed.capabilityId}`);
      }
      seen.add(parsed.capabilityId);
      return Object.freeze(parsed);
    });
    return Object.freeze(
      descriptors.sort(
        (left, right) =>
          compareText(left.displayName, right.displayName) ||
          compareText(left.capabilityId, right.capabilityId),
      ),
    );
  }

  async prepare(input: {
    readonly owner: OwnerScope;
    readonly requirements: readonly SavedToolRequirement[];
    readonly mode: RunnerCapabilityMode;
  }): Promise<CapabilityPreparationResult> {
    const owner = ownerScopeSchema.safeParse(input.owner);
    const requirements = z.array(savedToolRequirementSchema).max(256).readonly().safeParse(
      input.requirements,
    );
    const mode = z.enum(["test", "direct", "unattended"]).safeParse(input.mode);
    if (!owner.success || !requirements.success || !mode.success) {
      return {
        ok: false,
        error: {
          code: "CAPABILITY_REGISTRY_CONTRACT_VIOLATION",
          message: "Capability preparation input is invalid",
        },
      };
    }
    const ids = requirements.data.map((requirement) => requirement.capabilityId);
    let raw: readonly RunnerCapabilityResolution[];
    try {
      raw = await this.#registry.resolve({
        owner: owner.data,
        capabilityIds: ids,
        mode: mode.data,
      });
    } catch {
      return {
        ok: false,
        error: {
          code: "CAPABILITY_REGISTRY_CONTRACT_VIOLATION",
          message: "Capability registry resolution failed",
        },
      };
    }

    const requested = new Set(ids);
    const byId = new Map<string, RunnerCapabilityResolution>();
    try {
      for (const resolution of raw) {
        const capabilityId =
          resolution.status === "resolved"
            ? resolution.descriptor.capabilityId
            : resolution.capabilityId;
        if (!requested.has(capabilityId) || byId.has(capabilityId)) {
          throw new TypeError("Registry returned an unrequested or duplicate capability");
        }
        if (resolution.status === "resolved") {
          runnerCapabilityDescriptorSchema.parse(resolution.descriptor);
          validateModelToolName(resolution.modelToolName, capabilityId);
          if (
            (resolution as unknown as Record<symbol, unknown>)[
              Symbol.for("eve-agent-builder:runner-capability")
            ] !== true ||
            (resolution.tool as unknown as Record<symbol, unknown>)[
              Symbol.for("eve:tool-brand")
            ] !== true
          ) {
            throw new TypeError(
              "Resolved capability must be created with defineRunnerCapability and defineTool",
            );
          }
          assertRunnerToolAdapter(resolution.tool);
          if (
            mode.data === "unattended" &&
            resolution.descriptor.supportsUnattended !== true
          ) {
            byId.set(capabilityId, {
              status: "unavailable",
              capabilityId,
              reason: "disabled",
            });
            continue;
          }
        } else if (
          !["missing", "unauthorized", "disabled", "incompatible"].includes(
            resolution.reason,
          )
        ) {
          throw new TypeError("Registry returned an invalid unavailability reason");
        }
        byId.set(capabilityId, resolution);
      }
    } catch {
      return {
        ok: false,
        error: {
          code: "CAPABILITY_REGISTRY_CONTRACT_VIOLATION",
          message: "Capability registry returned an invalid resolution set",
        },
      };
    }

    const selected: ResolvedRunnerCapability[] = [];
    const planSelected: ExecutionCapabilityPlan["selected"][number][] = [];
    const optionalOmissions: ExecutionCapabilityPlan["optionalOmissions"][number][] = [];
    const modelNames = new Set<string>();
    for (const requirement of requirements.data) {
      const resolution = byId.get(requirement.capabilityId);
      let reason: CapabilityUnavailableReason | null = null;
      if (resolution === undefined) {
        reason = "missing";
      } else if (resolution.status === "unavailable") {
        reason = resolution.reason;
      } else {
        const compatible =
          resolution.descriptor.schemaFingerprint === requirement.schemaFingerprint ||
          resolution.compatibleSchemaFingerprints?.includes(requirement.schemaFingerprint) ===
            true;
        if (!compatible) reason = "incompatible";
      }
      if (reason !== null) {
        const outcome = unavailable(requirement, reason);
        if (!outcome.ok) return outcome;
        optionalOmissions.push({
          capabilityId: requirement.capabilityId,
          displayNameSnapshot: requirement.displayNameSnapshot,
          reason,
        });
        continue;
      }
      if (resolution === undefined || resolution.status !== "resolved") {
        throw new Error("Unreachable capability resolution state");
      }
      if (modelNames.has(resolution.modelToolName)) {
        return {
          ok: false,
          error: {
            code: "CAPABILITY_REGISTRY_CONTRACT_VIOLATION",
            message: "Selected capabilities resolve to a duplicate model tool name",
          },
        };
      }
      modelNames.add(resolution.modelToolName);
      selected.push(resolution);
      planSelected.push({
        capabilityId: resolution.descriptor.capabilityId,
        modelToolName: resolution.modelToolName,
        schemaFingerprint: resolution.descriptor.schemaFingerprint,
        consequential: effectiveConsequential(resolution.descriptor, requirement),
      });
    }

    const optionalOmissionNote =
      optionalOmissions.length === 0
        ? undefined
        : [
            "Optional capabilities unavailable for this run:",
            ...optionalOmissions.map(
              (entry) =>
                `- ${entry.displayNameSnapshot} (${entry.capabilityId}): ${entry.reason}`,
            ),
            "Do not substitute an unselected tool. Disclose any material effect in the final result.",
          ].join("\n");
    return {
      ok: true,
      value: {
        plan: {
          mode: mode.data,
          selected: Object.freeze(planSelected),
          optionalOmissions: Object.freeze(optionalOmissions),
        },
        resolved: Object.freeze(selected),
        ...(optionalOmissionNote === undefined ? {} : { optionalOmissionNote }),
        disclosureRequired: optionalOmissions.length > 0,
      },
    };
  }
}

export function lowerResolvedCapabilities(
  capabilities: readonly ResolvedRunnerCapability[],
  assertExecutionAllowed: (
    capability: ResolvedRunnerCapability,
    ctx: ToolContext,
    toolInput: unknown,
  ) => Promise<
    | void
    | Readonly<{
        complete(status: "succeeded" | "failed", errorCode?: string): Promise<void>;
      }>
  >,
  approvalFor?: (
    capability: ResolvedRunnerCapability,
    hostApproval: Approval<unknown> | undefined,
  ) => Approval<unknown> | undefined,
): DynamicToolSet {
  const lowered: Record<string, DynamicToolEntry<any, any>> = {};
  for (const capability of capabilities) {
    validateModelToolName(
      capability.modelToolName,
      capability.descriptor.capabilityId,
    );
    if (Object.hasOwn(lowered, capability.modelToolName)) {
      throw new TypeError(`Duplicate lowered tool name: ${capability.modelToolName}`);
    }
    const tool = capability.tool;
    const approval = approvalFor?.(
      capability,
      tool.approval as Approval<unknown> | undefined,
    ) ?? tool.approval;
    lowered[capability.modelToolName] = defineTool({
      description: tool.description,
      inputSchema: tool.inputSchema as ToolDefinition<any, any>["inputSchema"],
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: tool.outputSchema as ToolDefinition<any, any>["outputSchema"] }),
      ...(approval === undefined
        ? {}
        : { approval: approval as ToolDefinition<any, any>["approval"] }),
      ...(tool.toModelOutput === undefined
        ? {}
        : { toModelOutput: tool.toModelOutput as ToolDefinition<any, any>["toModelOutput"] }),
      execute: async (toolInput, ctx) => {
        const permit = await assertExecutionAllowed(capability, ctx, toolInput);
        try {
          const result = await tool.execute.call(tool, toolInput, ctx);
          await permit?.complete("succeeded");
          return result;
        } catch (error) {
          await permit?.complete(
            "failed",
            error instanceof Error && error.name.length > 0 ? error.name : "CAPABILITY_EXECUTION_FAILED",
          );
          throw error;
        }
      },
    } as ToolDefinition<any, any>) as DynamicToolEntry<any, any>;
  }
  return Object.freeze(lowered);
}

export function createRunnerCapabilityService(
  registry: RunnerCapabilityRegistry,
): RunnerCapabilityService {
  return new RunnerCapabilityService(registry);
}
