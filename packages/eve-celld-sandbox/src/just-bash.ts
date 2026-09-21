import {
  SandboxTemplateNotProvisionedError,
  type SandboxBackend,
  type SandboxBackendHandle,
  type SandboxSession,
  type SandboxSpawnOptions,
  type SandboxProcess,
  type SandboxReadTextFileOptions,
} from "eve/sandbox";
import {
  base64,
  unbase64,
  cellName,
  Identity,
  LIMITS,
  ProtocolError,
  readBounded,
  resolvePath,
  VERSION,
  type Terminal,
} from "./protocol.js";
import { CelldClient, type CelldOptions } from "./client.js";
export { CelldClient, type CelldOptions } from "./client.js";
export { ProtocolError } from "./protocol.js";
const NAME = "celld-just-bash-v1";
function checkOptions(options: unknown) {
  if (options && Object.keys(options).length)
    throw new ProtocolError(
      "UNSUPPORTED",
      "This backend accepts no per-session or bootstrap provider options",
    );
}
function terminal(result: Terminal): Terminal {
  if (result.state !== "completed")
    throw new ProtocolError(
      result.error ?? result.state.toUpperCase(),
      result.stderr,
      409,
    );
  return result;
}
function decode(
  bytes: Uint8Array,
  options: SandboxReadTextFileOptions,
): string {
  const encoding = options.encoding ?? "utf-8";
  const text =
    encoding === "utf8" || encoding === "utf-8"
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : Buffer.from(bytes).toString(encoding as BufferEncoding);
  if (options.startLine === undefined && options.endLine === undefined)
    return text;
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  return lines.slice((options.startLine ?? 1) - 1, options.endLine).join("");
}
function streamOf(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

export function celldJustBash(options: CelldOptions): SandboxBackend {
  const client = new CelldClient(options);
  const identity = (
    kind: Identity["kind"],
    key: string,
    template: string | null = null,
  ): Identity =>
    Identity.parse({ namespace: options.namespace, kind, key, template });
  async function handle(
    ref: Identity,
    id: string,
    generation?: string,
  ): Promise<SandboxBackendHandle> {
    const opened = await client.request(ref, { op: "open", generation });
    let closed = false;
    const pending = new Set<Promise<unknown>>();
    function live() {
      if (closed)
        throw new ProtocolError("STOPPED", "Reopen this sandbox handle");
    }
    function track<T>(promise: Promise<T>): Promise<T> {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise)).catch(() => {});
      return promise;
    }
    const gen = opened.generation;
    async function spawn(input: SandboxSpawnOptions): Promise<SandboxProcess> {
      live();
      input.abortSignal?.throwIfAborted();
      const command = client.command({
        command: input.command,
        cwd:
          input.workingDirectory === undefined
            ? "/workspace"
            : resolvePath(input.workingDirectory),
        env: input.env,
      });
      const execution = track(
        client.request(ref, { op: "execute", generation: gen, command }),
      );
      let cancelPromise: Promise<void> | undefined;
      const cancel = () =>
        (cancelPromise ??= track(
          (async () => {
            await client.request(ref, {
              op: "cancel",
              generation: gen,
              command,
            });
            await execution;
          })(),
        ));
      const onAbort = () => {
        void cancel().catch(() => {});
      };
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (input.abortSignal?.aborted) onAbort();
      void execution
        .finally(() => input.abortSignal?.removeEventListener("abort", onAbort))
        .catch(() => {});
      // Buffered, one chunk after the remote commit; no claim of live streaming.
      function output(which: "stdout" | "stderr") {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            void execution
              .then(
                (r) => {
                  controller.enqueue(new TextEncoder().encode(r[which]));
                  controller.close();
                },
                (e) => controller.error(e),
              )
              .catch(() => {});
          },
        });
      }
      return {
        stdout: output("stdout"),
        stderr: output("stderr"),
        async wait() {
          const r = await execution;
          if (input.abortSignal?.aborted && r.state !== "completed")
            throw input.abortSignal.reason;
          terminal(r);
          return { exitCode: r.exitCode };
        },
        async kill() {
          await cancel();
        },
      };
    }
    const session: SandboxSession = {
      id,
      resolvePath,
      spawn,
      async run(input) {
        const p = await spawn(input);
        const [out, err, status] = await Promise.all([
          readBounded(p.stdout, LIMITS.outputBytes),
          readBounded(p.stderr, LIMITS.outputBytes),
          p.wait(),
        ]);
        return {
          stdout: new TextDecoder().decode(out),
          stderr: new TextDecoder().decode(err),
          exitCode: status.exitCode,
        };
      },
      async readBinaryFile(input) {
        live();
        input.abortSignal?.throwIfAborted();
        const data = await client.request(
          ref,
          { op: "read", generation: gen, path: resolvePath(input.path) },
          input.abortSignal,
        );
        return data === null ? null : unbase64(data);
      },
      async readFile(input) {
        const data = await session.readBinaryFile(input);
        return data === null ? null : streamOf(data);
      },
      async readTextFile(input) {
        for (const v of [input.startLine, input.endLine])
          if (v !== undefined && (!Number.isInteger(v) || v < 1))
            throw new Error("Line numbers must be positive integers (1-based)");
        if (
          input.startLine !== undefined &&
          input.endLine !== undefined &&
          input.startLine > input.endLine
        )
          throw new Error("startLine must not be greater than endLine");
        const data = await session.readBinaryFile(input);
        return data === null ? null : decode(data, input);
      },
      async writeBinaryFile(input) {
        live();
        input.abortSignal?.throwIfAborted();
        if (input.content.byteLength > LIMITS.fileBytes)
          throw new ProtocolError("LIMIT", "Per-file byte limit exceeded", 413);
        await track(
          client.request(
            ref,
            {
              op: "write",
              generation: gen,
              path: resolvePath(input.path),
              data: base64(input.content),
            },
            input.abortSignal,
          ),
        );
      },
      async writeFile(input) {
        live();
        input.abortSignal?.throwIfAborted();
        await session.writeBinaryFile({
          ...input,
          content: await readBounded(input.content, LIMITS.fileBytes),
        });
      },
      async writeTextFile(input) {
        await session.writeBinaryFile({
          ...input,
          content: Buffer.from(
            input.content,
            (input.encoding ?? "utf-8") as BufferEncoding,
          ),
        });
      },
      async removePath(input) {
        live();
        input.abortSignal?.throwIfAborted();
        await track(
          client.request(
            ref,
            {
              op: "remove",
              generation: gen,
              path: resolvePath(input.path),
              force: input.force ?? false,
              recursive: input.recursive ?? false,
            },
            input.abortSignal,
          ),
        );
      },
      async setNetworkPolicy(policy) {
        if (policy !== "deny-all")
          throw new ProtocolError(
            "UNSUPPORTED",
            "Only deny-all is supported; command networking is disabled",
          );
      },
    };
    async function stop() {
      closed = true;
      await client.request(ref, { op: "stop", generation: gen });
      await Promise.allSettled([...pending]);
    }
    return {
      session,
      useSessionFn: async (o) => {
        checkOptions(o);
        live();
        return session;
      },
      async captureState() {
        // Eve captures reconnect metadata after authored stop() hooks too.
        // The remote generation check still rejects a deleted sandbox.
        await client.request(ref, { op: "snapshot", generation: gen });
        return {
          backendName: NAME,
          sessionKey: id,
          metadata: {
            protocol: VERSION,
            schema: 1,
            identity: ref,
            generation: gen,
          },
        };
      },
      stop,
      shutdown: stop,
      async delete(input) {
        input?.abortSignal?.throwIfAborted();
        closed = true;
        await client.request(
          ref,
          { op: "delete", generation: gen },
          input?.abortSignal,
        );
        await Promise.allSettled([...pending]);
      },
    };
  }
  return {
    name: NAME,
    async create(input) {
      const ref = identity("session", input.sessionKey, input.templateKey);
      let generation: string | undefined;
      if (input.existingMetadata) {
        const m = input.existingMetadata;
        if (
          m.protocol !== VERSION ||
          m.schema !== 1 ||
          typeof m.generation !== "string" ||
          cellName(Identity.parse(m.identity)) !== cellName(ref)
        )
          throw new ProtocolError(
            "METADATA",
            "Reconnect metadata does not match this namespace, template, session, or protocol",
          );
        generation = m.generation;
      }
      try {
        return await handle(ref, input.sessionKey, generation);
      } catch (e) {
        if (
          e instanceof ProtocolError &&
          e.code === "MISSING_TEMPLATE" &&
          input.templateKey !== null
        )
          throw new SandboxTemplateNotProvisionedError({
            backendName: NAME,
            templateKey: input.templateKey,
          });
        throw e;
      }
    },
    async prewarm(input) {
      const template = identity("template", input.templateKey);
      if ((await client.request(template, { op: "peek" })).exists)
        return { reused: true };
      const ref = identity("build", crypto.randomUUID(), input.templateKey);
      const build = await handle(ref, input.templateKey);
      try {
        for (const file of input.seedFiles)
          await build.session.writeBinaryFile({
            path: file.path,
            content:
              typeof file.content === "string"
                ? new TextEncoder().encode(file.content)
                : file.content,
          });
        if (input.bootstrap) {
          input.log?.("Running bootstrap through celld");
          await input.bootstrap({
            use: async (o) => {
              checkOptions(o);
              return build.session;
            },
          });
        }
        const state = await build.captureState();
        return await client.request(template, {
          op: "publish",
          source: ref,
          generation: state.metadata.generation as string,
        });
      } finally {
        await build.delete();
      }
    },
  };
}
