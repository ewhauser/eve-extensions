// Test-only Worker. Never included by the normal build or wrangler config.
import production, {
  SandboxCell as ProductionCell,
} from "../../../src/worker/just-bash.js";
import { AgentFsWorkspace } from "../../../src/worker/agentfs.js";
import {
  cellName,
  Identity,
  Snapshot,
  base64,
  unbase64,
} from "../../../src/protocol.js";
import { z } from "zod";

const Fixture = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("legacy"),
    identity: Identity,
    entries: Snapshot,
    generation: z.string().uuid(),
  }),
  z.object({
    action: z.literal("inspect"),
    identity: Identity,
    path: z.string(),
  }),
  z.object({ action: z.enum(["fail-commit", "repair"]), identity: Identity }),
]);
export class SandboxCell extends ProductionCell {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__fixture")
      return super.fetch(request);
    const fixture = Fixture.parse(await request.json());
    const sql = this.ctx.storage.sql;
    if (fixture.action === "legacy") {
      this.ctx.storage.transactionSync(() => {
        for (const table of [
          "fs_data",
          "fs_symlink",
          "fs_dentry",
          "fs_inode",
          "fs_config",
        ])
          sql.exec(`DROP TABLE ${table}`);
        sql.exec(
          "CREATE TABLE files(path TEXT PRIMARY KEY,kind TEXT NOT NULL,bytes BLOB NOT NULL,mode INTEGER NOT NULL,mtime REAL NOT NULL)",
        );
        for (const e of fixture.entries)
          sql.exec(
            "INSERT INTO files VALUES(?,?,?,?,?)",
            e.path,
            e.kind,
            unbase64(e.data),
            e.mode,
            e.mtime,
          );
        sql.exec(
          "INSERT OR REPLACE INTO meta VALUES('generation',?)",
          fixture.generation,
        );
        sql.exec("INSERT OR REPLACE INTO meta VALUES('deleted','false')");
        sql.exec("INSERT OR REPLACE INTO meta VALUES('stopped','false')");
        sql.exec(
          "INSERT INTO commands VALUES('legacy-finished','{}','completed',?,?)",
          JSON.stringify({
            id: "legacy-finished",
            state: "completed",
            stdout: "before upgrade",
            stderr: "",
            exitCode: 0,
          }),
          Date.now(),
        );
      });
    } else if (fixture.action === "inspect") {
      const fs = new AgentFsWorkspace(this.ctx.storage).fs;
      const stats = await fs.stat(fixture.path);
      return Response.json({
        legacyTables: sql
          .exec("SELECT name FROM sqlite_master WHERE name='files'")
          .toArray().length,
        stats,
        data: stats.isFile() ? base64(await fs.readFile(fixture.path)) : null,
        config: sql.exec("SELECT * FROM fs_config ORDER BY key").toArray(),
        metadata: sql
          .exec("SELECT mtime_nsec FROM fs_inode WHERE ino=?", stats.ino)
          .one(),
      });
    } else if (fixture.action === "fail-commit") {
      sql.exec(
        "CREATE TRIGGER fail_completed BEFORE UPDATE ON commands WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END",
      );
    } else sql.exec("DROP TRIGGER fail_completed");
    await this.ctx.storage.sync();
    return Response.json({ ok: true });
  }
}

export default {
  async fetch(
    request: Request,
    env: { CELLS: DurableObjectNamespace; SERVICE_TOKEN: string },
  ) {
    if (new URL(request.url).pathname !== "/__fixture")
      return production.fetch(request, env);
    if (request.headers.get("authorization") !== `Bearer ${env.SERVICE_TOKEN}`)
      return new Response("Unauthorized", { status: 401 });
    const fixture = Fixture.parse(await request.json());
    return env.CELLS.getByName(cellName(fixture.identity)).fetch(
      new Request("http://cell/__fixture", {
        method: "POST",
        body: JSON.stringify(fixture),
      }),
    );
  },
};
