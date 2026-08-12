import { createHash, randomUUID } from "node:crypto";

export const AWS_LAMBDA_MICROVM_ACTIVATION_VERSION = 2;
export const AWS_LAMBDA_MICROVM_MAX_ACTIVATION_BYTES = 4095;

export interface AwsLambdaMicrovmActivationEnvelope {
  readonly activationId: string;
  readonly capability: string;
  readonly controllerCaSha256: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly protocolVersion: 2;
  readonly version: 2;
}

export interface AwsLambdaMicrovmActivationRequest {
  readonly networkLaneId: string;
  readonly purposeHash: string;
  readonly replacementOf?: string;
}

export interface AwsLambdaMicrovmActivationIssuer {
  issueActivation(
    request: AwsLambdaMicrovmActivationRequest,
  ): Promise<AwsLambdaMicrovmActivationEnvelope>;
}

export function createAwsLambdaMicrovmActivationEnvelope(input: {
  readonly capability: string;
  readonly controllerCaSha256: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly activationId?: string;
}): AwsLambdaMicrovmActivationEnvelope {
  const envelope: AwsLambdaMicrovmActivationEnvelope = {
    activationId: input.activationId ?? randomUUID(),
    capability: input.capability,
    controllerCaSha256: expectSha256(input.controllerCaSha256, "controllerCaSha256"),
    expiresAt: expectTimestamp(input.expiresAt, "expiresAt"),
    issuedAt: expectTimestamp(input.issuedAt, "issuedAt"),
    protocolVersion: AWS_LAMBDA_MICROVM_ACTIVATION_VERSION,
    version: AWS_LAMBDA_MICROVM_ACTIVATION_VERSION,
  };
  validateAwsLambdaMicrovmActivationEnvelope(envelope);
  return envelope;
}

export function serializeAwsLambdaMicrovmActivationEnvelope(
  value: AwsLambdaMicrovmActivationEnvelope,
): string {
  validateAwsLambdaMicrovmActivationEnvelope(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > AWS_LAMBDA_MICROVM_MAX_ACTIVATION_BYTES) {
    throw new Error("AWS Lambda MicroVM activation payload must be smaller than 4 KiB.");
  }
  return serialized;
}

export function validateAwsLambdaMicrovmActivationEnvelope(
  value: AwsLambdaMicrovmActivationEnvelope,
): void {
  if (value.version !== 2 || value.protocolVersion !== 2) {
    throw new Error("AWS Lambda MicroVM activation requires protocol v2.");
  }
  expectIdentifier(value.activationId, "activationId");
  expectSha256(value.controllerCaSha256, "controllerCaSha256");
  const issuedAt = Date.parse(expectTimestamp(value.issuedAt, "issuedAt"));
  const expiresAt = Date.parse(expectTimestamp(value.expiresAt, "expiresAt"));
  if (expiresAt <= issuedAt) throw new Error("AWS Lambda MicroVM activation expiry is invalid.");
  validateCapability(value.capability);
  rejectUnexpectedKeys(value as unknown as Record<string, unknown>);
}

export function hashAwsLambdaMicrovmCapability(capability: string): string {
  return createHash("sha256").update(capability).digest("hex");
}

function validateCapability(value: string): void {
  if (typeof value !== "string" || value.length < 8 || /[\0\r\n]/.test(value)) {
    throw new Error("AWS Lambda MicroVM activation capability is invalid.");
  }
  const segments = value.split(".");
  if (segments.length !== 3) throw new Error("AWS Lambda MicroVM capability must be a JWT.");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("AWS Lambda MicroVM capability contains an invalid JWT payload.");
  }
  const forbidden = new Set([
    "access_token",
    "api_key",
    "approval",
    "credential",
    "external_connection",
    "password",
    "placement",
    "principal",
    "provider",
    "refresh_token",
    "scope",
    "scopes",
    "secret",
  ]);
  for (const key of Object.keys(payload)) {
    if (forbidden.has(key.toLowerCase())) {
      throw new Error(`AWS Lambda MicroVM capability contains forbidden claim ${key}.`);
    }
  }
  if (payload.typ !== "agent-egress-capability+jwt") {
    throw new Error("AWS Lambda MicroVM capability has an invalid typ claim.");
  }
}

function rejectUnexpectedKeys(value: Record<string, unknown>): void {
  const allowed = new Set([
    "activationId",
    "capability",
    "controllerCaSha256",
    "expiresAt",
    "issuedAt",
    "protocolVersion",
    "version",
  ]);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new Error(`AWS Lambda MicroVM activation contains unexpected field ${unexpected}.`);
  }
}

function expectIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 3072 || /[\0\r\n]/.test(value)) {
    throw new Error(`AWS Lambda MicroVM activation ${name} is invalid.`);
  }
  return value;
}

function expectSha256(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`AWS Lambda MicroVM activation ${name} is invalid.`);
  }
  return value;
}

function expectTimestamp(value: string, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`AWS Lambda MicroVM activation ${name} is invalid.`);
  }
  return value;
}
