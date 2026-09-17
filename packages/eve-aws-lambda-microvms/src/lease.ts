import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { AwsLambdaMicrovmStorage } from "./storage.js";
import { instrumentAwsLambdaMicrovmOperation } from "./telemetry.js";

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
        const now = Date.now();
        const current = await input.storage.getJson<unknown>(input.key);
        try {
          if (current === null) {
            const stored = await input.storage.putJson(
              input.key,
              leaseDocument(holder, now + ttlMs),
              { absent: true },
            );
            span.setAttributes({
              "eve.aws_lambda_microvm.lease.attempts": attempts,
              "eve.aws_lambda_microvm.lease.contended": contended,
            });
            return stored.etag;
          }
          const document = parseLease(current.value);
          if (document.expiresAt <= now) {
            const stored = await input.storage.putJson(
              input.key,
              leaseDocument(holder, now + ttlMs),
              { etag: current.etag },
            );
            span.setAttributes({
              "eve.aws_lambda_microvm.lease.attempts": attempts,
              "eve.aws_lambda_microvm.lease.contended": true,
            });
            return stored.etag;
          }
          contended = true;
          if (now >= deadline) {
            throw new Error(
              `AWS Lambda MicroVM lease ${input.key} is held by another runtime until ${new Date(document.expiresAt).toISOString()}.`,
            );
          }
        } catch (error) {
          if (!isPreconditionFailed(error)) throw error;
          contended = true;
          if (Date.now() >= deadline) {
            throw new Error(`Timed out acquiring AWS Lambda MicroVM lease ${input.key}.`, {
              cause: error,
            });
          }
        }
        await sleep(250 + Math.floor(Math.random() * 251));
      }
    },
  );

  let currentEtag = acquisition;
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
      currentEtag = await instrumentAwsLambdaMicrovmOperation(
        { name: "eve.aws_lambda_microvm.lease.renew" },
        async () =>
          (
            await input.storage.putJson(input.key, leaseDocument(holder, nextExpiresAt), {
              etag: currentEtag,
            })
          ).etag,
      );
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
        await instrumentAwsLambdaMicrovmOperation(
          { name: "eve.aws_lambda_microvm.lease.release" },
          async () => await input.storage.deleteObject(input.key, { etag: currentEtag }),
        );
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
