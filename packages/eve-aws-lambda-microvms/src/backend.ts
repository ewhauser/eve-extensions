// Derived from vercel/eve PR #208 (Apache-2.0); adapted for standalone packaging.
import { createHash, randomUUID } from "node:crypto";

import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
} from "eve/sandbox";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";

import type {
  AwsLambdaMicrovmApi,
  AwsLambdaMicrovmLogging,
  AwsLambdaMicrovmRecord,
} from "./api.js";
import {
  serializeAwsLambdaMicrovmActivationEnvelope,
  type AwsLambdaMicrovmActivationProvider,
} from "./activation.js";
import {
  restoreAwsLambdaMicrovmCheckpoint,
  uploadAwsLambdaMicrovmCheckpoint,
} from "./checkpoint.js";
import {
  HttpAwsLambdaMicrovmController,
  type AwsLambdaMicrovmController,
} from "./controller-client.js";
import { AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION } from "./image-artifact.js";
import { acquireAwsLambdaMicrovmLease, type AwsLambdaMicrovmLease } from "./lease.js";
import {
  AWS_LAMBDA_MICROVM_METADATA_VERSION,
  type AwsLambdaMicrovmCheckpoint,
  type AwsLambdaMicrovmSessionMetadata,
  type AwsLambdaMicrovmTemplateDescriptor,
  parseAwsLambdaMicrovmSessionMetadata,
  parseAwsLambdaMicrovmTemplateDescriptor,
} from "./metadata.js";
import { resolveAwsLambdaMicrovmOptions, type ResolvedAwsLambdaMicrovmOptions } from "./options.js";
import { ensureAwsLambdaMicrovmImage } from "./provision.js";
import { SdkAwsLambdaMicrovmApi } from "./sdk-api.js";
import { createAwsLambdaMicrovmSession, createLoggingSandboxSession } from "./session.js";
import { SdkAwsLambdaMicrovmStorage, type AwsLambdaMicrovmStorage } from "./storage.js";
import type { AwsLambdaMicrovmSandboxOptions } from "./types.js";

export const AWS_LAMBDA_MICROVM_BACKEND_NAME = "aws-lambda-microvms";

export interface AwsLambdaMicrovmBackendServices {
  readonly activationProvider?: AwsLambdaMicrovmActivationProvider;
  readonly api: AwsLambdaMicrovmApi;
  readonly createController: (microvm: AwsLambdaMicrovmRecord) => AwsLambdaMicrovmController;
  readonly storage: AwsLambdaMicrovmStorage;
}

export interface CreateAwsLambdaMicrovmSandboxInput {
  readonly options: AwsLambdaMicrovmSandboxOptions;
  readonly services?: AwsLambdaMicrovmBackendServices;
}

export interface AwsLambdaMicrovmSandboxBackend extends SandboxBackend {
  readonly provisioning: {
    readonly prewarmAtBuild: true;
    readonly requiresTemplate: true;
    readonly scopeKey: string;
  };
}

type SandboxBackendPrewarmResult = Awaited<ReturnType<SandboxBackend["prewarm"]>>;

/** Creates an AWS Lambda MicroVM sandbox backend with injectable services. */
export function createAwsLambdaMicrovmSandbox(
  input: CreateAwsLambdaMicrovmSandboxInput,
): AwsLambdaMicrovmSandboxBackend {
  const options = resolveAwsLambdaMicrovmOptions(input.options);
  const services = input.services ?? createDefaultServices(options);

  return {
    name: AWS_LAMBDA_MICROVM_BACKEND_NAME,
    provisioning: {
      prewarmAtBuild: true,
      requiresTemplate: true,
      scopeKey: options.applicationId,
    },
    async create(createInput) {
      return await createSessionHandle({ createInput, options, services });
    },
    async prewarm(prewarmInput) {
      return await prewarmTemplate({ options, prewarmInput, services });
    },
  };
}

/** Constructs an explicit AWS Lambda MicroVM sandbox backend for Eve. */
export function awsLambdaMicrovm(
  options: AwsLambdaMicrovmSandboxOptions,
): AwsLambdaMicrovmSandboxBackend {
  return createAwsLambdaMicrovmSandbox({ options });
}

function createDefaultServices(
  options: ResolvedAwsLambdaMicrovmOptions,
): AwsLambdaMicrovmBackendServices {
  const api = new SdkAwsLambdaMicrovmApi(options.region);
  return {
    api,
    activationProvider: undefined,
    createController: (microvm) => new HttpAwsLambdaMicrovmController({ api, microvm }),
    storage: new SdkAwsLambdaMicrovmStorage({
      bucket: options.artifactBucket,
      kmsKeyId: options.artifactKmsKeyId,
      region: options.region,
    }),
  };
}

async function prewarmTemplate(input: {
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly prewarmInput: SandboxBackendPrewarmInput;
  readonly services: AwsLambdaMicrovmBackendServices;
}): Promise<SandboxBackendPrewarmResult> {
  await input.services.storage.assertBucketRegion();
  const lease = await acquireAwsLambdaMicrovmLease({
    key: templateLeaseKey(input.options, input.prewarmInput.templateKey),
    storage: input.services.storage,
    ttlMs: 10 * 60 * 1000,
    waitMs: 30 * 60 * 1000,
  });
  try {
    return await prewarmTemplateWithLease(input);
  } finally {
    await lease.release();
  }
}

async function prewarmTemplateWithLease(input: {
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly prewarmInput: SandboxBackendPrewarmInput;
  readonly services: AwsLambdaMicrovmBackendServices;
}): Promise<SandboxBackendPrewarmResult> {
  const stableTemplateKey = stabilizeTemplateKey(
    input.options,
    input.prewarmInput.templateKey,
  );
  const descriptorKey = templateDescriptorKey(input.options, input.prewarmInput.templateKey);
  const templateHash = hashKey(stableTemplateKey);
  const existing = await input.services.storage.getJson<unknown>(descriptorKey);
  const image = await ensureAwsLambdaMicrovmImage({
    api: input.services.api,
    log: input.prewarmInput.log,
    options: input.options,
    storage: input.services.storage,
  });
  if (existing !== null) {
    const descriptor = parseAwsLambdaMicrovmTemplateDescriptor(existing.value);
    if (
      descriptor.configHash === image.configHash &&
      descriptor.controllerProtocolVersion === AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION &&
      descriptor.imageArn === image.imageArn &&
      descriptor.imageVersion === image.imageVersion &&
      descriptor.region === input.options.region &&
      descriptor.templateHash === templateHash
    ) {
      return { reused: true };
    }
  }

  let checkpoint: AwsLambdaMicrovmCheckpoint | undefined;
  let pendingCheckpoint: Awaited<ReturnType<typeof uploadAwsLambdaMicrovmCheckpoint>> | undefined;
  let temporaryMicrovm: AwsLambdaMicrovmRecord | undefined;
  try {
    if (input.prewarmInput.bootstrap !== undefined || input.prewarmInput.seedFiles.length > 0) {
      temporaryMicrovm = await runMicrovm({
        egressNetworkConnectorArns: input.options.buildEgressNetworkConnectorArns,
        egressProxyCaSha256: input.options.egressProxyCaSha256,
        imageArn: image.imageArn,
        imageVersion: image.imageVersion,
        options: input.options,
        purposeKey: stableTemplateKey,
        templateHash,
        services: input.services,
      });
      const controller = input.services.createController(temporaryMicrovm);
      await controller.waitUntilReady();
      const session = createAwsLambdaMicrovmSession({
        controller,
        id: input.prewarmInput.templateKey,
      });

      if (input.prewarmInput.bootstrap !== undefined) {
        input.prewarmInput.log?.("running sandbox bootstrap");
        await input.prewarmInput.bootstrap({
          use: async () => createLoggingSandboxSession({ log: input.prewarmInput.log, session }),
        });
      }
      for (const file of input.prewarmInput.seedFiles) {
        if (typeof file.content === "string") {
          await session.writeTextFile({ content: file.content, path: file.path });
        } else {
          await session.writeBinaryFile({ content: file.content, path: file.path });
        }
      }

      input.prewarmInput.log?.("capturing full-filesystem template checkpoint");
      pendingCheckpoint = await uploadAwsLambdaMicrovmCheckpoint({
        controller,
        generation: 1,
        objectKeyPrefix: `${input.options.artifactPrefix}/templates/${hashKey(stableTemplateKey)}/checkpoints`,
        storage: input.services.storage,
      });
      if (pendingCheckpoint === null) {
        throw new Error("AWS Lambda MicroVM template changed no filesystem state during prewarm.");
      }
      checkpoint = pendingCheckpoint.checkpoint;
    }

    const descriptor: AwsLambdaMicrovmTemplateDescriptor = {
      checkpoint,
      configHash: image.configHash,
      controllerProtocolVersion: AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION,
      ...(input.options.egressProxyCaSha256 === undefined
        ? {}
        : { egressProxyCaSha256: input.options.egressProxyCaSha256 }),
      imageArn: image.imageArn,
      imageVersion: image.imageVersion,
      region: input.options.region,
      templateHash,
      version: AWS_LAMBDA_MICROVM_METADATA_VERSION,
    };
    await input.services.storage.putJson(descriptorKey, descriptor, {
      absent: existing === null,
      etag: existing?.etag,
    });
    await pendingCheckpoint?.commit();
    return { reused: false };
  } catch (error) {
    await pendingCheckpoint?.release().catch(() => undefined);
    throw new Error(
      `Failed to prewarm AWS Lambda MicroVM template "${input.prewarmInput.templateKey}": ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    if (temporaryMicrovm !== undefined) {
      await input.services.api.terminateMicrovm(temporaryMicrovm.microvmId).catch(() => undefined);
    }
  }
}

async function createSessionHandle(input: {
  readonly createInput: SandboxBackendCreateInput;
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly services: AwsLambdaMicrovmBackendServices;
}): Promise<SandboxBackendHandle> {
  await input.services.storage.assertBucketRegion();
  let createInput = input.createInput;
  if (createInput.templateKey === null) {
    const templateKey = defaultTemplateKey(input.options);
    await prewarmTemplate({
      options: input.options,
      prewarmInput: {
        runtimeContext: createInput.runtimeContext,
        seedFiles: [],
        templateKey,
      },
      services: input.services,
    });
    createInput = { ...createInput, templateKey };
  }
  const initialLease = await acquireAwsLambdaMicrovmLease({
    key: sessionLeaseKey(input.options, createInput.sessionKey),
    storage: input.services.storage,
  });
  try {
    return await createLeasedSessionHandle({ ...input, createInput, initialLease });
  } catch (error) {
    await initialLease.release().catch(() => undefined);
    throw error;
  }
}

async function createLeasedSessionHandle(input: {
  readonly createInput: SandboxBackendCreateInput;
  readonly initialLease: AwsLambdaMicrovmLease;
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly services: AwsLambdaMicrovmBackendServices;
}): Promise<SandboxBackendHandle> {
  const templateKey = input.createInput.templateKey;
  if (templateKey === null) throw new Error("AWS Lambda MicroVM template resolution failed.");
  const storedTemplate = await input.services.storage.getJson<unknown>(
    templateDescriptorKey(input.options, templateKey),
  );
  if (storedTemplate === null) {
    throw new SandboxTemplateNotProvisionedError({
      backendName: AWS_LAMBDA_MICROVM_BACKEND_NAME,
      templateKey,
    });
  }
  const template = parseAwsLambdaMicrovmTemplateDescriptor(storedTemplate.value);
  if (template.region !== input.options.region) {
    throw new Error(
      `AWS Lambda MicroVM template is in ${template.region}, but this backend is configured for ${input.options.region}.`,
    );
  }
  assertControllerCompatibility(template.controllerProtocolVersion);
  if (template.egressProxyCaSha256 !== input.options.egressProxyCaSha256) {
    throw new Error(
      "AWS Lambda MicroVM template does not contain the configured egress proxy CA; provision the updated template before launching sessions.",
    );
  }

  const manifestKey = sessionManifestKey(input.options, input.createInput.sessionKey);
  const storedSession = await input.services.storage.getJson<unknown>(manifestKey);
  const persistedSession =
    storedSession === null
      ? parseAwsLambdaMicrovmSessionMetadata(input.createInput.existingMetadata)
      : parseAwsLambdaMicrovmSessionMetadata({
          ...expectRecord(storedSession.value, "session manifest"),
          manifestEtag: storedSession.etag,
        });
  if (persistedSession !== undefined) {
    assertControllerCompatibility(persistedSession.controllerProtocolVersion);
  }

  const source =
    persistedSession === undefined
      ? template
      : persistedSession.configHash === template.configHash
        ? persistedSession
        : { ...template, checkpoint: persistedSession.checkpoint };
  const microvm = await runMicrovm({
    egressNetworkConnectorArns: input.options.runtimeEgressNetworkConnectorArns,
    egressProxyCaSha256: source.egressProxyCaSha256,
    imageArn: source.imageArn,
    imageVersion: source.imageVersion,
    options: input.options,
    purposeKey: stabilizeSessionKey(input.options, input.createInput.sessionKey),
    replacementOf:
      persistedSession?.activationId === undefined
        ? undefined
        : {
            activationId: persistedSession.activationId,
            placeholderGeneration: persistedSession.placeholderGeneration!,
            trustedBindingGeneration: persistedSession.trustedBindingGeneration!,
          },
    sessionKey: stabilizeSessionKey(input.options, input.createInput.sessionKey),
    services: input.services,
    templateHash: source.templateHash,
  });
  const launchedMicrovm = true;
  const activeMicrovm = microvm;

  const controller = input.services.createController(activeMicrovm);
  try {
    assertFreshReplacement(activeMicrovm, persistedSession, input.options);
    await controller.waitUntilReady();
    if (persistedSession === undefined || persistedSession.microvmId !== activeMicrovm.microvmId) {
      if (source.checkpoint !== undefined) {
        await restoreAwsLambdaMicrovmCheckpoint({
          checkpoint: source.checkpoint,
          controller,
          storage: input.services.storage,
        });
      }
    }
  } catch (error) {
    if (launchedMicrovm) {
      await input.services.api.terminateMicrovm(activeMicrovm.microvmId).catch(() => undefined);
    }
    throw error;
  }

  let metadata: AwsLambdaMicrovmSessionMetadata | undefined = persistedSession;
  let lease: AwsLambdaMicrovmLease | undefined = input.initialLease;
  let captured = false;
  let controllerPaused = false;
  let shutDown = false;

  const sessionCheckpointPrefix = `${input.options.artifactPrefix}/sessions/${hashKey(
    stabilizeSessionKey(input.options, input.createInput.sessionKey),
  )}/checkpoints/`;

  async function ensureLease(): Promise<AwsLambdaMicrovmLease> {
    lease ??= await acquireAwsLambdaMicrovmLease({
      key: sessionLeaseKey(input.options, input.createInput.sessionKey),
      storage: input.services.storage,
    });
    await lease.ensureHeld();
    return lease;
  }

  async function ensureActive(): Promise<void> {
    await ensureLease();
    if (!controllerPaused) return;
    throw new Error(
      "AWS Lambda MicroVM authority ended after checkpoint termination. Open a new sandbox handle for a fresh activation and restore.",
    );
  }

  const session = createAwsLambdaMicrovmSession({
    beforeOperation: ensureActive,
    controller,
    id: input.createInput.sessionKey,
    onMutate() {
      captured = false;
    },
  });

  async function capture(): Promise<AwsLambdaMicrovmSessionMetadata> {
    if (shutDown) throw new Error("AWS Lambda MicroVM sandbox handle is shut down.");
    await ensureActive();
    const activeLease = await ensureLease();
    const previousCheckpoint = metadata?.checkpoint ?? source.checkpoint;
    const pending = await uploadAwsLambdaMicrovmCheckpoint({
      controller,
      generation: (previousCheckpoint?.generation ?? 0) + 1,
      objectKeyPrefix: `${input.options.artifactPrefix}/sessions/${hashKey(
        stabilizeSessionKey(input.options, input.createInput.sessionKey),
      )}/checkpoints`,
      storage: input.services.storage,
    });
    const checkpoint = pending?.checkpoint ?? previousCheckpoint;
    const body: Omit<AwsLambdaMicrovmSessionMetadata, "manifestEtag"> = {
      ...(activeMicrovm.activationId === undefined
        ? {}
        : {
            activationId: activeMicrovm.activationId,
            controllerCaSha256: activeMicrovm.controllerCaSha256!,
            placeholderGeneration: activeMicrovm.placeholderGeneration!,
            placeholderPlacement: activeMicrovm.placeholderPlacement!,
            trustedBindingGeneration: activeMicrovm.trustedBindingGeneration!,
          }),
      checkpoint,
      configHash: source.configHash,
      controllerProtocolVersion: AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION,
      ...(source.egressProxyCaSha256 === undefined
        ? {}
        : { egressProxyCaSha256: source.egressProxyCaSha256 }),
      imageArn: source.imageArn,
      imageVersion: source.imageVersion,
      ...(input.options.networkingMode === "customer-managed"
        ? {
            egressNetworkConnectorArn: input.options.runtimeEgressNetworkConnectorArns[0]!,
            networkLaneId: input.options.runtimeNetworkLaneId!,
          }
        : {}),
      microvmId: activeMicrovm.microvmId,
      region: source.region,
      templateHash: source.templateHash,
      version: AWS_LAMBDA_MICROVM_METADATA_VERSION,
    };
    try {
      const stored = await input.services.storage.putJson(manifestKey, body, {
        absent: metadata === undefined,
        etag: metadata?.manifestEtag,
      });
      const nextMetadata: AwsLambdaMicrovmSessionMetadata = {
        ...body,
        manifestEtag: stored.etag,
      };
      metadata = nextMetadata;
      await pending?.commit();
      controller.pauseHeartbeats();
      controllerPaused = true;
      if (nextMetadata.activationId !== undefined) {
        try {
          await input.services.activationProvider!.revokeTrustedBinding({
            activationId: nextMetadata.activationId,
            placeholderGeneration: nextMetadata.placeholderGeneration!,
            trustedBindingGeneration: nextMetadata.trustedBindingGeneration!,
          });
        } catch (error) {
          await input.services.api.terminateMicrovm(activeMicrovm.microvmId).catch(() => undefined);
          throw new Error(
            "AWS Lambda MicroVM checkpoint is durable, but revoking its trusted proxy binding failed; the MicroVM was terminated and the checkpoint remains available.",
            { cause: error },
          );
        }
      }
      try {
        await input.services.api.terminateMicrovm(activeMicrovm.microvmId);
      } catch (error) {
        throw new Error(
          "AWS Lambda MicroVM checkpoint is durable, but terminating the retired MicroVM failed; stale authority remains unusable.",
          { cause: error },
        );
      }
      captured = true;
      await activeLease.release();
      lease = undefined;
      return nextMetadata;
    } catch (error) {
      await pending?.release().catch(() => undefined);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    if (shutDown) return;
    if (!captured) await capture();
    controller.pauseHeartbeats();
    shutDown = true;
  }

  async function deleteSandbox(options?: { readonly abortSignal?: AbortSignal }): Promise<void> {
    if (shutDown && metadata === undefined) return;
    options?.abortSignal?.throwIfAborted();
    const activeLease = await ensureLease();
    const checkpoint =
      metadata?.checkpoint?.key.startsWith(sessionCheckpointPrefix) === true
        ? metadata.checkpoint
        : undefined;
    try {
      if (!controllerPaused) {
        controller.pauseHeartbeats();
        if (activeMicrovm.activationId !== undefined) {
          await input.services.activationProvider!.revokeTrustedBinding({
            activationId: activeMicrovm.activationId,
            placeholderGeneration: activeMicrovm.placeholderGeneration!,
            trustedBindingGeneration: activeMicrovm.trustedBindingGeneration!,
          });
        }
        await input.services.api.terminateMicrovm(activeMicrovm.microvmId);
        controllerPaused = true;
      }
      options?.abortSignal?.throwIfAborted();
      if (metadata !== undefined) {
        await input.services.storage.deleteObject(manifestKey, { etag: metadata.manifestEtag });
      }
      if (checkpoint !== undefined) {
        await input.services.storage.deleteObject(checkpoint.key, { etag: checkpoint.etag });
      }
      metadata = undefined;
      captured = false;
      shutDown = true;
    } finally {
      await activeLease.release();
      lease = undefined;
    }
  }

  return {
    async captureState() {
      return {
        backendName: AWS_LAMBDA_MICROVM_BACKEND_NAME,
        metadata: { ...(await capture()) },
        sessionKey: input.createInput.sessionKey,
      };
    },
    delete: deleteSandbox,
    shutdown: stop,
    session,
    stop,
    useSessionFn: async () => session,
  };
}

function assertFreshReplacement(
  microvm: AwsLambdaMicrovmRecord,
  metadata: AwsLambdaMicrovmSessionMetadata | undefined,
  options: ResolvedAwsLambdaMicrovmOptions,
): void {
  if (metadata === undefined || options.networkingMode !== "customer-managed") return;
  const expectedConnector = options.runtimeEgressNetworkConnectorArns[0]!;
  const valid =
    microvm.egressNetworkConnectorArns.length === 1 &&
    microvm.egressNetworkConnectorArns[0] === expectedConnector &&
    microvm.activationId !== undefined &&
    microvm.activationId !== metadata.activationId &&
    microvm.controllerSessionToken !== undefined &&
    microvm.placeholderGeneration !== undefined &&
    metadata.placeholderGeneration !== undefined &&
    microvm.placeholderGeneration > metadata.placeholderGeneration &&
    microvm.trustedBindingGeneration !== undefined &&
    metadata.trustedBindingGeneration !== undefined &&
    microvm.trustedBindingGeneration > metadata.trustedBindingGeneration &&
    microvm.placeholderPlacement?.environmentVariable ===
      metadata.placeholderPlacement?.environmentVariable &&
    microvm.controllerCaSha256 !== undefined &&
    microvm.controllerCaSha256 === metadata.controllerCaSha256 &&
    microvm.egressProxyCaSha256 === options.egressProxyCaSha256;
  if (!valid) {
    throw new Error(
      "AWS Lambda MicroVM replacement rejected stale placeholder/binding generations, activation, controller authentication, CA, placement, or connector state.",
    );
  }
}

async function runMicrovm(input: {
  readonly egressNetworkConnectorArns: readonly string[];
  readonly egressProxyCaSha256?: string;
  readonly imageArn: string;
  readonly imageVersion: string;
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly purposeKey: string;
  readonly replacementOf?: {
    readonly activationId: string;
    readonly placeholderGeneration: number;
    readonly trustedBindingGeneration: number;
  };
  readonly sessionKey?: string;
  readonly services: AwsLambdaMicrovmBackendServices;
  readonly templateHash: string;
}): Promise<AwsLambdaMicrovmRecord> {
  if (input.options.networkingMode === "customer-managed" && input.services.activationProvider === undefined) {
    throw new Error("AWS Lambda MicroVM customer-managed networking requires an activation provider.");
  }
  const ingressNetworkConnectorArns = [input.options.httpIngressNetworkConnectorArn];
  if (input.options.shellIngressNetworkConnectorArn !== undefined) {
    ingressNetworkConnectorArns.push(input.options.shellIngressNetworkConnectorArn);
  }
  const activation =
    input.options.networkingMode === "customer-managed"
      ? await input.services.activationProvider!.createActivation({
          networkLaneId:
            input.sessionKey === undefined
              ? input.options.buildNetworkLaneId!
              : input.options.runtimeNetworkLaneId!,
          purposeHash: hashKey(input.purposeKey),
          replacementOf: input.replacementOf,
        })
      : undefined;
  const runHookPayload =
    activation === undefined
      ? JSON.stringify({
          controllerProtocolVersion: AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION,
          eveSession: hashKey(input.purposeKey),
        })
      : serializeAwsLambdaMicrovmActivationEnvelope(activation);
  const microvm = await input.services.api.runMicrovm({
    clientToken: randomUUID(),
    egressNetworkConnectorArns: input.egressNetworkConnectorArns,
    executionRoleArn: input.options.executionRoleArn,
    idlePolicy: input.options.idlePolicy,
    imageArn: input.imageArn,
    imageVersion: input.imageVersion,
    ingressNetworkConnectorArns,
    logging: resolveLogging(input.options),
    maximumDurationSeconds: input.options.maximumDurationSeconds,
    runHookPayload,
  });
  if (input.options.networkingMode === "customer-managed") {
    const expectedConnector = input.egressNetworkConnectorArns[0]!;
    const matchesConnector =
      microvm.egressNetworkConnectorArns.length === 1 &&
      microvm.egressNetworkConnectorArns[0] === expectedConnector;
    const matchesImage =
      microvm.imageArn === input.imageArn && microvm.imageVersion === input.imageVersion;
    if (!matchesConnector || !matchesImage) {
      await input.services.api.terminateMicrovm(microvm.microvmId).catch(() => undefined);
      throw new Error(
        `AWS Lambda MicroVM activation did not match the requested image and customer-managed connector; terminated ${microvm.microvmId} before controller traffic.`,
      );
    }
    Object.defineProperties(microvm, {
      activationId: { value: activation!.activationId },
      controllerCaSha256: { value: activation!.controllerCaSha256 },
      egressProxyCaSha256: { value: input.egressProxyCaSha256 },
      controllerSessionToken: { value: activation!.controllerSessionToken },
      placeholderGeneration: { value: activation!.placeholder.generation },
      placeholderPlacement: { value: activation!.placeholder.placement },
      trustedBindingGeneration: { value: activation!.placeholder.trustedBindingGeneration },
    });
  }
  return microvm;
}

function resolveLogging(options: ResolvedAwsLambdaMicrovmOptions): AwsLambdaMicrovmLogging {
  return options.runtimeLogging === false
    ? { disabled: true }
    : { cloudWatch: options.runtimeLogging };
}

function templateDescriptorKey(
  options: ResolvedAwsLambdaMicrovmOptions,
  templateKey: string,
): string {
  return `${options.artifactPrefix}/templates/${hashKey(stabilizeTemplateKey(options, templateKey))}/manifest.json`;
}

function sessionManifestKey(options: ResolvedAwsLambdaMicrovmOptions, sessionKey: string): string {
  return `${options.artifactPrefix}/sessions/${hashKey(stabilizeSessionKey(options, sessionKey))}/manifest.json`;
}

function sessionLeaseKey(options: ResolvedAwsLambdaMicrovmOptions, sessionKey: string): string {
  return `${options.artifactPrefix}/sessions/${hashKey(stabilizeSessionKey(options, sessionKey))}/lease.json`;
}

function templateLeaseKey(options: ResolvedAwsLambdaMicrovmOptions, templateKey: string): string {
  return `${options.artifactPrefix}/templates/${hashKey(stabilizeTemplateKey(options, templateKey))}/lease.json`;
}

function defaultTemplateKey(options: ResolvedAwsLambdaMicrovmOptions): string {
  return `eve-sbx-tpl-${AWS_LAMBDA_MICROVM_BACKEND_NAME}-${options.applicationHash.slice(0, 16)}-default`;
}

function stabilizeTemplateKey(
  options: ResolvedAwsLambdaMicrovmOptions,
  templateKey: string,
): string {
  return stabilizeEveScope(options, templateKey, "tpl");
}

function stabilizeSessionKey(
  options: ResolvedAwsLambdaMicrovmOptions,
  sessionKey: string,
): string {
  return stabilizeEveScope(options, sessionKey, "ses");
}

/**
 * Eve 0.49.0 scopes keys to the application path. Replace only that generated
 * scope segment so resources remain stable across build and deployment roots.
 */
function stabilizeEveScope(
  options: ResolvedAwsLambdaMicrovmOptions,
  key: string,
  kind: "ses" | "tpl",
): string {
  const prefix = `eve-sbx-${kind}-${AWS_LAMBDA_MICROVM_BACKEND_NAME}-`;
  if (!key.startsWith(prefix)) return key;
  const suffix = key.slice(prefix.length);
  if (!/^[a-f0-9]{16}-/.test(suffix)) return key;
  return `${prefix}${options.applicationHash.slice(0, 16)}-${suffix.slice(17)}`;
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertControllerCompatibility(version: number): void {
  if (version !== AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION) {
    throw new Error(
      `AWS Lambda MicroVM checkpoint requires controller protocol ${version}, but this eve version supports ${AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION}.`,
    );
  }
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid AWS Lambda MicroVM ${name}.`);
  }
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
