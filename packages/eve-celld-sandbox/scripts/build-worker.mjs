import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { portableBash } from "./portable-bash.mjs";
const settings = {
  bundle: true,
  plugins: [portableBash],
  format: "esm",
  platform: "browser",
  target: "es2023",
  external: ["cloudflare:workers", "node:*"],
  logLevel: "info",
};
if (process.argv[2]) {
  await build({
    ...settings,
    entryPoints: [process.argv[2]],
    outfile: process.argv[3],
  });
} else {
  const result = await build({
    ...settings,
    entryPoints: ["src/worker/index.ts", "src/worker/just-bash.ts"],
    outdir: "dist/worker",
    metafile: true,
  });
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(input));
    while (directory !== dirname(directory)) {
      try {
        const manifest = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (manifest.name) {
          packages.set(directory, manifest);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
  }
  const notices = [];
  for (const [directory, manifest] of [...packages].sort((a, b) =>
    a[1].name.localeCompare(b[1].name),
  )) {
    notices.push(
      `${manifest.name}@${manifest.version}\nLicense: ${manifest.license ?? "See upstream license"}\nRepository: ${typeof manifest.repository === "string" ? manifest.repository : (manifest.repository?.url ?? "unspecified")}`,
    );
    const files = (await readdir(directory))
      .filter((name) => /^(license|licence|notice|copying)(?:\.|$)/i.test(name))
      .sort();
    for (const file of files)
      notices.push(`${file}\n${await readFile(join(directory, file), "utf8")}`);
    if (!files.length)
      notices.push(
        "The upstream npm package contains no separate license text. Its declared license is recorded above.",
      );
  }
  await writeFile(
    "dist/worker/THIRD_PARTY_NOTICES.txt",
    notices.join("\n\n---\n\n") + "\n",
  );
}
