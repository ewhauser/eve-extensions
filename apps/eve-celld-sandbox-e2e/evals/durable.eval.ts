import { defineEval } from "eve/evals";
export default defineEval({
  description:
    "Real Eve bash tool executes remotely and reads a saved result on a later turn",
  async test(t) {
    const first = await t.send("calculate and save");
    t.succeeded();
    t.calledTool("bash", { output: /celld\/just-bash/ });
    t.calledTool("bash", { output: /agentfs/ });
    t.calledTool("bash", { output: /template-ready/ });
    await first.session.send("read saved");
    t.succeeded();
    t.calledTool("bash", { output: /5/ });
  },
});
