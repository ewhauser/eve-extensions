import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileMonitor,
  defineChannelEvent,
  defineInboundChannel,
  defineMonitor,
  ignore,
  MonitorRuntime,
  type ChannelEvent,
} from "../src/index.js";
import { PostgresMonitorStore, type PostgresPool } from "../src/postgres.js";
import { VirtualMonitorClock } from "../src/testing.js";

const connectionString = process.env.EVE_AMBIENT_POSTGRES_URL;
const postgresDescribe = connectionString === undefined ? describe.skip : describe;

const source = defineInboundChannel({
  id: "postgres-events",
  inbound: {
    changed: defineChannelEvent({ schema: z.object({ key: z.string() }) }),
  },
});
type Event = ChannelEvent<"changed", { key: string }>;

postgresDescribe("PostgresMonitorStore integration", () => {
  const schema = `eve_ambient_test_${process.pid}_${Date.now()}`;
  let pool: Pool;
  let store: PostgresMonitorStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    const migration = await readFile(
      new URL("../migrations/001_eve_ambient.sql", import.meta.url),
      "utf8",
    );
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(migration);
    } finally {
      client.release();
    }
    store = new PostgresMonitorStore({
      pool: pool as unknown as PostgresPool,
      schema,
    });
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("runs ordered mailboxes, indexed cardinality, and retention on real PostgreSQL", async () => {
    const clock = new VirtualMonitorClock();
    const definition = defineMonitor<Event>({
      id: "postgres-conformance",
      sources: [source.event("changed")],
      correlate: ({ event }) => event.data.key,
      decision: () => ignore({ reason: "recorded" }),
      task: { instructions: "Review.", evidence: ({ events }) => ({ count: events.length }) },
      route: () => null,
      retention: { payload: "1s", decisions: "1h", dedupe: "1s" },
      metadata: { owner: "test", useCase: "postgres-conformance" },
    });
    const runtime = new MonitorRuntime({
      applicationId: "app",
      deployment: { monitors: [compileMonitor(definition, "v1")] },
      channels: [source],
      store,
      clock,
    });
    await runtime.initialize();
    for (const [id, key] of [["one", "same"], ["two", "same"], ["three", "other"]] as const) {
      await runtime.publish(source, "changed", {
        tenantId: "tenant",
        installationId: "installation",
        id,
        data: { key },
        origin: { kind: "external" },
      });
    }
    await runtime.drain();

    expect(await runtime.listRuns()).toHaveLength(3);
    await store.transaction("count", async (tx) => {
      await expect(tx.countInstances({ tenantId: "tenant", applicationId: "app" })).resolves.toBe(2);
    });

    await runtime.publish(source, "changed", {
      tenantId: "tenant",
      installationId: "installation",
      id: "unfinished",
      data: { key: "unfinished" },
      origin: { kind: "external" },
    });
    clock.advance(1_000);
    await runtime.purgeExpired();

    expect(await runtime.listDeadLetters()).toContainEqual(
      expect.objectContaining({
        stage: "retention",
        reason: "source dedupe retention expired before subscription completed",
      }),
    );
  }, 20_000);
});
