import { defineAgentBuilderRoleAgent } from "eve-agent-builder/mounts/runner-agent";

import { roleIsolationModel } from "../../lib/role-model.js";

export default defineAgentBuilderRoleAgent({
  role: "test_runner",
  mode: "test",
  model: roleIsolationModel({
    role: "test_runner",
    personaMarker: "Agent Builder test runner",
    executionTools: [
      "agent_builder__draft_get",
      "agent_builder__run_context",
      "agent_builder__test_submit",
      "fixture_read",
    ],
  }),
  modelContextWindowTokens: 32_000,
  description: "Isolated saved-draft test runner with exact-call interactive approval policy.",
});
