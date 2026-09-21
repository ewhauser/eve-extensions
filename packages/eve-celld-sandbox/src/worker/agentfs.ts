import { AgentFS, type CloudflareStorage } from "agentfs-sdk/cloudflare";
import { Buffer } from "node:buffer";
import {
  base64,
  unbase64,
  LIMITS,
  ProtocolError,
  type Entry,
} from "../protocol.js";
import {
  LegacyWorkspace,
  validateSnapshot,
  type WorkspaceStore,
} from "./workspace.js";

// AgentFS owns file content, directory entries and inodes in this same cell.
// The shell gets an isolated snapshot so a failed command cannot commit writes.
export class AgentFsWorkspace implements WorkspaceStore {
  readonly fs: AgentFS;
  constructor(private storage: DurableObjectStorage) {
    const sql = storage.sql;
    if (
      sql
        .exec("SELECT name FROM sqlite_master WHERE name='fs_config'")
        .toArray().length
    ) {
      const version = sql
        .exec<{
          value: string;
        }>("SELECT value FROM fs_config WHERE key='schema_version'")
        .toArray()[0]?.value;
      if (version !== undefined && version !== "0.4")
        throw new ProtocolError(
          "SCHEMA",
          `Unsupported AgentFS schema: ${version}`,
          409,
        );
    }
    // The SDK declares an unconstrained sql.exec<T>; Workers constrains T to
    // SQL rows. The methods and values used by the SDK match at runtime.
    this.fs = storage.transactionSync(() =>
      AgentFS.create(storage as CloudflareStorage),
    );
    if (this.fs.getChunkSize() !== 4096)
      throw new ProtocolError(
        "SCHEMA",
        "Expected AgentFS 4096-byte chunks",
        409,
      );
  }

  async migrate(): Promise<void> {
    const sql = this.storage.sql;
    if (
      !sql.exec("SELECT name FROM sqlite_master WHERE name='files'").toArray()
        .length
    )
      return;
    await this.storage.transaction(async () => {
      const count = sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM files")
        .one().count;
      if (count) {
        // Never overwrite an independently populated AgentFS workspace.
        if ((await this.fs.readdir("/")).length)
          throw new ProtocolError(
            "MIGRATION",
            "Both legacy and AgentFS files exist; refusing to overwrite either",
            409,
          );
        await this.save(new LegacyWorkspace(sql).load());
      }
      sql.exec("DROP TABLE files");
    });
  }

  private bounds(): void {
    const sizes = this.storage.sql
      .exec<{
        total: number;
        largest: number;
        stored: number;
      }>(
        "SELECT COALESCE(SUM(size),0) AS total, COALESCE(MAX(size),0) AS largest, (SELECT COALESCE(SUM(length(data)),0) FROM fs_data) AS stored FROM fs_inode",
      )
      .one();
    if (
      sizes.total > LIMITS.snapshotBytes ||
      sizes.stored > LIMITS.snapshotBytes ||
      sizes.largest > LIMITS.fileBytes
    )
      throw new ProtocolError(
        "LIMIT",
        "Stored AgentFS workspace exceeds snapshot limits; no file bytes were loaded",
        413,
      );
  }

  async load(): Promise<Entry[]> {
    this.bounds();
    const roots = await this.fs.readdir("/");
    if (!roots.length) return [];
    if (roots.length !== 1 || roots[0] !== "workspace")
      throw new ProtocolError(
        "SNAPSHOT",
        "AgentFS contains paths outside /workspace",
      );
    const entries: Entry[] = [];
    const pending = ["/workspace"];
    while (pending.length) {
      const path = pending.pop()!;
      const stats = await this.fs.lstat(path);
      if ((!stats.isFile() && !stats.isDirectory()) || stats.nlink !== 1)
        throw new ProtocolError(
          "UNSUPPORTED",
          "AgentFS snapshot cannot contain symbolic or hard links",
        );
      const ns = this.storage.sql
        .exec<{
          mtime_nsec: number;
        }>("SELECT mtime_nsec FROM fs_inode WHERE ino=?", stats.ino)
        .one().mtime_nsec;
      const bytes = stats.isFile()
        ? await this.fs.readFile(path)
        : new Uint8Array();
      if (bytes.length !== stats.size)
        throw new ProtocolError(
          "SNAPSHOT",
          "AgentFS file size does not match stored chunks",
        );
      entries.push({
        path,
        kind: stats.isDirectory() ? "directory" : "file",
        data: base64(bytes),
        mode: stats.mode & 0o7777,
        mtime: stats.mtime * 1000 + ns / 1e6,
      });
      if (stats.isDirectory())
        for (const name of await this.fs.readdir(path))
          pending.push(`${path}/${name}`);
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    validateSnapshot(entries);
    return entries;
  }

  // Call inside storage.transaction(), together with the command's journal
  // result. The SDK returns promises and uses nested transactionSync internally.
  async save(entries: Entry[]): Promise<void> {
    validateSnapshot(entries);
    const previous = new Map((await this.load()).map((e) => [e.path, e]));
    const next = new Map(entries.map((e) => [e.path, e]));
    // Remove children before parents, including file/directory replacements.
    for (const old of [...previous.values()].sort(
      (a, b) => b.path.length - a.path.length,
    )) {
      if (!next.has(old.path) || next.get(old.path)!.kind !== old.kind) {
        await this.fs.rm(old.path, { recursive: true, force: true });
        previous.delete(old.path);
      }
    }
    for (const e of [...entries].sort(
      (a, b) => a.path.length - b.path.length,
    )) {
      const old = previous.get(e.path);
      if (e.kind === "directory") {
        if (!old) await this.fs.mkdir(e.path);
      } else if (!old || old.data !== e.data) {
        await this.fs.writeFile(e.path, Buffer.from(unbase64(e.data)));
      }
    }
    // AgentFS 0.6.4 has no chmod/utimes API. Update only its documented inode
    // metadata, after all writes; SDK methods own all bytes/directory changes.
    for (const e of entries) {
      const stats = await this.fs.lstat(e.path);
      const seconds = Math.floor(e.mtime / 1000);
      const nanos = Math.round((e.mtime - seconds * 1000) * 1e6);
      this.storage.sql.exec(
        "UPDATE fs_inode SET mode=?,mtime=?,mtime_nsec=? WHERE ino=?",
        (e.kind === "directory" ? 0o040000 : 0o100000) | e.mode,
        seconds,
        nanos,
        stats.ino,
      );
    }
  }

  async clear(): Promise<void> {
    await this.fs.rm("/workspace", { recursive: true, force: true });
  }

  async info() {
    const stats = await this.fs.statfs();
    return {
      engine: "agentfs",
      sdkVersion: "0.6.4",
      schemaVersion: "0.4",
      chunkSize: this.fs.getChunkSize(),
      ...stats,
    };
  }
}
