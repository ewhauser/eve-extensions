import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type {
  NormalizedAgent,
  NormalizedCommand,
  NormalizedMcpServer,
  NormalizedPlugin,
  NormalizedSkill,
  PluginAppRequirement,
  PluginManifest,
} from "./types.js";
import { pathExists, readJson, resolveInside, sha256, stableJson, toSlug, walkFiles } from "./util.js";

type FrontmatterValue = string | string[];

interface MarkdownDocument {
  body: string;
  frontmatter: Record<string, FrontmatterValue>;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseMarkdownDocument(markdown: string): MarkdownDocument {
  const normalized = markdown.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { body: normalized, frontmatter: {} };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { body: normalized, frontmatter: {} };
  const raw = normalized.slice(4, end).split("\n");
  const frontmatter: Record<string, FrontmatterValue> = {};

  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    if (!line || /^\s/.test(line) || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? "";
    if (!key) continue;
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < raw.length && (/^\s/.test(raw[index + 1] ?? "") || raw[index + 1] === "")) {
        index += 1;
        block.push((raw[index] ?? "").replace(/^\s{1,4}/, ""));
      }
      frontmatter[key] = value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => scalar(item))
        .filter(Boolean);
      continue;
    }
    frontmatter[key] = scalar(value);
  }
  return { body: normalized.slice(end + 5), frontmatter };
}

function stringValue(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value ? [value] : [];
}

function asManifest(value: unknown, path: string): PluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenAI plugin manifest must be an object: ${path}`);
  }
  const candidate = value as Record<string, unknown>;
  for (const key of ["name", "version", "description"] as const) {
    if (typeof candidate[key] !== "string" || candidate[key].length === 0) {
      throw new Error(`OpenAI plugin manifest requires a non-empty ${key}: ${path}`);
    }
  }
  return candidate as PluginManifest;
}

function configuredPaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return [];
}

async function capabilityRoots(root: string, value: unknown, conventional: string): Promise<string[]> {
  const declared = configuredPaths(value);
  const paths = declared.length > 0 ? declared : (await pathExists(resolve(root, conventional)) ? [conventional] : []);
  const output: string[] = [];
  for (const path of paths) {
    const resolved = await resolveInside(root, path, `${conventional} path`);
    if (!(await stat(resolved)).isDirectory()) throw new Error(`${conventional} path is not a directory: ${path}`);
    output.push(resolved);
  }
  return output;
}

function ensureUnique(items: readonly { id: string; sourcePath: string }[], kind: string): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const prior = seen.get(item.id);
    if (prior) throw new Error(`${kind} name collision after normalization: ${prior} and ${item.sourcePath}`);
    seen.set(item.id, item.sourcePath);
  }
}

async function normalizeSkills(root: string, roots: string[], manifest: PluginManifest): Promise<NormalizedSkill[]> {
  const skills: NormalizedSkill[] = [];
  for (const skillsRoot of roots) {
    const tree = await walkFiles(skillsRoot);
    const skillDocuments = tree.filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
    const packageRoots = skillDocuments.map((file) => dirname(file.path) === "." ? "" : dirname(file.path));
    for (let index = 0; index < skillDocuments.length; index += 1) {
      const documentFile = skillDocuments[index];
      if (!documentFile) continue;
      const packageRoot = packageRoots[index] ?? "";
      const parsed = parseMarkdownDocument(Buffer.from(documentFile.bytes).toString("utf8"));
      const sourcePath = relative(root, resolve(skillsRoot, documentFile.path)).split(sep).join("/");
      const inferred = packageRoot ? packageRoot.split("/").at(-1) : "skill";
      const id = toSlug(stringValue(parsed.frontmatter.name) ?? inferred ?? "skill");
      const files: Record<string, Uint8Array> = {};
      for (const file of tree) {
        if (file.path === documentFile.path) continue;
        const relativeToPackage = packageRoot ? file.path.slice(packageRoot.length + 1) : file.path;
        if (packageRoot && !file.path.startsWith(`${packageRoot}/`)) continue;
        const nestedRoot = packageRoots.find(
          (candidate) => candidate !== packageRoot && candidate.startsWith(`${packageRoot}/`) && file.path.startsWith(`${candidate}/`),
        );
        if (nestedRoot) continue;
        files[relativeToPackage] = file.bytes;
      }
      const metadata = Object.fromEntries(
        Object.entries(parsed.frontmatter).filter(
          ([key, value]) =>
            typeof value === "string" && !["name", "description", "license", "allowed-tools", "argument-hint"].includes(key),
        ),
      ) as Record<string, string>;
      const skill: NormalizedSkill = {
        id,
        sourcePath,
        description: stringValue(parsed.frontmatter.description) ?? manifest.description,
        markdown: parsed.body,
        files,
      };
      const license = stringValue(parsed.frontmatter.license) ?? manifest.license;
      if (license) skill.license = license;
      if (Object.keys(metadata).length > 0) skill.metadata = metadata;
      skills.push(skill);
    }
  }
  ensureUnique(skills, "Skill");
  return skills;
}

async function normalizeMarkdownDirectory<T extends NormalizedCommand | NormalizedAgent>(
  root: string,
  roots: string[],
  kind: "command" | "agent",
  manifest: PluginManifest,
): Promise<T[]> {
  const output: Array<NormalizedCommand | NormalizedAgent> = [];
  for (const capabilityRoot of roots) {
    for (const file of await walkFiles(capabilityRoot)) {
      if (!file.path.endsWith(".md")) continue;
      const parsed = parseMarkdownDocument(Buffer.from(file.bytes).toString("utf8"));
      const sourcePath = relative(root, resolve(capabilityRoot, file.path)).split(sep).join("/");
      const id = toSlug(stringValue(parsed.frontmatter.name) ?? file.path.replace(/\.md$/i, ""));
      const description = stringValue(parsed.frontmatter.description) ?? manifest.description;
      if (kind === "command") {
        output.push({ id, sourcePath, description, markdown: parsed.body });
      } else {
        output.push({
          id,
          sourcePath,
          description,
          instructions: parsed.body,
          declaredTools: stringList(parsed.frontmatter.tools ?? parsed.frontmatter["allowed-tools"]),
        });
      }
    }
  }
  ensureUnique(output, kind === "command" ? "Command" : "Agent");
  return output as T[];
}

async function referencedJson(root: string, configured: unknown, conventional: string): Promise<unknown | undefined> {
  if (configured && typeof configured === "object" && !Array.isArray(configured)) return configured;
  const paths = configuredPaths(configured);
  const candidate = paths[0] ?? (await pathExists(resolve(root, conventional)) ? conventional : undefined);
  if (!candidate) return undefined;
  return readJson(await resolveInside(root, candidate, conventional));
}

function normalizeApps(value: unknown): PluginAppRequirement[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const wrapped = value as Record<string, unknown>;
  const apps = wrapped.apps && typeof wrapped.apps === "object" && !Array.isArray(wrapped.apps)
    ? wrapped.apps as Record<string, unknown>
    : wrapped;
  const output: PluginAppRequirement[] = [];
  for (const [name, definition] of Object.entries(apps)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    const entry = definition as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    output.push({ name, id: entry.id, required: entry.required !== false });
  }
  return output.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeMcp(value: unknown, manifest: PluginManifest, unsupported: string[]): NormalizedMcpServer[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const wrapped = value as Record<string, unknown>;
  const servers = wrapped.mcpServers && typeof wrapped.mcpServers === "object" && !Array.isArray(wrapped.mcpServers)
    ? wrapped.mcpServers as Record<string, unknown>
    : wrapped;
  const output: NormalizedMcpServer[] = [];
  for (const [name, definition] of Object.entries(servers)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      unsupported.push(`MCP server ${name} has an invalid definition.`);
      continue;
    }
    const entry = definition as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : "http";
    if (!new Set(["http", "sse"]).has(type) || typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) {
      unsupported.push(`MCP server ${name} is not a remote HTTP server; stdio and local processes are not imported.`);
      continue;
    }
    const authKeys = [
      "oauth_resource",
      "oauth",
      "headers",
      "bearer_token_env_var",
      "auth",
      "env",
      "token",
      "api_key",
      "apiKey",
    ].filter((key) => entry[key] !== undefined);
    if (authKeys.length > 0) {
      unsupported.push(`MCP server ${name} requires auth (${authKeys.join(", ")}); author an Eve connection auth resolver manually.`);
      continue;
    }
    output.push({ id: toSlug(name), url: entry.url, description: `${manifest.description} (${name} MCP server)` });
  }
  return output;
}

export async function inspectPlugin(root: string): Promise<NormalizedPlugin> {
  const manifestPath = resolve(root, ".codex-plugin/plugin.json");
  if (!(await pathExists(manifestPath))) throw new Error(`No OpenAI plugin manifest found at ${manifestPath}`);
  const manifest = asManifest(await readJson(manifestPath), manifestPath);

  const fullTree = await walkFiles(root);
  const digest = sha256(stableJson(fullTree.map((file) => [file.path, sha256(file.bytes)])));
  const skillRoots = await capabilityRoots(root, manifest.skills, "skills");
  const commandRoots = await capabilityRoots(root, manifest.commands, "commands");
  const agentRoots = await capabilityRoots(root, manifest.agents, "agents");
  const warnings: string[] = [];
  const unsupported: string[] = [];
  const skills = await normalizeSkills(root, skillRoots, manifest);
  const commands = await normalizeMarkdownDirectory<NormalizedCommand>(root, commandRoots, "command", manifest);
  const agents = await normalizeMarkdownDirectory<NormalizedAgent>(root, agentRoots, "agent", manifest);
  for (const agent of agents) {
    if (agent.declaredTools.length > 0) {
      warnings.push(`Agent ${agent.id} declares Codex tools (${agent.declaredTools.join(", ")}); Eve tool mounts must be configured separately.`);
    }
  }

  const apps = normalizeApps(await referencedJson(root, manifest.apps, ".app.json"));
  const mcpServers = normalizeMcp(
    await referencedJson(root, manifest.mcpServers, ".mcp.json"),
    manifest,
    unsupported,
  );
  if (manifest.hooks !== undefined || await pathExists(resolve(root, "hooks")) || await pathExists(resolve(root, ".codex-plugin/hooks.json"))) {
    unsupported.push("Plugin hooks are not executed or translated; review and port them as Eve hooks explicitly.");
  }
  if (apps.length > 0) {
    warnings.push(`Plugin requires ChatGPT app${apps.length === 1 ? "" : "s"}: ${apps.map((app) => `${app.name} (${app.id})`).join(", ")}.`);
  }

  return {
    manifest,
    root,
    digest,
    skills,
    commands,
    agents,
    apps,
    mcpServers,
    warnings,
    unsupported,
  };
}
