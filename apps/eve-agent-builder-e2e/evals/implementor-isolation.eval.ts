import { defineEval } from "eve/evals";

export default defineEval({
  description: "Implementor has a static persona and only its role-scoped Agent Builder surface.",
  async test(t) {
    const result = await t.send("ROLE_ISOLATION:implementor");
    result.expectOk();
    t.event("subagent.called", { data: { name: "implementor" }, count: 2 });
    t.calledTool("blocking-implementor", { count: 2 });
    t.messageIncludes("ROLE_ISOLATION_OK implementor");
    t.noFailedActions();
    t.succeeded();
  },
});
