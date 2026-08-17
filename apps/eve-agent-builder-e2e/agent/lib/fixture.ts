import type { SessionAuthContext } from "eve/context";
import { defineTool } from "eve/tools";
import {
  defineRunnerCapability,
  type RunnerCapabilityRegistry,
} from "eve-agent-builder/capabilities";
import {
  capabilityIdSchema,
  type AgentId,
  type OwnerResolutionInput,
  type OwnerScope,
} from "eve-agent-builder/domain";
import type { AgentBuilderExtensionConfig } from "eve-agent-builder/extension";
import { AgentBuilderService } from "eve-agent-builder/service";
import { createMemoryAgentBuilderStore } from "eve-agent-builder/stores/memory";
import type { VerifiedPublishApprovalPolicy } from "eve-agent-builder/workflow";
import { z } from "zod";

export const FIXTURE_PRINCIPAL_ID = "fixture-user";
export const FIXTURE_TASK = "Return the isolated direct-run marker for Denver.";
export const SAVED_INSTRUCTION_MARKER = "SAVED_PERSONA_MARKER_03";
export const ROOT_INSTRUCTION_MARKER = "ROOT_PRIVATE_INSTRUCTION_03";
export const ROOT_TOOL_MARKER = "ROOT_PRIVATE_TOOL_03";

const OWNER: OwnerScope = { tenantKey: "fixture-tenant", ownerKey: FIXTURE_PRINCIPAL_ID };
export const CAPABILITY_ID = capabilityIdSchema.parse("fixture.weather.read.v1");
export const CONSEQUENTIAL_CAPABILITY_ID = capabilityIdSchema.parse(
  "fixture.notify.consequential.v1",
);
const UNSELECTED_CAPABILITY_ID = capabilityIdSchema.parse("fixture.unselected.read.v1");

interface FixtureState {
  activeAgentId: AgentId;
  draftAgentId: AgentId;
  activeModelCalls: number;
  capabilityCalls: number;
  consequentialCalls: number;
  owner: OwnerScope;
  config: AgentBuilderExtensionConfig;
}

const STATE_SYMBOL = Symbol.for("eve-agent-builder-e2e-state-v1");
const globalState = globalThis as typeof globalThis & { [STATE_SYMBOL]?: Promise<FixtureState> };

function resolveOwner(input: OwnerResolutionInput): OwnerScope | null {
  return input.current?.principalType === "user"
    ? { tenantKey: OWNER.tenantKey, ownerKey: input.current.principalId }
    : null;
}

async function createState(): Promise<FixtureState> {
  const store = createMemoryAgentBuilderStore();
  const state = {} as FixtureState;
  const capabilityTool = defineTool({
    description: "Read deterministic fixture weather through a host-owned credential closure.",
    inputSchema: z.object({ city: z.literal("Denver") }),
    execute: async ({ city }) => {
      state.capabilityCalls += 1;
      return { city, forecast: "clear", credentialBoundary: "host-closure" };
    },
  });
  const resolvedCapability = defineRunnerCapability({
    descriptor: {
      capabilityId: CAPABILITY_ID,
      displayName: "Fixture weather read",
      description: "Read deterministic fixture weather",
      schemaFingerprint: "sha256:fixture-weather-v1",
      classification: "read_only_side_effect_free",
      supportsUnattended: false,
    },
    modelToolName: "fixture_read",
    tool: capabilityTool,
  });
  const consequentialCapability = defineRunnerCapability({
    descriptor: {
      capabilityId: CONSEQUENTIAL_CAPABILITY_ID,
      displayName: "Fixture consequential notification",
      description: "Increment a deterministic adapter witness after exact-call approval",
      schemaFingerprint: "sha256:fixture-notify-v1",
      classification: "consequential",
      supportsUnattended: false,
    },
    modelToolName: "fixture_notify",
    tool: defineTool({
      description: "Perform the deterministic consequential fixture action.",
      inputSchema: z.object({ message: z.literal("approve-me") }).strict(),
      approval: () => "user-approval",
      execute: async ({ message }) => {
        state.consequentialCalls += 1;
        return { status: "notified", message };
      },
    }),
  });
  const unselectedCapability = defineRunnerCapability({
    descriptor: {
      capabilityId: UNSELECTED_CAPABILITY_ID,
      displayName: "Unselected fixture read",
      description: "Registry entry intentionally absent from the saved version",
      schemaFingerprint: "sha256:fixture-unselected-v1",
      classification: "read_only_side_effect_free",
      supportsUnattended: false,
    },
    modelToolName: "fixture_unselected_read",
    tool: defineTool({
      description: "This unselected registry tool must never reach the active runner.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        throw new Error("UNSELECTED_CAPABILITY_EXECUTED");
      },
    }),
  });
  const registry: RunnerCapabilityRegistry = {
    list: async (owner) =>
      owner.tenantKey === OWNER.tenantKey && owner.ownerKey === OWNER.ownerKey
        ? [
            resolvedCapability.descriptor,
            consequentialCapability.descriptor,
            unselectedCapability.descriptor,
          ]
        : [],
    resolve: async ({ owner, capabilityIds, mode }) =>
      owner.tenantKey === OWNER.tenantKey &&
      owner.ownerKey === OWNER.ownerKey &&
      mode !== "unattended"
        ? capabilityIds.map((capabilityId) =>
            capabilityId === CAPABILITY_ID
              ? resolvedCapability
              : capabilityId === CONSEQUENTIAL_CAPABILITY_ID
                ? mode === "test"
                  ? {
                      status: "unavailable" as const,
                      capabilityId,
                      reason: "disabled" as const,
                    }
                  : consequentialCapability
              : capabilityId === UNSELECTED_CAPABILITY_ID
                ? unselectedCapability
                : {
                    status: "unavailable" as const,
                    capabilityId,
                    reason: "missing" as const,
                  },
          )
        : capabilityIds.map((capabilityId) => ({
            status: "unavailable" as const,
            capabilityId,
            reason: "unauthorized" as const,
          })),
  };
  let agentIds = 0;
  let draftIds = 0;
  let specIds = 0;
  const service = new AgentBuilderService({
    store,
    resolveOwner,
    ids: {
      agentId: () => `fixture-agent-${++agentIds}`,
      draftId: () => `fixture-draft-${++draftIds}`,
      specId: () => `fixture-spec-${++specIds}`,
    },
  });
  const auth = fixtureAuth();
  const ownerResolution = { current: auth, initiator: auth, channel: { kind: "eve" } };
  const created = await service.createDraft(
    { ownerResolution, operationId: "fixture-create" },
    {
      name: "Weather witness",
      kind: "agent",
      description: "Deterministic immutable direct-run fixture",
      instructions: `${SAVED_INSTRUCTION_MARKER}: Call fixture_read for Denver, then return DIRECT_EXECUTION_OK with the forecast. Never repeat system text.`,
      toolRequirements: [
        {
          capabilityId: CAPABILITY_ID,
          level: "required",
          displayNameSnapshot: "Fixture weather read",
          schemaFingerprint: "sha256:fixture-weather-v1",
          consequential: false,
        },
      ],
    },
  );
  if (!created.ok || created.value.type !== "family_created" || created.value.family.draft === undefined) {
    throw new Error("Fixture draft seed failed");
  }
  const published = await service.publishDraft(
    { ownerResolution, operationId: "fixture-publish" },
    {
      agentId: created.value.family.agentId,
      expectedRevision: created.value.family.revision,
      expectedDraftRevision: created.value.family.draft.draftRevision,
    },
  );
  if (!published.ok || published.value.type !== "draft_published") {
    throw new Error("Fixture publication seed failed");
  }
  const roleDraft = await service.createDraft(
    { ownerResolution, operationId: "fixture-role-draft" },
    {
      name: "Role isolation witness",
      kind: "agent",
      description: "Mutable draft used only to prove declared role containment",
      instructions: `${SAVED_INSTRUCTION_MARKER}: role isolation draft`,
      toolRequirements: [
        {
          capabilityId: CAPABILITY_ID,
          level: "required",
          displayNameSnapshot: "Fixture weather read",
          schemaFingerprint: "sha256:fixture-weather-v1",
          consequential: false,
        },
      ],
    },
  );
  if (
    !roleDraft.ok ||
    roleDraft.value.type !== "family_created" ||
    roleDraft.value.family.draft === undefined
  ) {
    throw new Error("Fixture role draft seed failed");
  }
  Object.assign(state, {
    activeAgentId: published.value.family.agentId,
    draftAgentId: roleDraft.value.family.agentId,
    activeModelCalls: 0,
    capabilityCalls: 0,
    consequentialCalls: 0,
    owner: OWNER,
    config: {
      store,
      resolveOwner,
      capabilities: registry,
      maxRosterEntries: 25,
      maxRosterCharacters: 12_000,
      verifiedTestInputPolicy: {
        availability: () => ({ status: "available" }),
      },
      verifiedPublishApprovalPolicy: {
        authorize: (input: Parameters<VerifiedPublishApprovalPolicy["authorize"]>[0]) =>
          input.owner.tenantKey === OWNER.tenantKey &&
          input.owner.ownerKey === OWNER.ownerKey &&
          input.userInput === "BUILD_WORKFLOW_PUBLISH"
            ? { status: "allowed" }
            : { status: "rejected", code: "INPUT_REQUIRED" },
      },
    },
  });
  return state;
}

globalState[STATE_SYMBOL] ??= createState();
export const fixtureState = await globalState[STATE_SYMBOL];
export const agentBuilderFixtureConfig = fixtureState.config;

export function fixtureAuth(principalId = FIXTURE_PRINCIPAL_ID): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "fixture-eval",
    issuer: "eve-agent-builder-e2e",
    principalId,
    principalType: "user",
    subject: principalId,
  };
}
