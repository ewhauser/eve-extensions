/**
 * One end-to-end scenario against a real celld fleet, gated on the fleet being
 * reachable. It is the live counterpart of `celld-runtime.test.ts`: the same
 * flow, but with celld's own storage, placement, proxying, and alarms instead
 * of the in-process harness.
 *
 * Run it with a fleet up and the worker deployed:
 *
 *   CELLD_FLEET_URL=http://127.0.0.1:8787 \
 *   CELLD_EVALUATOR_URL=http://127.0.0.1:8791/monitor-evaluations \
 *   CELLD_SECRET=... \
 *   pnpm exec vitest run test/celld-integration.test.ts
 *
 * `CELLD_EVALUATOR_URL` must be a loopback or fleet-reachable address whose
 * port this test may bind: it serves `createEvaluationFetchHandler` there for
 * the duration of the run. The fleet's `EVALUATOR_URL` var, if set, must
 * match, since it wins over the URL the runtime sends with each append.
 *
 * Without those variables the whole file skips, and the main suite never needs
 * a fleet.
 */

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileMonitor,
  defineChannelEvent,
  defineInboundChannel,
  defineMonitor,
  ignore,
  MonitorRuntime,
  wake,
  type ChannelEvent,
} from "../src/index.js";
import { createEvaluationFetchHandler } from "../src/celld.js";
import { MemoryMonitorStore } from "../src/memory.js";
import { MemoryConversationChannel } from "../src/testing.js";
import { compareCellState, type PublishedEvent } from "./celld-oracle.js";

const FLEET_URL = process.env.CELLD_FLEET_URL;
const EVALUATOR_URL = process.env.CELLD_EVALUATOR_URL;
const SECRET = process.env.CELLD_SECRET ?? "eve-ambient-integration";
const enabled = FLEET_URL !== undefined && EVALUATOR_URL !== undefined;

const messageSchema = z.object({ channelId: z.string(), text: z.string() });
const slack = defineInboundChannel({
  id: "slack",
  replyTarget: z.object({ channel: z.string() }),
  inbound: { message: defineChannelEvent({ schema: messageSchema }) },
});
type MessageEvent = ChannelEvent<
  "message",
  z.infer<typeof messageSchema>,
  { channel: string }
>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)("celld fleet integration", () => {
  const store = new MemoryMonitorStore();
  const delivery = new MemoryConversationChannel<{ channel: string }>({ id: "slack-delivery" });
  // A fresh application id per run, so the instance keys — and therefore the
  // cells — are new and never collide with a previous run's pinned state.
  const applicationId = `app-it-${randomUUID().slice(0, 8)}`;
  let runtime: MonitorRuntime;
  let server: Server;

  const monitor = defineMonitor<MessageEvent>({
    id: "ambient",
    sources: [slack.event("message")],
    correlate: ({ event }) => event.data.channelId,
    buffer: {
      mode: "debounce",
      quietPeriod: "1s",
      maxWait: "5s",
      maxEvents: 5,
      maxBytes: 10_000,
    },
    cooldown: { afterWake: "3s", during: "accumulate" },
    decision: ({ events }) =>
      events.some((event) => event.data.text.includes("wake"))
        ? wake({ reason: "useful" })
        : ignore({ reason: "quiet" }),
    task: {
      instructions: "Review the evidence.",
      evidence: ({ events }) => ({ texts: events.map((event) => event.data.text) }),
    },
    route: ({ events }) => ({
      channel: delivery,
      target: { channel: events.at(-1)!.data.channelId },
      auth: "app" as const,
    }),
    metadata: { owner: "test", useCase: "celld-integration" },
  });

  beforeAll(async () => {
    runtime = new MonitorRuntime({
      applicationId,
      deployment: { monitors: [compileMonitor(monitor, "v1")] },
      channels: [slack],
      deliveryChannels: [delivery],
      store,
      mailbox: {
        mode: "celld",
        fleetUrl: FLEET_URL!,
        evaluatorUrl: EVALUATOR_URL!,
        secret: SECRET,
      },
    });
    await runtime.initialize();
    server = await serveEvaluator(
      createEvaluationFetchHandler(runtime, { secret: SECRET }),
      new URL(EVALUATOR_URL!),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("buffers in a real cell, evaluates on its alarm, and stays machine-conformant", async () => {
    const channelId = `C-${randomUUID().slice(0, 8)}`;
    await runtime.publish(slack, "message", publishInput("1", "please wake me", channelId));
    await runtime.publish(slack, "message", publishInput("2", "more context", channelId));
    const drained = await runtime.drain();
    expect(drained.evaluations).toBe(0);
    expect(drained.runs).toBe(0);
    expect(await store.listInstances({ applicationId })).toHaveLength(0);

    // celld's own alarm drives this; nothing here advances a clock.
    const run = await waitFor(async () => {
      const runs = await runtime.listRuns();
      return runs.find((candidate) => candidate.status === "delivered") ?? null;
    }, 30_000);

    expect(delivery.deliveries).toHaveLength(1);
    expect(delivery.deliveries[0]!.evidence.projectedEvidence).toEqual({
      texts: ["please wake me", "more context"],
    });
    expect(run.batch.closedBy).toBe("quiet-period");

    const cellName = run.instanceId;
    const state = (await (
      await fetch(`${FLEET_URL}/cells/${encodeURIComponent(cellName)}/state`, {
        headers: { authorization: `Bearer ${SECRET}` },
      })
    ).json()) as Record<string, any>;

    const published = new Map<string, PublishedEvent>();
    for (const entry of state.log as { kind: string; ref?: string }[]) {
      if (entry.kind !== "append" || entry.ref === undefined) continue;
      const record = (await store.getEvent(entry.ref))!;
      published.set(entry.ref, {
        bytes: record.bytes,
        acceptedAt: record.acceptedAt,
        ingressSequence: record.ingressSequence,
      });
    }
    const verdict = compareCellState(state as never, { ...state.pin, cellName, published });
    expect(verdict.mismatches).toEqual([]);
    expect(verdict.differences).toEqual([]);
  }, 60_000);
});

function publishInput(id: string, text: string, channelId: string) {
  return {
    tenantId: "tenant-a",
    installationId: "workspace-a",
    id: `${channelId}-${id}`,
    data: { channelId, text },
    replyTarget: { channel: channelId },
    actor: { id: "U1", principalType: "user" as const },
    origin: { kind: "external" as const },
  };
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(250);
  }
}

/** Serves one fetch handler on the evaluator URL's host and port. */
async function serveEvaluator(
  handler: (request: Request) => Promise<Response>,
  url: URL,
): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const request = new Request(new URL(incoming.url ?? "/", url), {
        method: incoming.method ?? "POST",
        headers,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      });
      handler(request)
        .then(async (response) => {
          outgoing.writeHead(response.status, { "content-type": "application/json" });
          outgoing.end(await response.text());
        })
        .catch((error: unknown) => {
          outgoing.writeHead(500, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: String(error) }));
        });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(Number(url.port || 80), url.hostname, resolve);
  });
  return server;
}
