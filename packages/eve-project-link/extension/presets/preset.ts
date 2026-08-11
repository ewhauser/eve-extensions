import { z } from "zod";

import type {
  ProjectOperation,
  ProjectOperationGuidance,
  ProjectPreset,
  ProjectPresetSystem,
  ProjectToolHints,
} from "../lib/types.js";

const identifier = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1);
const stringList = z.array(z.string().trim().min(1).max(4_000)).min(1).max(30);

export const projectToolHintsSchema = z
  .object({
    connectionNames: z.array(identifier).max(30).optional(),
    toolNames: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
    discoveryQueries: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  })
  .strict();

export const projectOperationGuidanceSchema = z
  .object({
    locate: stringList,
    create: stringList.optional(),
    retrieve: stringList,
    update: stringList.optional(),
  })
  .strict();

const projectPresetSystemSchema = z
  .object({
    kind: identifier,
    name: z.string().trim().min(1).max(200),
    description: text.max(2_000),
  })
  .strict();

const projectPresetTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: text.max(2_000).optional(),
    system: projectPresetSystemSchema,
    resourceLabel: z.string().trim().min(1).max(100),
    toolHints: projectToolHintsSchema.optional(),
    operations: projectOperationGuidanceSchema,
    metadata: z.record(z.string(), z.string().max(4_000)).optional(),
  })
  .strict();

export const projectPresetSchema = projectPresetTemplateSchema
  .extend({
    id: identifier,
    presetKey: z.string().trim().min(1).max(200),
  })
  .strict();

export type ProjectPresetTemplate = z.infer<typeof projectPresetTemplateSchema>;

export interface ProjectPresetDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly key: string;
  readonly parameters: TSchema;
  readonly resolve: (parameters: z.output<TSchema>) => ProjectPresetTemplate;
}

const emptyParameters = z.object({}).strict();

export interface ProjectGuidanceOverride {
  /** Replace the preset-specific guidance for this operation. */
  readonly replace?: readonly string[] | undefined;
  /** Add installation-specific guidance after the preset guidance. */
  readonly append?: readonly string[] | undefined;
}

export interface ProjectToolHintOverrides {
  /** Replace the preset's tool hints before additions are applied. */
  readonly replace?: ProjectToolHints | undefined;
  /** Add mounted connection names, exact tool names, or discovery queries. */
  readonly add?: ProjectToolHints | undefined;
}

export interface ConfigureProjectPresetOptions<TSchema extends z.ZodType> {
  readonly id: string;
  readonly parameters?: z.input<TSchema> | undefined;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly resourceLabel?: string | undefined;
  readonly tools?: ProjectToolHintOverrides | undefined;
  readonly guidance?:
    | Partial<Record<ProjectOperation, ProjectGuidanceOverride>>
    | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

function distinct(items: readonly string[]): readonly string[] {
  return [...new Set(items)];
}

function mergeToolHints(
  defaults: ProjectToolHints | undefined,
  overrides: ProjectToolHintOverrides | undefined,
): ProjectToolHints | undefined {
  const base = overrides?.replace ?? defaults;
  const addition = overrides?.add;
  if (!base && !addition) return undefined;

  const result: ProjectToolHints = {
    connectionNames: distinct([
      ...(base?.connectionNames ?? []),
      ...(addition?.connectionNames ?? []),
    ]),
    toolNames: distinct([
      ...(base?.toolNames ?? []),
      ...(addition?.toolNames ?? []),
    ]),
    discoveryQueries: distinct([
      ...(base?.discoveryQueries ?? []),
      ...(addition?.discoveryQueries ?? []),
    ]),
  };
  return result;
}

function operationGuidance(
  defaults: readonly string[] | undefined,
  override: ProjectGuidanceOverride | undefined,
): readonly string[] | undefined {
  const result = [
    ...(override?.replace ?? defaults ?? []),
    ...(override?.append ?? []),
  ];
  return result.length === 0 ? undefined : result;
}

function mergeOperations(
  defaults: ProjectOperationGuidance,
  overrides:
    | Partial<Record<ProjectOperation, ProjectGuidanceOverride>>
    | undefined,
): ProjectOperationGuidance {
  const locate = operationGuidance(defaults.locate, overrides?.locate);
  const retrieve = operationGuidance(defaults.retrieve, overrides?.retrieve);
  if (!locate || !retrieve) {
    throw new Error("Project presets must retain locate and retrieve guidance.");
  }
  const create = operationGuidance(defaults.create, overrides?.create);
  const update = operationGuidance(defaults.update, overrides?.update);
  return {
    locate,
    ...(create === undefined ? {} : { create }),
    retrieve,
    ...(update === undefined ? {} : { update }),
  };
}

/** Define a reusable, parameterized project shape without performing I/O. */
export function defineProjectPreset<TSchema extends z.ZodType>(
  definition: ProjectPresetDefinition<TSchema>,
): ProjectPresetDefinition<TSchema> {
  const key = z.string().trim().min(1).max(200).parse(definition.key);
  return { ...definition, key };
}

/** Define a reusable preset with no configurable parameters. */
export function defineStaticProjectPreset(
  input: ProjectPresetTemplate & { readonly key: string },
): ProjectPresetDefinition<typeof emptyParameters> {
  const { key, ...template } = input;
  return defineProjectPreset({
    key,
    parameters: emptyParameters,
    resolve: () => template as ProjectPresetTemplate,
  });
}

/** Resolve a preset definition into the plain data consumed by the extension. */
export function preset<TSchema extends z.ZodType>(
  definition: ProjectPresetDefinition<TSchema>,
  options: ConfigureProjectPresetOptions<TSchema>,
): ProjectPreset {
  const parameters = definition.parameters.parse(options.parameters ?? {});
  const template = projectPresetTemplateSchema.parse(
    definition.resolve(parameters),
  );
  const toolHints = mergeToolHints(template.toolHints, options.tools);
  const configured = {
    ...template,
    id: options.id,
    presetKey: definition.key,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.resourceLabel === undefined
      ? {}
      : { resourceLabel: options.resourceLabel }),
    operations: mergeOperations(template.operations, options.guidance),
    ...(toolHints === undefined ? {} : { toolHints }),
    metadata: { ...(template.metadata ?? {}), ...(options.metadata ?? {}) },
  };
  return projectPresetSchema.parse(configured) as ProjectPreset;
}

export type {
  ProjectOperationGuidance,
  ProjectPreset,
  ProjectPresetSystem,
  ProjectToolHints,
};
