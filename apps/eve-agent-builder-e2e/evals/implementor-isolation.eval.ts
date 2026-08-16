import { defineEval } from "eve/evals";

export default defineEval({
  description: "Implementor has a static persona and only its role-scoped Agent Builder surface.",
  async test(t) {
    const result = await t.send("ROLE_ISOLATION:implementor");
    result.expectOk();
    t.calledSubagent("implementor", { count: 2 });
    t.messageIncludes("ROLE_ISOLATION_OK implementor");
    t.noFailedActions();
    t.succeeded();
  },
});
