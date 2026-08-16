import { describe, expect, it } from "vitest";

import { createMemoryAgentBuilderStore } from "../stores/memory.js";
import {
  agentBuilderStoreConformanceCases,
  runAgentBuilderStoreConformanceSuite,
} from "../testing/store-conformance.js";

describe("MemoryAgentBuilderStore", () => {
  it("passes the reusable store conformance suite", async () => {
    const report = await runAgentBuilderStoreConformanceSuite(createMemoryAgentBuilderStore);
    expect(report.passed).toBe(agentBuilderStoreConformanceCases.length);
    expect(report.caseNames).toEqual(
      agentBuilderStoreConformanceCases.map((testCase) => testCase.name),
    );
  });
});
