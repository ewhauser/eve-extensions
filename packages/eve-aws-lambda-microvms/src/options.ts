// Derived from vercel/eve PR #208 (Apache-2.0); adapted for standalone packaging.
import { createHash } from "node:crypto";

import type {
  AwsLambdaMicrovmBaseImage,
  AwsLambdaMicrovmCloudWatchLogging,
  AwsLambdaMicrovmIdlePolicy,
  AwsLambdaMicrovmMemoryMiB,
  AwsLambdaMicrovmSandboxOptions,
} from "./types.js";

const MEMORY_VALUES = new Set<AwsLambdaMicrovmMemoryMiB>([512, 1024, 2048, 4096, 8192]);
const MAXIMUM_DURATION_SECONDS = 28_800;

export interface ResolvedAwsLambdaMicrovmOptions {
  readonly applicationId: string;
  readonly applicationHash: string;
  readonly artifactBucket: string;
  readonly artifactPrefix: string;
  readonly baseImage?: AwsLambdaMicrovmBaseImage;
  readonly buildEgressNetworkConnectorArns: readonly string[];
  readonly buildRoleArn: string;
  readonly executionRoleArn?: string;
  readonly httpIngressNetworkConnectorArn: string;
  readonly idlePolicy: AwsLambdaMicrovmIdlePolicy;
  readonly maximumDurationSeconds: number;
  readonly memoryMiB: AwsLambdaMicrovmMemoryMiB;
  readonly region: string;
  readonly runtimeEgressNetworkConnectorArns: readonly string[];
  readonly runtimeLogging: AwsLambdaMicrovmCloudWatchLogging | false;
  readonly shellIngressNetworkConnectorArn?: string;
  readonly tags: Readonly<Record<string, string>>;
}

export function resolveAwsLambdaMicrovmOptions(
  options: AwsLambdaMicrovmSandboxOptions,
): ResolvedAwsLambdaMicrovmOptions {
  const applicationId = expectNonEmpty("applicationId", options.applicationId);
  const region = expectNonEmpty("region", options.region);
  const artifactBucket = expectNonEmpty("artifactBucket", options.artifactBucket);
  const buildRoleArn = expectNonEmpty("buildRoleArn", options.buildRoleArn);
  const baseImage =
    options.baseImage === undefined
      ? undefined
      : {
          arn: expectNonEmpty("baseImage.arn", options.baseImage.arn),
          version: expectNonEmpty("baseImage.version", options.baseImage.version),
        };
  const applicationHash = sha256(applicationId).slice(0, 20);
  const memoryMiB = options.memoryMiB ?? 2048;
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

  const idlePolicy: AwsLambdaMicrovmIdlePolicy = {
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
  const artifactPrefix = normalizePrefix(
    options.artifactPrefix ?? `eve/lambda-microvms/${applicationHash}`,
  );

  return {
    applicationHash,
    applicationId,
    artifactBucket,
    artifactPrefix,
    baseImage,
    buildEgressNetworkConnectorArns: normalizeStringArray(
      "buildEgressNetworkConnectorArns",
      options.buildEgressNetworkConnectorArns ?? [internetEgress],
    ),
    buildRoleArn,
    executionRoleArn,
    httpIngressNetworkConnectorArn: `${managedConnectorPrefix}:ALL_INGRESS`,
    idlePolicy,
    maximumDurationSeconds,
    memoryMiB,
    region,
    runtimeEgressNetworkConnectorArns: normalizeStringArray(
      "runtimeEgressNetworkConnectorArns",
      options.runtimeEgressNetworkConnectorArns ?? [internetEgress],
    ),
    runtimeLogging:
      options.runtimeLogging ??
      (executionRoleArn === undefined
        ? false
        : { logGroup: `/aws/lambda-microvms/eve-${applicationHash}` }),
    shellIngressNetworkConnectorArn:
      options.shellAccess === true ? `${managedConnectorPrefix}:SHELL_INGRESS` : undefined,
    tags: normalizeTags(options.tags),
  };
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
