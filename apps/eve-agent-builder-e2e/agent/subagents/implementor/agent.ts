import { defineAgentBuilderRoleAgent } from "eve-agent-builder/mounts/runner-agent";

import { roleIsolationModel } from "../../lib/role-model.js";

export default defineAgentBuilderRoleAgent({
  role: "implementor",
  mode: "direct",
  model: roleIsolationModel({
    role: "implementor",
    personaMarker: "Agent Builder implementor",
    executionTools: [
      "agent_builder__capability_list",
      "agent_builder__draft_get",
      "agent_builder__implementor_patch",
      "agent_builder__run_context",
    ],
  }),
  modelContextWindowTokens: 32_000,
  description: "Static Agent Builder implementor with implementation-only field ownership.",
});
