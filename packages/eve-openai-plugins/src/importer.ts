import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";

import { accessPolicySource, generatePlugin } from "./generator.js";
import { inspectPlugin } from "./manifest.js";
import { resolvePluginSource } from "./source.js";
import {
  ACCESS_POLICY_PATH,
  LOCKFILE_NAME,
  type ApplyResult,
  type FileChange,
  type ImportOptions,
  type InstallationCheck,
  type InstallPlan,
  type PluginLockEntry,
  type PluginLockfile,
} from "./types.js";
import { assertInside, atomicWrite, pathExists, readJson, sha256, stableJson, toSlug } from "./util.js";

interface PreparedPlan {
  public: InstallPlan;
  desired: Map<string, string>;
  lockfile: PluginLockfile;
  entry: PluginLockEntry;
  pluginId: string;
}

export interface RemoveResult {
  pluginId: string;
  changes: FileChange[];
  lockfile: string;
}

function emptyLockfile(): PluginLockfile {
  return { version: 1, plugins: {} };
}

export async function readPluginLockfile(projectRoot: string): Promise<PluginLockfile> {
  const path = resolve(projectRoot, LOCKFILE_NAME);
  if (!(await pathExists(path))) return emptyLockfile();
  const value = await readJson(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${LOCKFILE_NAME}.`);
  const candidate = value as Partial<PluginLockfile>;
  if (candidate.version !== 1 || !candidate.plugins || typeof candidate.plugins !== "object") {
    throw new Error(`Unsupported ${LOCKFILE_NAME} format.`);
  }
  return candidate as PluginLockfile;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function defineAgentCall(expression: ts.Expression): ts.CallExpression | undefined {
  const candidate = unwrapExpression(expression);
  if (!ts.isCallExpression(candidate)) return undefined;
  const callee = unwrapExpression(candidate.expression);
  return ts.isIdentifier(callee) && callee.text === "defineAgent" ? candidate : undefined;
}

function exportedRootAgent(sourceFile: ts.SourceFile): ts.CallExpression | undefined {
  const variables = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        variables.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const exported = unwrapExpression(statement.expression);
    const expression = ts.isIdentifier(exported) ? variables.get(exported.text) : exported;
    return expression ? defineAgentCall(expression) : undefined;
  }
  return undefined;
}

function propertyName(property: ts.PropertyName): string | undefined {
  return ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined;
}

function literalModel(call: ts.CallExpression): string | undefined {
  const firstArgument = call.arguments[0] ? unwrapExpression(call.arguments[0]) : undefined;
  if (!firstArgument || !ts.isObjectLiteralExpression(firstArgument)) return undefined;

  let model: string | undefined;
  for (const property of firstArgument.properties) {
    // A spread can override a preceding literal or hide the effective value.
    if (ts.isSpreadAssignment(property)) return undefined;
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== "model") continue;
    if (model !== undefined) return undefined;
    const value = unwrapExpression(property.initializer);
    if (!ts.isStringLiteralLike(value)) return undefined;
    model = value.text;
  }
  return model;
}

async function literalRootModel(projectRoot: string): Promise<string | undefined> {
  const path = resolve(projectRoot, "agent/agent.ts");
  if (!(await pathExists(path))) return undefined;
  const source = await readFile(path, "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const root = exportedRootAgent(sourceFile);
  return root ? literalModel(root) : undefined;
}

async function connectorExists(projectRoot: string, mount: string): Promise<boolean> {
  for (const extension of ["ts", "js", "mts", "mjs"]) {
    if (await pathExists(resolve(projectRoot, `agent/extensions/${mount}.${extension}`))) return true;
  }
  return false;
}

function validateConnectorMount(value: string): string {
  if (toSlug(value) !== value) {
    throw new Error(`Connector extension mount must be a lowercase Eve slug, found ${JSON.stringify(value)}.`);
  }
  return value;
}

async function currentHash(projectRoot: string, relativePath: string): Promise<string | undefined> {
  const path = resolve(projectRoot, relativePath);
  assertInside(projectRoot, path, "generated file");
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return "not-a-file";
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function prepare(options: ImportOptions): Promise<PreparedPlan> {
  const projectRoot = resolve(options.projectRoot);
  if (!(await pathExists(projectRoot))) throw new Error(`Eve project root does not exist: ${projectRoot}`);
  const resolved = await resolvePluginSource(options.source);
  try {
    const plugin = await inspectPlugin(resolved.root);
    const pluginId = toSlug(plugin.manifest.name);
    const lockfile = await readPluginLockfile(projectRoot);
    const existing = lockfile.plugins[pluginId];
    if (existing && existing.name !== plugin.manifest.name) {
      throw new Error(`Plugin id ${pluginId} is already owned by ${existing.name}.`);
    }
    const connectorExtension = validateConnectorMount(
      options.connectorExtension ?? existing?.connectorExtension ?? "openai",
    );
    const model = options.model ?? existing?.model ?? (plugin.agents.length > 0 ? await literalRootModel(projectRoot) : undefined);
    const allowStaticConnections = options.allowStaticConnections ?? existing?.allowStaticConnections ?? false;
    const generated = generatePlugin(plugin, {
      ...(model ? { model } : {}),
      connectorExtension,
      connectorAvailable: await connectorExists(projectRoot, connectorExtension),
      allowStaticConnections,
    });
    const desiredHashes = Object.fromEntries(
      [...generated.files].map(([path, content]) => [path, sha256(content)]),
    );
    const entry: PluginLockEntry = {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      source: options.source,
      digest: plugin.digest,
      connectorExtension,
      allowStaticConnections,
      files: desiredHashes,
      apps: plugin.apps,
      unsupported: plugin.unsupported,
    };
    if (model) entry.model = model;

    const changes: FileChange[] = [];
    const conflicts: string[] = [];
    for (const [path, content] of generated.files) {
      const current = await currentHash(projectRoot, path);
      const oldHash = existing?.files[path];
      const desiredHash = sha256(content);
      if (current === undefined) {
        changes.push({ path, kind: "add" });
      } else if (!oldHash) {
        conflicts.push(`${path} already exists and is not owned by ${plugin.manifest.name}.`);
      } else if (current !== oldHash) {
        conflicts.push(`${path} was modified after installation; refusing to overwrite it.`);
      } else {
        changes.push({ path, kind: current === desiredHash ? "unchanged" : "update" });
      }
    }
    for (const [path, oldHash] of Object.entries(existing?.files ?? {})) {
      if (generated.files.has(path)) continue;
      const current = await currentHash(projectRoot, path);
      if (current === undefined) continue;
      if (current !== oldHash) {
        conflicts.push(`${path} was modified after installation; refusing to delete it.`);
      } else {
        changes.push({ path, kind: "delete" });
      }
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));

    const accessPath = resolve(projectRoot, ACCESS_POLICY_PATH);
    const publicPlan: InstallPlan = {
      plugin: { name: plugin.manifest.name, version: plugin.manifest.version, digest: plugin.digest },
      source: options.source,
      changes,
      conflicts,
      warnings: generated.warnings,
      unsupported: plugin.unsupported,
      requirements: {
        apps: plugin.apps,
        staticConnections: plugin.mcpServers.map((server) => server.id),
      },
      accessPolicy: {
        path: ACCESS_POLICY_PATH,
        willCreate: !(await pathExists(accessPath)),
      },
      lockfileChanged: existing === undefined || stableJson(existing) !== stableJson(entry),
    };
    return { public: publicPlan, desired: generated.files, lockfile, entry, pluginId };
  } finally {
    await resolved.cleanup();
  }
}

export async function planPluginImport(options: ImportOptions): Promise<InstallPlan> {
  return (await prepare(options)).public;
}

async function pruneEmptyParents(projectRoot: string, path: string): Promise<void> {
  const boundary = resolve(projectRoot, "agent");
  let current = dirname(path);
  while (current !== boundary && current !== projectRoot) {
    try {
      await rmdir(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return;
      throw error;
    }
    current = dirname(current);
  }
}

export async function applyPluginImport(options: ImportOptions): Promise<ApplyResult> {
  const projectRoot = resolve(options.projectRoot);
  const prepared = await prepare(options);
  if (prepared.public.conflicts.length > 0) {
    throw new Error(`Plugin import has conflicts:\n- ${prepared.public.conflicts.join("\n- ")}`);
  }

  if (prepared.public.accessPolicy.willCreate) {
    const accessPath = resolve(projectRoot, ACCESS_POLICY_PATH);
    await mkdir(dirname(accessPath), { recursive: true });
    await writeFile(accessPath, accessPolicySource(), { flag: "wx" });
  }
  for (const change of prepared.public.changes) {
    if (change.kind !== "add" && change.kind !== "update") continue;
    const content = prepared.desired.get(change.path);
    if (content === undefined) throw new Error(`Missing generated content for ${change.path}.`);
    await atomicWrite(resolve(projectRoot, change.path), content);
  }
  for (const change of prepared.public.changes) {
    if (change.kind !== "delete") continue;
    const path = resolve(projectRoot, change.path);
    await unlink(path);
    await pruneEmptyParents(projectRoot, path);
  }

  prepared.lockfile.plugins[prepared.pluginId] = prepared.entry;
  const lockPath = resolve(projectRoot, LOCKFILE_NAME);
  await atomicWrite(lockPath, stableJson(prepared.lockfile));
  return { plan: prepared.public, lockfile: lockPath };
}

export async function checkPluginInstallation(projectRootInput: string): Promise<InstallationCheck> {
  const projectRoot = resolve(projectRootInput);
  const lockfile = await readPluginLockfile(projectRoot);
  const problems: string[] = [];
  if (Object.keys(lockfile.plugins).length > 0 && !(await pathExists(resolve(projectRoot, ACCESS_POLICY_PATH)))) {
    problems.push(`${ACCESS_POLICY_PATH} is missing.`);
  }
  for (const [pluginId, plugin] of Object.entries(lockfile.plugins)) {
    for (const [path, expected] of Object.entries(plugin.files)) {
      const actual = await currentHash(projectRoot, path);
      if (actual === undefined) problems.push(`${pluginId}: ${path} is missing.`);
      else if (actual !== expected) problems.push(`${pluginId}: ${path} differs from the lockfile.`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export async function removePlugin(projectRootInput: string, requestedId: string): Promise<RemoveResult> {
  const projectRoot = resolve(projectRootInput);
  const lockfile = await readPluginLockfile(projectRoot);
  const pluginId = toSlug(requestedId);
  const entry = lockfile.plugins[pluginId];
  if (!entry) throw new Error(`Plugin is not installed: ${requestedId}`);
  const changes: FileChange[] = [];
  const conflicts: string[] = [];
  for (const [path, expected] of Object.entries(entry.files)) {
    const actual = await currentHash(projectRoot, path);
    if (actual === undefined) continue;
    if (actual !== expected) conflicts.push(`${path} was modified after installation; refusing to delete it.`);
    else changes.push({ path, kind: "delete" });
  }
  if (conflicts.length > 0) throw new Error(`Plugin removal has conflicts:\n- ${conflicts.join("\n- ")}`);
  for (const change of changes) {
    const path = resolve(projectRoot, change.path);
    await unlink(path);
    await pruneEmptyParents(projectRoot, path);
  }
  delete lockfile.plugins[pluginId];
  const lockPath = resolve(projectRoot, LOCKFILE_NAME);
  await atomicWrite(lockPath, stableJson(lockfile));
  return { pluginId, changes, lockfile: lockPath };
}
