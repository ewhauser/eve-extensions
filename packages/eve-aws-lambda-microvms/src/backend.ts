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
  AwsLambdaMicrovmRunInput,
  AwsLambdaMicrovmRequestMetadata,
} from "./api.js";
import {
  serializeAwsLambdaMicrovmActivationEnvelope,
  type AwsLambdaMicrovmActivationProvider,
  type AwsLambdaMicrovmActivationEnvelope,
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
import { bounded, emitLifecycle, timedPhase } from "./launch.js";
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
import { instrumentAwsLambdaMicrovmOperation } from "./telemetry.js";
import type { AwsLambdaMicrovmSandboxOptions } from "./types.js";

export const AWS_LAMBDA_MICROVM_BACKEND_NAME = "aws-lambda-microvms";

export interface AwsLambdaMicrovmBackendServices {
  readonly activationProvider?: AwsLambdaMicrovmActivationProvider;
  readonly api: AwsLambdaMicrovmApi;
  readonly createController: (microvm: AwsLambdaMicrovmRecord) => AwsLambdaMicrovmController;
  readonly storage: AwsLambdaMicrovmStorage;
}

export interface CreateAwsLambdaMicrovmSandboxInput {
  /** Trusted-host activation provider for customer-managed networking. */
  readonly activationProvider?: AwsLambdaMicrovmActivationProvider;
  readonly options: AwsLambdaMicrovmSandboxOptions;
  readonly services?: AwsLambdaMicrovmBackendServices;
}

export interface AwsLambdaMicrovmSandboxBackend extends SandboxBackend {
  create(input: SandboxBackendCreateInput & { readonly abortSignal?: AbortSignal }): Promise<SandboxBackendHandle>;
  readonly provisioning: {
    readonly prewarmAtBuild: true;
    readonly requiresTemplate: true;
    readonly scopeKey: string;
  };
}

type SandboxBackendPrewarmResult = Awaited<ReturnType<SandboxBackend["prewarm"]>>;

/** Creates an AWS Lambda MicroVM sandbox backend with an optional activation provider or injectable services. */
export function createAwsLambdaMicrovmSandbox(
  input: CreateAwsLambdaMicrovmSandboxInput,
): AwsLambdaMicrovmSandboxBackend {
  const options = resolveAwsLambdaMicrovmOptions(input.options);
  const defaultOrInjectedServices = input.services ?? createDefaultServices(options);
  const services =
    input.activationProvider === undefined
      ? defaultOrInjectedServices
      : { ...defaultOrInjectedServices, activationProvider: input.activationProvider };

  return {
    name: AWS_LAMBDA_MICROVM_BACKEND_NAME,
    provisioning: {
      prewarmAtBuild: true,
      requiresTemplate: true,
      scopeKey: options.applicationId,
    },
    async create(createInput) {
      return await instrumentAwsLambdaMicrovmOperation(
        telemetryOperation(options, "eve.aws_lambda_microvm.session.create"),
        async () => await createSessionHandle({ createInput, options, services }),
      );
    },
    async prewarm(prewarmInput) {
      return await instrumentAwsLambdaMicrovmOperation(
        telemetryOperation(options, "eve.aws_lambda_microvm.template.prewarm"),
        async () => await prewarmTemplate({ options, prewarmInput, services }),
      );
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
      await terminateMicrovmIfPresent(input.services.api, temporaryMicrovm.microvmId).catch(() => undefined);
    }
  }
}

async function createSessionHandle(input: {
  readonly createInput: SandboxBackendCreateInput & { readonly abortSignal?: AbortSignal };
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly services: AwsLambdaMicrovmBackendServices;
}): Promise<SandboxBackendHandle> {
  input.createInput.abortSignal?.throwIfAborted();
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
  const observer = input.options.onLifecycleEvent;
  const sessionHash = hashKey(stabilizeSessionKey(input.options, createInput.sessionKey));
  input = { ...input, options: { ...input.options, onLifecycleEvent: (event) => {
    emitLifecycle(observer, { ...event, sessionHash });
  } } };
  const started = Date.now();
  const deadlineAt = started + input.options.launchTimeoutMs;
  const abort = new AbortController();
  const signal = createInput.abortSignal === undefined ? abort.signal
    : AbortSignal.any([abort.signal, createInput.abortSignal]);
  const timer = setTimeout(() => abort.abort(new Error("AWS Lambda MicroVM launch deadline exceeded.")), input.options.launchTimeoutMs);
  timer.unref?.();
  let initialLease: AwsLambdaMicrovmLease | undefined;
  let launched: { readonly id: string; readonly microvm: AwsLambdaMicrovmRecord } | undefined;
  const leaseKey = sessionLeaseKey(input.options, createInput.sessionKey);
  try {
    emitLifecycle(input.options.onLifecycleEvent, { phase: "lease-acquisition", status: "started", durationMs: 0 });
    initialLease = await bounded(acquireAwsLambdaMicrovmLease({
      key: leaseKey, storage: input.services.storage, durable: true, deadlineAt, abortSignal: signal,
    }), signal, async (lateLease) => { await lateLease.release(); });
    emitLifecycle(input.options.onLifecycleEvent, { phase: "lease-acquisition", status: "completed", durationMs: Date.now() - started });
    const handle = await bounded(
      createLeasedSessionHandle({
        ...input,
        createInput,
        initialLease,
        onLaunched: (id, microvm) => { launched = { id, microvm }; },
      }),
      AbortSignal.any([signal, initialLease.signal]),
    );
    // No awaited work after this handoff: uncapped renewal may only start once
    // create has returned a ready handle, with its launch timer cleared.
    initialLease.promote();
    return handle;
  } catch (error) {
    emitLifecycle(input.options.onLifecycleEvent, {
      phase: "launch", status: Date.now() >= deadlineAt ? "deadline" : signal.aborted ? "cancelled" : "failed",
      durationMs: Date.now() - started,
    });
    // Cleanup must not keep the timed-out workflow promise alive.
    void initialLease?.release().catch(() => undefined).then(async () => {
      if (launched !== undefined) await retireLateLaunch({ ...input, createInput }, launched.id, launched.microvm);
    }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function createLeasedSessionHandle(input: {
  readonly createInput: SandboxBackendCreateInput & { readonly abortSignal?: AbortSignal };
  readonly initialLease: AwsLambdaMicrovmLease;
  readonly onLaunched: (id: string, microvm: AwsLambdaMicrovmRecord) => void;
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly services: AwsLambdaMicrovmBackendServices;
}): Promise<SandboxBackendHandle> {
  const templateKey = input.createInput.templateKey;
  if (templateKey === null) throw new Error("AWS Lambda MicroVM template resolution failed.");
  const storedTemplate = await timedPhase(input.options.onLifecycleEvent, "metadata-read", input.initialLease.signal,
    () => input.services.storage.getJson<unknown>(templateDescriptorKey(input.options, templateKey)));
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
  const storedSession = await timedPhase(input.options.onLifecycleEvent, "metadata-read", input.initialLease.signal,
    () => input.services.storage.getJson<unknown>(manifestKey));
  let authority = input.initialLease.state as SessionAuthority | undefined;
  const persistedSession = authority !== undefined
    ? parseAwsLambdaMicrovmSessionMetadata(authority.metadata ?? undefined)
    : storedSession === null
      ? parseAwsLambdaMicrovmSessionMetadata(input.createInput.existingMetadata)
      : parseAwsLambdaMicrovmSessionMetadata({
          ...expectRecord(storedSession.value, "session manifest"),
          manifestEtag: storedSession.etag,
        });
  if (persistedSession !== undefined) {
    assertControllerCompatibility(persistedSession.controllerProtocolVersion);
  }

  await input.initialLease.ensureHeld();
  authority ??= { metadata: persistedSession ?? null };
  if (authority.launch?.microvmId !== undefined) {
    // A previous owner learned the VM identity. Retire it before fresh authority.
    await terminateMicrovmIfPresent(input.services.api, authority.launch.microvmId);
    authority = { metadata: authority.metadata };
  }
  authority = { ...authority, launch: authority.launch ?? {
    id: hashKey(`${manifestKey}:${input.initialLease.generation}`),
  } };
  await input.initialLease.updateState(authority);

  const source =
    persistedSession === undefined
      ? template
      : persistedSession.configHash === template.configHash
        ? persistedSession
        : { ...template, checkpoint: persistedSession.checkpoint };
  const microvm = await runMicrovm({
    lease: input.initialLease,
    onLate: async (late) => {
      await input.initialLease.release().catch(() => undefined);
      await retireLateLaunch(input, authority!.launch!.id, late);
    },
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
  input.onLaunched(authority.launch!.id, microvm);
  const launchedMicrovm = true;
  const activeMicrovm = microvm;

  let controller: AwsLambdaMicrovmController;
  try {
    await input.initialLease.updateState({ ...authority, launch: {
      ...(input.initialLease.state as SessionAuthority).launch!, microvmId: activeMicrovm.microvmId,
    } });
    controller = input.services.createController(activeMicrovm);
    input.initialLease.signal.addEventListener("abort", () => controller.pauseHeartbeats(), { once: true });
    assertFreshReplacement(activeMicrovm, persistedSession, input.options);
    await bounded(controller.waitUntilReady(), input.initialLease.signal);
    await input.initialLease.ensureHeld();
    if (persistedSession === undefined || persistedSession.microvmId !== activeMicrovm.microvmId) {
      if (source.checkpoint !== undefined) {
        await bounded(restoreAwsLambdaMicrovmCheckpoint({
          checkpoint: source.checkpoint,
          controller,
          storage: input.services.storage,
        }), input.initialLease.signal);
      }
    }
    await input.initialLease.ensureHeld();
  } catch (error) {
    if (launchedMicrovm) {
      try {
        await bounded(input.initialLease.ensureHeld(), input.initialLease.signal);
        await bounded(terminateMicrovmIfPresent(input.services.api, activeMicrovm.microvmId), input.initialLease.signal);
        await input.initialLease.updateState({ metadata: authority.metadata } satisfies SessionAuthority);
      } catch {
        // The outer launch scope releases ownership before retrying cleanup.
      }
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
      durable: true,
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
      )}/checkpoints/${activeLease.generation}-${randomUUID()}`,
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
      const nextMetadata: AwsLambdaMicrovmSessionMetadata = {
        ...body,
        manifestEtag: randomUUID(),
      };
      // Lease generation and checkpoint pointer change in one S3 CAS. A separate
      // manifest write after ensureHeld would leave a takeover race.
      await activeLease.updateState({ metadata: nextMetadata } satisfies SessionAuthority);
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
          await terminateMicrovmIfPresent(input.services.api, activeMicrovm.microvmId).catch(() => undefined);
          throw new Error(
            "AWS Lambda MicroVM checkpoint is durable, but revoking its trusted proxy binding failed; the MicroVM was terminated and the checkpoint remains available.",
            { cause: error },
          );
        }
      }
      try {
        await terminateMicrovmIfPresent(input.services.api, activeMicrovm.microvmId);
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
        await terminateMicrovmIfPresent(input.services.api, activeMicrovm.microvmId);
        controllerPaused = true;
      }
      options?.abortSignal?.throwIfAborted();
      const currentAuthority = activeLease.state as SessionAuthority | undefined;
      if (currentAuthority?.metadata?.manifestEtag !== metadata?.manifestEtag) {
        throw new Error("AWS Lambda MicroVM session was replaced by another holder.");
      }
      await activeLease.updateState({ metadata: null } satisfies SessionAuthority);
      if (storedSession !== null) {
        await input.services.storage.deleteObject(manifestKey, { etag: storedSession.etag });
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

interface SessionAuthority {
  readonly metadata: AwsLambdaMicrovmSessionMetadata | null;
  readonly launch?: {
    readonly id: string;
    readonly request?: AwsLambdaMicrovmRunInput;
    readonly activation?: AwsLambdaMicrovmActivationEnvelope;
    readonly microvmId?: string;
  };
}

async function retireLateLaunch(
  input: { readonly createInput: SandboxBackendCreateInput; readonly options: ResolvedAwsLambdaMicrovmOptions; readonly services: AwsLambdaMicrovmBackendServices },
  launchId: string,
  microvm: AwsLambdaMicrovmRecord,
): Promise<void> {
  const started = Date.now();
  let cleanup: AwsLambdaMicrovmLease | undefined;
  try {
    cleanup = await acquireAwsLambdaMicrovmLease({
      key: sessionLeaseKey(input.options, input.createInput.sessionKey),
      storage: input.services.storage, durable: true, waitMs: 0,
      deadlineAt: Date.now() + input.options.launchTimeoutMs,
    });
    const state = cleanup.state as SessionAuthority | undefined;
    if (state?.launch?.id !== launchId) throw new Error("Launch was superseded.");
    // Publish retirement intent BEFORE dispatch: a delayed termination must never
    // target a VM a successor could adopt after this cleanup lease expires.
    await cleanup.updateState({ ...state, launch: { ...state.launch, microvmId: microvm.microvmId } });
    await bounded(terminateMicrovmIfPresent(input.services.api, microvm.microvmId), cleanup.signal);
    await cleanup.updateState({ metadata: state.metadata } satisfies SessionAuthority);
    emitLifecycle(input.options.onLifecycleEvent, { phase: "late-result", status: "terminated", durationMs: Date.now() - started });
  } catch {
    // A retry may have adopted the SAME idempotent result. Never terminate its VM.
    emitLifecycle(input.options.onLifecycleEvent, { phase: "late-result", status: "rejected", durationMs: Date.now() - started });
  } finally {
    void cleanup?.release().catch(() => undefined);
  }
}

async function runMicrovm(
  input: Parameters<typeof runMicrovmWithAuthority>[0],
): Promise<AwsLambdaMicrovmRecord> {
  const operation = telemetryOperation(input.options, "eve.aws_lambda_microvm.run");
  return await instrumentAwsLambdaMicrovmOperation(
    {
      ...operation,
      attributes: {
        ...operation.attributes,
        "eve.aws_lambda_microvm.image_version": input.imageVersion,
        "eve.aws_lambda_microvm.purpose": input.sessionKey === undefined ? "template" : "session",
      },
    },
    async (span) => {
      const microvm = await runMicrovmWithAuthority(input);
      span.setAttribute("eve.aws_lambda_microvm.microvm_id", microvm.microvmId);
      return microvm;
    },
  );
}

async function runMicrovmWithAuthority(input: {
  readonly lease?: AwsLambdaMicrovmLease;
  readonly onLate?: (microvm: AwsLambdaMicrovmRecord) => Promise<void>;
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
  await input.lease?.ensureHeld();
  const saved = (input.lease?.state as SessionAuthority | undefined)?.launch;
  const activation = saved?.activation ?? await timedPhase(input.options.onLifecycleEvent, "activation",
    input.lease?.signal ?? AbortSignal.timeout(input.options.launchTimeoutMs), async () => (
    input.options.networkingMode === "customer-managed"
      ? await instrumentAwsLambdaMicrovmOperation(
          telemetryOperation(input.options, "eve.aws_lambda_microvm.activation.create"),
          async () => await input.services.activationProvider!.createActivation({
          networkLaneId:
            input.sessionKey === undefined
              ? input.options.buildNetworkLaneId!
              : input.options.runtimeNetworkLaneId!,
          purposeHash: hashKey(input.purposeKey),
          replacementOf: input.replacementOf,
        }),
        )
      : undefined));
  await input.lease?.ensureHeld();
  const runHookPayload =
    activation === undefined
      ? JSON.stringify({
          controllerProtocolVersion: AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION,
          eveSession: hashKey(input.purposeKey),
        })
      : serializeAwsLambdaMicrovmActivationEnvelope(activation);
  const proposedRequest: AwsLambdaMicrovmRunInput = {
    clientToken: saved?.id ?? randomUUID(),
    egressNetworkConnectorArns: input.egressNetworkConnectorArns,
    executionRoleArn: input.options.executionRoleArn,
    idlePolicy: input.options.idlePolicy,
    imageArn: input.imageArn,
    imageVersion: input.imageVersion,
    ingressNetworkConnectorArns,
    logging: resolveLogging(input.options),
    maximumDurationSeconds: input.options.maximumDurationSeconds,
    runHookPayload,
  };
  const request = saved?.request ?? proposedRequest;
  const { clientToken: _savedToken, runHookPayload: _savedPayload, ...savedConfig } = request;
  const { clientToken: _nextToken, runHookPayload: _nextPayload, ...nextConfig } = proposedRequest;
  if (JSON.stringify(savedConfig) !== JSON.stringify(nextConfig)) {
    throw new Error("AWS Lambda MicroVM pending launch configuration changed; reconcile the pending launch before changing its image or runtime options.");
  }
  if (input.lease !== undefined) {
    const state = input.lease.state as SessionAuthority;
    await input.lease.updateState({ ...state, launch: { ...state.launch!, request, activation } });
  }
  const runStarted = Date.now();
  const signal = input.lease?.signal ?? AbortSignal.timeout(input.options.launchTimeoutMs);
  emitLifecycle(input.options.onLifecycleEvent, { phase: "run-microvm", status: "started", durationMs: 0 });
  let requestMetadata: AwsLambdaMicrovmRequestMetadata = {};
  const requestPromise = input.services.api.runMicrovm({
    ...request,
    abortSignal: signal,
    onRequestMetadata(metadata) {
      requestMetadata = { requestId: metadata.requestId, attempts: metadata.attempts, totalRetryDelay: metadata.totalRetryDelay };
    },
  }).then((result) => {
    emitLifecycle(input.options.onLifecycleEvent, { phase: "run-microvm", status: "completed", durationMs: Date.now() - runStarted, ...requestMetadata });
    return result;
  }, (error: unknown) => {
    emitLifecycle(input.options.onLifecycleEvent, { phase: "run-microvm", status: "failed", durationMs: Date.now() - runStarted, ...requestMetadata });
    throw error;
  });
  const microvm = await bounded(requestPromise, signal,
    input.onLate ?? (async (late) => { await terminateMicrovmIfPresent(input.services.api, late.microvmId); }));
  // Handles a suspended JS process where the wall clock advanced before timers fired.
  try { await input.lease?.ensureHeld(); } catch (error) {
    void input.onLate?.(microvm).catch(() => undefined);
    throw error;
  }
  if (input.options.networkingMode === "customer-managed") {
    const expectedConnector = input.egressNetworkConnectorArns[0]!;
    const matchesConnector =
      microvm.egressNetworkConnectorArns.length === 1 &&
      microvm.egressNetworkConnectorArns[0] === expectedConnector;
    const matchesImage =
      microvm.imageArn === input.imageArn && microvm.imageVersion === input.imageVersion;
    if (!matchesConnector || !matchesImage) {
      if (input.lease !== undefined) {
        const state = input.lease.state as SessionAuthority;
        await input.lease.updateState({ ...state, launch: { ...state.launch!, microvmId: microvm.microvmId } });
      }
      await bounded(terminateMicrovmIfPresent(input.services.api, microvm.microvmId), signal).catch(() => undefined);
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

function telemetryOperation(
  options: ResolvedAwsLambdaMicrovmOptions,
  name: string,
): {
  readonly attributes: Record<string, string>;
  readonly metricAttributes: Record<string, string>;
  readonly name: string;
} {
  const attributes = {
    "cloud.region": options.region,
    "eve.aws_lambda_microvm.networking_mode": options.networkingMode,
  };
  return { attributes, metricAttributes: attributes, name };
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
 * Eve 0.63.0 scopes keys to the application path. Replace only that generated
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

/** Retirement is complete when the VM is confirmed absent, including after a lost response. */
async function terminateMicrovmIfPresent(
  api: AwsLambdaMicrovmApi,
  microvmId: string,
): Promise<void> {
  try {
    await api.terminateMicrovm(microvmId);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const record = error as {
        readonly name?: unknown;
        readonly $metadata?: { readonly httpStatusCode?: unknown };
      };
      if (record.name === "ResourceNotFoundException" || record.$metadata?.httpStatusCode === 404) {
        return;
      }
    }
    throw error;
  }
}
