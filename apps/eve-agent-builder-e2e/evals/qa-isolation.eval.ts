import { defineEval } from "eve/evals";

export default defineEval({
  description: "QA has a static persona and only its role-scoped Agent Builder surface.",
  async test(t) {
    const result = await t.send("ROLE_ISOLATION:qa");
    result.expectOk();
    t.calledSubagent("qa", { count: 2 });
    t.messageIncludes("ROLE_ISOLATION_OK qa");
    t.noFailedActions();
    t.succeeded();
  },
});
