import {
  defineSandboxProvider,
  type SandboxConnection,
} from "eve/sandbox/provider";
import type { SandboxNetworkPolicy } from "eve/sandbox";

import { createAwsLambdaMicrovmSandbox } from "./backend.js";
import type { SandboxBackendHandle, SandboxSession } from "./legacy-backend.js";
import type { AwsLambdaMicrovmSandboxOptions } from "./types.js";

type PreparedTemplate = { readonly templateKey: string };
type SessionState = { readonly sessionKey: string; readonly templateKey: string };
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

/** Durable AWS Lambda MicroVM provider for Eve's connection-based sandbox API. */
export const AwsLambdaMicrovmSandbox = defineSandboxProvider<
  AwsLambdaMicrovmSandboxOptions,
  undefined,
  PreparedTemplate,
  SessionState,
  Extensions
>({
  name: "aws-lambda-microvms",
  environment(options) {
    const backend = createAwsLambdaMicrovmSandbox({ options });
    return {
      async prepare(context): Promise<PreparedTemplate> {
        const key = context.templateKey({ applicationId: options.applicationId });
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
      async start(context, _openOptions, artifact) {
        const handle = await backend.create({
          sessionKey: context.session.id,
          templateKey: artifact.templateKey,
          runtimeContext: { appRoot: context.resolveProjectPath(".") },
        });
        // The backend checkpoints on stop; keeping only lookup keys avoids
        // retiring the live MicroVM at each workflow state capture.
        return {
          connection: connection(handle.session, handle),
          state: { sessionKey: context.session.id, templateKey: artifact.templateKey },
        };
      },
      async resume(context, artifact, state) {
        if (artifact.templateKey !== state.templateKey) {
          throw new Error("AWS Lambda MicroVM template changed while resuming the session.");
        }
        const handle = await backend.create({
          sessionKey: state.sessionKey,
          templateKey: state.templateKey,
          runtimeContext: { appRoot: context.resolveProjectPath(".") },
        });
        return connection(handle.session, handle);
      },
      async onSessionEnd(context, state, endOptions) {
        if (state === null) return;
        const handle = await backend.create({
          sessionKey: state.sessionKey,
          templateKey: state.templateKey,
          runtimeContext: { appRoot: context.resolveProjectPath(".") },
        });
        await handle.delete({ abortSignal: endOptions.abortSignal });
      },
    };
  },
});
