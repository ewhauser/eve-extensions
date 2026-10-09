import { createHash } from "node:crypto";
import { defineSandboxProvider, type SandboxProviderResources } from "eve/sandbox/provider";

import { createAwsLambdaMicrovmSandbox } from "./backend.js";
import type { SandboxBackendHandle, SandboxSession } from "./legacy-backend.js";
import type { AwsLambdaMicrovmSandboxOptions } from "./types.js";

type PreparedTemplate = { readonly templateKey: string };
type SessionState = { readonly sessionKey: string; readonly templateKey: string };

function templateKey(sourceRevision: string, resources: SandboxProviderResources): string {
  return createHash("sha256")
    .update(JSON.stringify([sourceRevision, resources.source, resources.skills?.key, resources.workspace?.key]))
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
    onSandboxDelete: (options?: { readonly abortSignal?: AbortSignal }) => handle.delete(options),
    onSandboxStop: () => handle.stop(),
  };
}

/** Durable AWS Lambda MicroVM provider for Eve 0.71 and newer. */
export const AwsLambdaMicrovmSandbox = defineSandboxProvider<
  AwsLambdaMicrovmSandboxOptions,
  undefined,
  PreparedTemplate,
  SessionState,
  SandboxSession
>({
  name: "aws-lambda-microvms",
  environment(options) {
    const backend = createAwsLambdaMicrovmSandbox({ options });
    return {
      async prepare(context): Promise<PreparedTemplate> {
        const key = templateKey(context.sourceRevision, context.resources);
        await backend.prewarm({
          templateKey: key,
          runtimeContext: { appRoot: context.host.resolveProjectPath(".") },
          seedFiles: seedFiles(context.resources),
          ...(context.log === undefined ? {} : { log: context.log }),
        });
        return { templateKey: key };
      },
      async start(context, _openOptions, artifact) {
        const handle = await backend.create({
          sessionKey: context.session.id,
          templateKey: artifact.templateKey,
          runtimeContext: { appRoot: context.host.resolveProjectPath(".") },
        });
        // The checkpoint is stored in S3 when the session stops. The provider
        // state only needs the stable lookup keys; captureState would retire
        // the live MicroVM here and discard this handle.
        return {
          handle: providerHandle(handle),
          state: { sessionKey: context.session.id, templateKey: artifact.templateKey },
        };
      },
      async resume(context, artifact, state) {
        if (artifact.templateKey !== state.templateKey) {
          throw new Error("AWS Lambda MicroVM template changed while resuming the session.");
        }
        return providerHandle(await backend.create({
          sessionKey: state.sessionKey,
          templateKey: state.templateKey,
          runtimeContext: { appRoot: context.host.resolveProjectPath(".") },
        }));
      },
    };
  },
});
