import { randomBytes, randomUUID } from "node:crypto";

export const AWS_LAMBDA_MICROVM_ACTIVATION_VERSION = 2;
export const AWS_LAMBDA_MICROVM_MAX_ACTIVATION_BYTES = 4095;

export interface AwsLambdaMicrovmCredentialPlaceholder {
  readonly generation: number;
  readonly placement: {
    readonly environmentVariable: string;
  };
  readonly token: string;
  readonly trustedBindingGeneration: number;
}

export interface AwsLambdaMicrovmActivationEnvelope {
  readonly activationId: string;
  readonly controllerCaSha256: string;
  readonly controllerSessionToken: string;
  readonly placeholder: AwsLambdaMicrovmCredentialPlaceholder;
  readonly protocolVersion: 2;
  readonly version: 2;
}

export interface AwsLambdaMicrovmActivationRequest {
  readonly networkLaneId: string;
  readonly purposeHash: string;
  readonly replacementOf?: {
    readonly activationId: string;
    readonly placeholderGeneration: number;
    readonly trustedBindingGeneration: number;
  };
}

/** Trusted host seam that prepares non-authoritative guest activation material. */
export interface AwsLambdaMicrovmActivationProvider {
  createActivation(
    request: AwsLambdaMicrovmActivationRequest,
  ): Promise<AwsLambdaMicrovmActivationEnvelope>;
  revokeTrustedBinding(input: {
    readonly activationId: string;
    readonly placeholderGeneration: number;
    readonly trustedBindingGeneration: number;
  }): Promise<void>;
}

export function createAwsLambdaMicrovmActivationEnvelope(input: {
  readonly controllerCaSha256: string;
  readonly placeholder: AwsLambdaMicrovmCredentialPlaceholder;
  readonly activationId?: string;
  readonly controllerSessionToken?: string;
}): AwsLambdaMicrovmActivationEnvelope {
  const envelope: AwsLambdaMicrovmActivationEnvelope = {
    activationId: input.activationId ?? randomUUID(),
    controllerCaSha256: expectSha256(input.controllerCaSha256, "controllerCaSha256"),
    controllerSessionToken:
      input.controllerSessionToken ?? `eve_local_${randomBytes(32).toString("base64url")}`,
    placeholder: input.placeholder,
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
  expectOpaque(value.activationId, "activationId");
  expectSha256(value.controllerCaSha256, "controllerCaSha256");
  expectOpaque(value.controllerSessionToken, "controllerSessionToken");
  const placeholder = expectRecord(value.placeholder, "placeholder");
  rejectUnexpectedKeys(placeholder, ["generation", "placement", "token", "trustedBindingGeneration"], "placeholder");
  expectPositiveInteger(placeholder.generation, "placeholder.generation");
  expectPositiveInteger(
    placeholder.trustedBindingGeneration,
    "placeholder.trustedBindingGeneration",
  );
  const token = expectOpaque(placeholder.token, "placeholder.token");
  if (token === value.controllerSessionToken) {
    throw new Error("AWS Lambda MicroVM placeholder and controller authentication must be separate.");
  }
  const placement = expectRecord(placeholder.placement, "placeholder.placement");
  rejectUnexpectedKeys(placement, ["environmentVariable"], "placeholder.placement");
  const environmentVariable = expectString(
    placement.environmentVariable,
    "placeholder.placement.environmentVariable",
  );
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(environmentVariable)) {
    throw new Error("AWS Lambda MicroVM placeholder environment variable is invalid.");
  }
  rejectUnexpectedKeys(
    value as unknown as Record<string, unknown>,
    [
      "activationId",
      "controllerCaSha256",
      "controllerSessionToken",
      "placeholder",
      "protocolVersion",
      "version",
    ],
    "activation",
  );
}

function expectOpaque(value: unknown, name: string): string {
  const token = expectString(value, name);
  if (token.length < 8 || token.length > 8192 || /[\0\r\n]/.test(token)) {
    throw new Error(`AWS Lambda MicroVM activation ${name} is invalid.`);
  }
  if (token.split(".").length === 3) {
    throw new Error(`AWS Lambda MicroVM activation ${name} must not be JWT-shaped.`);
  }
  return token;
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  name: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new Error(`AWS Lambda MicroVM ${name} contains unexpected field ${unexpected}.`);
  }
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`AWS Lambda MicroVM activation ${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`AWS Lambda MicroVM activation ${name} is invalid.`);
  }
  return value;
}

function expectPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`AWS Lambda MicroVM activation ${name} is invalid.`);
  }
  return Number(value);
}

function expectSha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`AWS Lambda MicroVM activation ${name} is invalid.`);
  }
  return value;
}
