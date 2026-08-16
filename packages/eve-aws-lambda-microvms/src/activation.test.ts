import { describe, expect, it } from "vitest";

import {
  AWS_LAMBDA_MICROVM_MAX_ACTIVATION_BYTES,
  createAwsLambdaMicrovmActivationEnvelope,
  serializeAwsLambdaMicrovmActivationEnvelope,
} from "./activation.js";

const PLACEHOLDER = {
  generation: 7,
  placement: { environmentVariable: "OPENAI_API_KEY" },
  token: "eve_placeholder_opaque_12345678",
  trustedBindingGeneration: 11,
} as const;

describe("AWS Lambda MicroVM activation v2", () => {
  it("serializes separate opaque placeholder and localhost authentication below 4 KiB", () => {
    const value = createAwsLambdaMicrovmActivationEnvelope({
      activationId: "activation_opaque_12345678",
      controllerCaSha256: "a".repeat(64),
      controllerSessionToken: "eve_local_opaque_12345678",
      placeholder: PLACEHOLDER,
    });
    const serialized = serializeAwsLambdaMicrovmActivationEnvelope(value);

    expect(Buffer.byteLength(serialized)).toBeLessThan(4096);
    expect(value.placeholder).toEqual(PLACEHOLDER);
    expect(value.controllerSessionToken).not.toBe(value.placeholder.token);
    expect(serialized).not.toMatch(/jwt|issuer|audience|signature|access_token|refresh_token/i);
  });

  it.each([
    ["placeholder", { ...PLACEHOLDER, token: "header.payload.signature" }],
    ["controller", "header.payload.signature"],
  ] as const)("rejects JWT-shaped %s input", (kind, jwtShaped) => {
    expect(() =>
      createAwsLambdaMicrovmActivationEnvelope({
        controllerCaSha256: "a".repeat(64),
        controllerSessionToken:
          kind === "controller" ? String(jwtShaped) : "eve_local_opaque_12345678",
        placeholder: kind === "placeholder" ? (jwtShaped as never) : PLACEHOLDER,
      }),
    ).toThrow(/must not be JWT-shaped/);
  });

  it("rejects reused controller authentication and placeholder material", () => {
    expect(() =>
      createAwsLambdaMicrovmActivationEnvelope({
        controllerCaSha256: "a".repeat(64),
        controllerSessionToken: PLACEHOLDER.token,
        placeholder: PLACEHOLDER,
      }),
    ).toThrow(/must be separate/);
  });

  it("rejects invalid placement and generations", () => {
    expect(() =>
      createAwsLambdaMicrovmActivationEnvelope({
        controllerCaSha256: "a".repeat(64),
        placeholder: {
          ...PLACEHOLDER,
          placement: { environmentVariable: "invalid-name" },
        },
      }),
    ).toThrow(/environment variable/);
    expect(() =>
      createAwsLambdaMicrovmActivationEnvelope({
        controllerCaSha256: "a".repeat(64),
        placeholder: { ...PLACEHOLDER, trustedBindingGeneration: 0 },
      }),
    ).toThrow(/trustedBindingGeneration/);
  });

  it("rejects oversized activation payloads", () => {
    const value = createAwsLambdaMicrovmActivationEnvelope({
      controllerCaSha256: "a".repeat(64),
      placeholder: {
        ...PLACEHOLDER,
        token: `eve_placeholder_${"x".repeat(AWS_LAMBDA_MICROVM_MAX_ACTIVATION_BYTES)}`,
      },
    });
    expect(() => serializeAwsLambdaMicrovmActivationEnvelope(value)).toThrow(/smaller than 4 KiB/);
  });

  it("rejects unknown authorization-shaped fields", () => {
    expect(() =>
      serializeAwsLambdaMicrovmActivationEnvelope({
        ...createAwsLambdaMicrovmActivationEnvelope({
          controllerCaSha256: "a".repeat(64),
          placeholder: PLACEHOLDER,
        }),
        capability: "forbidden",
      } as never),
    ).toThrow(/unexpected field capability/);
  });

  it("does not admit proxy certificates or private keys into the run-hook envelope", () => {
    const value = createAwsLambdaMicrovmActivationEnvelope({
      controllerCaSha256: "a".repeat(64),
      placeholder: PLACEHOLDER,
    });

    expect(() =>
      serializeAwsLambdaMicrovmActivationEnvelope({
        ...value,
        egressProxyCaBundlePem: "-----BEGIN CERTIFICATE-----",
      } as never),
    ).toThrow(/unexpected field egressProxyCaBundlePem/);
    expect(serializeAwsLambdaMicrovmActivationEnvelope(value)).not.toMatch(
      /BEGIN (?:CERTIFICATE|(?:RSA |EC )?PRIVATE KEY)/,
    );
  });
});
