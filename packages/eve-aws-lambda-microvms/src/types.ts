// Derived from vercel/eve PR #208 (Apache-2.0); relocated to the package API.
/** Supported baseline memory allocations for an AWS Lambda MicroVM image. */
export type AwsLambdaMicrovmMemoryMiB = 512 | 1024 | 2048 | 4096 | 8192;

/** Idle suspension and retention policy applied to each MicroVM session. */
export interface AwsLambdaMicrovmIdlePolicy {
  /** Seconds without proxy traffic before AWS suspends the MicroVM. */
  readonly maxIdleDurationSeconds: number;
  /** Seconds AWS retains a suspended MicroVM before terminating it. */
  readonly suspendedDurationSeconds: number;
  /** Whether authenticated ingress automatically resumes a suspended MicroVM. */
  readonly autoResumeEnabled: boolean;
}

/** Exact Lambda-managed base image override used for eve image builds. */
export interface AwsLambdaMicrovmBaseImage {
  readonly arn: string;
  readonly version: string;
}

/** CloudWatch logging configuration for image builds and MicroVM sessions. */
export interface AwsLambdaMicrovmCloudWatchLogging {
  readonly logGroup?: string;
  readonly logStream?: string;
}

/** Network behavior for build, prewarm, and live-session MicroVMs. */
export type AwsLambdaMicrovmNetworkingMode = "legacy" | "customer-managed";

/**
 * Options accepted by {@link awsLambdaMicrovm}.
 *
 * eve creates Lambda MicroVM images and S3 artifacts, but never creates the
 * bucket, IAM roles, VPCs, or custom network connectors named here.
 */
export interface AwsLambdaMicrovmSandboxOptions {
  /** Stable application namespace shared by build and deployed runtime. */
  readonly applicationId: string;
  /** AWS region containing the bucket, image, connectors, and MicroVMs. */
  readonly region: string;
  /** Existing same-region S3 bucket used for image artifacts and checkpoints. */
  readonly artifactBucket: string;
  /** IAM role AWS assumes while building the MicroVM image. */
  readonly buildRoleArn: string;
  /** Prefix inside `artifactBucket`; defaults to an application-scoped eve prefix. */
  readonly artifactPrefix?: string;
  /** Optional execution role exposed to code inside the MicroVM through IMDS. */
  readonly executionRoleArn?: string;
  /** Baseline memory for the image. Defaults to 2048 MiB. */
  readonly memoryMiB?: AwsLambdaMicrovmMemoryMiB;
  /** Maximum MicroVM lifetime in seconds. Defaults to AWS's 28,800 second limit. */
  readonly maximumDurationSeconds?: number;
  /** Idle policy. Defaults to 5 minutes running and 30 minutes suspended. */
  readonly idlePolicy?: Partial<AwsLambdaMicrovmIdlePolicy>;
  /** Exact managed base image. Omit to use the newest available AL2023 image. */
  readonly baseImage?: AwsLambdaMicrovmBaseImage;
  /**
   * `customer-managed` fails closed unless both phases name exactly one
   * same-account, same-region customer connector. Omitted/`legacy` preserves
   * the 0.1.0 connector defaults for existing consumers.
   */
  readonly networkingMode?: AwsLambdaMicrovmNetworkingMode;
  /** Stable non-secret policy lane associated with the build connector. */
  readonly buildNetworkLaneId?: string;
  /** Egress connectors used for image build and template bootstrap. */
  readonly buildEgressNetworkConnectorArns?: readonly string[];
  /** Stable non-secret policy lane associated with the live-session connector. */
  readonly runtimeNetworkLaneId?: string;
  /** Egress connectors used for live agent sessions. */
  readonly runtimeEgressNetworkConnectorArns?: readonly string[];
  /** Adds AWS's shell ingress connector. Disabled by default. */
  readonly shellAccess?: boolean;
  /** CloudWatch configuration, or `false` to disable logging. */
  readonly runtimeLogging?: AwsLambdaMicrovmCloudWatchLogging | false;
  /** Tags attached to eve-owned MicroVM images. */
  readonly tags?: Readonly<Record<string, string>>;
}
