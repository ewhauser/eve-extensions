import { beforeEach, describe, expect, it, vi } from "vitest";

const otel = vi.hoisted(() => ({
  counter: { add: vi.fn() },
  histogram: { record: vi.fn() },
  span: {
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    end: vi.fn(),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    spanContext: vi.fn(() => ({
      spanId: "0000000000000000",
      traceFlags: 1,
      traceId: "00000000000000000000000000000000",
    })),
    updateName: vi.fn(),
  },
}));

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => otel.counter,
      createHistogram: () => otel.histogram,
    }),
  },
  SpanStatusCode: { ERROR: 2, OK: 1 },
  trace: {
    getTracer: () => ({
      startActiveSpan: async (
        _name: string,
        _options: unknown,
        callback: (span: typeof otel.span) => Promise<unknown>,
      ) => await callback(otel.span),
    }),
  },
}));

import type { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import { SdkAwsLambdaMicrovmApi } from "./sdk-api.js";

import { restoreAwsLambdaMicrovmCheckpoint } from "./checkpoint.js";
import type { AwsLambdaMicrovmStorage } from "./storage.js";
import type { AwsLambdaMicrovmController } from "./controller-client.js";

import {
  instrumentAwsLambdaMicrovmOperation,
  recordAwsSdkMetadata,
} from "./telemetry.js";

describe("AWS Lambda MicroVM telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves SDK spans and callbacks while forwarding the launch abort signal", async () => {
    const startedAt = new Date("2026-09-17T00:00:00Z");
    const send = vi.fn().mockResolvedValue({
      endpoint: "mvm.example.test", imageArn: "image", imageVersion: "1",
      microvmId: "mvm-1", state: "RUNNING", startedAt,
      $metadata: { requestId: "request-1", attempts: 2, totalRetryDelay: 42 },
    });
    const api = new SdkAwsLambdaMicrovmApi("us-east-1", { send } as unknown as LambdaMicrovmsClient);
    const abortSignal = new AbortController().signal;
    const onRequestMetadata = vi.fn();
    await api.runMicrovm({
      abortSignal, onRequestMetadata, clientToken: "stable-token",
      egressNetworkConnectorArns: [], ingressNetworkConnectorArns: [],
      imageArn: "image", imageVersion: "1", maximumDurationSeconds: 600,
      idlePolicy: { autoResumeEnabled: false, maxIdleDurationSeconds: 300, suspendedDurationSeconds: 1 },
      logging: { disabled: true }, runHookPayload: "private-activation",
    });
    expect(send.mock.calls[0]![1]).toEqual({ abortSignal });
    expect(onRequestMetadata).toHaveBeenCalledExactlyOnceWith({ requestId: "request-1", attempts: 2, totalRetryDelay: 42 });
    expect(otel.span.setAttribute).toHaveBeenCalledWith("aws.request_id", "request-1");
    expect(otel.span.setAttribute).toHaveBeenCalledWith("aws.sdk.attempts", 2);
    expect(otel.span.addEvent).toHaveBeenCalledWith("microvm.started", {}, startedAt);
    expect(otel.span.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(otel.span.setAttribute.mock.calls)).not.toContain("private-activation");
  });

  it("records successful operations with bounded metric attributes", async () => {
    await expect(
      instrumentAwsLambdaMicrovmOperation(
        {
          attributes: { "eve.aws_lambda_microvm.microvm_id": "microvm-sensitive" },
          metricAttributes: { "cloud.region": "us-west-2" },
          name: "aws.lambda_microvms.run_microvm",
        },
        async () => "ok",
      ),
    ).resolves.toBe("ok");

    expect(otel.span.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(otel.span.end).toHaveBeenCalledOnce();
    expect(otel.histogram.record).toHaveBeenCalledWith(
      expect.any(Number),
      {
        "cloud.region": "us-west-2",
        "eve.aws_lambda_microvm.operation": "aws.lambda_microvms.run_microvm",
        "eve.aws_lambda_microvm.outcome": "success",
      },
    );
    expect(otel.counter.add).toHaveBeenCalledWith(1, {
      "cloud.region": "us-west-2",
      "eve.aws_lambda_microvm.operation": "aws.lambda_microvms.run_microvm",
      "eve.aws_lambda_microvm.outcome": "success",
    });
  });

  it("records and rethrows failed operations", async () => {
    const error = new Error("launch failed");

    await expect(
      instrumentAwsLambdaMicrovmOperation(
        { name: "aws.lambda_microvms.run_microvm" },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);

    expect(otel.span.recordException).toHaveBeenCalledWith({
      name: "Error",
      message: "AWS Lambda MicroVM operation failed.",
    });
    expect(otel.span.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(otel.span.end).toHaveBeenCalledOnce();
    expect(otel.counter.add).toHaveBeenCalledWith(1, {
      "eve.aws_lambda_microvm.operation": "aws.lambda_microvms.run_microvm",
      "eve.aws_lambda_microvm.outcome": "error",
    });
  });

  it("does not export checkpoint keys from restore failures", async () => {
    await expect(restoreAwsLambdaMicrovmCheckpoint({
      checkpoint: {
        key: "private/checkpoint-key",
        generation: 1,
        size: 10,
        sha256: "a".repeat(64),
      },
      storage: { getObjectInfo: async () => null } as unknown as AwsLambdaMicrovmStorage,
      controller: {} as AwsLambdaMicrovmController,
    })).rejects.toThrow("private/checkpoint-key");

    expect(otel.span.recordException).toHaveBeenCalledWith({
      name: "Error",
      message: "AWS Lambda MicroVM operation failed.",
    });
    expect(JSON.stringify(otel.span.recordException.mock.calls)).not.toContain("private/checkpoint-key");
  });

  it.each([
    Object.assign(new Error("secret-message", { cause: new Error("secret-cause") }), {
      name: "secret-name",
      stack: "secret-stack",
    }),
    "secret-string",
    { toString() { throw new Error("must not stringify thrown objects"); } },
  ])("redacts arbitrary failures and preserves the original rejection (%#)", async (error) => {
    await expect(instrumentAwsLambdaMicrovmOperation(
      { name: "eve.aws_lambda_microvm.template.prewarm" },
      async () => { throw error; },
    )).rejects.toBe(error);
    expect(otel.span.recordException).toHaveBeenCalledWith({
      name: "Error",
      message: "AWS Lambda MicroVM operation failed.",
    });
  });

  it("records AWS request and retry metadata without request inputs", () => {
    recordAwsSdkMetadata(otel.span, {
      $metadata: {
        attempts: 3,
        httpStatusCode: 200,
        requestId: "request-123",
        totalRetryDelay: 1_250,
      },
      authToken: "must-not-be-recorded",
    });

    expect(otel.span.setAttribute.mock.calls).toEqual([
      ["aws.request_id", "request-123"],
      ["aws.sdk.attempts", 3],
      ["aws.sdk.total_retry_delay_ms", 1_250],
      ["http.response.status_code", 200],
    ]);
  });
});
