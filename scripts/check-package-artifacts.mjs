import { checkPackage, packages } from "./package-artifacts.mjs";

for (const packagePath of packages.keys()) {
  const { manifest, packResult } = checkPackage(packagePath);
  console.log(
    `checked ${manifest.name}@${manifest.version}: ${packResult.entryCount} files, ${packResult.size} bytes packed`,
  );
}
