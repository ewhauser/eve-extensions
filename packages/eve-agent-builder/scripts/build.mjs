import { spawnSync } from "node:child_process";

function run(command, args) {
  return spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

const clean = run("pnpm", ["run", "clean"]);
if (clean.error !== undefined) throw clean.error;
if (clean.status !== 0) process.exit(clean.status ?? 1);

const build = run("eve", ["extension", "build"]);
await import("./restore-hybrid-exports.mjs");
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
