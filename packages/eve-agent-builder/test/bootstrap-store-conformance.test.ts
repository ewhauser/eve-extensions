import { describe, expect, it } from "vitest";

import { createMemoryAgentBuilderStore } from "../stores/memory.js";
import {
  bootstrapStoreConformanceCases,
  runBootstrapStoreConformanceSuite,
} from "../testing/bootstrap-conformance.js";

describe("MemoryAgentBuilderStore bootstrap and lease transactions", () => {
  it("passes the reusable bootstrap conformance suite", async () => {
    const report = await runBootstrapStoreConformanceSuite(createMemoryAgentBuilderStore);
    expect(report.passed).toBe(bootstrapStoreConformanceCases.length);
    expect(report.caseNames).toEqual(bootstrapStoreConformanceCases.map(({ name }) => name));
  });
});
