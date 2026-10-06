import { defineSandbox } from "eve/sandbox";
import { CelldJustBashSandbox } from "eve-celld-sandbox";

export const environment = CelldJustBashSandbox.environment({
  endpoint: process.env.CELLD_ENDPOINT ?? "http://127.0.0.1:9876",
  token: process.env.CELLD_TOKEN ?? "",
  namespace: process.env.CELLD_NAMESPACE ?? "eve-demo",
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  const result = await sandbox.run({ command: "echo template-ready > bootstrap.txt" });
  if (result.exitCode) throw new Error(result.stderr);
  return sandbox;
});
