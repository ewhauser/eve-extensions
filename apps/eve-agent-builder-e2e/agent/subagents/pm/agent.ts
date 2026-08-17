import { defineAgentBuilderRoleAgent } from "eve-agent-builder/mounts/runner-agent";

import { roleIsolationModel } from "../../lib/role-model.js";

export default defineAgentBuilderRoleAgent({
  role: "pm",
  mode: "direct",
  model: roleIsolationModel({
    role: "pm",
    personaMarker: "host-declared Agent Builder PM",
    executionTools: [
      "agent_builder__draft_get",
      "agent_builder__pm_submit",
      "agent_builder__run_context",
    ],
  }),
  modelContextWindowTokens: 32_000,
  description: "Static Agent Builder PM with PM-only field ownership.",
});
