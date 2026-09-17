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

import {
  instrumentAwsLambdaMicrovmOperation,
  recordAwsSdkMetadata,
} from "./telemetry.js";

describe("AWS Lambda MicroVM telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(otel.span.recordException).toHaveBeenCalledWith(error);
    expect(otel.span.setStatus).toHaveBeenCalledWith({ code: 2 });
    expect(otel.span.end).toHaveBeenCalledOnce();
    expect(otel.counter.add).toHaveBeenCalledWith(1, {
      "eve.aws_lambda_microvm.operation": "aws.lambda_microvms.run_microvm",
      "eve.aws_lambda_microvm.outcome": "error",
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
