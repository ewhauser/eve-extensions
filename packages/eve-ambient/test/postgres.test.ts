import { describe, expect, it } from "vitest";
import { MemoryMonitorStore } from "../src/memory.js";
import { PostgresMonitorStore, type PostgresClient, type PostgresPool } from "../src/postgres.js";
import type { StoredMonitorRun } from "../src/storage.js";
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
        applicationId: "app",
        statuses: ["processing"],
        availableBefore: "2026-01-01T00:00:29.999Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.listSubscriptions({
        applicationId: "app",
        statuses: ["processing"],
        availableBefore: "2026-01-01T00:00:30.000Z",
        limit: 10,
      }),
    ).resolves.toHaveLength(1);
  });

  it("scopes and fairly interleaves subscription work by application and tenant", async () => {
    const store = new MemoryMonitorStore();
    for (const [id, applicationId, tenantId, sequence] of [
      ["a-1", "app", "tenant-a", "1"],
      ["a-2", "app", "tenant-a", "2"],
      ["b-1", "app", "tenant-b", "3"],
      ["other", "other-app", "tenant-c", "4"],
    ] as const) {
      await store.transaction(`subscription:${id}`, async (tx) => {
        await tx.putSubscription({
          id,
          eventRef: `event:${id}`,
          tenantId,
          applicationId,
          monitorId: "monitor",
          definitionVersion: "v1",
          ingressSequence: sequence,
          status: "pending",
          attempt: 0,
          availableAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      });
    }

    await expect(
      store.listSubscriptions({
        applicationId: "app",
        statuses: ["pending"],
        availableBefore: "2026-01-01T00:00:00.000Z",
        limit: 2,
      }),
    ).resolves.toMatchObject([
      { id: "a-1", tenantId: "tenant-a" },
      { id: "b-1", tenantId: "tenant-b" },
    ]);
  });
});

describe("PostgresMonitorStore due queries", () => {
  it("scope every worker scan to one application and rank subscriptions by tenant", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
    const pool: PostgresPool = {
      connect: async () => client(async () => ({ rows: [] })),
      query: async (text, values) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    };
    const store = new PostgresMonitorStore({ pool });

    await store.listSubscriptions({
      applicationId: "app",
      statuses: ["pending"],
      availableBefore: "2026-01-01T00:00:00.000Z",
      limit: 10,
    });
    await store.listDueInstances({
      applicationId: "app",
      availableBefore: "2026-01-01T00:00:00.000Z",
      limit: 10,
    });
    await store.listDueRuns({
      applicationId: "app",
      availableBefore: "2026-01-01T00:00:00.000Z",
      limit: 10,
    });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.text).toContain("application_id = $1");
      expect(call.values?.[0]).toBe("app");
    }
    expect(calls[0]?.text).toContain("PARTITION BY tenant_id");
  });

  it("matches PostgreSQL availability and lease predicates in memory", async () => {
    const store = new MemoryMonitorStore();
    await store.transaction("run", async (tx) => {
      await tx.putRun({
        id: "run",
        instanceId: "instance",
        tenantId: "tenant",
        applicationId: "app",
        monitorId: "monitor",
        definitionVersion: "v1",
        correlationKeyHash: "key",
        status: "processing",
        availableAt: "2026-01-01T00:01:00.000Z",
        leaseExpiresAt: "2026-01-01T00:00:10.000Z",
      } as StoredMonitorRun);
    });

    await expect(
      store.listDueRuns({
        applicationId: "app",
        availableBefore: "2026-01-01T00:00:30.000Z",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("uses key-aware ordering checks and a native sequence behind a commit-order fence", async () => {
    const calls: string[] = [];
    const query = (async (text: string) => {
      calls.push(text);
      if (text.includes("nextval")) return { rows: [{ value: "42" }] };
      if (text.includes("SELECT EXISTS")) return { rows: [{ exists: false }] };
      return { rows: [] };
    }) as PostgresClient["query"];
    const pool: PostgresPool = {
      connect: async () => client(query),
      query,
    };
    const store = new PostgresMonitorStore({ pool });

    await store.transaction("ordering", async (tx) => {
      await expect(tx.nextIngressSequence("tenant-app")).resolves.toBe("42");
      await expect(tx.hasEarlierOpenSubscription({
        tenantId: "tenant",
        applicationId: "app",
        monitorId: "monitor",
        definitionVersion: "v1",
        correlationKeyHash: "key-hash",
        ingressSequence: "7",
      })).resolves.toBe(false);
    });

    expect(calls.find((text) => text.includes("nextval"))).toContain("eve_ambient_ingress_sequence");
    expect(calls.find((text) => text.includes("pg_advisory_xact_lock") && text.includes("$1")))
      .toBeDefined();
    const ordering = calls.find((text) => text.includes("SELECT EXISTS"));
    expect(ordering).toContain("correlation_key_hash IS NULL OR correlation_key_hash = $5");
  });

  it("dead-letters open subscriptions before retention purges them", async () => {
    const calls: string[] = [];
    const query = (async (text: string) => {
      calls.push(text);
      return { rows: [], rowCount: 0 };
    }) as PostgresClient["query"];
    const pool: PostgresPool = {
      connect: async () => client(query),
      query,
    };
    const store = new PostgresMonitorStore({ pool });

    await store.purgeExpired("2026-01-01T00:00:00.000Z");

    const retentionDeadLetter = calls.find((text) =>
      text.includes("source dedupe retention expired before subscription completed"),
    );
    expect(retentionDeadLetter).toContain("INSERT INTO");
    expect(retentionDeadLetter).toContain("['pending','processing','ready']");
  });
});

function client(query: PostgresClient["query"]): PostgresClient {
  return { query, release() {} };
}
