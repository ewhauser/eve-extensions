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
import type { VerifiedTestInputPolicy } from "./lib/test-policy.js";
import type { BuildWorkflowCoordinatorIdFactory } from "./lib/workflow-service.js";
import type { VerifiedPublishApprovalPolicy } from "./lib/workflow.js";

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
      "getBuildWorkflow",
      "mutate",
      "createBootstrapGrant",
      "redeemBootstrapGrant",
      "getExecutionLease",
      "beginExecutionLease",
      "closeExecutionLease",
      "closeParentTurnExecutionLeases",
      "authorizeTestInput",
      "beginTestCapabilityExecution",
      "completeTestCapabilityExecution",
      "listTestCapabilityExecutions",
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

const workflowIdsSchema = z.custom<BuildWorkflowCoordinatorIdFactory>(
  (value) =>
    hasMethods(value, ["agentId", "draftId", "specId", "workflowId", "testRunId"]),
  {
    message:
      "workflowIds must provide agentId(), draftId(), specId(), workflowId(), and testRunId()",
  },
);

const tokenSourceSchema = z.custom<BootstrapTokenSource>(
  (value) => hasMethods(value, ["bytes"]),
  { message: "tokenSource must provide bytes(length)" },
);

const verifiedTestInputPolicySchema = z.custom<VerifiedTestInputPolicy>(
  (value) => hasMethods(value, ["availability"]),
  { message: "verifiedTestInputPolicy must provide availability()" },
);

const verifiedPublishApprovalPolicySchema = z.custom<VerifiedPublishApprovalPolicy>(
  (value) => hasMethods(value, ["authorize"]),
  { message: "verifiedPublishApprovalPolicy must provide authorize()" },
);

const config = z
  .object({
    store: storeSchema,
    resolveOwner: resolveOwnerSchema,
    capabilities: registrySchema,
    clock: clockSchema.optional(),
    serviceIds: serviceIdsSchema.optional(),
    bootstrapIds: bootstrapIdsSchema.optional(),
    workflowIds: workflowIdsSchema.optional(),
    tokenSource: tokenSourceSchema.optional(),
    verifiedTestInputPolicy: verifiedTestInputPolicySchema.optional(),
    verifiedPublishApprovalPolicy: verifiedPublishApprovalPolicySchema.optional(),
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
