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

const build = run("eve", ["build"]);
await import("../../../packages/eve-agent-builder/scripts/restore-hybrid-exports.mjs");
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
