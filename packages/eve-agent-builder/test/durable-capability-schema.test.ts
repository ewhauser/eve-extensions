import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { durableCapabilitySchema } from "../extension/lib/mounts/runner-tools.js";
import { capabilityIdSchema } from "../src/domain.js";

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../extension/lib/runtime/service.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../extension/lib/runtime/service.js")>(),
  getAgentBuilderRuntime: () => ({ capabilities: { prepare } }),
}));

const owner = { tenantKey: "tenant", ownerKey: "owner" };
const reference: Parameters<typeof durableCapabilitySchema>[2] = {
  descriptor: {
    capabilityId: capabilityIdSchema.parse("fixture.read.v1"),
    displayName: "Read",
    description: "Read a fixture",
    schemaFingerprint: "v1",
    classification: "read_only_side_effect_free",
    supportsUnattended: true,
  },
  modelToolName: "fixture_read",
  mode: "direct",
  consequential: false,
};

function resolved(schema: unknown, fingerprint = "v1") {
  return { ok: true, value: {
    resolved: [{
      descriptor: { ...reference.descriptor, schemaFingerprint: fingerprint },
      modelToolName: reference.modelToolName,
      tool: { inputSchema: schema, outputSchema: schema },
    }],
    plan: { selected: [{
      capabilityId: reference.descriptor.capabilityId,
      modelToolName: reference.modelToolName,
      schemaFingerprint: fingerprint,
    }] },
  } };
}

beforeEach(() => prepare.mockReset());

describe("durable capability schemas", () => {
  it.each(["input", "output"] as const)("replays %s validation and transformations from JSON metadata", async (direction) => {
    const original = z.object({ value: z.string().trim().min(1) });
    const factory = durableCapabilitySchema(original, direction, reference, owner);
    const snapshot = JSON.parse(JSON.stringify(factory.closure));
    expect(snapshot).toEqual(factory.closure);
    const replayed = factory.schema(snapshot) as Pick<z.ZodType, "~standard">;
    prepare.mockResolvedValue(resolved(z.object({ value: z.string().trim().min(1) })));
    await expect(replayed["~standard"].validate({ value: "  kept  " })).resolves.toEqual({ value: { value: "kept" } });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ owner, mode: "direct" }));
    const invalid = await replayed["~standard"].validate({ value: " " });
    expect(invalid.issues?.length).toBeGreaterThan(0);
    prepare.mockResolvedValue(resolved(original, "changed"));
    await expect(replayed["~standard"].validate({ value: "valid" })).rejects.toThrow("CAPABILITY_SCHEMA_CHANGED");
  });

  it("keeps plain JSON schemas as data", () => {
    const schema = { type: "object", properties: { value: { type: "string" } } };
    const factory = durableCapabilitySchema(schema, "input", reference, owner);
    expect(factory.schema(JSON.parse(JSON.stringify(factory.closure)))).toEqual(schema);
    expect(prepare).not.toHaveBeenCalled();
  });
});
