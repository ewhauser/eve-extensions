import { defineEval } from "eve/evals";

export default defineEval({
  description: "An unknown parked-child ID starts fresh and is blocked before its model executes.",
  async test(t) {
    const result = await t.send("UNKNOWN_CHILD_CASE");
    result.expectOk();
    // Eve rejects an unknown task ID before opening a child session.
    t.calledTool("blocking-active-runner", { status: "failed", count: 1 });
    t.messageIncludes("UNKNOWN_CHILD_BLOCKED_PRE_MODEL");
    t.succeeded();
  },
});
