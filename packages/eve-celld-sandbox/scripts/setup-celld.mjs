import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
const root = new URL("../", import.meta.url);
const assets = {
  "darwin-arm64": [
    "aarch64-apple-darwin",
    "f330823e049e64276ca7133957f4d50897cf8f5d34e7a53f621b2bfe63994861",
  ],
  "linux-arm64": [
    "aarch64-unknown-linux-gnu",
    "375c7cd9446d61e6ee2c263d6be792650153ffd7cd562b2c4b6b644776b4494e",
  ],
  "linux-x64": [
    "x86_64-unknown-linux-gnu",
    "b9f205da7365ef4a8b2e16f1f48065a8ddd5cda366edc258fea12a097d8ab4b7",
  ],
};
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
const asset = assets[`${process.platform}-${process.arch}`];
if (!asset)
  throw new Error(
    "celld 0.5.1 provides macOS arm64 and Linux arm64/x64 binaries. Use a supported platform.",
  );
const bin = new URL(".tools/celld", root);
if (!(await exists(bin))) {
  console.log("Downloading celld 0.5.1 from the upstream release…");
  const response = await fetch(
    `https://github.com/denoland/celld/releases/download/v0.5.1/celld-${asset[0]}.gz`,
  );
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(compressed).digest("hex") !== asset[1])
    throw new Error("celld download checksum mismatch");
  await mkdir(new URL(".tools/", root), { recursive: true });
  await writeFile(bin, gunzipSync(compressed));
  await chmod(bin, 0o755);
}
if (
  !execFileSync(bin.pathname, ["--version"], { encoding: "utf8" }).includes(
    "celld 0.5.1",
  )
)
  throw new Error("Expected celld 0.5.1; remove .tools/celld and rerun setup");
console.log("celld 0.5.1 is ready for integration tests.");
