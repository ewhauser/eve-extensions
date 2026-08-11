#!/usr/bin/env node
import { resolve } from "node:path";

import {
  applyPluginImport,
  checkPluginInstallation,
  planPluginImport,
  readPluginLockfile,
  removePlugin,
} from "./importer.js";
import { parseSourceSpecifier } from "./source.js";
import type { ImportOptions, InstallPlan } from "./types.js";

interface ParsedArguments {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const booleanFlags = new Set(["allow-static-connections", "check", "json", "help"]);
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value?.startsWith("--")) {
      if (value) positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const key = value.slice(2, equals >= 0 ? equals : undefined);
    if (booleanFlags.has(key)) {
      flags.set(key, true);
      continue;
    }
    const flagValue = equals >= 0 ? value.slice(equals + 1) : rest[++index];
    if (!flagValue || flagValue.startsWith("--")) throw new Error(`--${key} requires a value.`);
    flags.set(key, flagValue);
  }
  return { command, positional, flags };
}

function stringFlag(arguments_: ParsedArguments, name: string): string | undefined {
  const value = arguments_.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function usage(): string {
  return `Usage:
  eve-openai-plugins plan <source> [options]
  eve-openai-plugins apply <source> [options]
  eve-openai-plugins sync [--check] [options]
  eve-openai-plugins check [--root <path>]
  eve-openai-plugins remove <plugin-id> [--root <path>]

Sources:
  ./plugin                         local plugin directory
  git+https://host/repo.git#ref    Git repository (use --plugin-path for a monorepo)
  npm:@scope/package@version       npm package (lifecycle scripts are disabled)

Options:
  --root <path>                    Eve project root (default: current directory)
  --plugin-path <path>             plugin directory inside a Git/npm/local source
  --ref <ref>                      Git ref (overrides #ref)
  --model <provider/model>         model for imported subagents
  --connector-extension <slug>     root eve-openai-connectors mount (default: openai)
  --allow-static-connections       import unauthenticated HTTP MCP as static Eve connections
  --json                           print machine-readable output
`;
}

function optionsFor(arguments_: ParsedArguments, sourceText: string): ImportOptions {
  const projectRoot = resolve(stringFlag(arguments_, "root") ?? process.cwd());
  const pluginPath = stringFlag(arguments_, "plugin-path");
  const ref = stringFlag(arguments_, "ref");
  const source = parseSourceSpecifier(sourceText, {
    cwd: process.cwd(),
    ...(pluginPath ? { pluginPath } : {}),
    ...(ref ? { ref } : {}),
  });
  const options: ImportOptions = { projectRoot, source };
  const model = stringFlag(arguments_, "model");
  const connectorExtension = stringFlag(arguments_, "connector-extension");
  if (model) options.model = model;
  if (connectorExtension) options.connectorExtension = connectorExtension;
  if (arguments_.flags.has("allow-static-connections")) options.allowStaticConnections = true;
  return options;
}

function meaningfulChanges(plan: InstallPlan): number {
  return plan.changes.filter((change) => change.kind !== "unchanged").length
    + plan.conflicts.length
    + (plan.lockfileChanged ? 1 : 0);
}

function printPlan(plan: InstallPlan, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const active = plan.changes.filter((change) => change.kind !== "unchanged");
  process.stdout.write(`${plan.plugin.name}@${plan.plugin.version} (${plan.plugin.digest.slice(0, 12)})\n`);
  for (const change of active) process.stdout.write(`  ${change.kind.padEnd(6)} ${change.path}\n`);
  if (active.length === 0) process.stdout.write("  generated files are current\n");
  if (plan.accessPolicy.willCreate) process.stdout.write(`  add    ${plan.accessPolicy.path}\n`);
  if (plan.lockfileChanged) process.stdout.write("  update eve-openai-plugins.lock.json\n");
  for (const conflict of plan.conflicts) process.stdout.write(`  conflict: ${conflict}\n`);
  for (const warning of plan.warnings) process.stdout.write(`  warning: ${warning}\n`);
  for (const unsupported of plan.unsupported) process.stdout.write(`  unsupported: ${unsupported}\n`);
}

async function sync(arguments_: ParsedArguments): Promise<void> {
  const projectRoot = resolve(stringFlag(arguments_, "root") ?? process.cwd());
  const lockfile = await readPluginLockfile(projectRoot);
  const plans: InstallPlan[] = [];
  for (const [lockedId, entry] of Object.entries(lockfile.plugins)) {
    const options: ImportOptions = {
      projectRoot,
      source: entry.source,
      connectorExtension: entry.connectorExtension,
      allowStaticConnections: entry.allowStaticConnections,
    };
    if (entry.model) options.model = entry.model;
    const plan = await planPluginImport(options);
    if (plan.plugin.name !== entry.name) {
      throw new Error(
        `Locked plugin ${lockedId} resolved as ${plan.plugin.name}; remove and reinstall explicitly to accept an identity change.`,
      );
    }
    if (arguments_.flags.has("check")) plans.push(plan);
    else plans.push((await applyPluginImport(options)).plan);
  }
  if (arguments_.flags.has("json")) process.stdout.write(`${JSON.stringify(plans, null, 2)}\n`);
  else for (const plan of plans) printPlan(plan, false);
  if (arguments_.flags.has("check") && plans.some((plan) => meaningfulChanges(plan) > 0 || plan.accessPolicy.willCreate)) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (!arguments_.command || arguments_.command === "help" || arguments_.flags.has("help")) {
    process.stdout.write(usage());
    return;
  }
  const json = arguments_.flags.has("json");
  if (arguments_.command === "plan" || arguments_.command === "apply") {
    const source = arguments_.positional[0];
    if (!source) throw new Error(`${arguments_.command} requires a plugin source.`);
    const options = optionsFor(arguments_, source);
    const plan = arguments_.command === "plan"
      ? await planPluginImport(options)
      : (await applyPluginImport(options)).plan;
    printPlan(plan, json);
    if (plan.conflicts.length > 0) process.exitCode = 1;
    return;
  }
  if (arguments_.command === "sync") {
    await sync(arguments_);
    return;
  }
  if (arguments_.command === "check") {
    const result = await checkPluginInstallation(resolve(stringFlag(arguments_, "root") ?? process.cwd()));
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(result.ok ? "OpenAI plugin installation is consistent.\n" : `${result.problems.join("\n")}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (arguments_.command === "remove") {
    const id = arguments_.positional[0];
    if (!id) throw new Error("remove requires a plugin id.");
    const result = await removePlugin(resolve(stringFlag(arguments_, "root") ?? process.cwd()), id);
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `Removed ${result.pluginId}.\n`);
    return;
  }
  throw new Error(`Unknown command: ${arguments_.command}\n\n${usage()}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`eve-openai-plugins: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
