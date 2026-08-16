import { spawnSync } from "node:child_process";

function run(command, args) {
  return spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

const prepared = run("pnpm", ["run", "fixture:prepare"]);
if (prepared.error !== undefined) throw prepared.error;
if (prepared.status !== 0) process.exit(prepared.status ?? 1);

const result = run("eve", ["eval", "--strict", "--skip-report"]);
await Promise.all([
  import("./redact-bootstrap-tokens.mjs"),
  import("../../../packages/eve-agent-builder/scripts/restore-hybrid-exports.mjs"),
]);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
