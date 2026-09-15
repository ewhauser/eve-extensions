import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Wait for the pm child to finish its current turn.",
  inputSchema: z.object({
    agentId: z.string().optional(),
    message: z.string(),
    outputSchema: z.record(z.string(), z.json()).optional(),
  }).strict(),
  async execute(input, ctx) {
    "use workflow";
    return await ctx.agent("pm", {
      message: input.message,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    });
  },
});
