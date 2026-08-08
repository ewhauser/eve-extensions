import type { AwsLambdaMicrovmController } from "./controller-client.js";
import type { AwsLambdaMicrovmCheckpoint } from "./metadata.js";
import type { AwsLambdaMicrovmStorage } from "./storage.js";

export interface PendingAwsLambdaMicrovmCheckpoint {
  readonly checkpoint: AwsLambdaMicrovmCheckpoint;
  commit(): Promise<void>;
  release(): Promise<void>;
}

export async function uploadAwsLambdaMicrovmCheckpoint(input: {
  readonly controller: AwsLambdaMicrovmController;
  readonly generation: number;
  readonly objectKeyPrefix: string;
  readonly storage: AwsLambdaMicrovmStorage;
}): Promise<PendingAwsLambdaMicrovmCheckpoint | null> {
  const preparation = await input.controller.prepareCheckpoint();
  if (!preparation.dirty) return null;

  const checkpointId = expectDefined(preparation.checkpointId, "checkpointId");
  const partCount = expectDefined(preparation.partCount, "partCount");
  const partSha256s = expectDefined(preparation.partSha256s, "partSha256s");
  const sha256 = expectDefined(preparation.sha256, "sha256");
  const size = expectDefined(preparation.size, "size");
  const key = `${input.objectKeyPrefix}/${input.generation}-${sha256}.tar.zst`;
  const uploadId = await input.storage.createMultipartUpload(key);
  let completed = false;
  let completedEtag: string | undefined;

  try {
    const urls = await input.storage.presignUploadParts(key, uploadId, partSha256s);
    const parts = await input.controller.checkpointUpload(checkpointId, urls);
    if (parts.length !== partCount) {
      throw new Error(
        `AWS Lambda MicroVM controller uploaded ${parts.length} checkpoint parts; expected ${partCount}.`,
      );
    }
    const checksummedParts = parts.map((part, index) => {
      if (part.partNumber !== index + 1) {
        throw new Error(
          `AWS Lambda MicroVM controller returned checkpoint part ${part.partNumber} at position ${index + 1}.`,
        );
      }
      return { ...part, sha256: partSha256s[index] as string };
    });
    const result = await input.storage.completeMultipartUpload(
      key,
      uploadId,
      checksummedParts,
      sha256,
    );
    const stored = await input.storage.getObjectInfo(key);
    if (stored === null || stored.size !== size) {
      throw new Error(
        `AWS Lambda MicroVM checkpoint object verification failed for ${key}: expected ${size} bytes.`,
      );
    }
    completedEtag = result.etag ?? stored.etag;
    completed = true;
  } catch (error) {
    if (!completed) {
      await input.storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    }
    await input.controller.checkpointRelease().catch(() => undefined);
    throw error;
  }

  let finalized = false;
  return {
    checkpoint: { etag: completedEtag, generation: input.generation, key, sha256, size },
    async commit() {
      if (finalized) return;
      await input.controller.checkpointCommitted(checkpointId);
      finalized = true;
    },
    async release() {
      if (finalized) return;
      await input.controller.checkpointRelease();
      finalized = true;
    },
  };
}

export async function restoreAwsLambdaMicrovmCheckpoint(input: {
  readonly checkpoint: AwsLambdaMicrovmCheckpoint;
  readonly controller: AwsLambdaMicrovmController;
  readonly storage: AwsLambdaMicrovmStorage;
}): Promise<void> {
  const stored = await input.storage.getObjectInfo(input.checkpoint.key);
  if (
    stored === null ||
    stored.size !== input.checkpoint.size ||
    (input.checkpoint.etag !== undefined && stored.etag !== input.checkpoint.etag)
  ) {
    throw new Error(
      `AWS Lambda MicroVM checkpoint ${input.checkpoint.key} no longer matches its manifest.`,
    );
  }
  await input.controller.restoreCheckpoint({
    sha256: input.checkpoint.sha256,
    size: input.checkpoint.size,
    url: await input.storage.presignGet(input.checkpoint.key),
  });
}

function expectDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`AWS Lambda MicroVM controller omitted ${name} for a dirty checkpoint.`);
  }
  return value;
}
