import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const repositoryUrl = "git+https://github.com/ewhauser/eve-extensions.git";

export const packages = new Map([
  [
    "packages/eve-openai-compaction",
    {
      name: "eve-openai-compaction",
      requiredFiles: [
        "dist/index.d.ts",
        "dist/index.js",
        "patches/eve@0.31.3-source.patch",
        "patches/eve@0.31.3.patch",
        "LICENSE",
        "README.md",
      ],
    },
  ],
  [
    "packages/eve-openai-connectors",
    {
      name: "eve-openai-connectors",
      requiredFiles: [
        "dist/index.d.ts",
        "dist/index.mjs",
        "dist/tools/index.d.ts",
        "dist/tools/index.mjs",
        "LICENSE",
        "README.md",
      ],
    },
  ],
  [
    "packages/eve-aws-lambda-microvms",
    {
      name: "eve-aws-lambda-microvms",
      requiredFiles: [
        "dist/controller/controller.py",
        "dist/controller/Dockerfile",
        "dist/controller/launcher.py",
        "dist/controller/start.sh",
        "dist/index.d.ts",
        "dist/index.js",
        "LICENSE",
        "NOTICE",
        "README.md",
      ],
    },
  ],
]);

function readManifest(packagePath) {
  return JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
}

function validateManifest(packagePath, expected) {
  const manifest = readManifest(packagePath);
  const failures = [];

  if (manifest.name !== expected.name) {
    failures.push(`expected name ${expected.name}, found ${manifest.name}`);
  }
  if (manifest.private === true) {
    failures.push("publishable package is marked private");
  }
  if (manifest.publishConfig?.access !== "public") {
    failures.push("publishConfig.access must be public");
  }
  if (manifest.repository?.url !== repositoryUrl) {
    failures.push(`repository.url must be ${repositoryUrl}`);
  }
  if (manifest.repository?.directory !== packagePath) {
    failures.push(`repository.directory must be ${packagePath}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    failures.push(`version is not publishable SemVer: ${manifest.version}`);
  }

  if (failures.length > 0) {
    throw new Error(`${packagePath}/package.json:\n- ${failures.join("\n- ")}`);
  }

  return manifest;
}

function parsePackOutput(output, packagePath) {
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error(`npm pack returned an unexpected result for ${packagePath}`);
  }
  return result[0];
}

function validateContents(packagePath, expected, packResult) {
  const paths = new Set(packResult.files.map((file) => file.path));
  const missing = expected.requiredFiles.filter((file) => !paths.has(file));
  const forbidden = [...paths].filter(
    (file) =>
      file === ".env" ||
      file.startsWith(".env.") ||
      file.startsWith("coverage/") ||
      file.startsWith("node_modules/") ||
      file.startsWith("src/") ||
      file.startsWith("test/"),
  );

  if (missing.length > 0 || forbidden.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
    if (forbidden.length > 0) details.push(`forbidden: ${forbidden.join(", ")}`);
    throw new Error(`${packagePath} has invalid package contents (${details.join("; ")})`);
  }
}

export function checkPackage(packagePath) {
  const expected = packages.get(packagePath);
  if (!expected) throw new Error(`refusing unknown package path: ${packagePath}`);

  const manifest = validateManifest(packagePath, expected);
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--dry-run", "--ignore-scripts"],
    { cwd: packagePath, encoding: "utf8" },
  );
  const packResult = parsePackOutput(output, packagePath);
  validateContents(packagePath, expected, packResult);

  return { manifest, packResult };
}

export function packPackage(packagePath, destination) {
  const expected = packages.get(packagePath);
  if (!expected) throw new Error(`refusing unknown package path: ${packagePath}`);

  const manifest = validateManifest(packagePath, expected);
  const output = execFileSync(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      resolve(destination),
    ],
    { cwd: packagePath, encoding: "utf8" },
  );
  const packResult = parsePackOutput(output, packagePath);
  validateContents(packagePath, expected, packResult);

  const tarball = join(destination, basename(packResult.filename));
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  return { manifest, packResult, tarball };
}
