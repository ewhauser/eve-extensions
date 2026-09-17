import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireAwsLambdaMicrovmLease } from "./lease.js";
import type { AwsLambdaMicrovmStorage, StoredJson } from "./storage.js";

describe("AWS Lambda MicroVM S3 leases", () => {
  afterEach(() => vi.useRealTimers());

  it("caps persisted expiry and stops renewal at the absolute launch deadline", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const deadlineAt = Date.now() + 2500;
    const lease = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, ttlMs: 3000, deadlineAt });
    await vi.advanceTimersByTimeAsync(2000);
    expect(storage.json.get("lease")?.value).toMatchObject({ expiresAt: deadlineAt });
    const etag = storage.json.get("lease")?.etag;
    await vi.advanceTimersByTimeAsync(10000);
    expect(lease.signal.aborted).toBe(true);
    expect(storage.json.get("lease")?.etag).toBe(etag);
    await expect(lease.ensureHeld()).rejects.toThrow(/deadline|expired/);
    await expect(lease.promote()).rejects.toThrow(/deadline|expired/);
  });

  it("cannot resurrect expired authority when timers have not run", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const lease = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, ttlMs: 3000 });
    vi.setSystemTime(Date.now() + 3001);
    await expect(lease.ensureHeld()).rejects.toThrow(/expired/);
    await lease.release().catch(() => undefined);
  });

  it("promotes a confirmed launch to renewable session authority", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const lease = await acquireAwsLambdaMicrovmLease({
      key: "lease", storage, ttlMs: 3000, deadlineAt: Date.now() + 2500,
    });
    await lease.promote();
    await vi.advanceTimersByTimeAsync(20000);
    await expect(lease.ensureHeld()).resolves.toBeUndefined();
    expect(lease.signal.aborted).toBe(false);
    await lease.release();
  });

  it("atomically fences state updates against a successor and retains generations on release", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const first = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, durable: true, ttlMs: 3000 });
    await first.updateState({ checkpoint: "old" });
    vi.setSystemTime(Date.now() + 3001);
    const second = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, durable: true });
    expect(second.generation).toBe(first.generation + 1);
    expect(second.state).toEqual({ checkpoint: "old" });
    await second.updateState({ checkpoint: "new" });
    await expect(first.updateState({ checkpoint: "stale" })).rejects.toThrow();
    await first.release().catch(() => undefined);
    expect(storage.json.get("lease")?.value).toMatchObject({ state: { checkpoint: "new" } });
    await second.release();
    const third = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, durable: true });
    expect(third.generation).toBe(second.generation + 1);
    expect(third.state).toEqual({ checkpoint: "new" });
    await third.release();
  });

  it("does not extend persisted launch authority when a renewal stalls across its deadline", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const deadlineAt = Date.now() + 2500;
    const lease = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, ttlMs: 3000, deadlineAt });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const original = storage.putJson.bind(storage);
    vi.spyOn(storage, "putJson").mockImplementation(async (...args) => {
      await gate;
      return await original(...args);
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(lease.signal.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.json.get("lease")?.value).toMatchObject({ expiresAt: deadlineAt });
    await expect(lease.ensureHeld()).rejects.toThrow(/deadline|expired/);
  });

  it("rejects an old ETag even when the stale holder's local expiry has not elapsed", async () => {
    const storage = new MemoryStorage();
    const lease = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, durable: true });
    const current = storage.json.get("lease")!;
    storage.json.set("lease", { etag: "successor", value: { ...(current.value as object), state: { checkpoint: "successor" } } });
    await expect(lease.updateState({ checkpoint: "stale" })).rejects.toThrow(/precondition/);
    expect(lease.signal.aborted).toBe(true);
    await lease.release().catch(() => undefined);
    expect(storage.json.get("lease")?.etag).toBe("successor");
  });

  it("fails closed when a non-durable lease tries to acquire a fencing-aware session", async () => {
    const storage = new MemoryStorage();
    const lease = await acquireAwsLambdaMicrovmLease({ key: "lease", storage, durable: true });
    await lease.release();
    expect(storage.json.get("lease")?.value).toMatchObject({ version: 2 });
    await expect(acquireAwsLambdaMicrovmLease({ key: "lease", storage })).rejects.toThrow(/fencing-aware/);
  });

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
