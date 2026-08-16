import { defineDynamic, defineInstructions } from "eve/instructions";

import { getAgentBuilderRuntime, resolveDynamicOwner } from "../runtime/service.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const runtime = getAgentBuilderRuntime();
      const owner = await resolveDynamicOwner(runtime, ctx);
      const roster = await runtime.discovery.roster(owner);
      return defineInstructions({ markdown: roster.content });
    },
  },
});
