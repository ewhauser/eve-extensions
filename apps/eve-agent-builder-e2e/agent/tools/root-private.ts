import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Root-only canary tool that must never reach a declared child.",
  inputSchema: z.object({}).strict(),
  execute: async () => ({ marker: "ROOT_PRIVATE_TOOL_03" }),
});
