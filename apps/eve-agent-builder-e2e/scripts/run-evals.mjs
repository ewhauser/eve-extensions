import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, env = process.env) {
  return spawnSync(command, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
}

const prepared = run("pnpm", ["run", "fixture:prepare"]);
if (prepared.error !== undefined) throw prepared.error;
if (prepared.status !== 0) process.exit(prepared.status ?? 1);

// Each fixture invocation starts with fresh in-memory stores. Replaying a
// previous invocation's unfinished workflows against those stores is invalid.
rmSync(new URL("../.eve/.workflow-data/", import.meta.url), {
  recursive: true,
  force: true,
});

// Keep the pinned SDK's runtime database separate from a developer's other
// microsandbox installations, which can have newer schema migrations.
const sandboxHome = mkdtempSync(join(tmpdir(), "eve-agent-builder-e2e-msb-"));
let result;
try {
  result = run("eve", ["eval", "--strict", "--skip-report"], {
    ...process.env,
    MSB_HOME: sandboxHome,
  });
} finally {
  await Promise.all([
    import("./redact-bootstrap-tokens.mjs"),
    import("../../../packages/eve-agent-builder/scripts/restore-hybrid-exports.mjs"),
  ]);
  rmSync(sandboxHome, { recursive: true, force: true });
}
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
