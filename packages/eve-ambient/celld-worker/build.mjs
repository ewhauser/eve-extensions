#!/usr/bin/env node
// Bundle the mailbox worker locally with exactly the flags `celld deploy`
// uses, so a bundling failure surfaces here instead of half-way through a
// fleet deploy. Output: build/index.js, which is never uploaded — celld
// re-bundles from `main` at deploy time.
//
//   node build.mjs
//
// index.ts is a one-line re-export of `eve-ambient/celld-worker`, so run this
// from a directory whose node_modules resolves that package — either in place
// inside node_modules/eve-ambient, or from a copy inside your application.
//
// esbuild is the caller's, not this package's: celld shells out to a binary
// rather than depending on one, and so does this script. It is resolved from
// $CELLD_ESBUILD if set — use the same value your fleet uses, so the two
// bundles come from the same compiler — and from `esbuild` on PATH otherwise.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const esbuild = process.env.CELLD_ESBUILD ?? "esbuild";
const outfile = join(here, "build", "index.js");

mkdirSync(join(here, "build"), { recursive: true });

// crates/celld/deploy.rs::run_esbuild
const result = spawnSync(
  esbuild,
  [
    join(here, "index.ts"),
    "--bundle",
    "--format=esm",
    "--platform=browser",
    "--target=es2024",
    "--conditions=workerd,worker,browser",
    "--external:node:*",
    "--external:cloudflare:*",
    "--loader:.wasm=copy",
    `--outfile=${outfile}`,
  ],
  { stdio: "inherit" },
);

if (result.error !== undefined && result.error.code === "ENOENT") {
  console.error(
    `esbuild not found at ${JSON.stringify(esbuild)}. ` +
      "Set CELLD_ESBUILD to the binary your fleet deploys with.",
  );
  process.exit(127);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`bundled -> ${outfile} (${statSync(outfile).size} bytes)`);

// The whole point of src/time.ts and src/mailbox.ts importing no Node
// built-ins is that none of these reach the bundle. (esbuild’s own `__require`
// helper is not a Node import.)
const bundle = readFileSync(outfile, "utf8");
if (/from "node:|Buffer\.byteLength/.test(bundle)) {
  console.error("bundle references Node built-ins; the worker will fail in workerd");
  process.exit(1);
}
console.log("no Node built-ins in the bundle");
