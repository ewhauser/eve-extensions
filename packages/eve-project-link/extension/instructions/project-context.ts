import { defineInstructions } from "eve/instructions";
import { defineDynamic } from "eve/tools";

import extension from "../extension.js";
import { renderProjectContext } from "../lib/context.js";
import {
  getProjectLinkService,
  resolveProjectChannel,
} from "../lib/runtime.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const channel = await resolveProjectChannel(ctx);
      if (!channel) return null;
      const binding = await getProjectLinkService().status(channel);
      if (binding?.status !== "active" || !binding.context) return null;

      return defineInstructions({
        markdown: `${renderProjectContext(binding, extension.config.maxContextCharacters)}\n\nUse this compact card for routine answers. When freshness or omitted detail matters, use the mounted project-link status/refresh tools and the external provider's retrieval tools. Cite source URLs from the card when they support a claim.`,
      });
    },
  },
});
