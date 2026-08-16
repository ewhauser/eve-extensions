import { describe, expect, it } from "vitest";

import { resolveAwsLambdaMicrovmOptions } from "./options.js";

const REQUIRED = {
  applicationId: "analytics-agent",
  artifactBucket: "company-sandboxes",
  buildRoleArn: "arn:aws:iam::123456789012:role/eve-build",
  region: "us-east-1",
} as const;
const BUILD_CONNECTOR =
  "arn:aws:lambda:us-east-1:123456789012:network-connector:build-egress";
const RUNTIME_CONNECTOR =
  "arn:aws:lambda:us-east-1:123456789012:network-connector:runtime-egress";
const PUBLIC_TEST_CA = `-----BEGIN CERTIFICATE-----
MIICwjCCAaoCCQCw/VQlcDz3ETANBgkqhkiG9w0BAQsFADAjMSEwHwYDVQQDDBhl
dmUtZWdyZXNzLXByb3h5LXRlc3QtY2EwHhcNMjYwODE2MDIyNjU1WhcNMjYwODE3
MDIyNjU1WjAjMSEwHwYDVQQDDBhldmUtZWdyZXNzLXByb3h5LXRlc3QtY2EwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDH54ZSUg+WtgJgZjc2J31thXm6
+TDaJbwbCifCWrlIVaCmX9tccLuZnYVw0w/R/x8EE4l64hGQjQWDbDS3xcg4kfC1
66rVz7hDa80DmlHSLlARtNLQmQ689/UPLjbjp0pXeKWYe1r7KieWjawIzPliKGZ0
FfHNJ3YrvuCo4z1NIM+EfxOS31OfJ/+GOGzKSKDr+V/TQdLM1h8pIinZ7FifM92c
E3xAg0qKPyDKqUI1dlWqLFDPb0EnBnK+yLw7/McFlrEAbYXXoy9NA/PnEmhUW+We
TjVU/Vp2ZCjswZhIUC4VCOST9p1bNO2p10uLsK1XTpxkqynSuz0fI25/L/qtAgMB
AAEwDQYJKoZIhvcNAQELBQADggEBALQGo9CVTIPk07qLs2X0CAsw10rdyrGIxO+v
pc4n/JkxMbVCyV8wmFve7FYN97HLhJ9swKKHdh6m31+TXRq//ENxIHZD0X2SjeKv
ZS1JPcafAkeSBtGFZL7VZhBacvERuHrXK7iJd17vgznby0PH8DqUiGbbooIceBxd
GMiISlsOMCvnG7TqtrGWbGl84Wr57IQsEpvLphCTGISNT9ebHodjq2XwTiah1Ke1
vXE4cllUUkfTZrB8cfG0qIYWBG32sz3IkoOdZJa8jtKNsjhCwsX+/mi5PuUIENDk
cvKZSIRd5mmzmvNtQgWJanxamFuq2VD4N3Syvyplb/BiY46nN04=
-----END CERTIFICATE-----`;

describe("resolveAwsLambdaMicrovmOptions", () => {
  it("preserves 0.1.0 lifecycle and connector defaults in legacy mode", () => {
    const resolved = resolveAwsLambdaMicrovmOptions(REQUIRED);

    expect(resolved).toMatchObject({
      artifactPrefix: expect.stringMatching(/^eve\/lambda-microvms\/[a-f0-9]{20}$/),
      executionRoleArn: undefined,
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 1800,
      },
      maximumDurationSeconds: 28_800,
      memoryMiB: 2048,
      networkingMode: "legacy",
      runtimeLogging: false,
      shellIngressNetworkConnectorArn: undefined,
    });
    expect(resolved.httpIngressNetworkConnectorArn).toContain(":ALL_INGRESS");
    expect(resolved.runtimeEgressNetworkConnectorArns).toEqual([
      expect.stringContaining(":INTERNET_EGRESS"),
    ]);
  });

  it("requires explicit singleton customer-managed connectors and lane ids", () => {
    const resolved = resolveAwsLambdaMicrovmOptions({
      ...REQUIRED,
      buildEgressNetworkConnectorArns: [BUILD_CONNECTOR],
      buildNetworkLaneId: "build-reviewed",
      networkingMode: "customer-managed",
      runtimeEgressNetworkConnectorArns: [RUNTIME_CONNECTOR],
      runtimeNetworkLaneId: "runtime-reviewed",
    });

    expect(resolved).toMatchObject({
      buildEgressNetworkConnectorArns: [BUILD_CONNECTOR],
      buildNetworkLaneId: "build-reviewed",
      networkingMode: "customer-managed",
      runtimeEgressNetworkConnectorArns: [RUNTIME_CONNECTOR],
      runtimeNetworkLaneId: "runtime-reviewed",
    });
  });

  it.each([
    [{ buildEgressNetworkConnectorArns: undefined }, /exactly one/],
    [{ buildEgressNetworkConnectorArns: [] }, /exactly one/],
    [{ buildEgressNetworkConnectorArns: [" "] }, /non-empty/],
    [
      { buildEgressNetworkConnectorArns: [BUILD_CONNECTOR, BUILD_CONNECTOR] },
      /exactly one/,
    ],
    [
      {
        buildEgressNetworkConnectorArns: [
          "arn:aws:lambda:us-west-2:123456789012:network-connector:build-egress",
        ],
      },
      /configured for us-east-1/,
    ],
    [
      {
        buildEgressNetworkConnectorArns: [
          "arn:aws:lambda:us-east-1:999999999999:network-connector:build-egress",
        ],
      },
      /buildRoleArn belongs to 123456789012/,
    ],
    [
      {
        buildEgressNetworkConnectorArns: [
          "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
        ],
      },
      /customer-managed/,
    ],
  ] as const)("rejects unsafe strict build connector configuration %#", (override, error) => {
    expect(() =>
      resolveAwsLambdaMicrovmOptions(
        Object.assign(
          {
            ...REQUIRED,
            buildEgressNetworkConnectorArns: [BUILD_CONNECTOR],
            buildNetworkLaneId: "build-reviewed",
            networkingMode: "customer-managed" as const,
            runtimeEgressNetworkConnectorArns: [RUNTIME_CONNECTOR],
            runtimeNetworkLaneId: "runtime-reviewed",
          },
          override,
        ),
      ),
    ).toThrow(error);
  });

  it.each([
    [{ runtimeEgressNetworkConnectorArns: [] }, /exactly one/],
    [{ runtimeNetworkLaneId: undefined }, /runtimeNetworkLaneId/],
    [{ buildNetworkLaneId: undefined }, /buildNetworkLaneId/],
  ] as const)("rejects incomplete strict runtime/lane configuration %#", (override, error) => {
    expect(() =>
      resolveAwsLambdaMicrovmOptions(
        Object.assign(
          {
            ...REQUIRED,
            buildEgressNetworkConnectorArns: [BUILD_CONNECTOR],
            buildNetworkLaneId: "build-reviewed",
            networkingMode: "customer-managed" as const,
            runtimeEgressNetworkConnectorArns: [RUNTIME_CONNECTOR],
            runtimeNetworkLaneId: "runtime-reviewed",
          },
          override,
        ),
      ),
    ).toThrow(error);
  });

  it("enables CloudWatch by default when an execution role is supplied", () => {
    expect(
      resolveAwsLambdaMicrovmOptions({
        ...REQUIRED,
        executionRoleArn: "arn:aws:iam::123456789012:role/eve-runtime",
      }).runtimeLogging,
    ).toEqual({ logGroup: expect.stringMatching(/^\/aws\/lambda-microvms\/eve-/) });
  });

  it("normalizes a public egress proxy CA bundle and derives its image identity", () => {
    const resolved = resolveAwsLambdaMicrovmOptions({
      ...REQUIRED,
      egressProxyCaBundlePem: `\n${PUBLIC_TEST_CA}\n`,
    });

    expect(resolved.egressProxyCaBundlePem).toBe(`${PUBLIC_TEST_CA}\n`);
    expect(resolved.egressProxyCaSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["private key", "-----BEGIN PRIVATE KEY-----\nforbidden\n-----END PRIVATE KEY-----"],
    ["mixed bundle", `${PUBLIC_TEST_CA}\n-----BEGIN PRIVATE KEY-----\nforbidden\n-----END PRIVATE KEY-----`],
    ["invalid certificate", "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"],
  ])("rejects %s in the public egress trust bundle", (_name, bundle) => {
    expect(() =>
      resolveAwsLambdaMicrovmOptions({ ...REQUIRED, egressProxyCaBundlePem: bundle }),
    ).toThrow(/CERTIFICATE PEM blocks|invalid certificate/);
  });

  it("preserves explicit empty egress and enables shell ingress", () => {
    const resolved = resolveAwsLambdaMicrovmOptions({
      ...REQUIRED,
      buildEgressNetworkConnectorArns: [],
      runtimeEgressNetworkConnectorArns: [],
      shellAccess: true,
    });

    expect(resolved.buildEgressNetworkConnectorArns).toEqual([]);
    expect(resolved.runtimeEgressNetworkConnectorArns).toEqual([]);
    expect(resolved.shellIngressNetworkConnectorArn).toContain(":SHELL_INGRESS");
  });

  it("rejects unsupported memory and duration values", () => {
    expect(() => resolveAwsLambdaMicrovmOptions({ ...REQUIRED, memoryMiB: 768 as never })).toThrow(
      /memoryMiB/,
    );
    expect(() =>
      resolveAwsLambdaMicrovmOptions({ ...REQUIRED, maximumDurationSeconds: 28_801 }),
    ).toThrow(/maximumDurationSeconds/);
  });

  it("validates custom base images and reserved tags", () => {
    expect(() =>
      resolveAwsLambdaMicrovmOptions({
        ...REQUIRED,
        baseImage: { arn: " ", version: "1" },
      }),
    ).toThrow(/baseImage\.arn/);
    expect(() =>
      resolveAwsLambdaMicrovmOptions({
        ...REQUIRED,
        tags: { "eve:session": "raw-session-id" },
      }),
    ).toThrow(/reserved prefix/);
  });
});
