export type AwsLambdaMicrovmState =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDED"
  | "SUSPENDING"
  | "TERMINATED"
  | "TERMINATING";

export interface AwsLambdaMicrovmRecord {
  readonly endpoint: string;
  readonly imageArn: string;
  readonly imageVersion: string;
  readonly microvmId: string;
  readonly state: AwsLambdaMicrovmState;
  readonly stateReason?: string;
}

export interface AwsLambdaMicrovmImageRecord {
  readonly imageArn: string;
  readonly latestActiveImageVersion?: string;
  readonly name: string;
}

export interface AwsLambdaMicrovmImageVersionRecord {
  readonly imageArn: string;
  readonly imageVersion: string;
  readonly state:
    | "PENDING"
    | "IN_PROGRESS"
    | "SUCCESSFUL"
    | "FAILED"
    | "DELETING"
    | "DELETED"
    | "DELETE_FAILED";
  readonly stateReason?: string;
  readonly status?: "ACTIVE" | "INACTIVE";
}

export interface AwsLambdaMicrovmCreateImageInput {
  readonly baseImageArn: string;
  readonly baseImageVersion: string;
  readonly buildRoleArn: string;
  readonly clientToken: string;
  readonly codeArtifactUri: string;
  readonly description: string;
  readonly egressNetworkConnectorArns: readonly string[];
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly logging: AwsLambdaMicrovmLogging;
  readonly memoryMiB: number;
  readonly name: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface AwsLambdaMicrovmRunInput {
  readonly clientToken: string;
  readonly egressNetworkConnectorArns: readonly string[];
  readonly executionRoleArn?: string;
  readonly idlePolicy: {
    readonly autoResumeEnabled: boolean;
    readonly maxIdleDurationSeconds: number;
    readonly suspendedDurationSeconds: number;
  };
  readonly imageArn: string;
  readonly imageVersion: string;
  readonly ingressNetworkConnectorArns: readonly string[];
  readonly logging: AwsLambdaMicrovmLogging;
  readonly maximumDurationSeconds: number;
  readonly runHookPayload: string;
}

export type AwsLambdaMicrovmLogging =
  | { readonly disabled: true }
  | { readonly cloudWatch: { readonly logGroup?: string; readonly logStream?: string } };

export interface AwsLambdaMicrovmApi {
  createAuthToken(microvmId: string): Promise<string>;
  createImage(input: AwsLambdaMicrovmCreateImageInput): Promise<AwsLambdaMicrovmImageVersionRecord>;
  destroy(): void;
  getImageVersion(
    imageArn: string,
    imageVersion: string,
  ): Promise<AwsLambdaMicrovmImageVersionRecord>;
  getMicrovm(microvmId: string): Promise<AwsLambdaMicrovmRecord | null>;
  listImages(name: string): Promise<readonly AwsLambdaMicrovmImageRecord[]>;
  listImageVersions(imageArn: string): Promise<readonly AwsLambdaMicrovmImageVersionRecord[]>;
  listManagedImages(): Promise<readonly { readonly imageArn: string }[]>;
  listManagedImageVersions(
    imageArn: string,
  ): Promise<readonly { readonly imageArn: string; readonly imageVersion: string }[]>;
  resumeMicrovm(microvmId: string): Promise<void>;
  runMicrovm(input: AwsLambdaMicrovmRunInput): Promise<AwsLambdaMicrovmRecord>;
  suspendMicrovm(microvmId: string): Promise<void>;
  tagResource(resourceArn: string, tags: Readonly<Record<string, string>>): Promise<void>;
  terminateMicrovm(microvmId: string): Promise<void>;
}
