import { describe, expect, it } from "vitest";

import {
  agentIdSchema,
  canonicalizeAgentName,
  capabilityIdSchema,
  draftIdSchema,
  jsonValueSchema,
  MAX_JSON_VALUE_DEPTH,
  MAX_JSON_VALUE_NODES,
  ownerResolutionResultSchema,
  savedAgentDraftSchema,
  savedAgentEditableFieldsSchema,
  savedAgentFamilySchema,
  specIdSchema,
  timestampSchema,
  triggerIdSchema,
} from "../src/domain.js";
import { agentBuilderErrorSchema } from "../src/service.js";
import { agentBuilderStoreMutationResultSchema } from "../src/store.js";

const time = timestampSchema.parse("2026-01-01T00:00:00.000Z");

describe("domain schemas", () => {
  it("canonicalizes names with one deterministic locale-independent rule", () => {
    expect(canonicalizeAgentName("  Ａlpha\u00a0\tNAME  ")).toBe("alpha name");
    expect(canonicalizeAgentName("Straße")).toBe("straße");
    expect(canonicalizeAgentName("STRASSE")).toBe("strasse");
    expect(canonicalizeAgentName("I")).toBe("i");
  });

  it("requires canonical timestamps", () => {
    expect(timestampSchema.safeParse("2026-01-01T00:00:00.000Z").success).toBe(true);
    expect(timestampSchema.safeParse("2026-01-01T00:00:00Z").success).toBe(false);
    expect(timestampSchema.safeParse("2026-02-30T00:00:00.000Z").success).toBe(false);
    expect(timestampSchema.safeParse("2026-01-01T00:00:00.000+00:00").success).toBe(false);
  });

  it("rejects cyclic or over-budget JSON without overflowing the call stack", () => {
    let value: unknown = "leaf";
    for (let depth = 0; depth <= MAX_JSON_VALUE_DEPTH; depth += 1) {
      value = { next: value };
    }
    const tooWide = Array.from({ length: MAX_JSON_VALUE_NODES }, () => null);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(() => jsonValueSchema.safeParse(value)).not.toThrow();
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
    expect(jsonValueSchema.safeParse(tooWide).success).toBe(false);
    expect(jsonValueSchema.safeParse(cycle).success).toBe(false);
  });

  it("rejects nonempty skill capabilities/triggers and duplicate stable IDs", () => {
    const requirement = {
      capabilityId: capabilityIdSchema.parse("capability-a"),
      level: "required" as const,
      displayNameSnapshot: "Capability A",
      schemaFingerprint: "schema-a",
      consequential: false,
    };
    const trigger = {
      kind: "event" as const,
      triggerId: triggerIdSchema.parse("trigger-a"),
      sourceId: "source-a",
      filter: {},
      destination: { channelKind: "slack", address: "C123" },
    };
    const base = {
      name: "Skill",
      kind: "skill" as const,
      description: "",
      pmBrief: "",
      instructions: "Do one thing",
      toolRequirements: [],
      triggers: [],
      testChecklist: [],
      qaFindings: [],
    };

    expect(
      savedAgentEditableFieldsSchema.safeParse({ ...base, toolRequirements: [requirement] })
        .success,
    ).toBe(false);
    expect(savedAgentEditableFieldsSchema.safeParse({ ...base, triggers: [trigger] }).success).toBe(
      false,
    );
    expect(
      savedAgentEditableFieldsSchema.safeParse({
        ...base,
        kind: "agent",
        toolRequirements: [requirement, requirement],
      }).success,
    ).toBe(false);
    expect(
      savedAgentEditableFieldsSchema.safeParse({
        ...base,
        kind: "agent",
        triggers: [trigger, trigger],
      }).success,
    ).toBe(false);
  });

  it("enforces draft base and family active pointer pairs", () => {
    const draft = {
      draftId: draftIdSchema.parse("draft-a"),
      name: "Agent",
      kind: "agent" as const,
      description: "",
      pmBrief: "",
      instructions: "",
      toolRequirements: [],
      triggers: [],
      testChecklist: [],
      qaFindings: [],
      draftRevision: 1,
      createdAt: time,
      updatedAt: time,
    };
    expect(savedAgentDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      savedAgentDraftSchema.safeParse({ ...draft, basedOnSpecId: specIdSchema.parse("spec-a") })
        .success,
    ).toBe(false);
    expect(savedAgentDraftSchema.safeParse({ ...draft, basedOnVersion: 1 }).success).toBe(false);

    const family = {
      agentId: agentIdSchema.parse("agent-a"),
      owner: { tenantKey: "Tenant", ownerKey: "Owner" },
      lifecycle: "active" as const,
      activeSpecId: specIdSchema.parse("spec-a"),
      activeVersion: 1,
      revision: 1,
      createdAt: time,
      updatedAt: time,
    };
    expect(savedAgentFamilySchema.safeParse(family).success).toBe(true);
    expect(savedAgentFamilySchema.safeParse({ ...family, activeVersion: undefined }).success).toBe(
      false,
    );
    expect(savedAgentFamilySchema.safeParse({ ...family, activeSpecId: undefined }).success).toBe(
      false,
    );
  });

  it("uses closed typed lifecycle result and error schemas", () => {
    expect(
      ownerResolutionResultSchema.safeParse({
        ok: false,
        error: { code: "USER_PRINCIPAL_REQUIRED", message: "current user required" },
      }).success,
    ).toBe(true);
    expect(
      agentBuilderStoreMutationResultSchema.safeParse({
        ok: false,
        error: {
          code: "REVISION_CONFLICT",
          message: "stale",
          currentRevision: 3,
          currentDraftRevision: 2,
        },
      }).success,
    ).toBe(true);
    expect(
      agentBuilderStoreMutationResultSchema.safeParse({ ok: false, error: "conflict" }).success,
    ).toBe(false);
    expect(
      agentBuilderErrorSchema.safeParse({ code: "OWNER_MISMATCH", message: "wrong owner" })
        .success,
    ).toBe(true);
    expect(agentBuilderErrorSchema.safeParse({ code: "UNKNOWN", message: "stringly" }).success).toBe(
      false,
    );
  });
});
