import { createHash } from "node:crypto";
import { defineSandboxProvider, type SandboxProviderResources } from "eve/sandbox/provider";

import { celldContainer, type CelldContainerOptions } from "./container.js";
import type { CelldOptions } from "./client.js";
import { celldJustBash } from "./just-bash.js";
import type { SandboxBackend, SandboxBackendHandle, SandboxSession } from "./legacy-backend.js";

type PreparedTemplate = {
  readonly templateKey: string;
};

interface SessionState extends PreparedTemplate {
  readonly metadata: Record<string, unknown>;
  readonly sessionKey: string;
}

function templateKey(name: string, sourceRevision: string, resources: SandboxProviderResources) {
  return createHash("sha256")
    .update(JSON.stringify([name, sourceRevision, resources.source, resources.skills?.key, resources.workspace?.key]))
    .digest("hex");
}

function seedFiles(resources: SandboxProviderResources) {
  return [resources.workspace, resources.skills].flatMap((tree) =>
    tree?.files.map((file) => ({
      content: file.content,
      path: `${tree.targetPath}/${file.relativePath}`,
    })) ?? [],
  );
}

function providerHandle(handle: SandboxBackendHandle) {
  return {
    sandbox: handle.session,
    onRuntimeShutdown: () => handle.shutdown(),
    onSessionDelete: (options?: { readonly abortSignal?: AbortSignal }) => handle.delete(options),
    onSessionStop: () => handle.stop(),
  };
}

function providerImplementation(backend: SandboxBackend) {
  return {
    async prepare(context: {
      readonly sourceRevision: string;
      readonly resources: SandboxProviderResources;
      readonly host: { resolveProjectPath(path: string): string };
      readonly log?: (message: string) => void;
    }): Promise<PreparedTemplate> {
      const key = templateKey(backend.name, context.sourceRevision, context.resources);
      await backend.prewarm({
        templateKey: key,
        runtimeContext: { appRoot: context.host.resolveProjectPath(".") },
        seedFiles: seedFiles(context.resources),
        ...(context.log === undefined ? {} : { log: context.log }),
      });
      return { templateKey: key };
    },
    async start(
      context: {
        readonly host: { resolveProjectPath(path: string): string };
        readonly session: { readonly id: string };
      },
      _options: undefined,
      artifact: PreparedTemplate,
    ): Promise<{ readonly handle: ReturnType<typeof providerHandle>; readonly state: SessionState }> {
      const handle = await backend.create({
        sessionKey: context.session.id,
        templateKey: artifact.templateKey,
        runtimeContext: { appRoot: context.host.resolveProjectPath(".") },
      });
      try {
        const captured = await handle.captureState();
        return {
          handle: providerHandle(handle),
          state: {
            metadata: captured.metadata,
            sessionKey: captured.sessionKey,
            templateKey: artifact.templateKey,
          },
        };
      } catch (error) {
        await handle.delete().catch(() => undefined);
        throw error;
      }
    },
    async resume(
      context: { readonly host: { resolveProjectPath(path: string): string } },
      _artifact: PreparedTemplate,
      state: SessionState,
    ): Promise<ReturnType<typeof providerHandle>> {
      // A new Eve generation can prepare a new template while this session
      // still belongs to the old one. The recorded metadata validates the
      // original namespace, template, session, and generation on reconnect.
      return providerHandle(await backend.create({
        existingMetadata: state.metadata,
        sessionKey: state.sessionKey,
        templateKey: state.templateKey,
        runtimeContext: { appRoot: context.host.resolveProjectPath(".") },
      }));
    },
  };
}

/** Durable celld AgentFS/just-bash provider for Eve 0.71 and newer. */
export const CelldJustBashSandbox = defineSandboxProvider<
  CelldOptions,
  undefined,
  PreparedTemplate,
  SessionState,
  SandboxSession
>({
  name: "celld-just-bash-v1",
  environment: (options) => providerImplementation(celldJustBash(options)),
});

/** Ephemeral celld container provider for Eve 0.71 and newer. */
export const CelldContainerSandbox = defineSandboxProvider<
  CelldContainerOptions,
  undefined,
  PreparedTemplate,
  SessionState,
  SandboxSession
>({
  name: "celld-container-v1",
  environment: (options) => providerImplementation(celldContainer(options)),
});
