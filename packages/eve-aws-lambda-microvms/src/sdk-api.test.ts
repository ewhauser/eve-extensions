import { describe, expect, it, vi } from "vitest";

import { LambdaMicrovmsClient, RunMicrovmCommand } from "@aws-sdk/client-lambda-microvms";

import { SdkAwsLambdaMicrovmApi, microvmFromOutput } from "./sdk-api.js";

describe("AWS Lambda MicroVM SDK response mapping", () => {
  it("retains all egress connectors returned by RunMicrovm/GetMicrovm", () => {
    expect(
      microvmFromOutput({
        egressNetworkConnectors: [
          "arn:aws:lambda:us-east-1:123456789012:network-connector:one",
          "arn:aws:lambda:us-east-1:123456789012:network-connector:two",
        ],
        endpoint: "mvm.example.test",
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:test",
        imageVersion: "1",
        microvmId: "mvm-test",
        state: "RUNNING",
      }).egressNetworkConnectorArns,
    ).toEqual([
      "arn:aws:lambda:us-east-1:123456789012:network-connector:one",
      "arn:aws:lambda:us-east-1:123456789012:network-connector:two",
    ]);
  });

  it("maps an omitted legacy connector list to empty for compatibility", () => {
    expect(
      microvmFromOutput({
        endpoint: "mvm.example.test",
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:test",
        imageVersion: "1",
        microvmId: "mvm-test",
        state: "RUNNING",
      }).egressNetworkConnectorArns,
    ).toEqual([]);
  });
});


describe("RunMicrovm SDK request contract", () => {
  const request = {
    clientToken: "stable-launch-token",
    egressNetworkConnectorArns: ["egress"],
    idlePolicy: { autoResumeEnabled: false, maxIdleDurationSeconds: 300, suspendedDurationSeconds: 1 },
    imageArn: "image",
    imageVersion: "1",
    ingressNetworkConnectorArns: ["ingress"],
    logging: { disabled: true } as const,
    maximumDurationSeconds: 600,
    runHookPayload: "private-activation",
  };

  it("passes the exact abort signal and token to the AWS transport and emits only safe metadata", async () => {
    const output = {
      endpoint: "mvm.example.test", imageArn: "image", imageVersion: "1", microvmId: "mvm-1", state: "RUNNING",
      $metadata: { requestId: "request-1", attempts: 2, totalRetryDelay: 42, secret: "do-not-log" },
    };
    const send = vi.fn().mockResolvedValue(output);
    const api = new SdkAwsLambdaMicrovmApi("us-east-1", { send } as unknown as LambdaMicrovmsClient);
    const abort = new AbortController();
    const onRequestMetadata = vi.fn();
    await expect(api.runMicrovm({ ...request, abortSignal: abort.signal, onRequestMetadata })).resolves.toMatchObject({ microvmId: "mvm-1" });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(RunMicrovmCommand);
    expect(send.mock.calls[0]![0].input).toMatchObject({ clientToken: request.clientToken, runHookPayload: request.runHookPayload });
    expect(send.mock.calls[0]![1]).toEqual({ abortSignal: abort.signal });
    expect(onRequestMetadata).toHaveBeenCalledExactlyOnceWith({ requestId: "request-1", attempts: 2, totalRetryDelay: 42 });
  });

  it("retains request metadata on SDK failure without logging its error body", async () => {
    const error = Object.assign(new Error("secret-credential"), {
      $metadata: { requestId: "request-failed", attempts: 4, totalRetryDelay: 100 },
      request: request,
    });
    const send = vi.fn().mockRejectedValue(error);
    const api = new SdkAwsLambdaMicrovmApi("us-east-1", { send } as unknown as LambdaMicrovmsClient);
    const onRequestMetadata = vi.fn();
    await expect(api.runMicrovm({ ...request, onRequestMetadata })).rejects.toBe(error);
    expect(onRequestMetadata).toHaveBeenCalledExactlyOnceWith({ requestId: "request-failed", attempts: 4, totalRetryDelay: 100 });
    expect(JSON.stringify(onRequestMetadata.mock.calls)).not.toMatch(/secret|private-activation/);
  });

  it("handles cancellation without SDK response metadata", async () => {
    const abort = new AbortController();
    const send = vi.fn((_command, options) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const api = new SdkAwsLambdaMicrovmApi("us-east-1", { send } as unknown as LambdaMicrovmsClient);
    const onRequestMetadata = vi.fn();
    const pending = api.runMicrovm({ ...request, abortSignal: abort.signal, onRequestMetadata });
    const rejected = expect(pending).rejects.toThrow("aborted");
    abort.abort();
    await rejected;
    expect(onRequestMetadata).toHaveBeenCalledExactlyOnceWith({});
  });
});
