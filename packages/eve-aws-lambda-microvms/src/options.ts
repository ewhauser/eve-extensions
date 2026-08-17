// Derived from vercel/eve PR #208 (Apache-2.0); adapted for standalone packaging.
import { createHash, X509Certificate } from "node:crypto";

import type {
  AwsLambdaMicrovmBaseImage,
  AwsLambdaMicrovmCloudWatchLogging,
  AwsLambdaMicrovmIdlePolicy,
  AwsLambdaMicrovmMemoryMiB,
  AwsLambdaMicrovmSandboxOptions,
  AwsLambdaMicrovmVerifiedImage,
} from "./types.js";

const MEMORY_VALUES = new Set<AwsLambdaMicrovmMemoryMiB>([512, 1024, 2048, 4096, 8192]);
const MAXIMUM_DURATION_SECONDS = 28_800;

export interface ResolvedAwsLambdaMicrovmOptions {
  readonly applicationId: string;
  readonly applicationHash: string;
  readonly artifactBucket: string;
  readonly artifactKmsKeyId?: string;
  readonly artifactPrefix: string;
  readonly baseImage?: AwsLambdaMicrovmBaseImage;
  readonly buildEgressNetworkConnectorArns: readonly string[];
  readonly buildNetworkLaneId?: string;
  readonly buildRoleArn?: string;
  readonly executionRoleArn?: string;
  readonly egressProxyCaBundlePem?: string;
  readonly egressProxyCaSha256?: string;
  readonly httpIngressNetworkConnectorArn: string;
  readonly idlePolicy: AwsLambdaMicrovmIdlePolicy;
  readonly maximumDurationSeconds: number;
  readonly memoryMiB: AwsLambdaMicrovmMemoryMiB;
  readonly networkingMode: "legacy" | "customer-managed";
  readonly region: string;
  readonly runtimeEgressNetworkConnectorArns: readonly string[];
  readonly runtimeNetworkLaneId?: string;
  readonly runtimeLogging: AwsLambdaMicrovmCloudWatchLogging | false;
  readonly shellIngressNetworkConnectorArn?: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly verifiedImage?: AwsLambdaMicrovmVerifiedImage;
}

export function resolveAwsLambdaMicrovmOptions(
  options: AwsLambdaMicrovmSandboxOptions,
): ResolvedAwsLambdaMicrovmOptions {
  const applicationId = expectNonEmpty("applicationId", options.applicationId);
  const region = expectNonEmpty("region", options.region);
  const artifactBucket = expectNonEmpty("artifactBucket", options.artifactBucket);
  const verifiedImage = normalizeVerifiedImage(options.verifiedImage);
  const buildRoleArn = optionalNonEmpty("buildRoleArn", options.buildRoleArn);
  if (verifiedImage === undefined && buildRoleArn === undefined) {
    throw new Error(
      "AWS Lambda MicroVM buildRoleArn is required when verifiedImage is not supplied.",
    );
  }
  const artifactKmsKeyId = optionalNonEmpty("artifactKmsKeyId", options.artifactKmsKeyId);
  const baseImage =
    options.baseImage === undefined
      ? undefined
      : {
          arn: expectNonEmpty("baseImage.arn", options.baseImage.arn),
          version: expectNonEmpty("baseImage.version", options.baseImage.version),
        };
  const applicationHash = sha256(applicationId).slice(0, 20);
  const memoryMiB = options.memoryMiB ?? verifiedImage?.memoryMiB ?? 2048;
  if (!MEMORY_VALUES.has(memoryMiB)) {
    throw new Error("AWS Lambda MicroVM memoryMiB must be one of 512, 1024, 2048, 4096, or 8192.");
  }

  const maximumDurationSeconds = options.maximumDurationSeconds ?? MAXIMUM_DURATION_SECONDS;
  if (
    !Number.isInteger(maximumDurationSeconds) ||
    maximumDurationSeconds < 1 ||
    maximumDurationSeconds > MAXIMUM_DURATION_SECONDS
  ) {
    throw new Error(
      "AWS Lambda MicroVM maximumDurationSeconds must be an integer from 1 to 28800.",
    );
  }

  let idlePolicy: AwsLambdaMicrovmIdlePolicy = {
    autoResumeEnabled: options.idlePolicy?.autoResumeEnabled ?? true,
    maxIdleDurationSeconds: options.idlePolicy?.maxIdleDurationSeconds ?? 300,
    suspendedDurationSeconds: options.idlePolicy?.suspendedDurationSeconds ?? 1800,
  };
  for (const [name, value] of Object.entries(idlePolicy)) {
    if (name === "autoResumeEnabled") continue;
    if (!Number.isInteger(value) || Number(value) < 1) {
      throw new Error(`AWS Lambda MicroVM idlePolicy.${name} must be a positive integer.`);
    }
  }

  const managedConnectorPrefix = `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector`;
  const internetEgress = `${managedConnectorPrefix}:INTERNET_EGRESS`;
  const executionRoleArn = optionalNonEmpty("executionRoleArn", options.executionRoleArn);
  const egressProxyCa = normalizePublicCertificateBundle(options.egressProxyCaBundlePem);
  const networkingMode = options.networkingMode ?? "legacy";
  if (networkingMode !== "legacy" && networkingMode !== "customer-managed") {
    throw new Error(`AWS Lambda MicroVM networkingMode ${String(networkingMode)} is unsupported.`);
  }
  const buildNetworkLaneId = optionalNonEmpty(
    "buildNetworkLaneId",
    options.buildNetworkLaneId ?? verifiedImage?.buildNetworkLaneId,
  );
  const runtimeNetworkLaneId = optionalNonEmpty(
    "runtimeNetworkLaneId",
    options.runtimeNetworkLaneId,
  );
  const buildEgressNetworkConnectorArns = normalizeStringArray(
    "buildEgressNetworkConnectorArns",
    options.buildEgressNetworkConnectorArns ??
      verifiedImage?.buildEgressNetworkConnectorArns ??
      (networkingMode === "customer-managed" ? [] : [internetEgress]),
  );
  const runtimeEgressNetworkConnectorArns = normalizeStringArray(
    "runtimeEgressNetworkConnectorArns",
    options.runtimeEgressNetworkConnectorArns ??
      (networkingMode === "customer-managed" ? [] : [internetEgress]),
  );
  if (networkingMode === "customer-managed") {
    idlePolicy = {
      autoResumeEnabled: false,
      maxIdleDurationSeconds: maximumDurationSeconds,
      suspendedDurationSeconds: 1,
    };
    const account =
      buildRoleArn === undefined
        ? accountFromImageArn(verifiedImage!.imageArn)
        : accountFromBuildRoleArn(buildRoleArn);
    validateCustomerManagedConnector(
      "buildEgressNetworkConnectorArns",
      buildEgressNetworkConnectorArns,
      region,
      account,
    );
    validateCustomerManagedConnector(
      "runtimeEgressNetworkConnectorArns",
      runtimeEgressNetworkConnectorArns,
      region,
      account,
    );
    if (buildNetworkLaneId === undefined) {
      throw new Error(
        "AWS Lambda MicroVM buildNetworkLaneId is required in customer-managed networking mode.",
      );
    }
    if (runtimeNetworkLaneId === undefined) {
      throw new Error(
        "AWS Lambda MicroVM runtimeNetworkLaneId is required in customer-managed networking mode.",
      );
    }
  }
  const artifactPrefix = normalizePrefix(
    options.artifactPrefix ?? `eve/lambda-microvms/${applicationHash}`,
  );

  return {
    applicationHash,
    applicationId,
    artifactBucket,
    artifactKmsKeyId,
    artifactPrefix,
    baseImage,
    buildEgressNetworkConnectorArns,
    buildNetworkLaneId,
    buildRoleArn,
    executionRoleArn,
    egressProxyCaBundlePem: egressProxyCa?.pem,
    egressProxyCaSha256: egressProxyCa?.sha256,
    httpIngressNetworkConnectorArn: `${managedConnectorPrefix}:ALL_INGRESS`,
    idlePolicy,
    maximumDurationSeconds,
    memoryMiB,
    networkingMode,
    region,
    runtimeEgressNetworkConnectorArns,
    runtimeNetworkLaneId,
    runtimeLogging:
      options.runtimeLogging ??
      (executionRoleArn === undefined
        ? false
        : { logGroup: `/aws/lambda-microvms/eve-${applicationHash}` }),
    shellIngressNetworkConnectorArn:
      options.shellAccess === true ? `${managedConnectorPrefix}:SHELL_INGRESS` : undefined,
    tags: normalizeTags(options.tags),
    verifiedImage,
  };
}

function normalizeVerifiedImage(
  value: AwsLambdaMicrovmVerifiedImage | undefined,
): AwsLambdaMicrovmVerifiedImage | undefined {
  if (value === undefined) return undefined;
  if (value.schemaVersion !== 1) {
    throw new Error("AWS Lambda MicroVM verifiedImage.schemaVersion must be 1.");
  }
  if (!MEMORY_VALUES.has(value.memoryMiB)) {
    throw new Error("AWS Lambda MicroVM verifiedImage.memoryMiB is unsupported.");
  }
  const region = expectNonEmpty("verifiedImage.region", value.region);
  const imageArn = expectNonEmpty("verifiedImage.imageArn", value.imageArn);
  const imageArnMatch = /^arn:[^:]+:lambda:([^:]+):(\d{12}):microvm-image:.+/.exec(imageArn);
  if (imageArnMatch === null || imageArnMatch[1] !== region) {
    throw new Error(
      "AWS Lambda MicroVM verifiedImage.imageArn must be an account-scoped image ARN in verifiedImage.region.",
    );
  }
  return {
    schemaVersion: 1,
    applicationId: expectNonEmpty("verifiedImage.applicationId", value.applicationId),
    artifactSha256: expectSha256("verifiedImage.artifactSha256", value.artifactSha256),
    baseImage: {
      arn: expectNonEmpty("verifiedImage.baseImage.arn", value.baseImage.arn),
      version: expectNonEmpty("verifiedImage.baseImage.version", value.baseImage.version),
    },
    buildEgressNetworkConnectorArns: normalizeStringArray(
      "verifiedImage.buildEgressNetworkConnectorArns",
      value.buildEgressNetworkConnectorArns,
    ),
    buildNetworkLaneId: optionalNonEmpty(
      "verifiedImage.buildNetworkLaneId",
      value.buildNetworkLaneId,
    ),
    configSha256: expectSha256("verifiedImage.configSha256", value.configSha256),
    controllerProtocolVersion: expectPositiveInteger(
      "verifiedImage.controllerProtocolVersion",
      value.controllerProtocolVersion,
    ),
    egressProxyCaSha256:
      value.egressProxyCaSha256 === undefined
        ? undefined
        : expectSha256("verifiedImage.egressProxyCaSha256", value.egressProxyCaSha256),
    imageArn,
    imageVersion: expectNonEmpty("verifiedImage.imageVersion", value.imageVersion),
    memoryMiB: value.memoryMiB,
    region,
  };
}

function normalizePublicCertificateBundle(
  value: string | undefined,
): { readonly pem: string; readonly sha256: string } | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, "utf8") > 256 * 1024) {
    throw new Error("AWS Lambda MicroVM egressProxyCaBundlePem must not exceed 256 KiB.");
  }
  const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const remainder = value.replace(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    "",
  );
  if (blocks.length === 0 || remainder.trim().length !== 0) {
    throw new Error(
      "AWS Lambda MicroVM egressProxyCaBundlePem must contain only public CERTIFICATE PEM blocks.",
    );
  }
  let pem: string;
  try {
    pem = `${blocks.map((block) => new X509Certificate(block).toString().trim()).join("\n")}\n`;
  } catch (error) {
    throw new Error("AWS Lambda MicroVM egressProxyCaBundlePem contains an invalid certificate.", {
      cause: error,
    });
  }
  return { pem, sha256: sha256(pem) };
}

function accountFromBuildRoleArn(value: string): string {
  const match = /^arn:([^:]+):iam::(\d{12}):role\/.+/.exec(value);
  if (match === null) {
    throw new Error(
      "AWS Lambda MicroVM buildRoleArn must be an IAM role ARN with a 12-digit account ID.",
    );
  }
  return match[2]!;
}

function accountFromImageArn(value: string): string {
  const match = /^arn:[^:]+:lambda:[^:]+:(\d{12}):microvm-image:.+/.exec(value);
  if (match === null) {
    throw new Error(
      "AWS Lambda MicroVM verifiedImage.imageArn must be an account-scoped image ARN.",
    );
  }
  return match[1]!;
}

function validateCustomerManagedConnector(
  name: string,
  values: readonly string[],
  region: string,
  account: string,
): void {
  if (values.length !== 1) {
    throw new Error(
      `AWS Lambda MicroVM ${name} must contain exactly one connector in customer-managed networking mode.`,
    );
  }
  const value = values[0]!;
  const match = /^arn:([^:]+):lambda:([^:]+):(\d{12}|aws):network-connector:(.+)$/.exec(value);
  if (match === null) {
    throw new Error(`AWS Lambda MicroVM ${name}[0] must be a Lambda network connector ARN.`);
  }
  if (match[2] !== region) {
    throw new Error(
      `AWS Lambda MicroVM ${name}[0] is in ${match[2]}, but this backend is configured for ${region}.`,
    );
  }
  if (match[3] === "aws" || value.endsWith(":INTERNET_EGRESS")) {
    throw new Error(
      `AWS Lambda MicroVM ${name}[0] must be customer-managed; AWS-managed INTERNET_EGRESS is forbidden.`,
    );
  }
  if (match[3] !== account) {
    throw new Error(
      `AWS Lambda MicroVM ${name}[0] belongs to account ${match[3]}, but the configured image/build role belongs to ${account}.`,
    );
  }
}

function expectNonEmpty(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`AWS Lambda MicroVM ${name} must be a non-empty string.`);
  }
  return normalized;
}

function optionalNonEmpty(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : expectNonEmpty(name, value);
}

function expectSha256(name: string, value: string): string {
  const normalized = expectNonEmpty(name, value);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`AWS Lambda MicroVM ${name} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function expectPositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`AWS Lambda MicroVM ${name} must be a positive integer.`);
  }
  return value;
}

function normalizePrefix(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0) {
    throw new Error(
      "AWS Lambda MicroVM artifactPrefix must contain at least one non-slash character.",
    );
  }
  return normalized;
}

function normalizeStringArray(name: string, values: readonly string[]): readonly string[] {
  return values.map((value, index) => expectNonEmpty(`${name}[${index}]`, value));
}

function normalizeTags(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const entries = Object.entries(value)
    .map(([key, entry]) => [expectNonEmpty("tag key", key), entry] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 45) {
    throw new Error("AWS Lambda MicroVM tags may contain at most 45 user-defined entries.");
  }
  for (const [key, entry] of entries) {
    if (key.startsWith("aws:") || key.startsWith("eve:")) {
      throw new Error(`AWS Lambda MicroVM tag key "${key}" uses a reserved prefix.`);
    }
    if (key.length > 128 || entry.length > 256) {
      throw new Error(`AWS Lambda MicroVM tag "${key}" exceeds AWS tag length limits.`);
    }
  }
  return Object.fromEntries(entries);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
