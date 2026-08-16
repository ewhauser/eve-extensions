import { defineAgentBuilderRoleAgent } from "eve-agent-builder/mounts/runner-agent";

import { roleIsolationModel } from "../../lib/role-model.js";

export default defineAgentBuilderRoleAgent({
  role: "qa",
  mode: "direct",
  model: roleIsolationModel({
    role: "qa",
    personaMarker: "Agent Builder QA reviewer",
    executionTools: [
      "agent_builder__draft_get",
      "agent_builder__qa_patch",
      "agent_builder__run_context",
    ],
  }),
  modelContextWindowTokens: 32_000,
  description: "Static Agent Builder QA reviewer with QA-only field ownership.",
});
