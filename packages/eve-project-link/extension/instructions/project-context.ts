import { defineInstructions } from "eve/instructions";
import { defineDynamic } from "eve/tools";

import { getProjectLinkConfig } from "../extension.js";
import {
  renderPendingProjectLink,
  renderProjectContext,
} from "../lib/context.js";
import {
  getProjectLinkService,
  resolveProjectChannel,
} from "../lib/runtime.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const config = getProjectLinkConfig();
      const channel = await resolveProjectChannel(ctx);
      if (!channel) return null;
      const service = getProjectLinkService();
      const binding = await service.status(channel);
      if (!binding) return null;
      const plan = service.plan(binding);

      if (binding.status === "pending") {
        return defineInstructions({
          markdown: renderPendingProjectLink(
            plan,
            config.maxPromptCharacters,
          ),
        });
      }

      return defineInstructions({
        markdown: `${renderProjectContext(binding, config.maxPromptCharacters, plan)}\n\nUse this compact card for routine orientation. When freshness or omitted detail matters, follow the configured retrieval guidance with mounted tools, then save a newly curated card. Synchronize the external system only when the user requests it. Cite source URLs when they support a claim.`,
      });
    },
  },
});
