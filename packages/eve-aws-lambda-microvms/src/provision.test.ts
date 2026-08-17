import { describe, expect, it, vi } from "vitest";

import type { AwsLambdaMicrovmApi, AwsLambdaMicrovmImageVersionRecord } from "./api.js";
import { resolveAwsLambdaMicrovmOptions } from "./options.js";
import { ensureAwsLambdaMicrovmImage, isUnavailableImageVersion } from "./provision.js";
import type { AwsLambdaMicrovmStorage } from "./storage.js";

const IMAGE = {
  imageArn: "arn:aws:lambda:us-east-2:123456789012:microvm-image:eve-test",
  imageVersion: "1.0",
} as const;

describe("AWS Lambda MicroVM image provisioning", () => {
  it("reconciles an immutable identity and verifies it without build authority or writes", async () => {
    const createImage = vi.fn().mockResolvedValue({
      imageArn: IMAGE.imageArn,
      imageVersion: IMAGE.imageVersion,
      state: "PENDING",
    });
    const buildApi = {
      createImage,
      getImageVersion: vi.fn().mockResolvedValue({
        ...IMAGE,
        state: "SUCCESSFUL",
        status: "ACTIVE",
      }),
      listImages: vi.fn().mockResolvedValue([]),
      listManagedImages: vi.fn().mockResolvedValue([
        { imageArn: "arn:aws:lambda:us-east-2::microvm-image:al2023-1" },
      ]),
      listManagedImageVersions: vi.fn().mockResolvedValue([
        {
          imageArn: "arn:aws:lambda:us-east-2::microvm-image:al2023-1",
          imageVersion: "2026.08.1",
        },
      ]),
    } as unknown as AwsLambdaMicrovmApi;
    const putBytes = vi.fn().mockResolvedValue(undefined);
    const buildStorage = {
      hasObject: vi.fn().mockResolvedValue(false),
      putBytes,
    } as unknown as AwsLambdaMicrovmStorage;
    const buildOptions = resolveAwsLambdaMicrovmOptions({
      applicationId: "verified-agent",
      artifactBucket: "sandbox-artifacts",
      buildRoleArn: "arn:aws:iam::123456789012:role/eve-build",
      region: "us-east-2",
    });

    const reconciled = await ensureAwsLambdaMicrovmImage({
      api: buildApi,
      options: buildOptions,
      storage: buildStorage,
    });

    expect(reconciled.verifiedImage).toMatchObject({
      schemaVersion: 1,
      applicationId: "verified-agent",
      artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      baseImage: {
        arn: "arn:aws:lambda:us-east-2::microvm-image:al2023-1",
        version: "2026.08.1",
      },
      configSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      controllerProtocolVersion: 2,
      imageArn: IMAGE.imageArn,
      imageVersion: IMAGE.imageVersion,
      memoryMiB: 2048,
      region: "us-east-2",
    });
    expect(createImage).toHaveBeenCalledTimes(1);
    expect(putBytes).toHaveBeenCalledTimes(1);

    const runtimeCreateImage = vi.fn();
    const runtimeApi = {
      createImage: runtimeCreateImage,
      getImageVersion: vi.fn().mockResolvedValue({
        ...IMAGE,
        state: "SUCCESSFUL",
        status: "ACTIVE",
      }),
    } as unknown as AwsLambdaMicrovmApi;
    const runtimeStorage = {
      hasObject: vi.fn(() => {
        throw new Error("runtime must not inspect image artifacts");
      }),
      putBytes: vi.fn(() => {
        throw new Error("runtime must not upload image artifacts");
      }),
    } as unknown as AwsLambdaMicrovmStorage;
    const runtimeOptions = resolveAwsLambdaMicrovmOptions({
      applicationId: "verified-agent",
      artifactBucket: "sandbox-artifacts",
      region: "us-east-2",
      verifiedImage: reconciled.verifiedImage,
    });

    await expect(
      ensureAwsLambdaMicrovmImage({
        api: runtimeApi,
        options: runtimeOptions,
        storage: runtimeStorage,
      }),
    ).resolves.toMatchObject({
      imageArn: IMAGE.imageArn,
      imageVersion: IMAGE.imageVersion,
    });
    expect(runtimeCreateImage).not.toHaveBeenCalled();
    expect(runtimeStorage.hasObject).not.toHaveBeenCalled();
    expect(runtimeStorage.putBytes).not.toHaveBeenCalled();
  });

  it("rejects a verified identity when runtime configuration changes", async () => {
    const verifiedImage = {
      schemaVersion: 1,
      applicationId: "verified-agent",
      artifactSha256: "a".repeat(64),
      baseImage: { arn: "arn:aws:lambda:us-east-2::microvm-image:al2023-1", version: "1" },
      buildEgressNetworkConnectorArns: [],
      configSha256: "b".repeat(64),
      controllerProtocolVersion: 2,
      imageArn: IMAGE.imageArn,
      imageVersion: IMAGE.imageVersion,
      memoryMiB: 2048,
      region: "us-east-2",
    } as const;
    const options = resolveAwsLambdaMicrovmOptions({
      applicationId: "verified-agent",
      artifactBucket: "sandbox-artifacts",
      maximumDurationSeconds: 3600,
      region: "us-east-2",
      verifiedImage,
    });

    await expect(
      ensureAwsLambdaMicrovmImage({
        api: { getImageVersion: vi.fn() } as unknown as AwsLambdaMicrovmApi,
        options,
        storage: {} as AwsLambdaMicrovmStorage,
      }),
    ).rejects.toThrow(/artifactSha256|configSha256/);
  });

  it("waits while a pending image is inactive", () => {
    expect(
      isUnavailableImageVersion({ ...IMAGE, state: "PENDING", status: "INACTIVE" }),
    ).toBe(false);
  });

  it.each([
    { state: "FAILED", status: "INACTIVE" },
    { state: "DELETING", status: "INACTIVE" },
    { state: "DELETED", status: "INACTIVE" },
    { state: "DELETE_FAILED", status: "INACTIVE" },
    { state: "SUCCESSFUL", status: "INACTIVE" },
  ] satisfies Pick<AwsLambdaMicrovmImageVersionRecord, "state" | "status">[])(
    "rejects an unavailable $state/$status image",
    (image) => {
      expect(isUnavailableImageVersion({ ...IMAGE, ...image })).toBe(true);
    },
  );
});
