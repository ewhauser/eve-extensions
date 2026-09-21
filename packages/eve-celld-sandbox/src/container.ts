import {
  SandboxTemplateNotProvisionedError,
  type SandboxBackend,
  type SandboxBackendHandle,
  type SandboxProcess,
} from "eve/sandbox";
import { z } from "zod";
import { CelldTransport, type CelldOptions } from "./transport.js";
import {
  ContainerCommand,
  CONTAINER_TIMEOUT_MS,
  MAX_CONTAINER_TIMEOUT_MS,
  containerResponses,
  type ContainerOperation,
} from "./container-protocol.js";
import {
  Identity,
  VERSION,
  LIMITS,
  ProtocolError,
  base64,
  unbase64,
  cellName,
  resolvePath,
} from "./protocol.js";
import { buildSession, checkProviderOptions } from "./session.js";

export interface CelldContainerOptions extends CelldOptions {
  /** Native command deadline; defaults to 60 seconds, at most 15 minutes. */
  commandTimeoutMs?: number;
}
const NAME = "celld-container-v1";
const Metadata = z.object({
  protocol: z.literal(VERSION),
  schema: z.literal(1),
  identity: Identity,
  generation: z.string().uuid(),
  incarnation: z.string().uuid(),
});

/** A Cloudflare Sandbox container on celld. All container files are ephemeral. */
export function celldContainer(options: CelldContainerOptions): SandboxBackend {
  const transport = new CelldTransport(options);
  const timeoutMs = z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTAINER_TIMEOUT_MS)
    .parse(options.commandTimeoutMs ?? CONTAINER_TIMEOUT_MS);
  const identity = (
    kind: Identity["kind"],
    key: string,
    template: string | null = null,
  ) => Identity.parse({ namespace: options.namespace, kind, key, template });
  async function request<O extends ContainerOperation>(
    ref: Identity,
    operation: O,
    signal?: AbortSignal,
  ): Promise<z.infer<(typeof containerResponses)[O["op"]]>> {
    // Native processes can cause effects outside the journal. Never retry an uncertain request.
    const value = await transport.request(
      "/container/v1",
      { version: VERSION, identity: ref, operation },
      signal,
      MAX_CONTAINER_TIMEOUT_MS + 120_000,
    );
    return containerResponses[operation.op].parse(value) as z.infer<
      (typeof containerResponses)[O["op"]]
    >;
  }
  async function open(
    ref: Identity,
    generation?: string,
  ): Promise<SandboxBackendHandle> {
    const state = await request(ref, { op: "open", generation });
    let closed = false;
    let stopped = false;
    let stopping: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const live = () => {
      if (closed)
        throw new ProtocolError(
          "STOPPED",
          "Sandbox handle is stopped; reopen it",
        );
    };
    function track<T>(promise: Promise<T>) {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise)).catch(() => {});
      return promise;
    }
    const session = buildSession({
      id: ref.key,
      async spawn(input): Promise<SandboxProcess> {
        live();
        input.abortSignal?.throwIfAborted();
        const command = ContainerCommand.parse({
          id: crypto.randomUUID(),
          command: input.command,
          cwd:
            input.workingDirectory === undefined
              ? "/workspace"
              : resolvePath(input.workingDirectory),
          env: input.env,
          timeoutMs,
        });
        const execution = track(
          request(ref, { op: "execute", ...state, command }),
        );
        let cancellation: Promise<void> | undefined;
        const cancel = () =>
          (cancellation ??= track(
            (async () => {
              await request(ref, { op: "cancel", ...state, command });
              await execution;
            })(),
          ));
        const onAbort = () => {
          void cancel().catch(() => {});
        };
        input.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (input.abortSignal?.aborted) onAbort();
        void execution
          .finally(() =>
            input.abortSignal?.removeEventListener("abort", onAbort),
          )
          .catch(() => {});
        const output = (which: "stdout" | "stderr") =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              void execution
                .then(
                  (result) => {
                    controller.enqueue(new TextEncoder().encode(result[which]));
                    controller.close();
                  },
                  (error) => controller.error(error),
                )
                .catch(() => {});
            },
          });
        return {
          stdout: output("stdout"),
          stderr: output("stderr"),
          kill: cancel,
          async wait() {
            const result = await execution;
            if (result.state !== "completed") {
              if (input.abortSignal?.aborted) throw input.abortSignal.reason;
              throw new ProtocolError(
                result.error ?? result.state.toUpperCase(),
                result.stderr,
                409,
              );
            }
            return { exitCode: result.exitCode };
          },
        };
      },
      async readBinaryFile(input) {
        live();
        const data = await request(
          ref,
          { op: "read", ...state, path: resolvePath(input.path) },
          input.abortSignal,
        );
        return data === null ? null : unbase64(data);
      },
      async writeBinaryFile(input) {
        live();
        input.abortSignal?.throwIfAborted();
        if (input.content.byteLength > LIMITS.fileBytes)
          throw new ProtocolError(
            "LIMIT",
            "Per-file transfer limit exceeded",
            413,
          );
        await track(
          request(
            ref,
            {
              op: "write",
              ...state,
              path: resolvePath(input.path),
              data: base64(input.content),
            },
            input.abortSignal,
          ),
        );
      },
      async removePath(input) {
        live();
        await track(
          request(
            ref,
            {
              op: "remove",
              ...state,
              path: resolvePath(input.path),
              recursive: input.recursive ?? false,
              force: input.force ?? false,
            },
            input.abortSignal,
          ),
        );
      },
      async setNetworkPolicy() {
        throw new ProtocolError(
          "UNSUPPORTED",
          "Runtime network policies are unsupported; configure the celld container network at deployment",
        );
      },
    });
    const metadata = { protocol: VERSION, schema: 1, identity: ref, ...state };
    async function stop() {
      if (stopped) return;
      closed = true;
      stopping ??= (async () => {
        await request(ref, { op: "stop", ...state });
        await Promise.allSettled([...pending]);
        stopped = true;
      })().catch((error) => {
        stopping = undefined;
        throw error;
      });
      await stopping;
    }
    return {
      session,
      useSessionFn: async (o) => {
        checkProviderOptions(o);
        live();
        return session;
      },
      async captureState() {
        if (closed && !stopped) await stop();
        if (!closed) {
          await Promise.all([...pending]);
          await request(ref, { op: "capture", ...state });
        }
        return { backendName: NAME, sessionKey: ref.key, metadata };
      },
      stop,
      shutdown: stop,
      async delete(input) {
        input?.abortSignal?.throwIfAborted();
        closed = true;
        await request(ref, { op: "delete", ...state }, input?.abortSignal);
        await Promise.allSettled([...pending]);
        stopped = true;
      },
    };
  }
  return {
    name: NAME,
    async create(input) {
      const ref = identity("session", input.sessionKey, input.templateKey);
      let generation: string | undefined;
      if (input.existingMetadata) {
        const result = Metadata.safeParse(input.existingMetadata);
        if (!result.success || cellName(result.data.identity) !== cellName(ref))
          throw new ProtocolError(
            "METADATA",
            "Reconnect metadata does not match this container session",
          );
        generation = result.data.generation;
      }
      try {
        return await open(ref, generation);
      } catch (error) {
        if (
          error instanceof ProtocolError &&
          error.code === "MISSING_TEMPLATE" &&
          input.templateKey !== null
        )
          throw new SandboxTemplateNotProvisionedError({
            backendName: NAME,
            templateKey: input.templateKey,
          });
        throw error;
      }
    },
    async prewarm(input) {
      const template = identity("template", input.templateKey);
      if ((await request(template, { op: "peek" })).exists)
        return { reused: true };
      const ref = identity("build", crypto.randomUUID(), input.templateKey);
      const build = await open(ref);
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
          input.log?.("Validating celld container initialization");
          await input.bootstrap({
            use: async (o) => {
              checkProviderOptions(o);
              return build.session;
            },
          });
        }
        const { metadata } = await build.captureState();
        return await request(template, {
          op: "publish",
          source: ref,
          generation: metadata.generation as string,
          incarnation: metadata.incarnation as string,
        });
      } finally {
        await build.delete();
      }
    },
  };
}
