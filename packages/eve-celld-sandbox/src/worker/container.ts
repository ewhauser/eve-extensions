import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import {
  containerName,
  ContainerEnvelope,
  Recipe,
  type ContainerCommand,
  type RecipeStep,
  type ContainerOperation,
} from "../container-protocol.js";
import {
  commandFingerprint,
  failure,
  Identity,
  LIMITS,
  ProtocolError,
  ResponseEnvelope,
  unbase64,
  VERSION,
  type Terminal,
} from "../protocol.js";
import { errorResponse, jsonBody, reply } from "./http.js";

export type ContainerEnv = {
  CONTAINERS: DurableObjectNamespace<ContainerCell>;
  SERVICE_TOKEN: string;
};
type Active = {
  controller: AbortController;
  promise: Promise<Terminal>;
  command: ContainerCommand;
};
type Journal = { id: string; fingerprint: string; result: string | null };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function containerStub(env: ContainerEnv, identity: Identity) {
  const name = await containerName(identity);
  return getSandbox(env.CONTAINERS, name, {
    normalizeId: true,
    transport: "http",
    keepAlive: true,
  });
}
async function call(
  env: ContainerEnv,
  identity: Identity,
  operation: ContainerOperation,
): Promise<unknown> {
  const sandbox = await containerStub(env, identity);
  const response = await sandbox.fetch(
    new Request("http://cell/__eve", {
      method: "POST",
      body: JSON.stringify({ version: VERSION, identity, operation }),
    }),
  );
  const data = ResponseEnvelope.parse(await response.json());
  if (!data.ok)
    throw new ProtocolError(
      data.error.code,
      data.error.message,
      response.status,
    );
  return data.value;
}

/** SDK execution remains inside the container; only Eve lifecycle metadata and initialization recipes are durable. */
export class ContainerCell extends Sandbox<ContainerEnv> {
  private eveTail: Promise<unknown> = Promise.resolve();
  private eveActive = new Map<string, Active>();
  private eveStopping = false;
  constructor(ctx: DurableObjectState<{}>, env: ContainerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS eve_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS eve_commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT, created REAL NOT NULL)",
    );
    for (const row of ctx.storage.sql
      .exec<Journal>("SELECT * FROM eve_commands WHERE result IS NULL")
      .toArray()) {
      this.finish(
        failure(
          row.id,
          "interrupted",
          "Controller restarted; native command outcome is unknown. The command was not replayed.",
        ),
      );
      this.putMeta("recipe_failed", "true");
    }
  }
  private meta(key: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM eve_meta WHERE key=?", key)
      .toArray()[0]?.value;
  }
  private putMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO eve_meta VALUES(?,?)",
      key,
      value,
    );
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.eveTail.then(fn);
    this.eveTail = pending.catch(() => {});
    return pending;
  }
  private check(
    generation: string,
    incarnation?: string,
    requireRunning = true,
  ) {
    if (
      generation !== this.meta("generation") ||
      this.meta("deleted") === "true"
    )
      throw new ProtocolError(
        "STALE_SESSION",
        "Container session was deleted or replaced",
        409,
      );
    if (incarnation !== undefined && incarnation !== this.meta("incarnation"))
      throw new ProtocolError(
        "STALE_SESSION",
        "Container was replaced; reopen the sandbox",
        409,
      );
    if (
      requireRunning &&
      (this.eveStopping ||
        !this.ctx.container?.running ||
        this.meta("ready") !== "true")
    )
      throw new ProtocolError(
        "STOPPED",
        "Container stopped; reopen the sandbox (files are ephemeral)",
        409,
      );
  }
  override async onStart(): Promise<void> {
    await super.onStart();
    this.ctx.storage.transactionSync(() => {
      this.putMeta("incarnation", crypto.randomUUID());
      this.putMeta("ready", "false");
    });
  }
  private finish(result: Terminal) {
    this.ctx.storage.sql.exec(
      "UPDATE eve_commands SET result=? WHERE id=?",
      JSON.stringify(result),
      result.id,
    );
  }
  private appendRecipe(step: RecipeStep) {
    const recipe = Recipe.parse(JSON.parse(this.meta("recipe") ?? "[]"));
    recipe.push(step);
    const encoded = JSON.stringify(Recipe.parse(recipe));
    if (new TextEncoder().encode(encoded).length > LIMITS.requestBytes - 4096)
      throw new ProtocolError(
        "LIMIT",
        "Container initialization recipe exceeds size limit",
        413,
      );
    this.putMeta("recipe", encoded);
  }
  private async applyFile(step: Exclude<RecipeStep, { op: "execute" }>) {
    if (step.op === "write") {
      if (unbase64(step.data).byteLength > LIMITS.fileBytes)
        throw new ProtocolError(
          "LIMIT",
          "File transfer exceeds byte limit",
          413,
        );
      await this.mkdir(step.path.slice(0, step.path.lastIndexOf("/")) || "/", {
        recursive: true,
      });
      await this.writeFile(step.path, step.data, { encoding: "base64" });
    } else {
      const result = await this.exec(
        `rm ${step.recursive ? "-r " : ""}${step.force ? "-f " : ""}-- ${quote(step.path)}`,
        { timeout: 10_000 },
      );
      if (result.exitCode !== 0)
        throw new ProtocolError("FILESYSTEM", result.stderr, 409);
    }
  }
  private async runNative(
    command: ContainerCommand,
    controller: AbortController,
  ): Promise<Terminal> {
    const incarnation = this.meta("incarnation");
    const sessionId = `eve-${command.id}`;
    let started = false;
    let createdSession = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let kill: Promise<void> | undefined;
    const cancel = () => {
      if (started) kill ??= this.killProcess(command.id, "SIGKILL", sessionId);
      void kill?.catch(() => {});
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      controller.signal.throwIfAborted();
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, command.timeoutMs);
      await this.createSession({
        id: sessionId,
        cwd: command.cwd,
        env: command.env,
      });
      createdSession = true;
      controller.signal.throwIfAborted();
      // Inside the DO class the SDK takes sessionId as its third argument.
      // The getSandbox() proxy translates options.sessionId only for RPC callers.
      // A child shell keeps `exit`/`exec` from terminating the SDK's session shell.
      const process = await this.startProcess(
        `bash -c ${quote(command.command)}`,
        {
          processId: command.id,
          autoCleanup: false,
          cwd: command.cwd,
          env: command.env,
          timeout: command.timeoutMs,
        },
        sessionId,
      );
      started = true;
      if (controller.signal.aborted) cancel();
      const status = await process.waitForExit(command.timeoutMs + 10_000);
      if (kill) await kill;
      const logs = await this.getProcessLogs(command.id, sessionId);
      if (controller.signal.aborted)
        return failure(
          command.id,
          timedOut ? "timeout" : "cancelled",
          "Native command stopped; partial filesystem writes may remain.",
        );
      if (
        new TextEncoder().encode(logs.stdout).length +
          new TextEncoder().encode(logs.stderr).length >
        LIMITS.outputBytes
      )
        throw new ProtocolError(
          "OUTPUT_LIMIT",
          "Command output exceeds transfer limit; writes are not rolled back",
          413,
        );
      return {
        id: command.id,
        state: "completed",
        stdout: logs.stdout,
        stderr: logs.stderr,
        exitCode: status.exitCode ?? 125,
      };
    } catch (error) {
      if (
        started &&
        !kill &&
        this.ctx.container?.running &&
        incarnation === this.meta("incarnation")
      ) {
        try {
          await this.killProcess(command.id, "SIGKILL", sessionId);
        } catch {
          /* The process may already have exited. */
        }
      }
      return failure(
        command.id,
        timedOut
          ? "timeout"
          : controller.signal.aborted
            ? "cancelled"
            : "failed",
        error instanceof Error
          ? error.message.slice(0, 1000)
          : "Native command failed",
      );
    } finally {
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
      if (
        createdSession &&
        this.ctx.container?.running &&
        incarnation === this.meta("incarnation")
      ) {
        try {
          await this.deleteSession(sessionId);
        } catch {
          /* Container teardown also removes sessions. */
        }
      }
    }
  }
  private execute(
    identity: Identity,
    op: Extract<ContainerOperation, { op: "execute" | "cancel" }>,
  ): Promise<Terminal> {
    this.check(op.generation, op.incarnation);
    if (identity.kind === "template")
      throw new ProtocolError("IMMUTABLE", "Templates are immutable", 409);
    if (
      new TextEncoder().encode(op.command.command).length > LIMITS.commandBytes
    )
      throw new ProtocolError(
        "LIMIT",
        "Command source exceeds byte limit",
        413,
      );
    const fingerprint = commandFingerprint(op.command);
    const old = this.ctx.storage.sql
      .exec<Journal>("SELECT * FROM eve_commands WHERE id=?", op.command.id)
      .toArray()[0];
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new ProtocolError(
          "ID_CONFLICT",
          "Command ID reused with different input",
          409,
        );
      if (old.result) return Promise.resolve(JSON.parse(old.result));
      const active = this.eveActive.get(op.command.id);
      if (!active)
        throw new ProtocolError(
          "OUTCOME_UNKNOWN",
          "Native command outcome is unknown; it was not replayed",
          409,
        );
      if (op.op === "cancel") active.controller.abort();
      return active.promise;
    }
    if (this.eveActive.size >= LIMITS.pending)
      throw new ProtocolError("BUSY", "Too many active commands", 429);
    this.ctx.storage.sql.exec(
      "DELETE FROM eve_commands WHERE result IS NOT NULL AND (created < ? OR id IN (SELECT id FROM eve_commands WHERE result IS NOT NULL ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET ?))",
      Date.now() - LIMITS.journalAgeMs,
      LIMITS.journalCount - 1,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO eve_commands VALUES(?,?,NULL,?)",
      op.command.id,
      fingerprint,
      Date.now(),
    );
    if (op.op === "cancel") {
      const result = failure(
        op.command.id,
        "cancelled",
        "Cancelled before execution",
      );
      this.finish(result);
      return Promise.resolve(result);
    }
    const controller = new AbortController();
    const run = async () => {
      await this.ctx.storage.sync();
      const result = await this.runNative(op.command, controller);
      if (identity.kind === "build") {
        if (result.state === "completed") {
          try {
            this.appendRecipe({ op: "execute", command: op.command });
          } catch (error) {
            this.putMeta("recipe_failed", "true");
            throw error;
          }
        } else this.putMeta("recipe_failed", "true");
      }
      this.finish(result);
      await this.ctx.storage.sync();
      return result;
    };
    const promise = identity.kind === "build" ? this.serialize(run) : run();
    this.eveActive.set(op.command.id, {
      controller,
      promise,
      command: op.command,
    });
    void promise
      .finally(() => this.eveActive.delete(op.command.id))
      .catch(() => {});
    return promise;
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__eve") return super.fetch(request);
    try {
      const { identity, operation: op } = ContainerEnvelope.parse(
        await jsonBody(request),
      );
      if (op.op === "peek")
        return reply({ exists: this.meta("published") === "true" });
      if (op.op === "execute" || op.op === "cancel")
        return reply(await this.execute(identity, op));
      if (op.op === "stop" || op.op === "delete") {
        this.check(op.generation, op.incarnation, false);
        this.eveStopping = true;
        for (const active of this.eveActive.values()) active.controller.abort();
        await Promise.allSettled(
          [...this.eveActive.values()].map((active) => active.promise),
        );
        return reply(
          await this.serialize(async () => {
            this.check(op.generation, op.incarnation, false);
            await this.destroy();
            this.putMeta("ready", "false");
            if (op.op === "delete") this.putMeta("deleted", "true");
            return null;
          }),
        );
      }
      if (op.op === "capture") {
        await Promise.all(
          [...this.eveActive.values()].map((active) => active.promise),
        );
      }
      return reply(
        await this.serialize(async () => {
          if (op.op === "publish") {
            if (
              identity.kind !== "template" ||
              op.source.kind !== "build" ||
              op.source.namespace !== identity.namespace ||
              op.source.template !== identity.key
            )
              throw new ProtocolError(
                "INVALID_REQUEST",
                "Invalid template source",
              );
            if (this.meta("published") === "true") return { reused: true };
            const recipe = Recipe.parse(
              await call(this.env, op.source, {
                op: "recipe",
                generation: op.generation,
                incarnation: op.incarnation,
              }),
            );
            this.ctx.storage.transactionSync(() => {
              this.putMeta("recipe", JSON.stringify(recipe));
              this.putMeta("published", "true");
            });
            return { reused: false };
          }
          if (op.op === "recipe") {
            if (identity.kind === "template") {
              if (this.meta("published") !== "true")
                throw new ProtocolError(
                  "MISSING_TEMPLATE",
                  "Container initialization template has not been prewarmed",
                  404,
                );
            } else {
              if (!op.generation || !op.incarnation)
                throw new ProtocolError("METADATA", "Missing build identity");
              this.check(op.generation, op.incarnation);
              if (
                identity.kind !== "build" ||
                this.meta("recipe_failed") === "true"
              )
                throw new ProtocolError(
                  "BOOTSTRAP",
                  "Cannot publish failed container initialization",
                  409,
                );
            }
            return Recipe.parse(JSON.parse(this.meta("recipe") ?? "[]"));
          }
          if (op.op === "open") {
            if (identity.kind === "template")
              throw new ProtocolError(
                "IMMUTABLE",
                "Use publish to create a template",
              );
            if (op.generation) this.check(op.generation, undefined, false);
            this.eveStopping = false;
            if (!this.meta("generation") || this.meta("deleted") === "true") {
              this.putMeta("generation", crypto.randomUUID());
              this.putMeta("deleted", "false");
            }
            if (!this.ctx.container?.running || this.meta("ready") !== "true") {
              const recipe =
                identity.kind === "session" && identity.template !== null
                  ? Recipe.parse(
                      await call(
                        this.env,
                        {
                          ...identity,
                          kind: "template",
                          key: identity.template,
                          template: null,
                        },
                        { op: "recipe" },
                      ),
                    )
                  : [];
              try {
                const init = await this.exec("mkdir -p /workspace", {
                  timeout: 60_000,
                });
                if (init.exitCode) throw new Error(init.stderr);
                // onStart identifies each physical container independently of its durable DO identity.
                if (!this.meta("incarnation"))
                  this.putMeta("incarnation", crypto.randomUUID());
                this.ctx.storage.sql.exec("DELETE FROM eve_commands");
                this.putMeta("recipe", "[]");
                this.putMeta("recipe_failed", "false");
                for (const step of recipe) {
                  if (step.op === "execute") {
                    const result = await this.runNative(
                      { ...step.command, id: crypto.randomUUID() },
                      new AbortController(),
                    );
                    if (result.state !== "completed")
                      throw new ProtocolError("BOOTSTRAP", result.stderr, 409);
                  } else await this.applyFile(step);
                }
                this.putMeta("ready", "true");
              } catch (error) {
                this.putMeta("ready", "false");
                await this.destroy();
                throw error;
              }
            }
            return {
              generation: this.meta("generation")!,
              incarnation: this.meta("incarnation")!,
            };
          }
          this.check(op.generation, op.incarnation);
          if (op.op === "capture") return null;
          if (identity.kind === "template")
            throw new ProtocolError("IMMUTABLE", "Templates are immutable");
          if (op.op === "read") {
            if (!(await this.exists(op.path)).exists) return null;
            // Bound bytes before crossing into the DO, even if a concurrent
            // process is growing the file. Base64 preserves arbitrary bytes.
            const file = await this.exec(
              `bash -c ${quote(`set -o pipefail; head -c ${LIMITS.fileBytes + 1} -- ${quote(op.path)} | base64 -w0`)}`,
              { timeout: 10_000 },
            );
            if (file.exitCode !== 0)
              throw new ProtocolError("FILESYSTEM", file.stderr, 409);
            if (unbase64(file.stdout).byteLength > LIMITS.fileBytes)
              throw new ProtocolError(
                "LIMIT",
                "File transfer exceeds byte limit",
                413,
              );
            return file.stdout;
          }
          const step: RecipeStep =
            op.op === "write"
              ? { op: "write", path: op.path, data: op.data }
              : {
                  op: "remove",
                  path: op.path,
                  recursive: op.recursive,
                  force: op.force,
                };
          try {
            await this.applyFile(step);
            if (identity.kind === "build") this.appendRecipe(step);
          } catch (error) {
            if (identity.kind === "build")
              this.putMeta("recipe_failed", "true");
            throw error;
          }
          return null;
        }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  }
}
