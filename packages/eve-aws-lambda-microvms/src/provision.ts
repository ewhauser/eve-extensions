import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { AwsLambdaMicrovmApi, AwsLambdaMicrovmImageVersionRecord } from "./api.js";
import {
  buildAwsLambdaMicrovmImageArtifact,
  AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION,
} from "./image-artifact.js";
import type { ResolvedAwsLambdaMicrovmOptions } from "./options.js";
import type { AwsLambdaMicrovmStorage } from "./storage.js";
import type { AwsLambdaMicrovmBaseImage, AwsLambdaMicrovmVerifiedImage } from "./types.js";

const IMAGE_BUILD_TIMEOUT_MS = 30 * 60 * 1000;

export interface ProvisionedAwsLambdaMicrovmImage {
  readonly configHash: string;
  readonly imageArn: string;
  readonly imageVersion: string;
  readonly verifiedImage: AwsLambdaMicrovmVerifiedImage;
}

export async function ensureAwsLambdaMicrovmImage(input: {
  readonly api: AwsLambdaMicrovmApi;
  readonly log?: (message: string) => void;
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly storage: AwsLambdaMicrovmStorage;
}): Promise<ProvisionedAwsLambdaMicrovmImage> {
  const artifact = await buildAwsLambdaMicrovmImageArtifact({
    egressProxyCaBundlePem: input.options.egressProxyCaBundlePem,
  });
  if (input.options.verifiedImage !== undefined) {
    return await verifyAwsLambdaMicrovmImage({
      api: input.api,
      artifactSha256: artifact.sha256,
      options: input.options,
      verifiedImage: input.options.verifiedImage,
    });
  }
  const baseImage = await resolveBaseImage(input.api, input.options);
  const imageHash = hashStable({
    artifact: artifact.sha256,
    baseImage,
    buildEgress: input.options.buildEgressNetworkConnectorArns,
    controllerProtocolVersion: AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION,
    memoryMiB: input.options.memoryMiB,
  });
  const configHash = configSha256(imageHash, input.options);
  const artifactKey = `${input.options.artifactPrefix}/images/${artifact.sha256}.zip`;
  const imageName = `eve-${input.options.applicationHash}-${imageHash.slice(0, 12)}`;

  if (!(await input.storage.hasObject(artifactKey))) {
    input.log?.("uploading deterministic MicroVM image artifact");
    await input.storage.putBytes(artifactKey, artifact.bytes, {
      "eve-application": input.options.applicationHash,
      "eve-controller": String(AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION),
      "eve-sha256": artifact.sha256,
    });
  }

  const existing = (await input.api.listImages(imageName)).find(
    (image) => image.name === imageName,
  );
  if (existing !== undefined) {
    const version =
      (await resolveExistingVersion(
        input.api,
        existing.imageArn,
        existing.latestActiveImageVersion,
      )) ?? (await waitForCreatedImageVersion(input.api, existing.imageArn, input.log));
    input.log?.(`reusing MicroVM image ${existing.imageArn}:${version.imageVersion}`);
    return provisionedImage({
      artifactSha256: artifact.sha256,
      baseImage,
      configHash,
      imageArn: existing.imageArn,
      imageVersion: version.imageVersion,
      options: input.options,
    });
  }

  input.log?.(`building MicroVM image ${imageName}`);
  let created: AwsLambdaMicrovmImageVersionRecord;
  try {
    created = await input.api.createImage({
      baseImageArn: baseImage.arn,
      baseImageVersion: baseImage.version,
      buildRoleArn: input.options.buildRoleArn!,
      clientToken: imageHash,
      codeArtifactUri: `s3://${input.options.artifactBucket}/${artifactKey}`,
      description: `eve sandbox image for ${input.options.applicationId}`,
      egressNetworkConnectorArns: input.options.buildEgressNetworkConnectorArns,
      environmentVariables: {},
      logging: { cloudWatch: {} },
      memoryMiB: input.options.memoryMiB,
      name: imageName,
      tags: {
        ...input.options.tags,
        "eve:application": input.options.applicationHash,
        "eve:config": configHash.slice(0, 32),
        "eve:controller": String(AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION),
        "eve:owner": "eve",
      },
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
    const raced = (await input.api.listImages(imageName)).find((image) => image.name === imageName);
    if (raced === undefined) throw error;
    const version =
      (await resolveExistingVersion(input.api, raced.imageArn, raced.latestActiveImageVersion)) ??
      (await waitForCreatedImageVersion(input.api, raced.imageArn, input.log));
    return provisionedImage({
      artifactSha256: artifact.sha256,
      baseImage,
      configHash,
      imageArn: raced.imageArn,
      imageVersion: version.imageVersion,
      options: input.options,
    });
  }

  const active = await waitForImageVersion(
    input.api,
    created.imageArn,
    created.imageVersion,
    input.log,
  );
  return provisionedImage({
    artifactSha256: artifact.sha256,
    baseImage,
    configHash,
    imageArn: active.imageArn,
    imageVersion: active.imageVersion,
    options: input.options,
  });
}

async function verifyAwsLambdaMicrovmImage(input: {
  readonly api: AwsLambdaMicrovmApi;
  readonly artifactSha256: string;
  readonly options: ResolvedAwsLambdaMicrovmOptions;
  readonly verifiedImage: AwsLambdaMicrovmVerifiedImage;
}): Promise<ProvisionedAwsLambdaMicrovmImage> {
  const identity = input.verifiedImage;
  const imageHash = hashStable({
    artifact: input.artifactSha256,
    baseImage: identity.baseImage,
    buildEgress: input.options.buildEgressNetworkConnectorArns,
    controllerProtocolVersion: AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION,
    memoryMiB: input.options.memoryMiB,
  });
  const configHash = configSha256(imageHash, input.options);
  const mismatches = [
    identity.applicationId === input.options.applicationId || "applicationId",
    identity.region === input.options.region || "region",
    identity.artifactSha256 === input.artifactSha256 || "artifactSha256",
    identity.controllerProtocolVersion === AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION ||
      "controllerProtocolVersion",
    identity.egressProxyCaSha256 === input.options.egressProxyCaSha256 ||
      "egressProxyCaSha256",
    identity.memoryMiB === input.options.memoryMiB || "memoryMiB",
    identity.buildNetworkLaneId === input.options.buildNetworkLaneId || "buildNetworkLaneId",
    arraysEqual(
      identity.buildEgressNetworkConnectorArns,
      input.options.buildEgressNetworkConnectorArns,
    ) || "buildEgressNetworkConnectorArns",
    identity.configSha256 === configHash || "configSha256",
  ].filter((entry): entry is string => entry !== true);
  if (mismatches.length > 0) {
    throw new Error(
      `AWS Lambda MicroVM verified image is incompatible with runtime configuration: ${mismatches.join(", ")}.`,
    );
  }
  const active = await input.api.getImageVersion(identity.imageArn, identity.imageVersion);
  if (
    active.imageArn !== identity.imageArn ||
    active.imageVersion !== identity.imageVersion ||
    active.state !== "SUCCESSFUL" ||
    active.status === "INACTIVE"
  ) {
    throw new Error(
      `AWS Lambda MicroVM verified image ${identity.imageArn}:${identity.imageVersion} is not active.`,
    );
  }
  return {
    configHash,
    imageArn: identity.imageArn,
    imageVersion: identity.imageVersion,
    verifiedImage: identity,
  };
}

function provisionedImage(input: {
  readonly artifactSha256: string;
  readonly baseImage: AwsLambdaMicrovmBaseImage;
  readonly configHash: string;
  readonly imageArn: string;
  readonly imageVersion: string;
  readonly options: ResolvedAwsLambdaMicrovmOptions;
}): ProvisionedAwsLambdaMicrovmImage {
  return {
    configHash: input.configHash,
    imageArn: input.imageArn,
    imageVersion: input.imageVersion,
    verifiedImage: {
      schemaVersion: 1,
      applicationId: input.options.applicationId,
      artifactSha256: input.artifactSha256,
      baseImage: input.baseImage,
      buildEgressNetworkConnectorArns: input.options.buildEgressNetworkConnectorArns,
      buildNetworkLaneId: input.options.buildNetworkLaneId,
      configSha256: input.configHash,
      controllerProtocolVersion: AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION,
      egressProxyCaSha256: input.options.egressProxyCaSha256,
      imageArn: input.imageArn,
      imageVersion: input.imageVersion,
      memoryMiB: input.options.memoryMiB,
      region: input.options.region,
    },
  };
}

async function waitForCreatedImageVersion(
  api: AwsLambdaMicrovmApi,
  imageArn: string,
  log?: (message: string) => void,
): Promise<AwsLambdaMicrovmImageVersionRecord> {
  const deadline = Date.now() + IMAGE_BUILD_TIMEOUT_MS;
  for (;;) {
    const versions = await api.listImageVersions(imageArn);
    const latest = [...versions].sort((left, right) =>
      compareVersionsDescending(left.imageVersion, right.imageVersion),
    )[0];
    if (latest !== undefined) {
      return await waitForImageVersion(api, imageArn, latest.imageVersion, log, deadline);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for AWS Lambda MicroVM image ${imageArn} to create a version.`,
      );
    }
    log?.("waiting for AWS Lambda MicroVM image version creation");
    await sleepWithJitter();
  }
}

async function resolveBaseImage(
  api: AwsLambdaMicrovmApi,
  options: ResolvedAwsLambdaMicrovmOptions,
): Promise<{ readonly arn: string; readonly version: string }> {
  if (options.baseImage !== undefined) {
    return { arn: options.baseImage.arn, version: options.baseImage.version };
  }
  const managed = await api.listManagedImages();
  const image = managed.find((candidate) => candidate.imageArn.endsWith(":microvm-image:al2023-1"));
  if (image === undefined) {
    throw new Error(
      `AWS Lambda MicroVMs are unavailable in ${options.region}: managed image al2023-1 was not found.`,
    );
  }
  const versions = await api.listManagedImageVersions(image.imageArn);
  const version = [...versions].sort((left, right) =>
    compareVersionsDescending(left.imageVersion, right.imageVersion),
  )[0];
  if (version === undefined) {
    throw new Error(`AWS managed MicroVM image ${image.imageArn} has no available versions.`);
  }
  return { arn: image.imageArn, version: version.imageVersion };
}

async function resolveExistingVersion(
  api: AwsLambdaMicrovmApi,
  imageArn: string,
  latestActiveImageVersion: string | undefined,
): Promise<AwsLambdaMicrovmImageVersionRecord | undefined> {
  if (latestActiveImageVersion !== undefined) {
    return await waitForImageVersion(api, imageArn, latestActiveImageVersion);
  }
  const versions = await api.listImageVersions(imageArn);
  const latest = [...versions].sort((left, right) =>
    compareVersionsDescending(left.imageVersion, right.imageVersion),
  )[0];
  return latest === undefined
    ? undefined
    : await waitForImageVersion(api, imageArn, latest.imageVersion);
}

async function waitForImageVersion(
  api: AwsLambdaMicrovmApi,
  imageArn: string,
  imageVersion: string,
  log?: (message: string) => void,
  deadline = Date.now() + IMAGE_BUILD_TIMEOUT_MS,
): Promise<AwsLambdaMicrovmImageVersionRecord> {
  for (;;) {
    const image = await api.getImageVersion(imageArn, imageVersion);
    if (image.state === "SUCCESSFUL" && image.status !== "INACTIVE") return image;
    if (isUnavailableImageVersion(image)) {
      throw new Error(
        `AWS Lambda MicroVM image ${imageArn}:${imageVersion} is unavailable: ${image.stateReason ?? `${image.state}/${image.status ?? "UNKNOWN"}`}. Check the configured CloudWatch build logs (default ${defaultBuildLogGroup(imageArn)}).`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for AWS Lambda MicroVM image ${imageArn}:${imageVersion}.`,
      );
    }
    log?.(`waiting for MicroVM image ${imageVersion} (${image.state.toLowerCase()})`);
    await sleepWithJitter();
  }
}

export function isUnavailableImageVersion(
  image: AwsLambdaMicrovmImageVersionRecord,
): boolean {
  return (
    image.state === "FAILED" ||
    image.state === "DELETING" ||
    image.state === "DELETED" ||
    image.state === "DELETE_FAILED" ||
    (image.state === "SUCCESSFUL" && image.status === "INACTIVE")
  );
}

async function sleepWithJitter(): Promise<void> {
  await sleep(1500 + Math.floor(Math.random() * 1501));
}

function compareVersionsDescending(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return rightNumber - leftNumber;
  return right.localeCompare(left);
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function configSha256(imageHash: string, options: ResolvedAwsLambdaMicrovmOptions): string {
  return hashStable({
    buildNetworkLaneId: options.buildNetworkLaneId,
    imageHash,
    executionRoleArn: options.executionRoleArn,
    egressProxyCaSha256: options.egressProxyCaSha256,
    idlePolicy: options.idlePolicy,
    maximumDurationSeconds: options.maximumDurationSeconds,
    networkingMode: options.networkingMode,
    runtimeEgress: options.runtimeEgressNetworkConnectorArns,
    runtimeNetworkLaneId: options.runtimeNetworkLaneId,
    runtimeLogging: options.runtimeLogging,
    shellIngress: options.shellIngressNetworkConnectorArn,
  });
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ["ConflictException", "ResourceConflictException"].includes(
      String((error as { readonly name?: unknown }).name),
    )
  );
}

function defaultBuildLogGroup(imageArn: string): string {
  return `/aws/lambda/microvms/${imageArn.slice(imageArn.lastIndexOf(":") + 1)}`;
}
