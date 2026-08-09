import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { packPackage, packages } from "./package-artifacts.mjs";

const releasePaths = JSON.parse(process.env.RELEASE_PATHS ?? "[]");
if (!Array.isArray(releasePaths) || releasePaths.length === 0) {
  throw new Error("RELEASE_PATHS must be a non-empty JSON array");
}

const uniquePaths = [...new Set(releasePaths)];
for (const packagePath of uniquePaths) {
  if (!packages.has(packagePath)) {
    throw new Error(`refusing unknown release path: ${packagePath}`);
  }
}

const destination = resolve("release-artifacts");
mkdirSync(destination, { recursive: false });

for (const packagePath of uniquePaths.sort()) {
  const { manifest, tarball } = packPackage(packagePath, destination);
  console.log(`packed ${manifest.name}@${manifest.version} at ${tarball}`);
}
