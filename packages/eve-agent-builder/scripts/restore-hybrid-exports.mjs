import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.exports["."] = {
  types: "./dist/extension/lib/public.d.ts",
  import: "./dist/extension/lib/public.mjs",
  default: "./dist/extension/lib/public.mjs",
};
delete manifest.exports["./tools"];
const next = `${JSON.stringify(manifest, null, 2)}\n`;
if (readFileSync(path, "utf8") !== next) writeFileSync(path, next);
