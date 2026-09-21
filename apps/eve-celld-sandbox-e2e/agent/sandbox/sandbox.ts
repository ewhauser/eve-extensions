import { defineSandbox } from "eve/sandbox";
import { celldJustBash } from "eve-celld-sandbox";
export default defineSandbox({
  backend: celldJustBash({
    endpoint: process.env.CELLD_ENDPOINT ?? "http://127.0.0.1:9876",
    token: process.env.CELLD_TOKEN ?? "",
    namespace: process.env.CELLD_NAMESPACE ?? "eve-demo",
  }),
  async bootstrap({ use }) {
    const sandbox = await use();
    const result = await sandbox.run({
      command: "echo template-ready > bootstrap.txt",
    });
    if (result.exitCode) throw new Error(result.stderr);
  },
});
