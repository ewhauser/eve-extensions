import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Run the active-runner child and keep its session available for another turn.",
  inputSchema: z.object({
    message: z.string(),
    outputSchema: z.record(z.string(), z.json()).optional(),
  }).strict(),
  async serve(receive, ctx) {
    "use workflow";
    const agent = ctx.agent("active-runner");
    for (;;) {
      const { input } = await receive();
      const response = await agent.send(input.message, input.outputSchema === undefined
        ? undefined
        : { outputSchema: input.outputSchema });
      const result = await response.result();
      if (result.status === "failed") throw new Error(result.error?.message ?? "Child active-runner failed.");
      ctx.reply(result.data ?? result.message ?? null);
    }
  },
});
