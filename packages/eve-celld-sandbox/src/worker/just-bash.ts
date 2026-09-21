import { DurableObject } from "cloudflare:workers";
import { Bash, defineCommand } from "just-bash/browser";
import {
  base64,
  cellName,
  commandFingerprint,
  failure,
  LIMITS,
  ProtocolError,
  readBounded,
  RequestEnvelope,
  ResponseEnvelope,
  responses,
  unbase64,
  VERSION,
  type Command,
  type Identity,
  type Operation,
  type Terminal,
} from "../protocol.js";
import { durablePath, emptySnapshot, hydrate, snapshot } from "./workspace.js";
import { AgentFsWorkspace } from "./agentfs.js";

type Env = { CELLS: DurableObjectNamespace; SERVICE_TOKEN: string };
type Journal = {
  id: string;
  fingerprint: string;
  state: string;
  result: string | null;
  created: number;
};
type Active = { controller: AbortController; promise: Promise<Terminal> };
const reply = (value: unknown) =>
  Response.json({ version: VERSION, ok: true, value });
function errorResponse(error: unknown): Response {
  const e =
    error instanceof ProtocolError
      ? error
      : new ProtocolError(
          "RUNTIME",
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "Runtime failure",
          500,
        );
  return Response.json(
    {
      version: VERSION,
      ok: false,
      error: { code: e.code, message: e.message },
    },
    { status: e.status },
  );
}
async function envelope(request: Request) {
  let data: unknown;
  try {
    data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBounded(request.body, LIMITS.requestBytes),
      ),
    );
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw new ProtocolError("INVALID_REQUEST", "Expected UTF-8 JSON");
  }
  const parsed = RequestEnvelope.safeParse(data);
  if (!parsed.success)
    throw new ProtocolError(
      "INVALID_REQUEST",
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
        .slice(0, 1000),
    );
  return parsed.data;
}
async function call(env: Env, identity: Identity, operation: Operation) {
  const response = await env.CELLS.getByName(cellName(identity)).fetch(
    new Request("http://cell/v1", {
      method: "POST",
      body: JSON.stringify({ version: VERSION, identity, operation }),
    }),
  );
  const parsed = ResponseEnvelope.parse(await response.json());
  if (!parsed.ok)
    throw new ProtocolError(
      parsed.error.code,
      parsed.error.message,
      response.status,
    );
  return parsed.value;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (new URL(request.url).pathname === "/healthz")
        return Response.json({ ok: true, version: VERSION });
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1")
        throw new ProtocolError("NOT_FOUND", "Use POST /v1", 404);
      if (!env.SERVICE_TOKEN || env.SERVICE_TOKEN.length < 32)
        throw new ProtocolError(
          "CONFIG",
          "SERVICE_TOKEN must contain at least 32 characters",
          503,
        );
      // Hash both values to fixed-size buffers before constant-time comparison.
      const expected = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`Bearer ${env.SERVICE_TOKEN}`),
      );
      const supplied = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(request.headers.get("authorization") ?? ""),
      );
      let diff = 0;
      const a = new Uint8Array(expected),
        b = new Uint8Array(supplied);
      for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
      if (diff)
        throw new ProtocolError("UNAUTHORIZED", "Invalid service token", 401);
      const data = await envelope(request);
      return await env.CELLS.getByName(cellName(data.identity)).fetch(
        new Request("http://cell/v1", {
          method: "POST",
          body: JSON.stringify(data),
        }),
      );
    } catch (e) {
      return errorResponse(e);
    }
  },
};
export class SandboxCell extends DurableObject<Env> {
  private store: AgentFsWorkspace;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private active = new Map<string, Active>();
  private stopping = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new AgentFsWorkspace(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await this.store.migrate();
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
        );
        ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created REAL NOT NULL)",
        );
        const unfinished = ctx.storage.sql
          .exec<Journal>("SELECT * FROM commands WHERE result IS NULL")
          .toArray();
        for (const row of unfinished)
          this.finish(
            failure(
              row.id,
              "interrupted",
              "Cell restarted before this command committed; changes discarded.",
            ),
          );
      });
    });
  }
  private get(key: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key=?", key)
      .toArray()[0]?.value;
  }
  private set(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta VALUES(?,?)",
      key,
      value,
    );
  }
  private journal(id: string): Journal | undefined {
    return this.ctx.storage.sql
      .exec<Journal>("SELECT * FROM commands WHERE id=?", id)
      .toArray()[0];
  }
  private finish(result: Terminal) {
    this.ctx.storage.sql.exec(
      "UPDATE commands SET state=?,result=? WHERE id=?",
      result.state,
      JSON.stringify(result),
      result.id,
    );
  }
  private serialize<T>(fn: () => Promise<T>, barrier = false): Promise<T> {
    if (!barrier && this.queued >= LIMITS.pending)
      throw new ProtocolError("BUSY", "Cell mutation queue is full", 429);
    this.queued++;
    const result = this.tail.then(fn);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.queued--;
      });
    return result;
  }
  private check(generation: string) {
    if (this.get("generation") !== generation || this.get("deleted") === "true")
      throw new ProtocolError(
        "STALE_SESSION",
        "Session was deleted or replaced",
        409,
      );
  }
  private mutable(identity: Identity, generation: string) {
    this.check(generation);
    if (identity.kind === "template")
      throw new ProtocolError("IMMUTABLE", "Templates are immutable", 409);
    if (this.stopping || this.get("stopped") === "true")
      throw new ProtocolError(
        "STOPPED",
        "Reopen the sandbox before executing operations",
        409,
      );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const { identity, operation: op } = await envelope(request);
      if (op.op === "peek")
        return reply({
          exists:
            this.get("generation") !== undefined &&
            this.get("deleted") !== "true",
        });
      if (op.op === "status") {
        this.check(op.generation);
        const j = this.journal(op.id);
        return reply(
          j
            ? j.result
              ? JSON.parse(j.result)
              : { id: j.id, state: j.state }
            : null,
        );
      }
      if (op.op === "execute" || op.op === "cancel") {
        this.check(op.generation);
        if (identity.kind === "template")
          throw new ProtocolError("IMMUTABLE", "Templates are immutable", 409);
        return reply(
          await this.execute(
            identity,
            op.generation,
            op.command,
            op.op === "cancel",
          ),
        );
      }
      if (op.op === "stop" || op.op === "delete") {
        this.check(op.generation);
        if (identity.kind === "template")
          throw new ProtocolError("IMMUTABLE", "Templates are immutable", 409);
        this.stopping = true;
        this.set("stopped", "true");
        for (const a of this.active.values()) a.controller.abort();
        // A barrier behind every accepted mutation. Cancellation bypasses the queue.
        await this.serialize(async () => {
          if (op.op === "delete")
            await this.ctx.storage.transaction(async () => {
              await this.store.clear();
              this.ctx.storage.sql.exec("DELETE FROM commands");
              this.set("deleted", "true");
            });
          await this.ctx.storage.sync();
        }, true);
        return reply(null);
      }
      return reply(
        await this.serialize(async () => {
          if (op.op === "open") {
            if (identity.kind === "template")
              throw new ProtocolError(
                "IMMUTABLE",
                "Use publish to capture a template",
                409,
              );
            if (op.generation !== undefined) this.check(op.generation);
            if (!this.get("generation") || this.get("deleted") === "true") {
              let entries = emptySnapshot();
              if (identity.kind === "session" && identity.template !== null) {
                const template: Identity = {
                  namespace: identity.namespace,
                  kind: "template",
                  key: identity.template,
                  template: null,
                };
                entries = responses.snapshot.parse(
                  await call(this.env, template, { op: "snapshot" }),
                );
              }
              await this.ctx.storage.transaction(async () => {
                await this.store.save(entries);
                this.set("generation", crypto.randomUUID());
                this.set("deleted", "false");
              });
            }
            this.set("stopped", "false");
            this.stopping = false;
            return {
              generation: this.get("generation")!,
              cellId: this.ctx.id.toString(),
            };
          }
          if (op.op === "publish") {
            if (
              identity.kind !== "template" ||
              op.source.kind !== "build" ||
              op.source.namespace !== identity.namespace
            )
              throw new ProtocolError(
                "INVALID_REQUEST",
                "Templates must be captured from a build in the same namespace",
              );
            if (this.get("generation")) return { reused: true };
            const entries = responses.snapshot.parse(
              await call(this.env, op.source, {
                op: "snapshot",
                generation: op.generation,
              }),
            );
            await this.ctx.storage.transaction(async () => {
              await this.store.save(entries);
              this.set("generation", crypto.randomUUID());
            });
            return { reused: false };
          }
          if (op.op === "snapshot") {
            if (identity.kind === "template") {
              if (!this.get("generation"))
                throw new ProtocolError(
                  "MISSING_TEMPLATE",
                  "Requested template has not been prewarmed",
                  404,
                );
            } else {
              if (!op.generation)
                throw new ProtocolError(
                  "INVALID_REQUEST",
                  "Generation required",
                );
              this.check(op.generation);
            }
            return this.store.load();
          }
          this.mutable(identity, op.generation);
          const fs = await hydrate(await this.store.load());
          const path = durablePath(op.path);
          if (op.op === "read") {
            if (!(await fs.exists(path))) return null;
            return base64(await fs.readFileBuffer(path));
          }
          if (op.op === "write") {
            await fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", {
              recursive: true,
            });
            await fs.writeFile(path, unbase64(op.data));
          } else
            await fs.rm(path, { recursive: op.recursive, force: op.force });
          const entries = await snapshot(fs);
          await this.ctx.storage.transaction(() => this.store.save(entries));
          return null;
        }),
      );
    } catch (e) {
      return errorResponse(e);
    }
  }
  private execute(
    identity: Identity,
    generation: string,
    command: Command,
    cancel: boolean,
  ): Promise<Terminal> {
    if (new TextEncoder().encode(command.command).length > LIMITS.commandBytes)
      throw new ProtocolError(
        "LIMIT",
        "Command source exceeds byte limit",
        413,
      );
    const fingerprint = commandFingerprint(command);
    const old = this.journal(command.id);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new ProtocolError(
          "ID_CONFLICT",
          "Command ID was already used with different input",
          409,
        );
      if (old.result)
        return Promise.resolve(responses.execute.parse(JSON.parse(old.result)));
      const active = this.active.get(command.id);
      if (!active)
        throw new ProtocolError(
          "RUNTIME",
          "Unfinished command has no execution",
          500,
        );
      if (cancel) active.controller.abort();
      return active.promise;
    }
    this.mutable(identity, generation);
    if (this.queued >= LIMITS.pending)
      throw new ProtocolError("BUSY", "Cell mutation queue is full", 429);
    // Record a cancel-before-execute as a terminal journal entry, closing the
    // transport ordering race without requiring AbortSignal to cross HTTP.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM commands WHERE result IS NOT NULL AND (created < ? OR id IN (SELECT id FROM commands WHERE result IS NOT NULL ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET ?))",
        Date.now() - LIMITS.journalAgeMs,
        LIMITS.journalCount - 1,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO commands VALUES(?,?,?,?,?)",
        command.id,
        fingerprint,
        "queued",
        null,
        Date.now(),
      );
      if (cancel)
        this.finish(
          failure(command.id, "cancelled", "Cancelled before execution"),
        );
    });
    if (cancel)
      return Promise.resolve(
        failure(command.id, "cancelled", "Cancelled before execution"),
      );
    const controller = new AbortController();
    const promise = this.serialize(async () => {
      let result: Terminal;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = Date.now();
      try {
        await this.ctx.storage.sync(); // Journal must survive a crash before starting.
        if (controller.signal.aborted)
          throw new ProtocolError("CANCELLED", "Cancelled before execution");
        this.ctx.storage.sql.exec(
          "UPDATE commands SET state='running' WHERE id=?",
          command.id,
        );
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, command.timeoutMs);
        const fs = await hydrate(await this.store.load());
        const bash = new Bash({
          fs,
          cwd: durablePath(command.cwd),
          env: { HOME: "/workspace", TMPDIR: "/tmp" },
          defenseInDepth: false,
          commands: [
            "cat",
            "jq",
            "echo",
            "printf",
            "pwd",
            "ls",
            "mkdir",
            "rmdir",
            "rm",
            "cp",
            "mv",
            "touch",
            "chmod",
            "stat",
            "ln",
            "readlink",
            "find",
            "grep",
            "head",
            "tail",
            "wc",
            "sort",
            "uniq",
            "cut",
            "tr",
            "sed",
            "awk",
            "sleep",
            "seq",
            "true",
            "false",
            "base64",
            "env",
            "printenv",
            "tee",
          ],
          customCommands: [
            defineCommand("agentfs-info", async () => ({
              stdout: JSON.stringify(await this.store.info()) + "\n",
              stderr: "",
              exitCode: 0,
            })),
            defineCommand("celld-runtime", async () => ({
              stdout: `celld/just-bash ${this.ctx.id.toString()}\n`,
              stderr: "",
              exitCode: 0,
            })),
          ],
          executionLimitProfile: "hardened",
          executionLimits: {
            maxSourceBytes: LIMITS.commandBytes,
            maxExecutionTimeMs: command.timeoutMs,
            maxCommandCount: 5000,
            maxLoopIterations: 5000,
            maxAwkIterations: 5000,
            maxSedIterations: 5000,
            maxJqIterations: 10000,
            maxWorkUnits: 100000,
            maxOutputSize: LIMITS.outputBytes,
            maxStringLength: LIMITS.fileBytes,
            maxArrayElements: 20000,
            maxCallDepth: 32,
            maxFileSystemBytes: LIMITS.snapshotBytes + LIMITS.fileBytes,
            maxLiveBytes: 16 * 1024 * 1024,
            maxInputBytes: 8 * 1024 * 1024,
            maxTraversalEntries: 2048,
            maxTraversalDepth: 64,
            maxTraversalWork: 10000,
          },
        });
        const r = await bash.exec(command.command, {
          cwd: durablePath(command.cwd),
          env: command.env,
          signal: controller.signal,
          rawScript: true,
        });
        if (
          controller.signal.aborted ||
          Date.now() - started >= command.timeoutMs
        )
          throw new ProtocolError(
            timedOut || Date.now() - started >= command.timeoutMs
              ? "TIMEOUT"
              : "CANCELLED",
            "Execution aborted; filesystem changes discarded",
          );
        if (fs.violation) throw fs.violation;
        if (
          new TextEncoder().encode(r.stdout).length +
            new TextEncoder().encode(r.stderr).length >
          LIMITS.outputBytes
        )
          throw new ProtocolError(
            "OUTPUT_LIMIT",
            "Combined output exceeds byte limit",
            413,
          );
        const entries = await snapshot(fs);
        // Snapshot enumeration yields too: cancellation must still win until
        // the commit begins, not just until Bash.exec returns. Check once more
        // inside the transaction after the SDK's asynchronous writes.
        if (
          controller.signal.aborted ||
          Date.now() - started >= command.timeoutMs
        ) {
          throw new ProtocolError(
            timedOut || Date.now() - started >= command.timeoutMs
              ? "TIMEOUT"
              : "CANCELLED",
            "Execution aborted before commit; filesystem changes discarded",
          );
        }
        result = {
          id: command.id,
          state: "completed",
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
        };
        await this.ctx.storage.transaction(async () => {
          await this.store.save(entries);
          if (
            controller.signal.aborted ||
            Date.now() - started >= command.timeoutMs
          )
            throw new ProtocolError(
              controller.signal.aborted && !timedOut ? "CANCELLED" : "TIMEOUT",
              "Execution aborted during commit; filesystem changes discarded",
            );
          this.finish(result);
        });
      } catch (e) {
        const code =
          e instanceof ProtocolError
            ? e.code
            : e instanceof Error && e.name === "ExecutionLimitError"
              ? "EXECUTION_LIMIT"
              : "RUNTIME";
        result = failure(
          command.id,
          timedOut || code === "TIMEOUT"
            ? "timeout"
            : controller.signal.aborted || code === "CANCELLED"
              ? "cancelled"
              : "failed",
          e instanceof Error ? e.message.slice(0, 1000) : "Execution failed",
          code,
        );
        this.ctx.storage.transactionSync(() => this.finish(result));
      } finally {
        if (timer) clearTimeout(timer);
      }
      await this.ctx.storage.sync();
      return result;
    });
    this.active.set(command.id, { controller, promise });
    void promise.finally(() => this.active.delete(command.id)).catch(() => {});
    return promise;
  }
}
