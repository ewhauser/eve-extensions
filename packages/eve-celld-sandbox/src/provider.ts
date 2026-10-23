import {
  defineSandboxProvider,
  type SandboxConnection,
  type SandboxJson,
  type SandboxPrepareContext,
  type SandboxSessionContext,
} from "eve/sandbox/provider";
import type { SandboxNetworkPolicy } from "eve/sandbox";

import { celldContainer, type CelldContainerOptions } from "./container.js";
import type { CelldOptions } from "./client.js";
import { celldJustBash } from "./just-bash.js";
import type { SandboxBackend, SandboxBackendHandle, SandboxSession } from "./legacy-backend.js";

type PreparedTemplate = { readonly templateKey: string };
type SessionState = {
  readonly metadata: Readonly<Record<string, SandboxJson>>;
  readonly sessionKey: string;
  readonly templateKey: string;
};
type Extensions = { setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> };

function connection(
  session: SandboxSession,
  lifecycle?: Pick<SandboxBackendHandle, "shutdown" | "stop">,
): SandboxConnection<Extensions> {
  return {
    workspaceRoot: session.resolvePath("."),
    spawn: (options) => session.spawn(options),
    readFile: (options) => session.readFile(options),
    writeFiles: (options) => session.writeFiles(options),
    removePath: (options) => session.removePath(options),
    stop: async () => { await lifecycle?.stop(); },
    close: async () => { await lifecycle?.shutdown(); },
    extensions: { setNetworkPolicy: (policy) => session.setNetworkPolicy(policy) },
  };
}

function providerImplementation(backend: SandboxBackend) {
  return {
    async prepare(context: SandboxPrepareContext): Promise<PreparedTemplate> {
      const key = context.templateKey({ provider: backend.name });
      await backend.prewarm({
        templateKey: key,
        runtimeContext: { appRoot: context.resolveProjectPath(".") },
        seedFiles: [],
        bootstrap: async ({ use }) => {
          await context.populate(connection(await use()));
        },
        log: context.log,
      });
      return { templateKey: key };
    },
    async start(context: SandboxSessionContext, _options: undefined, artifact: PreparedTemplate) {
      const handle = await backend.create({
        sessionKey: context.session.id,
        templateKey: artifact.templateKey,
        runtimeContext: { appRoot: context.resolveProjectPath(".") },
      });
      try {
        const captured = await handle.captureState();
        return {
          connection: connection(handle.session, handle),
          state: {
            metadata: captured.metadata as Record<string, SandboxJson>,
            sessionKey: captured.sessionKey,
            templateKey: artifact.templateKey,
          },
        };
      } catch (error) {
        await handle.delete().catch(() => undefined);
        throw error;
      }
    },
    async resume(context: SandboxSessionContext, _artifact: PreparedTemplate, state: SessionState) {
      // Reconnect using the recorded namespace, template, session and generation.
      const handle = await backend.create({
        existingMetadata: state.metadata,
        sessionKey: state.sessionKey,
        templateKey: state.templateKey,
        runtimeContext: { appRoot: context.resolveProjectPath(".") },
      });
      return connection(handle.session, handle);
    },
    async onSessionEnd(context: SandboxSessionContext, state: SessionState | null, options: { readonly abortSignal?: AbortSignal }) {
      if (state === null) return;
      const handle = await backend.create({
        existingMetadata: state.metadata,
        sessionKey: state.sessionKey,
        templateKey: state.templateKey,
        runtimeContext: { appRoot: context.resolveProjectPath(".") },
      });
      await handle.delete({ abortSignal: options.abortSignal });
    },
  };
}

/** Durable celld AgentFS/just-bash provider for Eve's connection-based sandbox API. */
export const CelldJustBashSandbox = defineSandboxProvider<
  CelldOptions,
  undefined,
  PreparedTemplate,
  SessionState,
  Extensions
>({
  name: "celld-just-bash-v1",
  environment: (options) => providerImplementation(celldJustBash(options)),
});

/** Ephemeral celld container provider for Eve's connection-based sandbox API. */
export const CelldContainerSandbox = defineSandboxProvider<
  CelldContainerOptions,
  undefined,
  PreparedTemplate,
  SessionState,
  Extensions
>({
  name: "celld-container-v1",
  environment: (options) => providerImplementation(celldContainer(options)),
});
