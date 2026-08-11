import { describe, expect, it } from "vitest";
import { MemoryMonitorStore } from "../src/memory.js";
import { PostgresMonitorStore, type PostgresClient, type PostgresPool } from "../src/postgres.js";
import { TransientMonitorError } from "../src/types.js";

describe("PostgresMonitorStore error boundaries", () => {
  it("classifies query failures as transient store failures", async () => {
    const failure = new Error("connection reset");
    const pool: PostgresPool = {
      connect: async () => client(async () => ({ rows: [] })),
      query: async () => {
        throw failure;
      },
    };
    const store = new PostgresMonitorStore({ pool });

    await expect(store.listRuns({ applicationId: "app" })).rejects.toMatchObject({
      name: "TransientMonitorError",
      cause: failure,
    });
  });

  it("does not relabel deterministic transaction callback failures", async () => {
    const deterministic = new TypeError("invalid definition");
    const pool: PostgresPool = {
      connect: async () => client(async () => ({ rows: [] })),
      query: async () => ({ rows: [] }),
    };
    const store = new PostgresMonitorStore({ pool });

    await expect(
      store.transaction("definition", async () => {
        throw deterministic;
      }),
    ).rejects.toBe(deterministic);
    await expect(
      store.listRuns({ applicationId: "app" }),
    ).resolves.toEqual([]);
    expect(deterministic).not.toBeInstanceOf(TransientMonitorError);
  });
});

describe("subscription leases", () => {
  it("does not return processing work until its lease expires", async () => {
    const store = new MemoryMonitorStore();
    await store.transaction("subscription", async (tx) => {
      await tx.putSubscription({
        id: "subscription",
        eventRef: "event",
        tenantId: "tenant",
        applicationId: "app",
        monitorId: "monitor",
        definitionVersion: "v1",
        ingressSequence: "1",
        status: "processing",
        attempt: 1,
        availableAt: "2026-01-01T00:00:00.000Z",
        leaseExpiresAt: "2026-01-01T00:00:30.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    await expect(
      store.listSubscriptions({
        statuses: ["processing"],
        availableBefore: "2026-01-01T00:00:29.999Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.listSubscriptions({
        statuses: ["processing"],
        availableBefore: "2026-01-01T00:00:30.000Z",
        limit: 10,
      }),
    ).resolves.toHaveLength(1);
  });
});

function client(query: PostgresClient["query"]): PostgresClient {
  return { query, release() {} };
}
