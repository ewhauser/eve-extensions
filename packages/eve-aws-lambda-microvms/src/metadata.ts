export const AWS_LAMBDA_MICROVM_METADATA_VERSION = 1;

export interface AwsLambdaMicrovmCheckpoint {
  readonly etag?: string;
  readonly generation: number;
  readonly key: string;
  readonly sha256: string;
  readonly size: number;
}

export interface AwsLambdaMicrovmTemplateDescriptor {
  readonly checkpoint?: AwsLambdaMicrovmCheckpoint;
  readonly configHash: string;
  readonly controllerProtocolVersion: number;
  readonly imageArn: string;
  readonly imageVersion: string;
  readonly region: string;
  readonly templateHash: string;
  readonly version: typeof AWS_LAMBDA_MICROVM_METADATA_VERSION;
}

export interface AwsLambdaMicrovmSessionMetadata extends AwsLambdaMicrovmTemplateDescriptor {
  readonly checkpoint?: AwsLambdaMicrovmCheckpoint;
  readonly manifestEtag: string;
  readonly microvmId: string;
}

export function parseAwsLambdaMicrovmTemplateDescriptor(
  value: unknown,
): AwsLambdaMicrovmTemplateDescriptor {
  const record = expectRecord(value, "template descriptor");
  expectVersion(record.version);
  return {
    checkpoint: parseCheckpoint(record.checkpoint),
    configHash: expectString(record.configHash, "configHash"),
    controllerProtocolVersion: expectPositiveInteger(
      record.controllerProtocolVersion,
      "controllerProtocolVersion",
    ),
    imageArn: expectString(record.imageArn, "imageArn"),
    imageVersion: expectString(record.imageVersion, "imageVersion"),
    region: expectString(record.region, "region"),
    templateHash: expectSha256(record.templateHash, "templateHash"),
    version: AWS_LAMBDA_MICROVM_METADATA_VERSION,
  };
}

export function parseAwsLambdaMicrovmSessionMetadata(
  value: unknown,
): AwsLambdaMicrovmSessionMetadata | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, "session metadata");
  return {
    ...parseAwsLambdaMicrovmTemplateDescriptor(record),
    manifestEtag: expectString(record.manifestEtag, "manifestEtag"),
    microvmId: expectString(record.microvmId, "microvmId"),
  };
}

function parseCheckpoint(value: unknown): AwsLambdaMicrovmCheckpoint | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, "checkpoint");
  const etag = record.etag;
  return {
    etag: typeof etag === "string" && etag.length > 0 ? etag : undefined,
    generation: expectPositiveInteger(record.generation, "checkpoint.generation"),
    key: expectString(record.key, "checkpoint.key"),
    sha256: expectSha256(record.sha256),
    size: expectNonNegativeInteger(record.size, "checkpoint.size"),
  };
}

function expectVersion(value: unknown): void {
  if (value !== AWS_LAMBDA_MICROVM_METADATA_VERSION) {
    throw new Error(`Unsupported AWS Lambda MicroVM metadata version ${String(value)}.`);
  }
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid AWS Lambda MicroVM ${name}.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid AWS Lambda MicroVM ${name}.`);
  }
  return value;
}

function expectPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`Invalid AWS Lambda MicroVM ${name}.`);
  }
  return Number(value);
}

function expectNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid AWS Lambda MicroVM ${name}.`);
  }
  return Number(value);
}

function expectSha256(value: unknown, name = "checkpoint.sha256"): string {
  const digest = expectString(value, name);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Invalid AWS Lambda MicroVM ${name}.`);
  }
  return digest;
}
