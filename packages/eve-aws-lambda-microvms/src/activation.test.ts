import { describe, expect, it } from "vitest";

import {
  AWS_LAMBDA_MICROVM_MAX_ACTIVATION_BYTES,
  createAwsLambdaMicrovmActivationEnvelope,
  hashAwsLambdaMicrovmCapability,
  serializeAwsLambdaMicrovmActivationEnvelope,
} from "./activation.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const capability = (claims: Record<string, unknown> = {}) =>
  `${encode({ alg: "ES256", typ: "JWT" })}.${encode({
    aud: "agent-egress",
    exp: 1_893_456_300,
    iat: 1_893_456_000,
    jti: "grant-1",
    lane_id: "lane-a",
    sub: "sandbox/test",
    typ: "agent-egress-capability+jwt",
    ...claims,
  })}.signature`;

describe("AWS Lambda MicroVM activation v2", () => {
  it("serializes a strict non-secret activation below 4 KiB", () => {
    const value = createAwsLambdaMicrovmActivationEnvelope({
      activationId: "activation-12345678",
      capability: capability(),
      controllerCaSha256: "a".repeat(64),
      expiresAt: "2030-01-01T00:05:00.000Z",
      issuedAt: "2030-01-01T00:00:00.000Z",
    });
    const serialized = serializeAwsLambdaMicrovmActivationEnvelope(value);

    expect(Buffer.byteLength(serialized)).toBeLessThan(4096);
    expect(serialized).not.toMatch(/password|secret|access_token|credential/i);
    expect(hashAwsLambdaMicrovmCapability(value.capability)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["principal", "provider", "scopes", "credential", "placement", "secret"])(
    "rejects forbidden capability claim %s",
    (claim) => {
      expect(() =>
        createAwsLambdaMicrovmActivationEnvelope({
          capability: capability({ [claim]: "forbidden" }),
          controllerCaSha256: "a".repeat(64),
          expiresAt: "2030-01-01T00:05:00.000Z",
          issuedAt: "2030-01-01T00:00:00.000Z",
        }),
      ).toThrow(/forbidden claim/);
    },
  );

  it("rejects oversized activation payloads", () => {
    const value = createAwsLambdaMicrovmActivationEnvelope({
      capability: capability({ padding: "x".repeat(AWS_LAMBDA_MICROVM_MAX_ACTIVATION_BYTES) }),
      controllerCaSha256: "a".repeat(64),
      expiresAt: "2030-01-01T00:05:00.000Z",
      issuedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(() => serializeAwsLambdaMicrovmActivationEnvelope(value)).toThrow(/smaller than 4 KiB/);
  });

  it("rejects invalid CA digests and inverted validity windows", () => {
    expect(() =>
      createAwsLambdaMicrovmActivationEnvelope({
        capability: capability(),
        controllerCaSha256: "bad",
        expiresAt: "2030-01-01T00:05:00.000Z",
        issuedAt: "2030-01-01T00:00:00.000Z",
      }),
    ).toThrow(/controllerCaSha256/);
    expect(() =>
      createAwsLambdaMicrovmActivationEnvelope({
        capability: capability(),
        controllerCaSha256: "a".repeat(64),
        expiresAt: "2030-01-01T00:00:00.000Z",
        issuedAt: "2030-01-01T00:05:00.000Z",
      }),
    ).toThrow(/expiry/);
  });
});
