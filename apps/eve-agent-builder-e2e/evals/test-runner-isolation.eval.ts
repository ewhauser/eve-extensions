import { defineEval } from "eve/evals";

export default defineEval({
  description: "Test runner infrastructure is isolated without claiming PR 04 input policy.",
  async test(t) {
    const result = await t.send("ROLE_ISOLATION:test-runner");
    result.expectOk();
    t.event("subagent.called", { data: { name: "test-runner" }, count: 2 });
    t.calledTool("blocking-test-runner", { count: 2 });
    t.messageIncludes("ROLE_ISOLATION_OK test_runner");
    t.noFailedActions();
    t.succeeded();
  },
});
