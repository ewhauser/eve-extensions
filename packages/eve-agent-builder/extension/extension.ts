import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { RunnerCapabilityRegistry } from "./lib/capabilities.js";
import type {
  BootstrapClock,
  BootstrapIdFactory,
  BootstrapTokenSource,
} from "./lib/bootstrap.js";
import type { AgentBuilderServiceOptions } from "./lib/service.js";
import type { AgentBuilderStore } from "./lib/store.js";
import type { ResolveOwner } from "./lib/domain.js";

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    methods.every((method) => typeof (value as Record<string, unknown>)[method] === "function")
  );
}

const storeSchema = z.custom<AgentBuilderStore>(
  (value) =>
    hasMethods(value, [
      "getMutationReplay",
      "getFamily",
      "getVersion",
      "listVersions",
      "listActiveFamilies",
      "mutate",
      "createBootstrapGrant",
      "redeemBootstrapGrant",
      "getExecutionLease",
      "beginExecutionLease",
      "closeExecutionLease",
      "closeParentTurnExecutionLeases",
    ]),
  { message: "store must implement AgentBuilderStore" },
);

const registrySchema = z.custom<RunnerCapabilityRegistry>(
  (value) => hasMethods(value, ["list", "resolve"]),
  { message: "capabilities must implement RunnerCapabilityRegistry" },
);

const resolveOwnerSchema = z.custom<ResolveOwner>(
  (value) => typeof value === "function",
  { message: "resolveOwner must be a function" },
);

const clockSchema = z.custom<BootstrapClock & NonNullable<AgentBuilderServiceOptions["clock"]>>(
  (value) => hasMethods(value, ["now"]),
  { message: "clock must provide now()" },
);

const serviceIdsSchema = z.custom<NonNullable<AgentBuilderServiceOptions["ids"]>>(
  (value) => hasMethods(value, ["agentId", "draftId", "specId"]),
  { message: "serviceIds must provide agentId(), draftId(), and specId()" },
);

const bootstrapIdsSchema = z.custom<BootstrapIdFactory>(
  (value) => hasMethods(value, ["grantId", "leaseId"]),
  { message: "bootstrapIds must provide grantId() and leaseId()" },
);

const tokenSourceSchema = z.custom<BootstrapTokenSource>(
  (value) => hasMethods(value, ["bytes"]),
  { message: "tokenSource must provide bytes(length)" },
);

const config = z
  .object({
    store: storeSchema,
    resolveOwner: resolveOwnerSchema,
    capabilities: registrySchema,
    clock: clockSchema.optional(),
    serviceIds: serviceIdsSchema.optional(),
    bootstrapIds: bootstrapIdsSchema.optional(),
    tokenSource: tokenSourceSchema.optional(),
    maxAgentFamiliesPerOwner: z.number().int().positive().optional(),
    maxBootstrapGrantTtlMs: z.number().int().positive().max(5 * 60 * 1_000).optional(),
    executionLeaseTtlMs: z.number().int().positive().optional(),
    maxRosterEntries: z.number().int().positive().default(25),
    maxRosterCharacters: z.number().int().min(256).default(12_000),
  })
  .strict();

export type AgentBuilderExtensionConfig = z.output<typeof config>;

// Pin the package namespace so helpers loaded from separately compiled host
// mount modules observe the same configured object graph.
const extension = defineExtension({ config }, "eve-agent-builder");

export function getAgentBuilderConfig(): AgentBuilderExtensionConfig {
  return extension.config;
}

export default extension;
