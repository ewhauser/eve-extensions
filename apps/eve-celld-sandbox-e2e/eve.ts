import "./config.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const bin = join(dirname(require.resolve("eve/package.json")), "bin/eve.js");
const args =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ["invoke", "calculate and save"];
const invoke = args[0] === "invoke";
const child = spawn(process.execPath, [bin, ...args], {
  cwd: new URL(".", import.meta.url),
  env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" },
  stdio: invoke ? ["inherit", "pipe", "inherit"] : "inherit",
});
// Eve emits development sandbox progress to stdout even for `invoke`.
// Route its progress lines to stderr so stdout remains resumable JSON.
if (invoke) {
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) =>
    (/^(?:eve:|\[eve:)/.test(line) ? process.stderr : process.stdout).write(
      line + "\n",
    ),
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
