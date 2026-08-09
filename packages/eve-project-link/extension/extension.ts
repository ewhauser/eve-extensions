import { defineExtension } from "eve/extension";
import type { DynamicResolveContext } from "eve/tools";
import { z } from "zod";

import type {
  ProjectChannel,
  ProjectChannelResolver,
  ProjectLinkLogger,
  ProjectLinkStore,
  ProjectProvider,
} from "./lib/types.js";

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

const provider = z.custom<ProjectProvider>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProjectProvider).kind === "string" &&
    hasMethod(value, "createProject") &&
    hasMethod(value, "readContext") &&
    hasMethod(value, "writeContext"),
  { message: "Each provider must implement ProjectProvider." },
);

const resolveChannel = z.custom<ProjectChannelResolver>(
  (value) => typeof value === "function",
  { message: "resolveChannel must be a function." },
);

const logger = z.custom<ProjectLinkLogger>(
  (value) => hasMethod(value, "warn") && hasMethod(value, "error"),
  { message: "logger must provide warn(message) and error(message)." },
);

const config = z
  .object({
    store,
    providers: z.array(provider).min(1),
    defaultProvider: z.string().trim().min(1).default("notion"),
    resolveChannel: resolveChannel.optional(),
    maxContextCharacters: z.number().int().min(1_000).max(30_000).default(6_000),
    provisioningTimeoutMs: z.number().int().min(1_000).default(120_000),
    approvals: z
      .object({
        link: z.boolean().default(true),
        saveContext: z.boolean().default(false),
        unlink: z.boolean().default(true),
      })
      .default({ link: true, saveContext: false, unlink: true }),
    logger: logger.optional(),
  })
  .superRefine((value, ctx) => {
    const kinds = new Set<string>();
    for (const item of value.providers) {
      if (kinds.has(item.kind)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate project provider kind: ${item.kind}`,
          path: ["providers"],
        });
      }
      kinds.add(item.kind);
    }
    if (!kinds.has(value.defaultProvider)) {
      ctx.addIssue({
        code: "custom",
        message: `defaultProvider ${value.defaultProvider} is not present in providers.`,
        path: ["defaultProvider"],
      });
    }
  });

export type ProjectLinkExtensionContext = DynamicResolveContext;
export type ResolvedProjectChannel = ProjectChannel;

export default defineExtension({ config });
