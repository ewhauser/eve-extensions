import { describe, expect, it } from "vitest";

import { createMemoryAgentBuilderStore } from "../stores/memory.js";
import {
  runTestPolicyStoreConformanceSuite,
  testPolicyStoreConformanceCases,
} from "../testing/test-policy-conformance.js";

describe("MemoryAgentBuilderStore interactive test policy", () => {
  it("passes the reusable test-policy conformance suite", async () => {
    const report = await runTestPolicyStoreConformanceSuite(createMemoryAgentBuilderStore);
    expect(report.passed).toBe(testPolicyStoreConformanceCases.length);
    expect(report.caseNames).toEqual(testPolicyStoreConformanceCases.map(({ name }) => name));
  });
});
