import { defineDynamic, defineInstructions } from "eve/instructions";

import { getAgentBuilderRuntime, resolveDynamicOwner } from "../runtime/service.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const runtime = getAgentBuilderRuntime();
      const owner = await resolveDynamicOwner(runtime, ctx);
      const roster = await runtime.discovery.roster(owner);
      return defineInstructions({
        markdown: [
          "Agent Builder build state is typed and durable. Allocate with agent_builder__workflow_allocate, then use agent_builder__workflow_get and agent_builder__prepare_next_build_step. Invoke only the returned declared role in a fresh child for this authenticated parent turn. Never choose a role from prose, reuse a child on a later parent turn, or treat free-form child text as a handoff. If the user requests an edit after QA approval, call agent_builder__workflow_reopen before preparing a fresh PM child; this atomically invalidates the prior test and approval. Publish only with agent_builder__workflow_publish after the typed state says publish_ready; that exact call requires current-user approval.",
          "",
          roster.content,
        ].join("\n"),
      });
    },
  },
});
