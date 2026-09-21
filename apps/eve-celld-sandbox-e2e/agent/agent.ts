import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  ...(process.env.EVE_MODEL ? {} : { modelContextWindowTokens: 32000 }),
  model:
    process.env.EVE_MODEL ??
    mockModel(({ lastUserMessage, userMessageCount, toolResults }) => {
      // One real Eve bash call per user turn, followed by the observed result.
      const command = lastUserMessage?.includes("read saved")
        ? "celld-runtime; agentfs-info; cat result.txt"
        : "celld-runtime; agentfs-info; cat bootstrap.txt; cat records.json | jq '[.[].score] | add' > result.txt; cat result.txt";
      const result =
        toolResults.filter((r) => r.name === "bash").length >= userMessageCount
          ? toolResults.at(-1)
          : undefined;
      return result
        ? JSON.stringify(result.output)
        : { toolCalls: [{ name: "bash", input: { command } }] };
    }),
});
