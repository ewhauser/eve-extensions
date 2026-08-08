import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { AwsLambdaMicrovmStorage } from "./storage.js";

const LEASE_VERSION = 1;

interface LeaseDocument {
  readonly expiresAt: number;
  readonly holder: string;
  readonly version: typeof LEASE_VERSION;
}

export interface AwsLambdaMicrovmLease {
  ensureHeld(): Promise<void>;
  release(): Promise<void>;
}

export async function acquireAwsLambdaMicrovmLease(input: {
  readonly key: string;
  readonly storage: AwsLambdaMicrovmStorage;
  readonly ttlMs?: number;
  readonly waitMs?: number;
}): Promise<AwsLambdaMicrovmLease> {
  const holder = randomUUID();
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + (input.waitMs ?? 30_000);
  let etag: string;

  for (;;) {
    const now = Date.now();
    const current = await input.storage.getJson<unknown>(input.key);
    try {
      if (current === null) {
        etag = (
          await input.storage.putJson(input.key, leaseDocument(holder, now + ttlMs), {
            absent: true,
          })
        ).etag;
        break;
      }
      const document = parseLease(current.value);
      if (document.expiresAt <= now) {
        etag = (
          await input.storage.putJson(input.key, leaseDocument(holder, now + ttlMs), {
            etag: current.etag,
          })
        ).etag;
        break;
      }
      if (now >= deadline) {
        throw new Error(
          `AWS Lambda MicroVM lease ${input.key} is held by another runtime until ${new Date(document.expiresAt).toISOString()}.`,
        );
      }
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring AWS Lambda MicroVM lease ${input.key}.`, {
          cause: error,
        });
      }
    }
    await sleep(250 + Math.floor(Math.random() * 251));
  }

  let currentEtag = etag;
  let expiresAt = Date.now() + ttlMs;
  let released = false;
  let lost: unknown;
  let operations = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operations.then(operation);
    operations = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function renew(): Promise<void> {
    if (released || lost !== undefined) return;
    const nextExpiresAt = Date.now() + ttlMs;
    try {
      currentEtag = (
        await input.storage.putJson(input.key, leaseDocument(holder, nextExpiresAt), {
          etag: currentEtag,
        })
      ).etag;
      expiresAt = nextExpiresAt;
    } catch (error) {
      lost = error;
      throw error;
    }
  }

  const renewalTimer = setInterval(
    () => {
      void enqueue(renew).catch(() => undefined);
    },
    Math.max(1000, Math.floor(ttlMs / 3)),
  );
  renewalTimer.unref?.();

  return {
    async ensureHeld() {
      if (released) throw new Error(`AWS Lambda MicroVM lease ${input.key} was released.`);
      if (lost !== undefined) {
        throw new Error(`AWS Lambda MicroVM lease ${input.key} was lost.`, { cause: lost });
      }
      if (expiresAt - Date.now() < ttlMs / 3) await enqueue(renew);
    },
    async release() {
      if (released) return;
      clearInterval(renewalTimer);
      await enqueue(async () => {
        if (lost !== undefined) {
          throw new Error(`AWS Lambda MicroVM lease ${input.key} was lost.`, { cause: lost });
        }
        await input.storage.deleteObject(input.key, { etag: currentEtag });
      });
      released = true;
    },
  };
}

function leaseDocument(holder: string, expiresAt: number): LeaseDocument {
  return { expiresAt, holder, version: LEASE_VERSION };
}

function parseLease(value: unknown): LeaseDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid AWS Lambda MicroVM lease document.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== LEASE_VERSION ||
    typeof record.holder !== "string" ||
    !Number.isFinite(record.expiresAt)
  ) {
    throw new Error("Invalid AWS Lambda MicroVM lease document.");
  }
  return {
    expiresAt: Number(record.expiresAt),
    holder: record.holder,
    version: LEASE_VERSION,
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
