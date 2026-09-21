import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { AwsLambdaMicrovmStorage } from "./storage.js";
import { instrumentAwsLambdaMicrovmOperation } from "./telemetry.js";

interface LeaseDocument {
  readonly expiresAt: number;
  readonly holder: string;
  readonly generation: number;
  readonly state?: unknown;
  readonly version: 1 | 2;
}

export interface AwsLambdaMicrovmLease {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly state: unknown;
  ensureHeld(): Promise<void>;
  /** Synchronous handoff after the final bounded ownership check; starts renewal next turn. */
  promote(): void;
  /** Publish state with the SAME conditional write used for ownership. */
  updateState(state: unknown): Promise<void>;
  release(): Promise<void>;
}

export async function acquireAwsLambdaMicrovmLease(input: {
  readonly key: string;
  readonly storage: AwsLambdaMicrovmStorage;
  readonly ttlMs?: number;
  readonly waitMs?: number;
  readonly deadlineAt?: number;
  readonly abortSignal?: AbortSignal;
  /** Retain a tombstone so generations and committed state survive release. */
  readonly durable?: boolean;
}): Promise<AwsLambdaMicrovmLease> {
  const holder = randomUUID();
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000;
  let deadlineAt = input.deadlineAt ?? Infinity;
  const waitDeadline = Date.now() + (input.waitMs ?? 30_000);
  const abort = new AbortController();
  const signal = input.abortSignal === undefined
    ? abort.signal
    : AbortSignal.any([abort.signal, input.abortSignal]);

  function checkDeadline(): void {
    if (Date.now() >= deadlineAt) abort.abort(new Error("AWS Lambda MicroVM launch deadline exceeded."));
    signal.throwIfAborted();
  }

  const acquisition = await instrumentAwsLambdaMicrovmOperation(
    {
      attributes: {
        "eve.aws_lambda_microvm.lease.ttl_ms": ttlMs,
        "eve.aws_lambda_microvm.lease.wait_ms": input.waitMs ?? 30_000,
      },
      name: "eve.aws_lambda_microvm.lease.acquire",
    },
    async (span) => {
      let attempts = 0;
      let contended = false;
      for (;;) {
        attempts++;
        checkDeadline();
        const current = await input.storage.getJson<unknown>(input.key);
        checkDeadline();
        const previous = current === null ? undefined : parseLease(current.value);
        if (previous?.version === 2 && !input.durable) {
          throw new Error("Durable AWS Lambda MicroVM authority requires a fencing-aware runtime.");
        }
        const now = Date.now();
        try {
          if (previous === undefined || previous.expiresAt <= now) {
            const document: LeaseDocument = {
              expiresAt: Math.min(now + ttlMs, deadlineAt),
              generation: (previous?.generation ?? 0) + 1,
              holder,
              state: previous?.state,
              version: input.durable ? 2 : 1,
            };
            const etag = (await input.storage.putJson(input.key, document, {
              absent: current === null,
              etag: current?.etag,
            })).etag;
            span.setAttributes({
              "eve.aws_lambda_microvm.lease.attempts": attempts,
              "eve.aws_lambda_microvm.lease.contended": contended || (previous !== undefined && previous.expiresAt > 0),
            });
            return { etag, document };
          }
          contended = true;
          if (now >= waitDeadline) {
            throw new Error(`AWS Lambda MicroVM lease ${input.key} is held by another runtime.`);
          }
        } catch (error) {
          if (!isPreconditionFailed(error)) throw error;
          contended = true;
          if (Date.now() >= waitDeadline) {
            throw new Error(`Timed out acquiring AWS Lambda MicroVM lease ${input.key}.`, { cause: error });
          }
        }
        await sleep(250 + Math.floor(Math.random() * 251), undefined, { signal });
      }
    },
  );
  let { etag, document } = acquisition;

  let released = false;
  let releasePromise: Promise<void> | undefined;
  let operations = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let promotionTimer: ReturnType<typeof setTimeout> | undefined;
  function fail(error: unknown): never {
    clearInterval(renewalTimer);
    clearTimeout(expiryTimer);
    clearTimeout(promotionTimer);
    abort.abort(error);
    throw error;
  }
  function check(): void {
    checkDeadline();
    if (released) throw new Error(`AWS Lambda MicroVM lease ${input.key} was released.`);
    if (Date.now() >= document.expiresAt) fail(new Error("AWS Lambda MicroVM lease expired."));
  }
  function armExpiry(): void {
    clearTimeout(expiryTimer);
    clearTimeout(promotionTimer);
    expiryTimer = setTimeout(() => {
      clearInterval(renewalTimer);
      abort.abort(new Error(Date.now() >= deadlineAt
        ? "AWS Lambda MicroVM launch deadline exceeded."
        : "AWS Lambda MicroVM lease expired."));
    }, Math.max(0, document.expiresAt - Date.now()));
    expiryTimer.unref?.();
  }
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operations.then(operation);
    operations = pending.then(() => undefined, () => undefined);
    return pending;
  }
  async function write(state: unknown): Promise<void> {
    check();
    const next: LeaseDocument = {
      ...document,
      expiresAt: Math.min(Date.now() + ttlMs, deadlineAt),
      state,
    };
    try {
      etag = await instrumentAwsLambdaMicrovmOperation(
        { name: "eve.aws_lambda_microvm.lease.renew" },
        async () => (await input.storage.putJson(input.key, next, { etag })).etag,
      );
      // Do not resurrect authority if the request outlived the previous expiry.
      const previousExpiry = document.expiresAt;
      document = next;
      if (Date.now() >= previousExpiry) fail(new Error("AWS Lambda MicroVM lease expired."));
      check();
      armExpiry();
    } catch (error) {
      fail(error);
    }
  }
  const renewalTimer = setInterval(() => {
    void enqueue(() => write(document.state)).catch(() => undefined);
  }, Math.max(1, Math.floor(ttlMs / 3)));
  renewalTimer.unref?.();
  signal.addEventListener("abort", () => {
    clearInterval(renewalTimer);
    clearTimeout(expiryTimer);
    clearTimeout(promotionTimer);
  }, { once: true });
  armExpiry();

  return {
    generation: document.generation,
    signal,
    get state() { return document.state; },
    async ensureHeld() {
      check();
      // Verify remote ownership, including forced takeover, without a read/write gap.
      await enqueue(() => write(document.state));
    },
    promote() {
      check();
      if (deadlineAt === Infinity) return;
      deadlineAt = Infinity;
      // Keep the persisted launch expiry until the handle has been delivered.
      // Scheduling instead of awaiting also prevents a lost renewal response
      // from blocking create() behind a ten-minute persisted lease.
      promotionTimer = setTimeout(() => {
        void enqueue(() => write(document.state)).catch(() => undefined);
      }, 0);
      promotionTimer.unref?.();
    },
    async updateState(state) {
      await enqueue(() => write(state));
    },
    release() {
      if (releasePromise !== undefined) return releasePromise;
      released = true;
      clearInterval(renewalTimer);
      clearTimeout(expiryTimer);
      clearTimeout(promotionTimer);
      abort.abort(new Error("AWS Lambda MicroVM lease released."));
      releasePromise = enqueue(async () => await instrumentAwsLambdaMicrovmOperation(
        { name: "eve.aws_lambda_microvm.lease.release" },
        async () => {
          // Exact ETag prevents even a delayed release from deleting a successor.
          if (input.durable) {
            etag = (await input.storage.putJson(input.key, { ...document, expiresAt: 0 }, { etag })).etag;
          } else {
            await input.storage.deleteObject(input.key, { etag });
          }
        },
      ));
      return releasePromise;
    },
  };
}

function parseLease(value: unknown): LeaseDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid AWS Lambda MicroVM lease document.");
  }
  const record = value as Record<string, unknown>;
  if ((record.version !== 1 && record.version !== 2) || typeof record.holder !== "string" ||
    !Number.isFinite(record.expiresAt) ||
    (record.generation !== undefined && (!Number.isSafeInteger(record.generation) || Number(record.generation) < 1))) {
    throw new Error("Invalid AWS Lambda MicroVM lease document.");
  }
  return {
    expiresAt: Number(record.expiresAt), holder: record.holder,
    generation: Number(record.generation ?? 0), state: record.state, version: record.version,
  };
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as {
    readonly $metadata?: { readonly httpStatusCode?: unknown };
    readonly message?: unknown;
    readonly name?: unknown;
  };
  return (
    record.name === "PreconditionFailed" ||
    record.$metadata?.httpStatusCode === 412 ||
    (typeof record.message === "string" && /precondition failed/i.test(record.message))
  );
}
