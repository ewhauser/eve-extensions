import { defineEval } from "eve/evals";

export default defineEval({
  description: "PM has a static persona and only its role-scoped Agent Builder surface.",
  async test(t) {
    const result = await t.send("ROLE_ISOLATION:pm");
    result.expectOk();
    t.calledSubagent("pm", { count: 2 });
    t.messageIncludes("ROLE_ISOLATION_OK pm");
    t.noFailedActions();
    t.succeeded();
  },
});
