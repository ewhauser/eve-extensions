import { metrics, type Meter, type MeterProvider } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { instrumentAwsLambdaMicrovmOperation } from "./telemetry.js";

// Use the real API: mocked getMeter implementations hide permanently cached no-ops.
afterEach(() => metrics.disable());

it("records metrics after a provider is registered following import and first use", async () => {
  metrics.disable();
  await instrumentAwsLambdaMicrovmOperation({ name: "before-sdk" }, async () => undefined);

  const record = vi.fn();
  const add = vi.fn();
  const meter = {
    createHistogram: vi.fn(() => ({ record })),
    createCounter: vi.fn(() => ({ add })),
  } as unknown as Meter;
  const provider: MeterProvider = { getMeter: () => meter };
  expect(metrics.setGlobalMeterProvider(provider)).toBe(true);

  await instrumentAwsLambdaMicrovmOperation({ name: "after-sdk" }, async () => undefined);
  expect(record).toHaveBeenCalledWith(expect.any(Number), {
    "eve.aws_lambda_microvm.operation": "after-sdk",
    "eve.aws_lambda_microvm.outcome": "success",
  });
  expect(add).toHaveBeenCalledWith(1, {
    "eve.aws_lambda_microvm.operation": "after-sdk",
    "eve.aws_lambda_microvm.outcome": "success",
  });
});
