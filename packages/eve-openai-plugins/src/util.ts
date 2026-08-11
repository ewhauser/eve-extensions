import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PLUGIN_BYTES = 25 * 1024 * 1024;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function toSlug(value: string): string {
  const base = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "plugin";
  if (base.length <= 56) return base;
  return `${base.slice(0, 47).replace(/-+$/g, "")}-${sha256(base).slice(0, 8)}`;
}

/** Join already-normalized identity segments while honoring Eve's 64-character slot limit. */
export function qualifySlug(parts: readonly string[], maxLength = 64): string {
  const value = parts
    .map((part) => (/^[a-z0-9]+(?:-+[a-z0-9]+)*$/.test(part) ? part : toSlug(part)))
    .join("--");
  if (value.length <= maxLength) return value;
  const prefix = value.slice(0, maxLength - 9).replace(/-+$/g, "");
  return `${prefix}-${sha256(value).slice(0, 8)}`;
}

export function assertRelativePath(path: string, label: string): string {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (!normalized) throw new Error(`${label} must identify content below its plugin root.`);
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} escapes its plugin root: ${JSON.stringify(path)}`);
  }
  return normalized;
}

export function assertInside(root: string, candidate: string, label: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes ${root}: ${candidate}`);
  }
}

export async function resolveInside(root: string, path: string, label: string): Promise<string> {
  const safe = assertRelativePath(path, label);
  const candidate = resolve(root, safe);
  assertInside(root, candidate, label);
  const resolvedRoot = await realpath(root);
  const resolvedCandidate = await realpath(candidate);
  assertInside(resolvedRoot, resolvedCandidate, label);
  return resolvedCandidate;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON from ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export async function walkFiles(root: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const output: Array<{ path: string; bytes: Uint8Array }> = [];
  let total = 0;

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = resolve(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Plugin packages may not contain symbolic links: ${absolute}`);
      }
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`Plugin file exceeds ${MAX_FILE_BYTES} bytes: ${absolute}`);
      }
      total += stat.size;
      if (total > MAX_PLUGIN_BYTES) {
        throw new Error(`Plugin content exceeds ${MAX_PLUGIN_BYTES} bytes.`);
      }
      output.push({
        path: relative(root, absolute).split(sep).join("/"),
        bytes: await readFile(absolute),
      });
    }
  }

  await visit(root);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, content, { flag: "wx" });
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
}

export function stableJson(value: unknown): string {
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object" && !(input instanceof Uint8Array)) {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sort(item)]),
      );
    }
    return input;
  }
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
