import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const repositoryUrl = "git+https://github.com/ewhauser/eve-extensions.git";

const agentBuilderPublicModules = [
  "public",
  "bootstrap",
  "capabilities",
  "discovery",
  "domain",
  "roles",
  "service",
  "store",
  "test-policy",
  "workflow",
  "workflow-service",
  "stores/memory",
  "testing/bootstrap-conformance",
  "testing/store-conformance",
  "testing/test-policy-conformance",
  "testing/workflow-conformance",
  "runtime/owner",
  "runtime/service",
  "mounts/active-runner-hooks",
  "mounts/active-runner-instructions",
  "mounts/active-runner-persona",
  "mounts/active-runner-tools",
  "mounts/implementor-draft-instructions",
  "mounts/implementor-hooks",
  "mounts/implementor-persona",
  "mounts/implementor-tools",
  "mounts/personas",
  "mounts/pm-draft-instructions",
  "mounts/pm-hooks",
  "mounts/pm-persona",
  "mounts/pm-tools",
  "mounts/qa-draft-instructions",
  "mounts/qa-hooks",
  "mounts/qa-persona",
  "mounts/qa-tools",
  "mounts/root-instructions",
  "mounts/root-hooks",
  "mounts/root-tools",
  "mounts/runner-agent",
  "mounts/runner-hooks",
  "mounts/runner-instructions",
  "mounts/runner-tools",
  "mounts/test-runner-hooks",
  "mounts/test-runner-instructions",
  "mounts/test-runner-persona",
  "mounts/test-runner-tools",
];

export const packages = new Map([
  [
    "packages/eve-agent-builder",
    {
      name: "eve-agent-builder",
      requiredFiles: [
        "dist/index.d.ts",
        "dist/index.mjs",
        "dist/extension/_manifest.json",
        "dist/extension/extension.d.ts",
        "dist/extension/extension.mjs",
        ...agentBuilderPublicModules.flatMap((module) => [
          `dist/extension/lib/${module}.d.ts`,
          `dist/extension/lib/${module}.mjs`,
        ]),
        "LICENSE",
        "README.md",
      ],
    },
  ],
  [
    "packages/eve-slack-participation",
    {
      name: "eve-slack-participation",
      requiredFiles: [
        "dist/index.d.ts",
        "dist/index.mjs",
        "dist/extension/slack.d.ts",
        "dist/extension/slack.mjs",
        "dist/extension/lib/types.d.ts",
        "dist/extension/lib/types.mjs",
        "dist/tools/index.d.ts",
        "dist/tools/index.mjs",
        "LICENSE",
        "README.md",
      ],
    },
  ],
  [
    "packages/eve-project-link",
    {
      name: "eve-project-link",
      requiredFiles: [
        "dist/index.d.ts",
        "dist/index.mjs",
        "dist/tools/index.d.ts",
        "dist/tools/index.mjs",
        "dist/extension/presets/index.d.ts",
        "dist/extension/presets/index.mjs",
        "dist/extension/presets/preset.d.ts",
        "dist/extension/presets/preset.mjs",
        "dist/extension/presets/notion.d.ts",
        "dist/extension/presets/notion.mjs",
        "dist/extension/presets/linear.d.ts",
        "dist/extension/presets/linear.mjs",
        "dist/extension/presets/custom.d.ts",
        "dist/extension/presets/custom.mjs",
        "dist/extension/stores/memory.d.ts",
        "dist/extension/stores/memory.mjs",
        "dist/extension/lib/types.d.ts",
        "dist/extension/lib/types.mjs",
        "dist/extension/skills/project-link/SKILL.md",
        "PRESETS.md",
        "LICENSE",
        "README.md",
      ],
    },
  ],
  [
    "packages/eve-progress",
    {
      name: "eve-progress",
      requiredFiles: [
        "dist/index.d.ts",
        "dist/index.mjs",
        "dist/extension/_manifest.json",
        "dist/extension/extension.d.ts",
        "dist/extension/extension.mjs",
        "dist/extension/hooks/progress.d.ts",
        "dist/extension/hooks/progress.mjs",
        "dist/extension/instructions.md",
        "dist/extension/lib/projection.d.ts",
        "dist/extension/lib/projection.mjs",
        "dist/extension/lib/types.d.ts",
        "dist/extension/lib/types.mjs",
        "dist/extension/slack.d.ts",
        "dist/extension/slack.mjs",
        "dist/extension/skills/work-plan/SKILL.md",
        "patches/eve@0.38.0.patch",
        "LICENSE",
        "README.md",
      ],
    },
  ],
  [
    "packages/eve-openai-compaction",
    {
      name: "eve-openai-compaction",
      requiredFiles: [
        "dist/index.d.ts",
        "dist/index.js",
        "patches/eve@0.38.0-source.patch",
        "patches/eve@0.38.0.patch",
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
        "patches/eve@0.45.0.patch",
        "LICENSE",
        "README.md",
      ],
    },
  ],
  [
    "packages/eve-openai-imagegen",
    {
      name: "eve-openai-imagegen",
      requiredFiles: [
        "dist/index.d.ts",
        "dist/index.mjs",
        "dist/tools/index.d.ts",
        "dist/tools/index.mjs",
        "dist/extension/skills/imagegen/SKILL.md",
        "LICENSE",
        "README.md",
      ],
    },
  ],
  [
    "packages/eve-openai-plugins",
    {
      name: "eve-openai-plugins",
      requiredFiles: [
        "dist/cli.d.ts",
        "dist/cli.js",
        "dist/index.d.ts",
        "dist/index.js",
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
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    typeof result.filename !== "string" ||
    !Array.isArray(result.files)
  ) {
    throw new Error(`pnpm pack returned an unexpected result for ${packagePath}`);
  }
  return result;
}

function runPack(packagePath, args) {
  return execFileSync(
    "pnpm",
    ["--config.ignore-scripts=true", "pack", "--json", ...args],
    { cwd: packagePath, encoding: "utf8" },
  );
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

function validatePackedManifest(packagePath, sourceManifest, tarball) {
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  const failures = [];

  if (packedManifest.name !== sourceManifest.name) {
    failures.push(`expected packed name ${sourceManifest.name}, found ${packedManifest.name}`);
  }
  if (packedManifest.version !== sourceManifest.version) {
    failures.push(
      `expected packed version ${sourceManifest.version}, found ${packedManifest.version}`,
    );
  }

  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, specifier] of Object.entries(packedManifest[field] ?? {})) {
      if (typeof specifier === "string" && /^(?:catalog|workspace):/.test(specifier)) {
        failures.push(`${field}.${name} contains unresolved specifier ${specifier}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`${packagePath} has an invalid packed manifest:\n- ${failures.join("\n- ")}`);
  }
}

function normalizePackResult(packResult, tarball) {
  return {
    ...packResult,
    entryCount: packResult.files.length,
    size: statSync(tarball).size,
  };
}

export function checkPackage(packagePath) {
  const expected = packages.get(packagePath);
  if (!expected) throw new Error(`refusing unknown package path: ${packagePath}`);

  const manifest = validateManifest(packagePath, expected);
  const destination = mkdtempSync(join(tmpdir(), "eve-package-check-"));
  try {
    const output = runPack(packagePath, ["--pack-destination", destination]);
    const parsed = parsePackOutput(output, packagePath);
    const tarball = join(destination, basename(parsed.filename));
    const packResult = normalizePackResult(parsed, tarball);
    validateContents(packagePath, expected, packResult);
    validatePackedManifest(packagePath, manifest, tarball);
    return { manifest, packResult };
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

export function packPackage(packagePath, destination) {
  const expected = packages.get(packagePath);
  if (!expected) throw new Error(`refusing unknown package path: ${packagePath}`);

  const manifest = validateManifest(packagePath, expected);
  const output = runPack(packagePath, ["--pack-destination", resolve(destination)]);
  const parsed = parsePackOutput(output, packagePath);
  const tarball = join(destination, basename(parsed.filename));
  const packResult = normalizePackResult(parsed, tarball);
  validateContents(packagePath, expected, packResult);
  validatePackedManifest(packagePath, manifest, tarball);

  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  return { manifest, packResult, tarball };
}
