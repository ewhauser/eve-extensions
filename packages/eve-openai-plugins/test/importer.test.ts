import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACCESS_POLICY_PATH,
  applyPluginImport,
  checkPluginInstallation,
  inspectPlugin,
  parseMarkdownDocument,
  parseSourceSpecifier,
  planPluginImport,
  readPluginLockfile,
  removePlugin,
  resolvePluginSource,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), `${name}-`));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = resolve(root, path);
  await mkdir(resolve(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
}

async function fixture(): Promise<{ plugin: string; project: string }> {
  const root = await temporary("openai-plugin");
  const plugin = resolve(root, "plugin");
  const project = resolve(root, "project");
  await mkdir(plugin, { recursive: true });
  await mkdir(project, { recursive: true });
  await put(
    plugin,
    ".codex-plugin/plugin.json",
    JSON.stringify({
      name: "design-suite",
      version: "1.2.3",
      description: "Design and inspect product interfaces.",
      license: "MIT",
      skills: "./skills/",
      apps: "./.app.json",
      mcpServers: "./.mcp.json",
      hooks: { beforeTool: "./hooks/check.js" },
    }),
  );
  await put(
    plugin,
    "skills/inspect/SKILL.md",
    `---
name: inspect-design
description: >-
  Inspect a design and report
  concrete implementation details.
metadata-key: metadata-value
---
# Inspect design

Read references/checklist.md before reporting.
`,
  );
  await put(plugin, "skills/inspect/references/checklist.md", "# Checklist\n\n- Layout\n- Color\n");
  await put(plugin, "skills/inspect/assets/pixel.bin", Uint8Array.from([0, 255, 1, 2]));
  await put(
    plugin,
    "commands/review.md",
    `---
description: Review a supplied design.
---
Read skills/inspect/SKILL.md and review $ARGUMENTS.
`,
  );
  await put(
    plugin,
    "agents/reviewer.md",
    `---
name: design-reviewer
description: Review designs independently and return actionable findings.
tools: [Read, Glob]
---
You are a design reviewer. Load the inspect-design skill before working.
`,
  );
  await put(
    plugin,
    ".app.json",
    JSON.stringify({ apps: { figma: { id: "connector_figma", required: true } } }),
  );
  await put(
    plugin,
    ".mcp.json",
    JSON.stringify({ mcpServers: { publicDesign: { type: "http", url: "https://example.test/mcp" } } }),
  );
  await put(project, "agent/agent.ts", 'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.5" });\n');
  await put(project, "agent/extensions/openai.ts", "export default {};\n");
  return { plugin, project };
}

describe("plugin inspection", () => {
  it("normalizes skills, commands, agents, apps, MCP, and unsupported hooks", async () => {
    const { plugin } = await fixture();
    const inspected = await inspectPlugin(plugin);
    expect(inspected.manifest.name).toBe("design-suite");
    expect(inspected.skills).toHaveLength(1);
    expect(inspected.skills[0]?.description).toBe("Inspect a design and report concrete implementation details.");
    expect(Array.from(inspected.skills[0]?.files["assets/pixel.bin"] ?? [])).toEqual([0, 255, 1, 2]);
    expect(inspected.commands.map((command) => command.id)).toEqual(["review"]);
    expect(inspected.agents[0]?.declaredTools).toEqual(["Read", "Glob"]);
    expect(inspected.apps).toEqual([{ name: "figma", id: "connector_figma", required: true }]);
    expect(inspected.mcpServers[0]?.url).toBe("https://example.test/mcp");
    expect(inspected.unsupported).toContain(
      "Plugin hooks are not executed or translated; review and port them as Eve hooks explicitly.",
    );
  });

  it("rejects symbolic links anywhere in a plugin", async () => {
    const { plugin } = await fixture();
    await symlink("SKILL.md", resolve(plugin, "skills/inspect/linked.md"));
    await expect(inspectPlugin(plugin)).rejects.toThrow("may not contain symbolic links");
  });
});

describe("plan and apply", () => {
  it("writes runtime-gated Eve capabilities, static opt-in connections, and a deterministic lock", async () => {
    const { plugin, project } = await fixture();
    const options = {
      projectRoot: project,
      source: { kind: "local" as const, path: plugin },
      allowStaticConnections: true,
    };
    const plan = await planPluginImport(options);
    expect(plan.conflicts).toEqual([]);
    expect(plan.lockfileChanged).toBe(true);
    expect(plan.accessPolicy).toEqual({ path: ACCESS_POLICY_PATH, willCreate: true });
    expect(plan.requirements.apps[0]?.id).toBe("connector_figma");
    expect(plan.changes.map((change) => change.path)).toContain(
      "agent/subagents/openai-plugin--design-suite--design-reviewer/agent.ts",
    );
    expect(plan.changes.map((change) => change.path)).toContain(
      "agent/connections/openai-plugin--design-suite--publicdesign.ts",
    );

    await applyPluginImport(options);
    const dynamicSkill = await readFile(
      resolve(project, "agent/skills/openai-plugin--design-suite--inspect-design.ts"),
      "utf8",
    );
    expect(dynamicSkill).toContain('"turn.started"');
    expect(dynamicSkill).toContain("isOpenAIPluginEnabled");
    expect(dynamicSkill).toContain("Buffer.from");
    const childExtension = await readFile(
      resolve(project, "agent/subagents/openai-plugin--design-suite--design-reviewer/extensions/openai.ts"),
      "utf8",
    );
    expect(childExtension).toContain('from "eve-openai-connectors"');
    expect(childExtension).toContain("getOpenAIPluginConnectorToken");
    expect(childExtension).toContain('allowedServices: ["figma"]');
    const rootCommand = await readFile(
      resolve(project, "agent/skills/openai-plugin--design-suite--command-review.ts"),
      "utf8",
    );
    expect(rootCommand).toContain('the Eve skill \\"openai-plugin--design-suite--inspect-design\\"');
    const childCommand = await readFile(
      resolve(
        project,
        "agent/subagents/openai-plugin--design-suite--design-reviewer/skills/command-review.ts",
      ),
      "utf8",
    );
    expect(childCommand).toContain('the Eve skill \\"inspect-design\\"');
    expect(childCommand).not.toContain("openai-plugin--design-suite--inspect-design");
    expect(await checkPluginInstallation(project)).toEqual({ ok: true, problems: [] });

    const lock = await readPluginLockfile(project);
    expect(lock.plugins["design-suite"]?.model).toBe("openai/gpt-5.5");
    const secondPlan = await planPluginImport(options);
    expect(secondPlan.accessPolicy.willCreate).toBe(false);
    expect(secondPlan.lockfileChanged).toBe(false);
    expect(secondPlan.changes.every((change) => change.kind === "unchanged")).toBe(true);
  });

  it("inherits the literal model from the exported root agent only", async () => {
    const { plugin, project } = await fixture();
    await put(
      project,
      "agent/agent.ts",
      `import { defineAgent } from "eve";
const compaction = { model: "openai/gpt-5-mini" };
// model: "openai/gpt-commented"
export default defineAgent({ model: "openai/gpt-5.5", compaction });
`,
    );
    await applyPluginImport({ projectRoot: project, source: { kind: "local", path: plugin } });
    expect((await readPluginLockfile(project)).plugins["design-suite"]?.model).toBe(
      "openai/gpt-5.5",
    );
  });

  it("rewrites long plugin command references to the final hashed skill name", async () => {
    const { plugin, project } = await fixture();
    const manifestPath = resolve(plugin, ".codex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.name = "design-suite-with-an-intentionally-long-name-that-requires-stable-hashing-across-references";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await applyPluginImport({ projectRoot: project, source: { kind: "local", path: plugin } });

    const skillDirectory = resolve(project, "agent/skills");
    const generated = await Promise.all(
      (await readdir(skillDirectory)).map(async (file) => ({
        file,
        source: await readFile(resolve(skillDirectory, file), "utf8"),
      })),
    );
    const skill = generated.find((entry) => entry.source.includes("# Inspect design"));
    const command = generated.find((entry) => entry.source.includes("# Imported command:"));
    expect(skill).toBeDefined();
    expect(command?.source).toContain(`the Eve skill \\"${skill?.file.replace(/\.ts$/, "")}\\"`);
  });

  it("refuses to overwrite a user-modified generated file", async () => {
    const { plugin, project } = await fixture();
    const options = { projectRoot: project, source: { kind: "local" as const, path: plugin } };
    await applyPluginImport(options);
    const generated = resolve(project, "agent/skills/openai-plugin--design-suite--inspect-design.ts");
    await writeFile(generated, `${await readFile(generated, "utf8")}\n// user edit\n`);
    await expect(applyPluginImport(options)).rejects.toThrow("refusing to overwrite");
    expect((await checkPluginInstallation(project)).ok).toBe(false);
  });

  it("removes only owned files and preserves the shared access policy", async () => {
    const { plugin, project } = await fixture();
    await applyPluginImport({ projectRoot: project, source: { kind: "local", path: plugin } });
    const result = await removePlugin(project, "design-suite");
    expect(result.changes.length).toBeGreaterThan(0);
    expect(await readFile(resolve(project, ACCESS_POLICY_PATH), "utf8")).toContain("return true");
    expect((await readPluginLockfile(project)).plugins).toEqual({});
  });

  it("emits a filesystem graph accepted by the Eve compiler", { timeout: 30_000 }, async () => {
    const { plugin, project } = await fixture();
    await put(
      project,
      "agent/extensions/openai.ts",
      `import openaiConnectors from "eve-openai-connectors";
export default openaiConnectors({ getToken: () => null });
`,
    );
    await put(project, "agent/instructions.md", "You are a generated plugin test agent.\n");
    await put(
      project,
      "package.json",
      JSON.stringify({
        name: "generated-plugin-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { eve: "0.38.0", "eve-openai-connectors": "0.1.0" },
      }),
    );
    await mkdir(resolve(project, "node_modules"), { recursive: true });
    await symlink(resolve(packageRoot, "node_modules/eve"), resolve(project, "node_modules/eve"), "dir");
    await symlink(resolve(packageRoot, "../eve-openai-connectors"), resolve(project, "node_modules/eve-openai-connectors"), "dir");
    await applyPluginImport({
      projectRoot: project,
      source: { kind: "local", path: plugin },
      allowStaticConnections: true,
    });
    const eveBin = resolve(packageRoot, "node_modules/eve/bin/eve.js");
    const result = await execFileAsync(process.execPath, [eveBin, "build"], {
      cwd: project,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(result.stdout).toContain("built");
  });
});

describe("parsers", () => {
  it("parses source adapters without conflating Git refs and plugin paths", () => {
    expect(parseSourceSpecifier("git+https://example.test/plugins.git#main", { pluginPath: "plugins/figma" })).toEqual({
      kind: "git",
      url: "https://example.test/plugins.git",
      ref: "main",
      pluginPath: "plugins/figma",
    });
    expect(parseSourceSpecifier("npm:@example/plugin@1.0.0")).toEqual({ kind: "npm", spec: "@example/plugin@1.0.0" });
  });

  it("preserves markdown without frontmatter", () => {
    expect(parseMarkdownDocument("# Plain\n")).toEqual({ body: "# Plain\n", frontmatter: {} });
  });

  it("resolves a Git plugin without executing repository code", async () => {
    const { plugin } = await fixture();
    await execFileAsync("git", ["init", "-q"], { cwd: plugin });
    await execFileAsync("git", ["add", "."], { cwd: plugin });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"],
      { cwd: plugin },
    );
    const source = await resolvePluginSource({ kind: "git", url: plugin });
    try {
      expect((await inspectPlugin(source.root)).manifest.name).toBe("design-suite");
    } finally {
      await source.cleanup();
    }
  });

  it("extracts npm sources safely with lifecycle scripts disabled", async () => {
    const { plugin } = await fixture();
    await put(
      plugin,
      "package.json",
      JSON.stringify({
        name: "design-suite-fixture",
        version: "1.2.3",
        files: [".codex-plugin", "skills", "commands", "agents", ".app.json", ".mcp.json"],
        scripts: { prepack: "node -e \"require('node:fs').writeFileSync('SCRIPT_RAN', 'yes')\"" },
      }),
    );
    const source = await resolvePluginSource({ kind: "npm", spec: `file:${plugin}` });
    try {
      expect((await inspectPlugin(source.root)).manifest.version).toBe("1.2.3");
      await expect(access(resolve(plugin, "SCRIPT_RAN"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await source.cleanup();
    }
  });

  it("rejects npm archives whose decompressed tar exceeds the safety bound", { timeout: 30_000 }, async () => {
    const { plugin } = await fixture();
    await put(
      plugin,
      "package.json",
      JSON.stringify({
        name: "design-suite-oversized-fixture",
        version: "1.2.3",
        files: [".codex-plugin", "oversized.bin"],
      }),
    );
    await put(plugin, "oversized.bin", Buffer.alloc(34 * 1024 * 1024));
    await expect(resolvePluginSource({ kind: "npm", spec: `file:${plugin}` })).rejects.toThrow(
      /archive expands beyond the safe size limit/,
    );
  });
});
