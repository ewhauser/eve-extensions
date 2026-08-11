import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { PluginSource } from "./types.js";
import {
  assertRelativePath,
  MAX_FILE_BYTES,
  MAX_PLUGIN_BYTES,
  pathExists,
  resolveInside,
} from "./util.js";

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
/** Allow bounded tar framing overhead above the extracted plugin payload. */
const MAX_NPM_ARCHIVE_BYTES = MAX_PLUGIN_BYTES + 8 * 1024 * 1024;

export interface ResolvedPluginSource {
  root: string;
  source: PluginSource;
  cleanup(): Promise<void>;
}

export function parseSourceSpecifier(
  specifier: string,
  options: { cwd?: string; pluginPath?: string; ref?: string } = {},
): PluginSource {
  const pluginPath = options.pluginPath;
  if (specifier.startsWith("git+")) {
    const raw = specifier.slice(4);
    const hash = raw.lastIndexOf("#");
    const url = hash >= 0 ? raw.slice(0, hash) : raw;
    const embeddedRef = hash >= 0 ? raw.slice(hash + 1) : undefined;
    if (!url || url.startsWith("-") || url.includes("\0")) throw new Error("Git plugin sources require a safe URL.");
    const source: PluginSource = { kind: "git", url };
    const ref = options.ref ?? embeddedRef;
    if (ref) {
      if (ref.startsWith("-") || ref.includes("\0")) throw new Error("Git plugin refs may not begin with '-' or contain NUL.");
      source.ref = ref;
    }
    if (pluginPath) source.pluginPath = assertRelativePath(pluginPath, "plugin path");
    return source;
  }
  if (specifier.startsWith("npm:")) {
    const spec = specifier.slice(4);
    if (!spec || spec.startsWith("-")) throw new Error("npm plugin sources require a package specifier.");
    const source: PluginSource = { kind: "npm", spec };
    if (pluginPath) source.pluginPath = assertRelativePath(pluginPath, "plugin path");
    return source;
  }
  const path = resolve(options.cwd ?? process.cwd(), specifier.startsWith("file:") ? specifier.slice(5) : specifier);
  const source: PluginSource = { kind: "local", path };
  if (pluginPath) source.pluginPath = assertRelativePath(pluginPath, "plugin path");
  return source;
}

export async function resolvePluginSource(source: PluginSource): Promise<ResolvedPluginSource> {
  if (source.kind === "local") {
    if (!(await pathExists(source.path))) throw new Error(`Plugin source does not exist: ${source.path}`);
    const root = source.pluginPath
      ? await resolveInside(source.path, source.pluginPath, "plugin path")
      : resolve(source.path);
    return { root, source, cleanup: async () => undefined };
  }

  const temporary = await mkdtemp(resolve(tmpdir(), "eve-openai-plugin-"));
  try {
    let extracted: string;
    if (source.kind === "git") {
      if (!source.url || source.url.startsWith("-") || source.url.includes("\0")) {
        throw new Error("Git plugin sources require a safe URL.");
      }
      if (source.ref?.startsWith("-") || source.ref?.includes("\0")) {
        throw new Error("Git plugin refs may not begin with '-' or contain NUL.");
      }
      const checkout = resolve(temporary, "repository");
      if (source.ref) {
        await execFileAsync("git", ["clone", "--filter=blob:none", "--no-checkout", "--", source.url, checkout]);
        await execFileAsync("git", ["-C", checkout, "fetch", "--depth", "1", "origin", source.ref]);
        await execFileAsync("git", ["-C", checkout, "checkout", "--detach", "FETCH_HEAD"]);
      } else {
        await execFileAsync("git", ["clone", "--depth", "1", "--", source.url, checkout]);
      }
      extracted = checkout;
    } else {
      if (!source.spec || source.spec.startsWith("-") || source.spec.includes("\0")) {
        throw new Error("npm plugin sources require a safe package specifier.");
      }
      const output = await execFileAsync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary, "--", source.spec],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      const result = JSON.parse(output.stdout) as Array<{ filename?: unknown }>;
      const filename = result[0]?.filename;
      if (result.length !== 1 || typeof filename !== "string") {
        throw new Error("npm pack returned an unexpected result.");
      }
      const archive = resolve(temporary, basename(filename));
      extracted = resolve(temporary, "package");
      await extractNpmArchive(archive, extracted);
    }

    const root = source.pluginPath
      ? await resolveInside(extracted, source.pluginPath, "plugin path")
      : extracted;
    return {
      root,
      source,
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function readTarString(buffer: Uint8Array, start: number, length: number): string {
  const bytes = buffer.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return Buffer.from(end >= 0 ? bytes.subarray(0, end) : bytes).toString("utf8");
}

function parseTarNumber(value: string): number {
  const clean = value.replace(/\0.*$/s, "").trim();
  if (!clean) return 0;
  const parsed = Number.parseInt(clean, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("npm archive has an invalid size.");
  return parsed;
}

function parsePax(content: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(Buffer.from(content.subarray(offset, space)).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > content.length) {
      throw new Error("npm archive has invalid PAX metadata.");
    }
    const record = Buffer.from(content.subarray(space + 1, offset + length - 1)).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

async function extractNpmArchive(archive: string, destination: string): Promise<void> {
  if ((await stat(archive)).size > MAX_NPM_ARCHIVE_BYTES) {
    throw new Error("npm plugin archive is too large before decompression.");
  }
  const compressed = await readFile(archive);
  let tar: Buffer;
  try {
    tar = await gunzipAsync(compressed, { maxOutputLength: MAX_NPM_ARCHIVE_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("npm plugin archive expands beyond the safe size limit.", { cause: error });
    }
    throw error;
  }
  let offset = 0;
  let total = 0;
  let nextPax: Record<string, string> = {};
  let nextLongName: string | undefined;
  const writes: Array<{ path: string; bytes?: Uint8Array }> = [];

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = parseTarNumber(readTarString(header, 124, 12));
    const type = String.fromCharCode(header[156] ?? 0) || "0";
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("npm archive is truncated.");
    const content = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x" || type === "g") {
      const parsed = parsePax(content);
      nextPax = type === "g" ? { ...nextPax, ...parsed } : parsed;
      continue;
    }
    if (type === "L") {
      nextLongName = Buffer.from(content).toString("utf8").replace(/\0+$/g, "");
      continue;
    }
    if (type === "1" || type === "2" || type === "K") {
      throw new Error("npm plugin archives may not contain links.");
    }

    const archivePath = nextPax.path ?? nextLongName ?? (prefix ? `${prefix}/${name}` : name);
    nextPax = {};
    nextLongName = undefined;
    if (!archivePath.startsWith("package/")) {
      throw new Error(`npm archive entry is outside package/: ${archivePath}`);
    }
    const relativePath = archivePath.slice("package/".length).replace(/\/$/, "");
    if (!relativePath) continue;
    const safe = assertRelativePath(relativePath, "npm archive entry");
    if (type === "5") {
      writes.push({ path: safe });
      continue;
    }
    if (type !== "0" && type !== "\0") continue;
    if (size > MAX_FILE_BYTES) throw new Error(`npm archive file is too large: ${safe}`);
    total += size;
    if (total > MAX_PLUGIN_BYTES) throw new Error("npm archive is too large.");
    writes.push({ path: safe, bytes: Uint8Array.from(content) });
  }

  await mkdir(destination, { recursive: true });
  for (const entry of writes) {
    const absolute = resolve(destination, entry.path);
    if (entry.bytes === undefined) {
      await mkdir(absolute, { recursive: true });
    } else {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, entry.bytes, { flag: "wx" });
    }
  }
}
