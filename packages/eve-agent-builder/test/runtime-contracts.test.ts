import type { SessionAuthContext } from "eve/context";
import {
  defineTool,
  type ApprovalContext,
  type ApprovalResponseContext,
} from "eve/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RunnerCapabilityService,
  defineRunnerCapability,
  lowerResolvedCapabilities,
  type RunnerCapabilityRegistry,
  type RunnerCapabilityResolution,
} from "../src/capabilities.js";
import {
  BootstrapService,
  formatBootstrapMessage,
  parseBootstrapMessage,
  type ExecutionLeaseRecord,
} from "../src/bootstrap.js";
import { AgentDiscoveryService } from "../src/discovery.js";
import {
  agentIdSchema,
  canonicalizeAgentName,
  capabilityIdSchema,
  draftIdSchema,
  operationIdSchema,
  specIdSchema,
  timestampSchema,
  type OwnerResolutionInput,
  type OwnerScope,
  type SavedAgentEditableFields,
  type SavedToolRequirement,
} from "../src/domain.js";
import {
  agentBuilderRoleOperations,
  createRoleScopedAgentBuilderService,
  roleMayPerform,
  rolePermissionMatrix,
} from "../src/roles.js";
import { AgentBuilderService } from "../src/service.js";
import type { AgentBuilderStore } from "../src/store.js";
import {
  createOwnerApproval,
  ownerChannelFromContext,
} from "../extension/lib/runtime/owner.js";
import { scopedToolOperationId } from "../extension/lib/runtime/service.js";
import {
  composeConsequentialTestApproval,
  type TestCapabilityStepScope,
  type TestInputGrantRecord,
  type TestInputUnavailableCode,
} from "../src/test-policy.js";
import { createMemoryAgentBuilderStore } from "../stores/memory.js";

const OWNER_A: OwnerScope = { tenantKey: "tenant", ownerKey: "owner-a" };
const OWNER_B: OwnerScope = { tenantKey: "tenant", ownerKey: "owner-b" };

function principal(id: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "test",
    principalId: id,
    principalType: "user",
  };
}

function ownerInput(id = "owner-a"): OwnerResolutionInput {
  const current = principal(id);
  return { current, initiator: current, channel: { kind: "test" } };
}

describe("owner-scoped runtime authorization", () => {
  it("preserves channel scope and rejects approval responders from another owner", async () => {
    const channel = ownerChannelFromContext({
      kind: "slack",
      metadata: { teamId: "team-a", channelId: "channel-a" },
    });
    const seen: OwnerResolutionInput[] = [];
    const approval = createOwnerApproval({
      owner: OWNER_A,
      channel,
      resolveOwner: async (input) => {
        seen.push(input);
        if (input.current === null) {
          return {
            ok: false,
            error: { code: "USER_PRINCIPAL_REQUIRED", message: "Current user required" },
          };
        }
        return {
          ok: true,
          owner: input.current.principalId === "owner-a" ? OWNER_A : OWNER_B,
          principal: input.current,
        };
      },
    });
    const responseContext = (responder: SessionAuthContext) =>
      ({
        responder,
        session: { initiator: principal("owner-a") },
      }) as ApprovalResponseContext<unknown>;

    expect(await approval.request({} as ApprovalContext<unknown>)).toBe("user-approval");
    expect(await approval.response?.(responseContext(principal("owner-b")))).toEqual({
      status: "rejected",
      reason: "OWNER_MISMATCH",
    });
    expect(await approval.response?.(responseContext(principal("owner-a")))).toEqual({
      status: "allowed",
    });
    expect(seen.map((input) => input.channel)).toEqual([channel, channel]);
  });
});

function fields(
  name: string,
  kind: "agent" | "skill" = "agent",
  toolRequirements: readonly SavedToolRequirement[] = [],
): SavedAgentEditableFields {
  return {
    name,
    kind,
    description: `Description for ${name}`,
    pmBrief: "brief",
    instructions: `SAVED:${name}`,
    toolRequirements,
    triggers: [],
    testChecklist: [],
    qaFindings: [],
  };
}

async function addActive(
  store: AgentBuilderStore,
  input: {
    owner: OwnerScope;
    id: string;
    name: string;
    kind?: "agent" | "skill";
    description?: string;
    second: number;
  },
) {
  const editable = {
    ...fields(input.name, input.kind),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
  const agentId = agentIdSchema.parse(input.id);
  const draftId = draftIdSchema.parse(`draft-${input.id}`);
  const specId = specIdSchema.parse(`spec-${input.id}`);
  const at = (offset: number) =>
    timestampSchema.parse(
      new Date(Date.UTC(2026, 0, 1) + (input.second + offset) * 1_000).toISOString(),
    );
  const created = await store.mutate({
    type: "create_family",
    owner: input.owner,
    mutation: {
      operationId: operationIdSchema.parse(`create-${input.id}`),
      requestFingerprint: `create-${input.id}`,
    },
    occurredAt: at(0),
    agentId,
    draftId,
    maxFamilies: 100,
    canonicalName: canonicalizeAgentName(input.name),
    fields: editable,
  });
  if (!created.ok || created.type !== "family_created" || created.family.draft === undefined) {
    throw new Error("seed create failed");
  }
  const published = await store.mutate({
    type: "publish_draft",
    owner: input.owner,
    mutation: {
      operationId: operationIdSchema.parse(`publish-${input.id}`),
      requestFingerprint: `publish-${input.id}`,
    },
    occurredAt: at(1),
    agentId,
    expectedRevision: created.family.revision,
    expectedDraftRevision: created.family.draft.draftRevision,
    specId,
    publishedBy: "principal",
  });
  if (!published.ok || published.type !== "draft_published") throw new Error("seed publish failed");
  const activated = await store.mutate({
    type: "activate_version",
    owner: input.owner,
    mutation: {
      operationId: operationIdSchema.parse(`activate-${input.id}`),
      requestFingerprint: `activate-${input.id}`,
    },
    occurredAt: at(2),
    agentId,
    expectedRevision: published.family.revision,
    specId,
    version: 1,
  });
  if (!activated.ok || activated.type !== "version_activated") throw new Error("seed activate failed");
  return activated;
}

describe("stable runner capability registry", () => {
  const capabilityId = capabilityIdSchema.parse("capability.weather.read.v1");
  const requirement: SavedToolRequirement = {
    capabilityId,
    level: "required",
    displayNameSnapshot: "Weather read",
    schemaFingerprint: "sha256:weather-v1",
    consequential: false,
  };
  const approval = () => "user-approval" as const;
  const realTool = defineTool({
    description: "Read weather with host credentials",
    inputSchema: z.object({ city: z.string() }),
    approval,
    execute: async ({ city }) => ({ city, secretWasUsedByClosure: true }),
  });
  const resolved = defineRunnerCapability({
    descriptor: {
      capabilityId,
      displayName: "Weather read",
      description: "Read weather",
      schemaFingerprint: "sha256:weather-v1",
      classification: "unknown",
      supportsUnattended: false,
    },
    modelToolName: "host_weather_read",
    tool: realTool,
  });

  function registry(result: RunnerCapabilityResolution = resolved): RunnerCapabilityRegistry {
    return {
      list: async (owner) => (owner.ownerKey === OWNER_A.ownerKey ? [resolved.descriptor] : []),
      resolve: async ({ owner, capabilityIds }) =>
        owner.ownerKey === OWNER_A.ownerKey && capabilityIds.includes(capabilityId)
          ? [result]
          : [],
    };
  }

  it("preserves the exact host tool and conservatively classifies unknown", async () => {
    const service = new RunnerCapabilityService(registry());
    const prepared = await service.prepare({ owner: OWNER_A, requirements: [requirement], mode: "direct" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.plan.selected).toEqual([
      {
        capabilityId,
        modelToolName: "host_weather_read",
        schemaFingerprint: "sha256:weather-v1",
        consequential: true,
      },
    ]);
    let guardCalls = 0;
    const lowered = lowerResolvedCapabilities(prepared.value.resolved, async () => {
      guardCalls += 1;
    });
    expect(Object.keys(lowered)).toEqual(["host_weather_read"]);
    expect(lowered.host_weather_read).not.toBe(realTool);
    expect(lowered.host_weather_read?.inputSchema).toBe(realTool.inputSchema);
    expect(lowered.host_weather_read?.approval).toBe(approval);
    await expect(
      lowered.host_weather_read?.execute({ city: "Denver" }, {} as never),
    ).resolves.toEqual({ city: "Denver", secretWasUsedByClosure: true });
    expect(guardCalls).toBe(1);
  });

  it("checks the lease guard immediately before the real adapter executes", async () => {
    let adapterCalls = 0;
    const guardedTool = defineTool({
      description: "Guarded host closure",
      inputSchema: z.object({ city: z.string() }),
      execute: async () => {
        adapterCalls += 1;
        return "must-not-run";
      },
    });
    const guarded = defineRunnerCapability({
      descriptor: resolved.descriptor,
      modelToolName: "guarded_weather_read",
      tool: guardedTool,
    });
    const lowered = lowerResolvedCapabilities([guarded], async () => {
      throw new Error("OWNER_MISMATCH");
    });
    await expect(
      lowered.guarded_weather_read?.execute({ city: "Denver" }, {} as never),
    ).rejects.toThrow("OWNER_MISMATCH");
    expect(adapterCalls).toBe(0);
  });

  it("blocks every required unavailability before lowering and omits optional drift explicitly", async () => {
    for (const reason of ["missing", "unauthorized", "disabled", "incompatible"] as const) {
      const unavailable: RunnerCapabilityResolution = { status: "unavailable", capabilityId, reason };
      const blocked = await new RunnerCapabilityService(registry(unavailable)).prepare({
        owner: OWNER_A,
        requirements: [requirement],
        mode: "direct",
      });
      expect(blocked).toMatchObject({
        ok: false,
        error: { code: "REQUIRED_CAPABILITY_UNAVAILABLE", reason },
      });
      const optional = await new RunnerCapabilityService(registry(unavailable)).prepare({
        owner: OWNER_A,
        requirements: [{ ...requirement, level: "optional" }],
        mode: "direct",
      });
      expect(optional).toMatchObject({
        ok: true,
        value: {
          plan: { selected: [], optionalOmissions: [{ capabilityId, reason }] },
          disclosureRequired: true,
        },
      });
      if (optional.ok) expect(optional.value.optionalOmissionNote).toContain("Do not substitute");
    }
  });

  it("rejects unauthorized extras, stable-ID model names, and unattended drift while selecting consequential tests", async () => {
    expect(() =>
      defineRunnerCapability({
        descriptor: resolved.descriptor,
        modelToolName: capabilityId,
        tool: realTool,
      }),
    ).toThrow("must not reuse");
    const extraId = capabilityIdSchema.parse("capability.extra.v1");
    const badRegistry: RunnerCapabilityRegistry = {
      list: async () => [],
      resolve: async () => [
        resolved,
        { status: "unavailable", capabilityId: extraId, reason: "missing" },
      ],
    };
    expect(
      await new RunnerCapabilityService(badRegistry).prepare({
        owner: OWNER_A,
        requirements: [requirement],
        mode: "direct",
      }),
    ).toMatchObject({ ok: false, error: { code: "CAPABILITY_REGISTRY_CONTRACT_VIOLATION" } });
    expect(
      await new RunnerCapabilityService(registry()).prepare({
        owner: OWNER_A,
        requirements: [requirement],
        mode: "unattended",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "REQUIRED_CAPABILITY_UNAVAILABLE", reason: "disabled" },
    });
    const forged = { ...resolved } as RunnerCapabilityResolution;
    expect(
      await new RunnerCapabilityService(registry(forged)).prepare({
        owner: OWNER_A,
        requirements: [requirement],
        mode: "direct",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_REGISTRY_CONTRACT_VIOLATION" },
    });
    const testPrepared = await new RunnerCapabilityService(registry()).prepare({
        owner: OWNER_A,
        requirements: [requirement],
        mode: "test",
      });
    expect(testPrepared).toMatchObject({
      ok: true,
      value: { plan: { mode: "test", selected: [{ consequential: true }] } },
    });
  });

  it("rejects a required adapter whose schema cannot cross Eve's JSON Schema boundary", async () => {
    const mutableTool = defineTool({
      description: "Initially valid host tool",
      inputSchema: z.object({ value: z.string() }),
      execute: async ({ value }) => value,
    });
    const mutableResolution = defineRunnerCapability({
      descriptor: resolved.descriptor,
      modelToolName: "mutable_host_tool",
      tool: mutableTool,
    });
    Object.assign(mutableTool, {
      inputSchema: z.custom<Record<string, unknown>>(() => true),
    });
    expect(
      await new RunnerCapabilityService(registry(mutableResolution)).prepare({
        owner: OWNER_A,
        requirements: [requirement],
        mode: "direct",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_REGISTRY_CONTRACT_VIOLATION" },
    });
  });
});

describe("consequential test approval composition", () => {
  const step = {} as TestCapabilityStepScope;
  const requestContext = {
    callId: "capability-call",
    toolInput: { value: "opaque" },
    toolName: "fixture_consequential",
  } as ApprovalContext<unknown>;
  const responseContext = {
    request: {
      callId: "capability-call",
      requestId: "approval-request",
      toolInput: { value: "opaque" },
      toolName: "fixture_consequential",
    },
    responder: principal("owner-a"),
  } as ApprovalResponseContext<unknown>;

  function configuration(input: Parameters<typeof composeConsequentialTestApproval>[0]) {
    const approval = composeConsequentialTestApproval(input);
    if (typeof approval === "function") throw new Error("Expected composed approval policies");
    return approval;
  }

  it("denies every unavailable input condition before a grant or adapter call", async () => {
    const unavailableCodes: readonly TestInputUnavailableCode[] = [
      "INPUT_REQUIRED",
      "INPUT_UNAVAILABLE",
      "INPUT_DENIED",
      "INPUT_CANCELLED",
      "INPUT_TIMEOUT",
      "INPUT_STALE",
      "INPUT_MALFORMED",
      "INPUT_AMBIGUOUS",
      "UNATTENDED_INPUT_FORBIDDEN",
    ];
    for (const code of unavailableCodes) {
      let grantCalls = 0;
      let adapterCalls = 0;
      const approval = configuration({
        getStep: async () => ({ ok: true, value: step }),
        getResponseStep: async () => ({ ok: true, value: step }),
        inputPolicy: {
          availability: () => ({ status: "unavailable", code, message: code }),
        },
        authorize: async () => {
          grantCalls += 1;
          return { ok: true, value: {} as TestInputGrantRecord };
        },
      });
      const decision = await approval.request(requestContext);
      if (decision === "user-approval") adapterCalls += 1;
      expect(decision).toEqual({ type: "denied", reason: code });
      expect(grantCalls).toBe(0);
      expect(adapterCalls).toBe(0);
    }
  });

  it("preserves host denial and rejects denied responses before storing a grant", async () => {
    let availabilityCalls = 0;
    let grantCalls = 0;
    const hostDenied = configuration({
      hostApproval: () => ({ type: "denied", reason: "HOST_DENIED" }),
      getStep: async () => ({ ok: true, value: step }),
      getResponseStep: async () => ({ ok: true, value: step }),
      inputPolicy: {
        availability: () => {
          availabilityCalls += 1;
          return { status: "available" };
        },
      },
      authorize: async () => {
        grantCalls += 1;
        return { ok: true, value: {} as TestInputGrantRecord };
      },
    });
    expect(await hostDenied.request(requestContext)).toEqual({
      type: "denied",
      reason: "HOST_DENIED",
    });
    expect(availabilityCalls).toBe(0);

    const responseDenied = configuration({
      hostApproval: {
        request: () => "user-approval",
        response: () => ({ status: "rejected", reason: "HOST_RESPONSE_DENIED" }),
      },
      getStep: async () => ({ ok: true, value: step }),
      getResponseStep: async () => ({ ok: true, value: step }),
      inputPolicy: { availability: () => ({ status: "available" }) },
      authorize: async () => {
        grantCalls += 1;
        return { ok: true, value: {} as TestInputGrantRecord };
      },
    });
    expect(await responseDenied.response?.(responseContext)).toEqual({
      status: "rejected",
      reason: "HOST_RESPONSE_DENIED",
    });
    expect(grantCalls).toBe(0);

    const policyDenied = configuration({
      getStep: async () => ({ ok: true, value: step }),
      getResponseStep: async () => ({ ok: true, value: step }),
      inputPolicy: {
        availability: () => ({ status: "available" }),
        authorizeResponse: () => ({ status: "rejected", reason: "INPUT_STALE" }),
      },
      authorize: async () => {
        grantCalls += 1;
        return { ok: true, value: {} as TestInputGrantRecord };
      },
    });
    expect(await policyDenied.response?.(responseContext)).toEqual({
      status: "rejected",
      reason: "INPUT_STALE",
    });
    expect(grantCalls).toBe(0);
  });

  it("stores one grant only after host and Builder response policies allow the exact call", async () => {
    let grantCalls = 0;
    const approval = configuration({
      hostApproval: {
        request: () => "user-approval",
        response: () => ({ status: "allowed" }),
      },
      getStep: async () => ({ ok: true, value: step }),
      getResponseStep: async () => ({ ok: true, value: step }),
      inputPolicy: {
        availability: () => ({ status: "available" }),
        authorizeResponse: () => ({ status: "allowed" }),
      },
      authorize: async () => {
        grantCalls += 1;
        return { ok: true, value: {} as TestInputGrantRecord };
      },
    });
    expect(await approval.request(requestContext)).toBe("user-approval");
    expect(await approval.response?.(responseContext)).toEqual({ status: "allowed" });
    expect(grantCalls).toBe(1);
  });
});

describe("deterministic owner-scoped discovery", () => {
  it("is random-insertion independent, excludes other owners and skills, and keeps every omission reachable", async () => {
    const definitions = Array.from({ length: 30 }, (_, index) => ({
      id: `agent-${String(index).padStart(2, "0")}`,
      name: `Agent ${String(29 - index).padStart(2, "0")}`,
      kind: index === 7 ? ("skill" as const) : ("agent" as const),
    }));
    const storeA = createMemoryAgentBuilderStore();
    const storeB = createMemoryAgentBuilderStore();
    for (const [index, definition] of definitions.entries()) {
      await addActive(storeA, { owner: OWNER_A, ...definition, second: index * 3 });
    }
    const randomized = [...definitions];
    let randomState = 0x5eed;
    for (let index = randomized.length - 1; index > 0; index -= 1) {
      randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0;
      const swap = randomState % (index + 1);
      [randomized[index], randomized[swap]] = [randomized[swap]!, randomized[index]!];
    }
    for (const [index, definition] of randomized.entries()) {
      await addActive(storeB, { owner: OWNER_A, ...definition, second: index * 3 });
    }
    await addActive(storeA, { owner: OWNER_B, id: "private-agent", name: "Private", second: 0 });
    const discoveryA = new AgentDiscoveryService({ store: storeA, maxRosterEntries: 3 });
    const discoveryB = new AgentDiscoveryService({ store: storeB, maxRosterEntries: 3 });
    expect((await discoveryA.list(OWNER_A)).map(({ agentId }) => agentId)).toEqual(
      (await discoveryB.list(OWNER_A)).map(({ agentId }) => agentId),
    );
    expect((await discoveryA.list(OWNER_A)).some(({ agentId }) => agentId === "private-agent")).toBe(false);
    const roster = await discoveryA.roster(OWNER_A);
    expect(roster.included).toHaveLength(3);
    expect(roster.omittedCount).toBe(26);
    expect(roster.included.every(({ kind }) => kind === "agent")).toBe(true);
    expect(roster.characterCount).toBeLessThanOrEqual(12_000);
    const defaultRoster = await new AgentDiscoveryService({ store: storeA }).roster(OWNER_A);
    expect(defaultRoster.included).toHaveLength(25);
    expect(defaultRoster.omittedCount).toBe(4);

    const collectPages = async (discovery: AgentDiscoveryService) => {
      const reachable: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await discovery.search(OWNER_A, {
          query: "agent",
          limit: 10,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!result.ok) throw new Error(result.error.code);
        reachable.push(...result.value.entries.map(({ agentId }) => agentId));
        cursor = result.value.nextCursor;
      } while (cursor !== undefined);
      return reachable;
    };
    const reachable = await collectPages(discoveryA);
    expect(reachable).toEqual(await collectPages(discoveryB));
    expect(new Set(reachable).size).toBe(30);
    for (const entry of await discoveryA.list(OWNER_A)) {
      expect(await discoveryA.get(OWNER_A, entry.agentId)).toMatchObject({ status: "found" });
    }
    const skill = definitions[7];
    expect(skill).toBeDefined();
    expect(await discoveryA.admitRun(OWNER_A, skill?.id)).toMatchObject({
      status: "load_skill_required",
    });
    for (const entry of (await discoveryA.list(OWNER_A)).filter(
      (candidate) => candidate.kind === "agent" &&
        !roster.included.some((included) => included.agentId === candidate.agentId),
    )) {
      expect(await discoveryA.admitRun(OWNER_A, entry.agentId)).toMatchObject({ status: "ready" });
    }
  });

  it("binds opaque cursors to owner and normalized query with a fixed max page size", async () => {
    const store = createMemoryAgentBuilderStore();
    for (let index = 0; index < 3; index += 1) {
      await addActive(store, {
        owner: OWNER_A,
        id: `search-${index}`,
        name: `Daily Report ${index}`,
        second: index * 3,
      });
    }
    const discovery = new AgentDiscoveryService({ store });
    const first = await discovery.search(OWNER_A, { query: "daily rep", limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.nextCursor === undefined) throw new Error("expected cursor");
    expect(
      await discovery.search(OWNER_B, { query: "daily rep", cursor: first.value.nextCursor }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_CURSOR" } });
    expect(
      await discovery.search(OWNER_A, { query: "other", cursor: first.value.nextCursor }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_CURSOR" } });
    expect(await discovery.search(OWNER_A, { limit: 21 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("stops before the first roster entry that would exceed the character budget", async () => {
    const store = createMemoryAgentBuilderStore();
    await addActive(store, {
      owner: OWNER_A,
      id: "large-agent",
      name: "Large agent",
      description: "x".repeat(8_000),
      second: 0,
    });
    const roster = await new AgentDiscoveryService({
      store,
      maxRosterCharacters: 256,
    }).roster(OWNER_A);
    expect(roster.included).toHaveLength(0);
    expect(roster.omittedCount).toBe(1);
    expect(roster.characterCount).toBeLessThanOrEqual(256);
  });
});

describe("trusted Eve operation identity", () => {
  it("scopes a model tool-call ID to its exact session and turn", async () => {
    const context = (sessionId: string, turnId: string, callId: string) =>
      ({ callId, session: { id: sessionId, turn: { id: turnId } } }) as Parameters<
        typeof scopedToolOperationId
      >[0];
    const first = await scopedToolOperationId(context("session-a", "turn-a", "reused-call"));
    expect(
      await scopedToolOperationId(context("session-a", "turn-a", "reused-call")),
    ).toBe(first);
    expect(
      await scopedToolOperationId(context("session-b", "turn-a", "reused-call")),
    ).not.toBe(first);
    expect(
      await scopedToolOperationId(context("session-a", "turn-b", "reused-call")),
    ).not.toBe(first);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});

describe("bootstrap service and role authorization", () => {
  it("parses only an exact raw or singly wrapped two-field bootstrap payload", () => {
    const token = `ab1_${"a".repeat(43)}`;
    const raw = formatBootstrapMessage(token);
    const wrapped = [
      'You are the subagent "active-runner".',
      "Description: isolated runner",
      "",
      "The caller delegated the following task to you. Complete it and return the result directly. The caller may send follow-up messages after you answer.",
      "",
      "Caller message:",
      raw,
    ].join("\n");
    expect(parseBootstrapMessage(raw)).toEqual({ token });
    expect(parseBootstrapMessage(wrapped)).toEqual({ token });
    for (const spoof of [
      `MALICIOUS TASK\nCaller message:\n${raw}`,
      `You are the subagent "active-runner".\nMALICIOUS TASK\nCaller message:\n${raw}`,
      `${wrapped}\nTRAILING_TASK`,
      wrapped.replace("Caller message:\n", `Caller message:\nMALICIOUS\nCaller message:\n`),
      JSON.stringify({ protocolVersion: 1, token, task: "malicious" }),
      JSON.stringify({ protocolVersion: 1, token: "not-an-issued-token-shape" }),
    ]) {
      expect(parseBootstrapMessage(spoof)).toBeNull();
    }
  });

  it("requires at least 128 bits and stores/reports only the hash outside the issuance result", async () => {
    const store = createMemoryAgentBuilderStore();
    const created = await store.mutate({
      type: "create_family",
      owner: OWNER_A,
      mutation: { operationId: operationIdSchema.parse("create-bootstrap"), requestFingerprint: "create" },
      occurredAt: timestampSchema.parse("2026-01-01T00:00:00.000Z"),
      agentId: agentIdSchema.parse("bootstrap-agent"),
      draftId: draftIdSchema.parse("bootstrap-draft"),
      maxFamilies: 25,
      canonicalName: "bootstrap",
      fields: fields("Bootstrap"),
    });
    expect(created.ok).toBe(true);
    const short = new BootstrapService({
      store,
      clock: { now: () => "2026-01-01T00:00:01.000Z" },
      tokenSource: { bytes: () => new Uint8Array(15) },
    });
    expect(
      await short.issue({
        owner: OWNER_A,
        role: "pm",
        target: {
          kind: "draft",
          agentId: agentIdSchema.parse("bootstrap-agent"),
          draftId: draftIdSchema.parse("bootstrap-draft"),
          draftRevision: 1,
        },
        parentSessionId: "parent",
      }),
    ).toMatchObject({ ok: false, error: { code: "DEPENDENCY_CONTRACT_VIOLATION" } });

    const service = new BootstrapService({
      store,
      clock: { now: () => "2026-01-01T00:00:01.000Z" },
      ids: { grantId: () => "grant", leaseId: () => "lease" },
      tokenSource: { bytes: (length) => new Uint8Array(length).fill(9) },
    });
    const issued = await service.issue({
      owner: OWNER_A,
      role: "pm",
      target: {
        kind: "draft",
        agentId: agentIdSchema.parse("bootstrap-agent"),
        draftId: draftIdSchema.parse("bootstrap-draft"),
        draftRevision: 1,
      },
      parentSessionId: "parent",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(Buffer.from(issued.value.token.slice(4), "base64url")).toHaveLength(32);
    const wrongOwner = await service.redeem({
      token: issued.value.token,
      owner: OWNER_B,
      role: "pm",
      parentSessionId: "parent",
      parentCallId: "call",
      childSessionId: "child",
      bootstrapTurnId: "turn",
    });
    expect(wrongOwner).toMatchObject({ ok: false, error: { code: "OWNER_MISMATCH" } });
    expect(JSON.stringify(wrongOwner)).not.toContain(issued.value.token);
    expect(
      () =>
        new BootstrapService({
          store,
          maxGrantTtlMs: 5 * 60_000 + 1,
        }),
    ).toThrow("five-minute protocol maximum");
  });

  it("keeps the role matrix exhaustive and rejects cross-field and cross-owner patches", async () => {
    const expected = {
      root: ["draft_create", "workflow_allocate", "workflow_reopen", "bootstrap_issue", "agent_discovery", "test_request", "publish", "activate", "archive", "restore", "delete"],
      pm: ["draft_read", "pm_patch", "pm_submit"],
      implementor: ["draft_read", "implementor_patch", "implementor_submit", "capability_metadata"],
      qa: ["draft_read", "qa_patch", "qa_submit", "test_request"],
      test_runner: ["draft_read", "capability_execute", "test_submit"],
      active_runner: ["capability_execute"],
    } as const;
    for (const [role, allowed] of Object.entries(expected)) {
      const allowedOperations = new Set<string>(allowed);
      for (const operation of agentBuilderRoleOperations) {
        expect(roleMayPerform(role as keyof typeof rolePermissionMatrix, operation)).toBe(
          allowedOperations.has(operation),
        );
      }
    }

    const store = createMemoryAgentBuilderStore();
    let tick = 0;
    const service = new AgentBuilderService({
      store,
      clock: { now: () => `2026-01-01T00:00:0${++tick}.000Z` },
      ids: { agentId: () => "role-agent", draftId: () => "role-draft", specId: () => "role-spec" },
      resolveOwner: (input) =>
        input.current?.principalId === "owner-a" ? OWNER_A : input.current?.principalId === "owner-b" ? OWNER_B : null,
    });
    const created = await service.createDraft(
      { ownerResolution: ownerInput(), operationId: "role-create" },
      { name: "Role agent", kind: "agent" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok || created.value.type !== "family_created" || created.value.family.draft === undefined) return;
    const target = {
        kind: "draft",
        agentId: created.value.family.agentId,
        draftId: created.value.family.draft?.draftId ?? draftIdSchema.parse("missing"),
        draftRevision: created.value.family.draft?.draftRevision ?? 1,
      } as const;
    const createLease = async (
      role: "pm" | "implementor" | "qa",
      digit: string,
    ): Promise<ExecutionLeaseRecord> => {
      const tokenHash = `sha256:${digit.repeat(64)}`;
      const createdGrant = await store.createBootstrapGrant({
        grant: {
          grantId: `grant-${role}`,
          tokenHash,
          owner: OWNER_A,
          role,
          target,
          parentSessionId: "parent",
          issuedAt: timestampSchema.parse("2026-01-01T00:00:01.000Z"),
          expiresAt: timestampSchema.parse("2026-01-01T00:05:01.000Z"),
        },
      });
      if (!createdGrant.ok) throw new Error(`Unable to seed ${role} grant`);
      const redeemed = await store.redeemBootstrapGrant({
        tokenHash,
        owner: OWNER_A,
        role,
        expectedTarget: target,
        parentSessionId: "parent",
        parentCallId: `call-${role}`,
        childSessionId: `child-${role}`,
        bootstrapTurnId: "bootstrap",
        leaseId: `lease-${role}`,
        occurredAt: timestampSchema.parse("2026-01-01T00:00:02.000Z"),
        leaseExpiresAt: timestampSchema.parse("2026-01-01T00:05:02.000Z"),
      });
      if (!redeemed.ok) throw new Error(`Unable to seed ${role} lease`);
      const running = await store.beginExecutionLease({
        owner: OWNER_A,
        childSessionId: `child-${role}`,
        executionTurnId: `execution-${role}`,
        occurredAt: timestampSchema.parse("2026-01-01T00:00:03.000Z"),
      });
      if (!running.ok) throw new Error(`Unable to begin ${role} lease`);
      return running.value;
    };
    const leases = {
      pm: await createLease("pm", "1"),
      implementor: await createLease("implementor", "2"),
      qa: await createLease("qa", "3"),
    };
    const registry: RunnerCapabilityRegistry = { list: async () => [], resolve: async () => [] };
    let roleNow = "2026-01-01T00:00:04.000Z";
    const roles = createRoleScopedAgentBuilderService({
      service,
      capabilities: new RunnerCapabilityService(registry),
      store,
      clock: { now: () => roleNow },
    });
    const forbiddenFields = {
      pm: ["instructions", "toolRequirements", "triggers", "testChecklist", "qaFindings", "owner", "agentId", "revision"],
      implementor: ["name", "kind", "description", "pmBrief", "testChecklist", "qaFindings", "owner", "agentId", "revision"],
      qa: ["name", "kind", "description", "pmBrief", "instructions", "toolRequirements", "triggers", "owner", "agentId", "revision"],
    } as const;
    for (const [index, field] of forbiddenFields.pm.entries()) {
      expect(
        await roles.patchPm(
          { lease: leases.pm, mutationContext: { ownerResolution: ownerInput(), operationId: `pm-bad-${index}` } },
          { [field]: field.endsWith("s") ? [] : "forbidden" },
        ),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    for (const [index, field] of forbiddenFields.implementor.entries()) {
      expect(
        await roles.patchImplementor(
          { lease: leases.implementor, mutationContext: { ownerResolution: ownerInput(), operationId: `impl-bad-${index}` } },
          { [field]: field.endsWith("s") ? [] : "forbidden" },
        ),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    for (const [index, field] of forbiddenFields.qa.entries()) {
      expect(
        await roles.patchQa(
          { lease: leases.qa, mutationContext: { ownerResolution: ownerInput(), operationId: `qa-bad-${index}` } },
          { [field]: field.endsWith("s") ? [] : "forbidden" },
        ),
      ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    expect(
      await roles.patchPm(
        { lease: leases.pm, mutationContext: { ownerResolution: ownerInput("owner-b"), operationId: "pm-owner" } },
        { description: "wrong owner" },
      ),
    ).toMatchObject({ ok: false, error: { code: "OWNER_MISMATCH" } });
    expect(
      await roles.listCapabilityMetadata(ownerInput("owner-b"), leases.implementor),
    ).toMatchObject({ ok: false, error: { code: "OWNER_MISMATCH" } });
    expect(
      await roles.listCapabilityMetadata(ownerInput(), leases.implementor),
    ).toEqual({ ok: true, value: [] });
    expect(
      await roles.patchPm(
        {
          lease: { ...leases.pm, leaseId: "forged-lease" },
          mutationContext: { ownerResolution: ownerInput(), operationId: "pm-forged" },
        },
        { description: "forged" },
      ),
    ).toMatchObject({ ok: false, error: { code: "BOOTSTRAP_REQUIRED" } });
    const readyHash = `sha256:${"4".repeat(64)}`;
    await store.createBootstrapGrant({
      grant: {
        grantId: "grant-pm-ready",
        tokenHash: readyHash,
        owner: OWNER_A,
        role: "pm",
        target,
        parentSessionId: "parent",
        issuedAt: timestampSchema.parse("2026-01-01T00:00:01.000Z"),
        expiresAt: timestampSchema.parse("2026-01-01T00:05:01.000Z"),
      },
    });
    const ready = await store.redeemBootstrapGrant({
      tokenHash: readyHash,
      owner: OWNER_A,
      role: "pm",
      expectedTarget: target,
      parentSessionId: "parent",
      parentCallId: "call-pm-ready",
      childSessionId: "child-pm-ready",
      bootstrapTurnId: "bootstrap-ready",
      leaseId: "lease-pm-ready",
      occurredAt: timestampSchema.parse("2026-01-01T00:00:02.000Z"),
      leaseExpiresAt: timestampSchema.parse("2026-01-01T00:05:02.000Z"),
    });
    expect(ready.ok).toBe(true);
    if (ready.ok) {
      expect(await roles.readDraft("pm", ownerInput(), ready.value)).toMatchObject({
        ok: false,
        error: { code: "BOOTSTRAP_REQUIRED" },
      });
    }
    roleNow = "2026-01-01T00:05:02.000Z";
    expect(await roles.readDraft("qa", ownerInput(), leases.qa)).toMatchObject({
      ok: false,
      error: { code: "BOOTSTRAP_REQUIRED" },
    });
  });
});
