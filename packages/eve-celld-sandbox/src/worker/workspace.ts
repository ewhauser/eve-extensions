import { InMemoryFs, type IFileSystem } from "just-bash/browser";
import {
  base64,
  unbase64,
  LIMITS,
  ProtocolError,
  resolvePath,
  type Entry,
} from "../protocol.js";

export function durablePath(path: string): string {
  const p = resolvePath(path);
  if (p !== "/workspace" && !p.startsWith("/workspace/"))
    throw new ProtocolError("PATH", "Durable files must be under /workspace");
  return p;
}
export function validateSnapshot(entries: Entry[]): void {
  let total = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (new TextEncoder().encode(e.path).length > 1024 || e.path.includes("\0"))
      throw new ProtocolError(
        "LIMIT",
        "Workspace path exceeds 1024 bytes or contains NUL",
        413,
      );
    if (durablePath(e.path) !== e.path || seen.has(e.path))
      throw new ProtocolError("SNAPSHOT", "Invalid or duplicate snapshot path");
    seen.add(e.path);
    const size = unbase64(e.data).length;
    if (size > LIMITS.fileBytes)
      throw new ProtocolError("LIMIT", "Per-file byte limit exceeded", 413);
    if (e.kind === "directory" && size)
      throw new ProtocolError("SNAPSHOT", "Directory has content");
    total += size;
  }
  if (total > LIMITS.snapshotBytes)
    throw new ProtocolError("LIMIT", "Total snapshot byte limit exceeded", 413);
  if (
    new TextEncoder().encode(JSON.stringify(entries)).length >
    LIMITS.requestBytes - 1024
  )
    throw new ProtocolError(
      "LIMIT",
      "Snapshot wire representation exceeds byte limit",
      413,
    );
  if (!entries.some((e) => e.path === "/workspace" && e.kind === "directory"))
    throw new ProtocolError("SNAPSHOT", "Workspace root is missing");
}

// Async mutation guards cover interpreter operations. Bash's synchronous
// initialization creates synthetic /bin, /proc, etc. before scripts run.
export class WorkspaceFs extends InMemoryFs {
  violation: ProtocolError | undefined;
  constructor() {
    super({}, { maxTotalBytes: LIMITS.snapshotBytes + LIMITS.fileBytes });
  }
  private writable(path: string, root = true) {
    const p = resolvePath(path);
    if (
      !(
        p === "/workspace" ||
        p.startsWith("/workspace/") ||
        p === "/tmp" ||
        p.startsWith("/tmp/") ||
        p === "/dev/null"
      )
    )
      throw new ProtocolError(
        "PATH",
        "Only /workspace (durable) and /tmp (temporary) are writable",
      );
    if (!root && (p === "/workspace" || p === "/tmp"))
      throw new ProtocolError("PATH", "Cannot remove or move a workspace root");
  }
  override async writeFile(...args: Parameters<InMemoryFs["writeFile"]>) {
    this.writable(args[0]);
    const value = args[1];
    const length =
      typeof value === "string"
        ? new TextEncoder().encode(value).length
        : value.length;
    if (length > LIMITS.fileBytes) {
      this.violation = new ProtocolError(
        "LIMIT",
        "Per-file byte limit exceeded",
        413,
      );
      throw this.violation;
    }
    return super.writeFile(...args);
  }
  override async appendFile(...args: Parameters<InMemoryFs["appendFile"]>) {
    this.writable(args[0]);
    await super.appendFile(...args);
    if ((await this.stat(args[0])).size > LIMITS.fileBytes) {
      this.violation = new ProtocolError(
        "LIMIT",
        "Per-file byte limit exceeded",
        413,
      );
      throw this.violation;
    }
  }
  override async mkdir(...args: Parameters<InMemoryFs["mkdir"]>) {
    this.writable(args[0]);
    return super.mkdir(...args);
  }
  override async rm(...args: Parameters<InMemoryFs["rm"]>) {
    this.writable(args[0], false);
    return super.rm(...args);
  }
  override async cp(...args: Parameters<InMemoryFs["cp"]>) {
    this.writable(args[1]);
    return super.cp(...args);
  }
  override async mv(...args: Parameters<InMemoryFs["mv"]>) {
    this.writable(args[0], false);
    this.writable(args[1], false);
    return super.mv(...args);
  }
  override async chmod(...args: Parameters<InMemoryFs["chmod"]>) {
    this.writable(args[0]);
    return super.chmod(...args);
  }
  override async utimes(...args: Parameters<InMemoryFs["utimes"]>) {
    this.writable(args[0]);
    return super.utimes(...args);
  }
  override async symlink(): Promise<never> {
    throw new ProtocolError(
      "UNSUPPORTED",
      "ENOTSUP: symbolic links are not supported",
    );
  }
  override async link(): Promise<never> {
    throw new ProtocolError(
      "UNSUPPORTED",
      "ENOTSUP: hard links are not supported",
    );
  }
}
export async function hydrate(entries: Entry[]): Promise<WorkspaceFs> {
  validateSnapshot(entries);
  const fs = new WorkspaceFs();
  for (const e of entries
    .filter((e) => e.kind === "directory")
    .sort((a, b) => a.path.length - b.path.length))
    await fs.mkdir(e.path, { recursive: true });
  for (const e of entries.filter((e) => e.kind === "file"))
    await fs.writeFile(e.path, unbase64(e.data));
  for (const e of entries) {
    await fs.chmod(e.path, e.mode);
    await fs.utimes(e.path, new Date(e.mtime), new Date(e.mtime));
  }
  await fs.mkdir("/tmp", { recursive: true });
  return fs;
}
export async function snapshot(fs: IFileSystem): Promise<Entry[]> {
  const paths = fs
    .getAllPaths()
    .filter((p) => p === "/workspace" || p.startsWith("/workspace/"))
    .sort();
  const entries: Entry[] = [];
  for (const path of paths) {
    const s = await fs.lstat(path);
    if (s.isSymbolicLink)
      throw new ProtocolError("UNSUPPORTED", "Cannot persist symbolic links");
    if (s.size > LIMITS.fileBytes)
      throw new ProtocolError("LIMIT", "Per-file byte limit exceeded", 413);
    entries.push({
      path,
      kind: s.isDirectory ? "directory" : "file",
      data: s.isFile ? base64(await fs.readFileBuffer(path)) : "",
      mode: s.mode & 0o7777,
      mtime: s.mtime.getTime(),
    });
  }
  validateSnapshot(entries);
  return entries;
}
export function emptySnapshot(): Entry[] {
  return [
    {
      path: "/workspace",
      kind: "directory",
      data: "",
      mode: 0o755,
      mtime: Date.now(),
    },
  ];
}

// Replace this small interface with a direct SQLite IFileSystem in a future
// implementation; no transport or Eve lifecycle changes are required.
export interface WorkspaceStore {
  load(): Promise<Entry[]>;
  save(entries: Entry[]): Promise<void>;
}
// Read-only migration source for workspaces created before AgentFS.
export class LegacyWorkspace {
  constructor(private sql: SqlStorage) {}
  load(): Entry[] {
    // Bound the database read itself, including state written by older code,
    // before materializing any BLOBs or base64 strings in the isolate.
    const sizes = this.sql
      .exec<{
        total: number;
        largest: number;
      }>(
        "SELECT COALESCE(SUM(length(bytes)),0) AS total, COALESCE(MAX(length(bytes)),0) AS largest FROM files",
      )
      .one();
    if (sizes.total > LIMITS.snapshotBytes || sizes.largest > LIMITS.fileBytes)
      throw new ProtocolError(
        "LIMIT",
        "Stored workspace exceeds snapshot limits; no entries were loaded",
        413,
      );
    const rows = this.sql
      .exec<{
        path: string;
        kind: string;
        bytes: ArrayBuffer;
        mode: number;
        mtime: number;
      }>("SELECT * FROM files ORDER BY path")
      .toArray();
    const entries = rows.map((r) => ({
      path: r.path,
      kind: r.kind as Entry["kind"],
      data: base64(new Uint8Array(r.bytes)),
      mode: r.mode,
      mtime: r.mtime,
    }));
    validateSnapshot(entries);
    return entries;
  }
}
