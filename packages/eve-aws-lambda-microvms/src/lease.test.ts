import { describe, expect, it } from "vitest";

import { acquireAwsLambdaMicrovmLease } from "./lease.js";
import type { AwsLambdaMicrovmStorage, StoredJson } from "./storage.js";

describe("AWS Lambda MicroVM S3 leases", () => {
  it("serializes holders with conditional writes and deletes", async () => {
    const storage = new MemoryStorage();
    const first = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, waitMs: 0 });

    await expect(
      acquireAwsLambdaMicrovmLease({ key: "lease", storage, waitMs: 0 }),
    ).rejects.toThrow(/held by another runtime/);

    await first.release();
    const second = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, waitMs: 0 });
    await expect(second.ensureHeld()).resolves.toBeUndefined();
    await second.release();
  });

  it("replaces an expired lease using its exact ETag", async () => {
    const storage = new MemoryStorage();
    storage.json.set("lease", {
      etag: '"old"',
      value: { expiresAt: 0, holder: "stale", version: 1 },
    });

    const lease = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, waitMs: 0 });
    await expect(lease.ensureHeld()).resolves.toBeUndefined();
    await lease.release();
    expect(storage.json.has("lease")).toBe(false);
  });
});

class MemoryStorage implements AwsLambdaMicrovmStorage {
  readonly json = new Map<string, StoredJson<unknown>>();
  #etag = 0;

  async abortMultipartUpload(): Promise<void> {}
  async assertBucketRegion(): Promise<void> {}
  async completeMultipartUpload(): Promise<{ readonly etag?: string }> {
    return {};
  }
  async createMultipartUpload(): Promise<string> {
    return "upload";
  }
  async deleteObject(key: string, condition: { readonly etag?: string } = {}): Promise<void> {
    const current = this.json.get(key);
    if (condition.etag !== undefined && current?.etag !== condition.etag) {
      throw preconditionError();
    }
    this.json.delete(key);
  }
  destroy(): void {}
  async getJson<T>(key: string): Promise<StoredJson<T> | null> {
    return (this.json.get(key) as StoredJson<T> | undefined) ?? null;
  }
  async hasObject(): Promise<boolean> {
    return false;
  }
  async getObjectInfo(): Promise<null> {
    return null;
  }
  async presignGet(): Promise<string> {
    return "https://example.test/get";
  }
  async presignUploadParts(): Promise<readonly string[]> {
    return [];
  }
  async putBytes(): Promise<void> {}
  async putJson(
    key: string,
    value: unknown,
    condition: { readonly absent?: boolean; readonly etag?: string } = {},
  ): Promise<{ readonly etag: string }> {
    const current = this.json.get(key);
    if (
      (condition.absent === true && current !== undefined) ||
      (condition.etag !== undefined && current?.etag !== condition.etag)
    ) {
      throw preconditionError();
    }
    const etag = `"${++this.#etag}"`;
    this.json.set(key, { etag, value });
    return { etag };
  }
}

function preconditionError(): Error {
  return Object.assign(new Error("precondition failed"), {
    $metadata: { httpStatusCode: 412 },
    name: "PreconditionFailed",
  });
}
