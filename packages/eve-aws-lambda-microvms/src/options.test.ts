import { describe, expect, it } from "vitest";

import { resolveAwsLambdaMicrovmOptions } from "./options.js";

const REQUIRED = {
  applicationId: "analytics-agent",
  artifactBucket: "company-sandboxes",
  buildRoleArn: "arn:aws:iam::123456789012:role/eve-build",
  region: "us-east-1",
} as const;

describe("resolveAwsLambdaMicrovmOptions", () => {
  it("applies secure lifecycle and connector defaults", () => {
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
      runtimeLogging: false,
      shellIngressNetworkConnectorArn: undefined,
    });
    expect(resolved.httpIngressNetworkConnectorArn).toContain(":ALL_INGRESS");
    expect(resolved.runtimeEgressNetworkConnectorArns).toEqual([
      expect.stringContaining(":INTERNET_EGRESS"),
    ]);
  });

  it("enables CloudWatch by default when an execution role is supplied", () => {
    expect(
      resolveAwsLambdaMicrovmOptions({
        ...REQUIRED,
        executionRoleArn: "arn:aws:iam::123456789012:role/eve-runtime",
      }).runtimeLogging,
    ).toEqual({ logGroup: expect.stringMatching(/^\/aws\/lambda-microvms\/eve-/) });
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
