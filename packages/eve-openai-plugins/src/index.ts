export { generatePlugin, accessPolicySource, type GenerateOptions, type GeneratedPlugin } from "./generator.js";
export { inspectPlugin, parseMarkdownDocument } from "./manifest.js";
export {
  applyPluginImport,
  checkPluginInstallation,
  planPluginImport,
  readPluginLockfile,
  removePlugin,
  type RemoveResult,
} from "./importer.js";
export { parseSourceSpecifier, resolvePluginSource, type ResolvedPluginSource } from "./source.js";
export type {
  ApplyResult,
  FileChange,
  FileChangeKind,
  ImportOptions,
  InstallationCheck,
  InstallPlan,
  NormalizedAgent,
  NormalizedCommand,
  NormalizedMcpServer,
  NormalizedPlugin,
  NormalizedSkill,
  PluginAppRequirement,
  PluginLockEntry,
  PluginLockfile,
  PluginManifest,
  PluginSource,
} from "./types.js";
export { ACCESS_POLICY_PATH, LOCKFILE_NAME } from "./types.js";
