import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileMonitor,
  defineChannelEvent,
  defineInboundChannel,
  defineMonitor,
  deriveLifecycleValue,
  dispatchLifecycle,
  ignore,
  lifecycleConfig,
  MonitorRuntime,
  wake,
  type ChannelEvent,
  type LifecycleEvent,
  type MonitorDefinition,
  type MonitorDeliveryChannel,
  type MonitorStore,
  type StoredMonitorInstance,
} from "../src/index.js";
import { MemoryMonitorStore } from "../src/memory.js";
import { PostgresMonitorStore, type PostgresPool } from "../src/postgres.js";
import { MemoryConversationChannel, VirtualMonitorClock } from "../src/testing.js";

const schema = z.object({ key: z.string(), text: z.string() });
const targetSchema = z.object({ room: z.string(), thread: z.string() });
const channel = defineInboundChannel({
  id: "chat",
  replyTarget: targetSchema,
  inbound: { message: defineChannelEvent({ schema, chat: true }) },
});
type TestEvent = ChannelEvent<"message", z.infer<typeof schema>, z.infer<typeof targetSchema>>;

function makeDefinition(
  overrides: Partial<MonitorDefinition<TestEvent, unknown, unknown>>,
): MonitorDefinition<ChannelEvent> {
  return defineMonitor<TestEvent>({
    id: "model",
    sources: [channel.event("message")],
    correlate: ({ event }) => event.data.key,
    decision: () => wake({ reason: "useful" }),
    task: { instructions: "Review.", evidence: () => ({}) },
    route: () => null,
    metadata: { owner: "test", useCase: "model" },
    ...overrides,
  } as MonitorDefinition<TestEvent>) as unknown as MonitorDefinition<ChannelEvent>;
}

const CONFIGS: readonly { readonly name: string; readonly definition: MonitorDefinition<ChannelEvent> }[] = [
  { name: "immediate", definition: makeDefinition({}) },
  {
    name: "immediate+cooldown",
    definition: makeDefinition({ cooldown: { afterWake: "10s", during: "accumulate" } }),
  },
  {
    name: "debounce",
    definition: makeDefinition({
      buffer: { mode: "debounce", quietPeriod: "2s", maxWait: "10s", maxEvents: 3, maxBytes: 100 },
    }),
  },
  {
    name: "debounce+cooldown",
    definition: makeDefinition({
      buffer: { mode: "debounce", quietPeriod: "2s", maxWait: "10s", maxEvents: 3, maxBytes: 100 },
      cooldown: { afterWake: "10s", during: "accumulate" },
    }),
  },
];

interface ModelNode {
  readonly instance: StoredMonitorInstance;
  readonly nowMs: number;
  readonly appended: number;
  readonly completed: number;
  readonly claimed: number;
  readonly depth: number;
}

type ModelOp =
  | "append"
  | "append-big"
  | "tick-quiet"
  | "tick-maxwait"
  | "tick-cooldown"
  | "claim"
  | "complete-wake"
  | "complete-ignore"
  | "complete-suppressed-wake"
  | "fail";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function freshInstance(): StoredMonitorInstance {
  const at = new Date(T0).toISOString();
  return {
    id: "inst",
    tenantId: "tenant-a",
    applicationId: "app-a",
    monitorId: "model",
    definitionVersion: "v1",
    correlationKey: "key",
    correlationKeyHash: "hash",
    sealedBatches: [],
    evaluationGeneration: 0,
    consecutiveIgnores: 0,
    eventsSinceLastWake: 0,
    expiresAt: "2027-01-01T00:00:00.000Z",
    createdAt: at,
    updatedAt: at,
  };
}

function batchEventCount(instance: StoredMonitorInstance): number {
  return (
    (instance.openBatch?.events.length ?? 0) +
    instance.sealedBatches.reduce((sum, batch) => sum + batch.events.length, 0)
  );
}

/** Applies one dispatch twice from identical input and asserts determinism. */
function dispatch(
  instance: StoredMonitorInstance,
  definition: MonitorDefinition<ChannelEvent>,
  event: LifecycleEvent,
) {
  const first = dispatchLifecycle(instance, definition, event);
  const second = dispatchLifecycle(instance, definition, event);
  expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
  return first;
}

function assertInvariants(
  node: ModelNode,
  definition: MonitorDefinition<ChannelEvent>,
  label: string,
): void {
  const { instance } = node;
  const now = new Date(node.nowMs).toISOString();
  const value = deriveLifecycleValue(instance, now);
  // A run is active exactly in the evaluating state.
  expect(instance.activeRunId !== undefined, `${label}: evaluating<=>activeRunId`).toBe(
    value === "evaluating",
  );
  // The due-scan timer exists exactly when idle work is buffered.
  const hasBatches = instance.openBatch !== undefined || instance.sealedBatches.length > 0;
  if (instance.activeRunId !== undefined || !hasBatches) {
    expect(instance.nextEvaluationAt, `${label}: timer must be unset`).toBeUndefined();
  } else {
    expect(instance.nextEvaluationAt, `${label}: timer must be set`).toBeDefined();
  }
  // Debounce bounds are never exceeded by an open batch.
  const config = lifecycleConfig(definition);
  if (config.buffer.mode === "debounce" && instance.openBatch !== undefined) {
    expect(instance.openBatch.events.length).toBeLessThanOrEqual(config.buffer.maxEvents!);
    expect(instance.openBatch.bytes).toBeLessThanOrEqual(config.buffer.maxBytes!);
  }
  // Every appended event is in a batch, the active claim, or completed.
  expect(
    batchEventCount(instance) + node.claimed + node.completed,
    `${label}: event conservation`,
  ).toBe(node.appended);
}

describe("instance lifecycle model sweep", () => {
  for (const { name, definition } of CONFIGS) {
    it(`explores ${name} transitions without violating invariants`, () => {
      const config = lifecycleConfig(definition);
      const visited = new Set<string>();
      const worklist: ModelNode[] = [
        { instance: freshInstance(), nowMs: T0, appended: 0, completed: 0, claimed: 0, depth: 0 },
      ];
      let explored = 0;
      let refCounter = 0;

      const signature = (node: ModelNode): string => {
        const inst = node.instance;
        const now = new Date(node.nowMs).toISOString();
        const due =
          inst.nextEvaluationAt === undefined
            ? "none"
            : inst.nextEvaluationAt <= now
              ? "due"
              : "future";
        return JSON.stringify([
          deriveLifecycleValue(inst, now),
          Math.min(inst.openBatch?.events.length ?? 0, 3),
          Math.min(inst.sealedBatches.length, 3),
          inst.cooldownUntil !== undefined && inst.cooldownUntil > now,
          inst.cooldownUntil !== undefined && inst.cooldownUntil <= now,
          inst.activeRunId !== undefined,
          due,
          Math.min(inst.consecutiveIgnores, 2),
          Math.min(inst.eventsSinceLastWake, 2),
        ]);
      };

      const ops: readonly ModelOp[] = [
        "append",
        ...(config.buffer.mode === "debounce" ? (["append-big"] as const) : []),
        "tick-quiet",
        "tick-maxwait",
        ...(config.cooldownAfterWakeMs === undefined ? [] : (["tick-cooldown"] as const)),
        "claim",
        "complete-wake",
        "complete-ignore",
        "complete-suppressed-wake",
        "fail",
      ];

      while (worklist.length > 0 && explored < 4_000) {
        const node = worklist.pop()!;
        if (node.depth >= 12) continue;
        const key = signature(node);
        if (visited.has(key)) continue;
        visited.add(key);
        explored += 1;

        for (const op of ops) {
          const now = new Date(node.nowMs).toISOString();
          const inst = node.instance;
          let next: ModelNode | null = null;

          if (op === "append" || op === "append-big") {
            refCounter += 1;
            const bytes = op === "append" ? 10 : (config.buffer.maxBytes ?? 100) - 5;
            const result = dispatch(inst, definition, {
              type: "APPEND",
              ref: {
                ref: `evt_${refCounter}`,
                bytes,
                acceptedAt: now,
                ingressSequence: String(refCounter),
              },
              now,
            });
            next = { ...node, instance: result.instance, appended: node.appended + 1, depth: node.depth + 1 };
          } else if (op.startsWith("tick-")) {
            const ms =
              op === "tick-quiet"
                ? (config.buffer.quietPeriodMs ?? 1_000)
                : op === "tick-maxwait"
                  ? (config.buffer.maxWaitMs ?? 5_000)
                  : config.cooldownAfterWakeMs!;
            next = { ...node, nowMs: node.nowMs + ms, depth: node.depth + 1 };
          } else if (op === "claim") {
            if (
              inst.activeRunId !== undefined ||
              inst.nextEvaluationAt === undefined ||
              inst.nextEvaluationAt > now
            ) {
              continue;
            }
            const cooldownWasExpired =
              inst.cooldownUntil !== undefined && inst.cooldownUntil <= now;
            const result = dispatch(inst, definition, {
              type: "CLAIM",
              runId: `run_${inst.evaluationGeneration + 1}`,
              now,
            });
            // The due-scan timer never fires without a claimable batch.
            expect(result.claimedBatch, `${name}: due timer with nothing claimable`).toBeDefined();
            // A consumed cooldown never lingers past the claim it gated.
            if (cooldownWasExpired) {
              expect(result.instance.cooldownUntil).toBeUndefined();
              if (result.claimedBatch!.events.length > 1 || inst.openBatch !== undefined) {
                if (inst.sealedBatches.length === 0) {
                  expect(result.claimedBatch!.closedBy).toBe("cooldown-expired");
                }
              }
            }
            next = {
              ...node,
              instance: result.instance,
              claimed: result.claimedBatch!.events.length,
              depth: node.depth + 1,
            };
          } else {
            if (inst.activeRunId === undefined) continue;
            const preSealedEvents = inst.sealedBatches.flatMap((batch) => batch.events.map((e) => e.ref));
            const result =
              op === "fail"
                ? dispatch(inst, definition, { type: "RUN_FAILED", now })
                : dispatch(inst, definition, {
                    type: "RUN_COMPLETED",
                    status:
                      op === "complete-wake"
                        ? "delivered"
                        : op === "complete-ignore"
                          ? "ignored"
                          : "suppressed",
                    decision: {
                      action: op === "complete-ignore" ? "ignore" : "wake",
                      reasonClass: "model",
                    },
                    now,
                  });
            if (op === "complete-wake") {
              // Wake resets attention counters.
              expect(result.instance.eventsSinceLastWake).toBe(0);
              expect(result.instance.consecutiveIgnores).toBe(0);
              expect(result.instance.lastWakeAt).toBe(now);
              if (config.cooldownAfterWakeMs !== undefined) {
                expect(result.instance.cooldownUntil).toBe(
                  new Date(node.nowMs + config.cooldownAfterWakeMs).toISOString(),
                );
                if (config.buffer.mode === "immediate" && inst.sealedBatches.length > 0) {
                  // Consolidation merges accumulated batches exactly when a
                  // fresh cooldown starts.
                  expect(result.instance.sealedBatches).toHaveLength(0);
                  const openRefs = result.instance.openBatch?.events.map((e) => e.ref) ?? [];
                  for (const ref of preSealedEvents) expect(openRefs).toContain(ref);
                }
              } else {
                expect(result.instance.cooldownUntil).toBeUndefined();
              }
            }
            if (op === "complete-suppressed-wake") {
              // A suppressed wake never starts a cooldown.
              const post = result.instance.cooldownUntil;
              expect(post === undefined || post === inst.cooldownUntil).toBe(true);
            }
            if (op === "complete-ignore") {
              expect(result.instance.consecutiveIgnores).toBe(inst.consecutiveIgnores + 1);
              // An inherited stale cooldown never survives completion.
              if (result.instance.cooldownUntil !== undefined) {
                expect(result.instance.cooldownUntil > now).toBe(true);
              }
            }
            expect(result.instance.activeRunId).toBeUndefined();
            next = {
              ...node,
              instance: result.instance,
              completed: node.completed + node.claimed,
              claimed: 0,
              depth: node.depth + 1,
            };
          }

          if (next !== null) {
            assertInvariants(next, definition, `${name}/${op}`);
            worklist.push(next);
          }
        }
      }
      expect(explored).toBeGreaterThan(10);
    });
  }
});

type ScenarioStep =
  | { readonly kind: "publish"; readonly id: string; readonly key: string; readonly text: string }
  | { readonly kind: "advance"; readonly ms: number }
  | { readonly kind: "drain" };

interface ScenarioResult {
  readonly instances: unknown;
  readonly runs: unknown;
  readonly deliveries: readonly (readonly string[])[];
}

function conformanceMonitor(
  delivery: MonitorDeliveryChannel,
  overrides: Partial<MonitorDefinition<TestEvent, unknown, unknown>>,
) {
  return defineMonitor<TestEvent>({
    id: "conformance",
    sources: [channel.event("message")],
    correlate: ({ event }) => event.data.key,
    decision: ({ events }) =>
      events.some((event) => event.data.text.includes("wake"))
        ? wake({ reason: "useful" })
        : ignore({ reason: "quiet" }),
    task: {
      instructions: "Review.",
      evidence: ({ events }) => ({ refs: events.map((event) => event.data.text) }),
    },
    route: ({ events }) => ({
      channel: delivery,
      target: events.at(-1)!.replyTarget!,
      auth: "app" as const,
    }),
    metadata: { owner: "test", useCase: "conformance" },
    ...overrides,
  } as MonitorDefinition<TestEvent>);
}

const SCENARIOS: readonly {
  readonly name: string;
  readonly overrides: Partial<MonitorDefinition<TestEvent, unknown, unknown>>;
  readonly steps: readonly ScenarioStep[];
}[] = [
  {
    name: "debounce wake, cooldown accumulation, expiry evaluation",
    overrides: {
      buffer: { mode: "debounce", quietPeriod: "2s", maxWait: "10s", maxEvents: 5, maxBytes: 10_000 },
      cooldown: { afterWake: "30s", during: "accumulate" },
    },
    steps: [
      { kind: "publish", id: "e1", key: "k1", text: "wake please" },
      { kind: "publish", id: "e2", key: "k1", text: "context" },
      { kind: "drain" },
      { kind: "advance", ms: 2_000 },
      { kind: "drain" },
      { kind: "publish", id: "e3", key: "k1", text: "more wake" },
      { kind: "publish", id: "e4", key: "k1", text: "detail" },
      { kind: "drain" },
      { kind: "advance", ms: 30_000 },
      { kind: "drain" },
      { kind: "advance", ms: 2_000 },
      { kind: "drain" },
    ],
  },
  {
    // Publishing three immediate events before one drain makes the first wake
    // complete while two sealed singletons remain, exercising consolidation.
    name: "immediate wake with cooldown consolidation",
    overrides: { cooldown: { afterWake: "10s", during: "accumulate" } },
    steps: [
      { kind: "publish", id: "e1", key: "k1", text: "wake now" },
      { kind: "publish", id: "e2", key: "k1", text: "wake extra" },
      { kind: "publish", id: "e3", key: "k1", text: "wake more" },
      { kind: "drain" },
      { kind: "advance", ms: 10_000 },
      { kind: "drain" },
    ],
  },
  {
    name: "debounce overflow flush then max-wait flush with ignores",
    overrides: {
      buffer: { mode: "debounce", quietPeriod: "5s", maxWait: "8s", maxEvents: 2, maxBytes: 10_000 },
    },
    steps: [
      { kind: "publish", id: "e1", key: "k1", text: "one" },
      { kind: "publish", id: "e2", key: "k1", text: "two" },
      { kind: "publish", id: "e3", key: "k1", text: "three" },
      { kind: "drain" },
      { kind: "advance", ms: 4_000 },
      { kind: "publish", id: "e4", key: "k1", text: "four" },
      { kind: "drain" },
      { kind: "advance", ms: 4_000 },
      { kind: "drain" },
      { kind: "publish", id: "e5", key: "k2", text: "wake other key" },
      { kind: "drain" },
      { kind: "advance", ms: 5_000 },
      { kind: "drain" },
    ],
  },
];

function scenarioInput(id: string, key: string, text: string) {
  return {
    tenantId: "tenant-a",
    installationId: "install-a",
    id,
    data: { key, text },
    replyTarget: { room: "R1", thread: key },
    actor: { id: "U1", principalType: "user" as const },
    origin: { kind: "external" as const },
  };
}

/**
 * JSON-normalizes a result and replaces the delivery channel's random binding,
 * session, and turn identifiers with first-seen aliases so two runs of the
 * same scenario compare structurally.
 */
function normalize(value: unknown, memo: Map<string, string>): unknown {
  const scrub = (current: unknown): unknown => {
    if (typeof current === "string" && /^(binding|session|turn)_/.test(current)) {
      let alias = memo.get(current);
      if (alias === undefined) {
        alias = `${current.split("_")[0]}#${memo.size}`;
        memo.set(current, alias);
      }
      return alias;
    }
    if (Array.isArray(current)) return current.map(scrub);
    if (typeof current === "object" && current !== null) {
      // Sort keys so alias assignment order is store-independent (PostgreSQL
      // jsonb does not preserve object key order).
      return Object.fromEntries(
        Object.entries(current)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, scrub(entry)]),
      );
    }
    return current;
  };
  return scrub(JSON.parse(JSON.stringify(value)));
}

function scenarioAppId(scenario: (typeof SCENARIOS)[number]): string {
  return `app-${SCENARIOS.indexOf(scenario)}`;
}

async function runScenario(
  store: MonitorStore,
  scenario: (typeof SCENARIOS)[number],
): Promise<ScenarioResult> {
  const applicationId = scenarioAppId(scenario);
  const clock = new VirtualMonitorClock();
  const delivery = new MemoryConversationChannel({ id: "delivery", clock });
  const monitor = conformanceMonitor(delivery, scenario.overrides);
  const definition = monitor as unknown as MonitorDefinition<ChannelEvent>;
  let counter = 0;
  const runtime = new MonitorRuntime({
    applicationId,
    deployment: { monitors: [compileMonitor(monitor, "v1")] },
    channels: [channel],
    deliveryChannels: [delivery],
    store,
    clock,
    idGenerator: (prefix) => `${applicationId}_${prefix}_${(counter += 1)}`,
  });
  await runtime.initialize();

  for (const step of scenario.steps) {
    if (step.kind === "publish") {
      await runtime.publishChat(channel, "message", scenarioInput(step.id, step.key, step.text), []);
    } else if (step.kind === "advance") {
      clock.advance(step.ms);
    } else {
      await runtime.drain();
      const now = clock.now().toISOString();
      for (const instance of await store.listInstances({ applicationId })) {
        // Machine invariants hold for every record any store persists.
        const value = deriveLifecycleValue(instance, now);
        expect(instance.activeRunId !== undefined).toBe(value === "evaluating");
        const hasBatches =
          instance.openBatch !== undefined || instance.sealedBatches.length > 0;
        if (instance.activeRunId !== undefined || !hasBatches) {
          expect(instance.nextEvaluationAt).toBeUndefined();
        } else {
          expect(instance.nextEvaluationAt).toBeDefined();
        }
        const config = lifecycleConfig(definition);
        if (config.buffer.mode === "debounce" && instance.openBatch !== undefined) {
          expect(instance.openBatch.events.length).toBeLessThanOrEqual(config.buffer.maxEvents!);
        }
      }
    }
  }

  const [instances, runs] = await Promise.all([
    store.listInstances({ applicationId }),
    runtime.listRuns(),
  ]);
  const memo = new Map<string, string>();
  return {
    instances: normalize([...instances].sort((a, b) => a.id.localeCompare(b.id)), memo),
    runs: normalize([...runs].sort((a, b) => a.id.localeCompare(b.id)), memo),
    deliveries: delivery.deliveries.map((request) => request.evidence.sourceEventRefs),
  };
}

describe("scenario conformance on the memory store", () => {
  for (const scenario of SCENARIOS) {
    it(`replays deterministically: ${scenario.name}`, async () => {
      const first = await runScenario(new MemoryMonitorStore(), scenario);
      const second = await runScenario(new MemoryMonitorStore(), scenario);
      expect(second).toEqual(first);
      expect(first.deliveries.length).toBeGreaterThan(0);
    });
  }
});

const connectionString = process.env.EVE_AMBIENT_POSTGRES_URL;
const postgresDescribe = connectionString === undefined ? describe.skip : describe;

postgresDescribe("scenario conformance across stores", () => {
  let pool: Pool;
  let migration: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    migration = await readFile(
      new URL("../migrations/001_eve_ambient.sql", import.meta.url),
      "utf8",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  /**
   * Each scenario gets a fresh schema because the ingress sequence is global
   * per schema, and a fresh MemoryMonitorStore likewise starts from zero.
   */
  async function withSchema<T>(callback: (schema: string) => Promise<T>): Promise<T> {
    const schemaName = `eve_ambient_model_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`SET search_path TO "${schemaName}"`);
      await client.query(migration);
    } finally {
      client.release();
    }
    try {
      return await callback(schemaName);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  }

  for (const scenario of SCENARIOS) {
    it(`memory and PostgreSQL agree: ${scenario.name}`, async () => {
      const memory = await runScenario(new MemoryMonitorStore(), scenario);
      const postgres = await withSchema((schemaName) =>
        runScenario(
          new PostgresMonitorStore({ pool: pool as unknown as PostgresPool, schema: schemaName }),
          scenario,
        ),
      );
      expect(postgres.instances).toEqual(memory.instances);
      expect(postgres.runs).toEqual(memory.runs);
      expect(postgres.deliveries).toEqual(memory.deliveries);
    });
  }
});
