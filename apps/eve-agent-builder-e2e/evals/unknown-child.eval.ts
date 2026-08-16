import { defineEval } from "eve/evals";

export default defineEval({
  description: "An unknown parked-child ID starts fresh and is blocked before its model executes.",
  async test(t) {
    const result = await t.send("UNKNOWN_CHILD_CASE");
    result.expectOk();
    // A pre-model guard failure is still a real declared-child dispatch, but it
    // is intentionally not a completed subagent call.
    t.event("subagent.called", { data: { name: "active-runner" }, count: 1 });
    t.messageIncludes("UNKNOWN_CHILD_BLOCKED_PRE_MODEL");
    t.succeeded();
  },
});
