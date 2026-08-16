import {
  CreateMultipartUploadCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { SdkAwsLambdaMicrovmStorage } from "./storage.js";

const KMS_KEY_ARN =
  "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";

describe("SdkAwsLambdaMicrovmStorage encryption", () => {
  it("adds explicit SSE-KMS headers to every write initializer when configured", async () => {
    const { client, commands } = recordingClient();
    const storage = new SdkAwsLambdaMicrovmStorage(
      { bucket: "artifacts", kmsKeyId: KMS_KEY_ARN, region: "us-east-1" },
      client,
    );

    await storage.putJson("lease.json", { owner: "test" });
    await storage.putBytes("image.zip", new Uint8Array([1, 2, 3]));
    await storage.createMultipartUpload("checkpoint.zst");

    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command.input).toMatchObject({
        SSEKMSKeyId: KMS_KEY_ARN,
        ServerSideEncryption: "aws:kms",
      });
    }
  });

  it("preserves existing S3 requests when artifactKmsKeyId is omitted", async () => {
    const { client, commands } = recordingClient();
    const storage = new SdkAwsLambdaMicrovmStorage(
      { bucket: "artifacts", region: "us-east-1" },
      client,
    );

    await storage.putJson("lease.json", { owner: "test" });
    await storage.putBytes("image.zip", new Uint8Array([1, 2, 3]));
    await storage.createMultipartUpload("checkpoint.zst");

    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command.input).not.toHaveProperty("SSEKMSKeyId");
      expect(command.input).not.toHaveProperty("ServerSideEncryption");
    }
  });
});

function recordingClient(): {
  readonly client: S3Client;
  readonly commands: Array<CreateMultipartUploadCommand | PutObjectCommand>;
} {
  const commands: Array<CreateMultipartUploadCommand | PutObjectCommand> = [];
  const send = vi.fn(async (command: CreateMultipartUploadCommand | PutObjectCommand) => {
    commands.push(command);
    return command instanceof CreateMultipartUploadCommand
      ? { UploadId: "upload-id" }
      : { ETag: '\"etag\"' };
  });
  return {
    client: { destroy: vi.fn(), send } as unknown as S3Client,
    commands,
  };
}
