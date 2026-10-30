import { defineDynamic, defineInstructions } from "eve/instructions";

import { getProjectLinkConfig } from "../extension.js";
import {
  renderPendingProjectLink,
  renderProjectContext,
  renderProjectPointer,
} from "../lib/context.js";
import {
  getProjectLinkService,
  resolveProjectChannel,
} from "../lib/runtime.js";

export default defineDynamic(async (ctx) => {
      const config = getProjectLinkConfig();
      const channel = await resolveProjectChannel(ctx);
      if (!channel) return null;
      const service = getProjectLinkService();
      const binding = await service.status(channel);
      if (!binding) return null;
      const plan = service.plan(binding);

      if (binding.status === "pending") {
        return defineInstructions({
          content: renderPendingProjectLink(
            plan,
            config.maxPromptCharacters,
          ),
        });
      }

      if (plan.activeContextMode === "pointer") {
        return defineInstructions({
          content: renderProjectPointer(
            binding,
            config.maxPointerPromptCharacters,
          ),
        });
      }

      return defineInstructions({
        content: `${renderProjectContext(binding, config.maxPromptCharacters, plan)}\n\nUse this compact card for routine orientation. When freshness or omitted detail matters, follow the configured retrieval guidance with mounted tools, then save a newly curated card. Synchronize the external system only when the user requests it. Cite source URLs when they support a claim.`,
      });
});
