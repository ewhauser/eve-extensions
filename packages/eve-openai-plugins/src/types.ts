export const LOCKFILE_NAME = "eve-openai-plugins.lock.json";
export const ACCESS_POLICY_PATH = "agent/lib/openai-plugin-access.ts";

export type PluginSource =
  | { kind: "local"; path: string; pluginPath?: string }
  | { kind: "git"; url: string; ref?: string; pluginPath?: string }
  | { kind: "npm"; spec: string; pluginPath?: string };

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  license?: string;
  skills?: unknown;
  commands?: unknown;
  agents?: unknown;
  apps?: unknown;
  mcpServers?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

export interface NormalizedSkill {
  id: string;
  sourcePath: string;
  description: string;
  markdown: string;
  license?: string;
  metadata?: Record<string, string>;
  files: Record<string, Uint8Array>;
}

export interface NormalizedCommand {
  id: string;
  sourcePath: string;
  description: string;
  markdown: string;
}

export interface NormalizedAgent {
  id: string;
  sourcePath: string;
  description: string;
  instructions: string;
  declaredTools: readonly string[];
}

export interface PluginAppRequirement {
  name: string;
  id: string;
  required: boolean;
}

export interface NormalizedMcpServer {
  id: string;
  url: string;
  description: string;
}

export interface NormalizedPlugin {
  manifest: PluginManifest;
  root: string;
  digest: string;
  skills: NormalizedSkill[];
  commands: NormalizedCommand[];
  agents: NormalizedAgent[];
  apps: PluginAppRequirement[];
  mcpServers: NormalizedMcpServer[];
  warnings: string[];
  unsupported: string[];
}

export interface ImportOptions {
  projectRoot: string;
  source: PluginSource;
  model?: string;
  connectorExtension?: string;
  allowStaticConnections?: boolean;
}

export type FileChangeKind = "add" | "update" | "delete" | "unchanged";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
}

export interface InstallPlan {
  plugin: {
    name: string;
    version: string;
    digest: string;
  };
  source: PluginSource;
  changes: FileChange[];
  conflicts: string[];
  warnings: string[];
  unsupported: string[];
  requirements: {
    apps: PluginAppRequirement[];
    staticConnections: string[];
  };
  accessPolicy: {
    path: string;
    willCreate: boolean;
  };
  /** True when source metadata, requirements, options, or owned hashes would change the lock entry. */
  lockfileChanged: boolean;
}

export interface ApplyResult {
  plan: InstallPlan;
  lockfile: string;
}

export interface PluginLockEntry {
  name: string;
  version: string;
  source: PluginSource;
  digest: string;
  model?: string;
  connectorExtension: string;
  allowStaticConnections: boolean;
  files: Record<string, string>;
  apps: PluginAppRequirement[];
  unsupported: string[];
}

export interface PluginLockfile {
  version: 1;
  plugins: Record<string, PluginLockEntry>;
}

export interface InstallationCheck {
  ok: boolean;
  problems: string[];
}
