import { defineExtension } from "eve/extension";
import type { DynamicResolveContext } from "eve/tools";
import { z } from "zod";

import type {
  ProjectChannel,
  ProjectChannelResolver,
  ProjectLinkStore,
  ProjectPreset,
} from "./lib/types.js";
import { projectPresetSchema } from "./presets/preset.js";

function hasMethod(value: unknown, name: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === "function"
  );
}

const store = z.custom<ProjectLinkStore>(
  (value) =>
    hasMethod(value, "get") &&
    hasMethod(value, "create") &&
    hasMethod(value, "replace") &&
    hasMethod(value, "delete"),
  { message: "store must implement ProjectLinkStore." },
);

const resolveChannel = z.custom<ProjectChannelResolver>(
  (value) => typeof value === "function",
  { message: "resolveChannel must be a function." },
);

const configuredPreset = z.custom<ProjectPreset>(
  (value) => projectPresetSchema.safeParse(value).success,
  { message: "preset must be a configured ProjectPreset." },
);

const config = z
  .object({
    store,
    presets: z.array(configuredPreset).min(1),
    defaultPreset: z.string().trim().min(1).max(100).optional(),
    resolveChannel: resolveChannel.optional(),
    maxPromptCharacters: z.number().int().min(1_000).max(30_000).default(7_000),
    approvals: z
      .object({
        link: z.boolean().default(true),
        saveContext: z.boolean().default(false),
        unlink: z.boolean().default(true),
      })
      .default({ link: true, saveContext: false, unlink: true }),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const preset of value.presets) {
      if (ids.has(preset.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate configured project preset id: ${preset.id}`,
          path: ["presets"],
        });
      }
      ids.add(preset.id);
    }
    if (value.defaultPreset && !ids.has(value.defaultPreset)) {
      ctx.addIssue({
        code: "custom",
        message: `Default project preset ${value.defaultPreset} is not configured.`,
        path: ["defaultPreset"],
      });
    }
  });

export type ProjectLinkConfig = z.output<typeof config>;

const PROJECT_LINK_CONFIG = Symbol.for("eve-project-link.installation-config");

function installedConfig(): ProjectLinkConfig | undefined {
  return (
    globalThis as typeof globalThis & {
      [PROJECT_LINK_CONFIG]?: ProjectLinkConfig;
    }
  )[PROJECT_LINK_CONFIG];
}

function installConfig(value: ProjectLinkConfig): void {
  (
    globalThis as typeof globalThis & {
      [PROJECT_LINK_CONFIG]?: ProjectLinkConfig;
    }
  )[PROJECT_LINK_CONFIG] = value;
}

const extension = defineExtension({ config });

/**
 * Read the installed configuration even when Eve loads an extension-owned
 * dynamic module outside the configured mount module's instance graph.
 */
export function getProjectLinkConfig(): ProjectLinkConfig {
  return installedConfig() ?? extension.config;
}

const projectLink = ((values: z.input<typeof config>) => {
  const parsed = config.parse(values);
  const mounted = extension(values);
  installConfig(parsed);
  return mounted;
}) as typeof extension;

Object.defineProperties(projectLink, {
  config: { enumerable: true, get: getProjectLinkConfig },
  schema: { enumerable: true, value: extension.schema },
});

export type ProjectLinkExtensionContext = DynamicResolveContext;
export type ResolvedProjectChannel = ProjectChannel;

export default projectLink;
