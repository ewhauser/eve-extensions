import { describe, expect, it } from "vitest";

import { createMemoryAgentBuilderStore } from "../stores/memory.js";
import {
  buildWorkflowStoreConformanceCases,
  runBuildWorkflowStoreConformanceSuite,
} from "../testing/workflow-conformance.js";

describe("MemoryAgentBuilderStore build workflow transactions", () => {
  it("passes the reusable build workflow conformance suite", async () => {
    const report = await runBuildWorkflowStoreConformanceSuite(createMemoryAgentBuilderStore);
    expect(report.passed).toBe(buildWorkflowStoreConformanceCases.length);
    expect(report.caseNames).toEqual(buildWorkflowStoreConformanceCases.map(({ name }) => name));
  });
});
