# eve-ambient

`eve-ambient` is a durable ambient-attention runtime for Eve applications. It
accepts typed events from channels, applies deterministic filtering and exact
correlation, buffers by key, makes a restricted rule or model decision, and
delivers immutable structured evidence through a channel-owned conversation
binding.

The package targets Node.js 24 or newer and has no runtime dependency on a
particular Eve release. Eve 0.31.3 does not yet expose first-class
inbound-event, conversation-binding, or compiler hooks, so this package
supplies that runtime and its adapter contracts. The application's existing Eve
channel remains responsible for transport,
authentication, normalization, provider acknowledgement, canonical targets,
conversation bindings, and session ingress.

## Install

```sh
pnpm add eve-ambient
```

The optional `eve-ambient/ai-sdk` adapter additionally requires `ai` and `zod`:

```sh
pnpm add ai zod
```

For production, apply `migrations/001_eve_ambient.sql` to PostgreSQL. The
runtime accepts a `pg`-compatible pool through `eve-ambient/postgres` without
forcing a particular PostgreSQL client dependency. Local tests can use
`MemoryMonitorStore` from `eve-ambient/memory`.

## Define a channel event

Channels create events; monitors never poll, consume queues, or own webhooks.

```ts
import { z } from "zod";
import {
  defineChannelEvent,
  defineInboundChannel,
} from "eve-ambient";

export const slackEvents = defineInboundChannel({
  id: "slack",
  replyTarget: z.object({
    channelId: z.string(),
    threadTs: z.string(),
  }),
  inbound: {
    message: defineChannelEvent({
      schema: z.object({
        channelId: z.string(),
        ts: z.string(),
        threadTs: z.string().optional(),
        text: z.string(),
      }),
      chat: true,
      maxBytes: 128_000,
    }),
  },
});
```

`defineChannelEvent` accepts any Standard Schema v1 implementation. Publishing
validates the schema and size before durable acceptance. Source dedupe is
scoped by tenant, application, channel installation, and provider event ID.

## Define a monitor

```ts
import { z } from "zod";
import {
  compileMonitor,
  defineMonitor,
  ignore,
  modelDecision,
} from "eve-ambient";

export const ambientEngineering = defineMonitor({
  id: "ambient-engineering",
  mode: "active",
  sources: [
    slackEvents.event("message", { phase: "undispatched" }),
  ],

  filter: ({ event }) =>
    !event.actor?.isBot && event.data.text.trim().length > 0,

  correlate: ({ event }) => [
    event.source.installationId,
    event.data.channelId,
    event.data.threadTs ?? event.data.ts,
  ].join(":"),

  buffer: {
    mode: "debounce",
    quietPeriod: "2s",
    maxWait: "15s",
    maxEvents: 20,
    maxBytes: 64_000,
  },

  decision: modelDecision({
    model: "openai/gpt-5-nano",
    reasoning: "none",
    instructions: "Wake only when the engineering agent can contribute.",
    input: ({ events, instance, batch }) => ({
      messages: events.map((event) => event.data.text),
      priorWakeAt: instance.lastWakeAt ?? null,
      completeness: batch,
    }),
    metadata: {
      ignore: z.object({}),
      wake: z.object({ priority: z.enum(["low", "normal", "high"]) }),
    },
    timeout: "8s",
    maxInputTokens: 4_000,
    maxOutputTokens: 250,
    onError: ignore({ reason: "classifier-unavailable", metadata: {} }),
  }),

  cooldown: { afterWake: "30s", during: "accumulate" },

  task: {
    // Trusted static configuration. Do not interpolate event text here.
    instructions: "Review the attached evidence independently and respond only when useful.",
    evidence: ({ events, decision, batch }) => ({
      messages: events.map((event) => ({ ref: event.ref, text: event.data.text })),
      classifier: {
        action: decision.action,
        reason: decision.reason,
        metadata: decision.metadata ?? null,
      },
      completeness: batch,
    }),
  },

  route: ({ events }) => {
    const target = events.at(-1)?.replyTarget;
    return target
      ? { channel: slackDelivery, target, auth: "app" }
      : null;
  },

  session: { strategy: "channel", idleTimeout: "24h" },
  limits: {
    perMonitor: {
      maxEventsPerMinute: 2_000,
      maxModelCallsPerMinute: 120,
      maxModelInputTokensPerHour: 250_000,
      maxWakesPerHour: 30,
    },
    perKey: { maxWakesPerHour: 4 },
    overflow: "buffer",
  },
  retention: { payload: "24h", decisions: "30d", dedupe: "7d" },
  metadata: { owner: "engineering-productivity", useCase: "ambient-slack" },
});

export const compiled = compileMonitor(ambientEngineering, "git:8e7b2f1");
```

`filter`, `correlate`, rule decisions, evidence projection, and routing must be
synchronous and side-effect-free. The runtime rejects returned promises and
non-JSON evidence, targets, metadata, or event payloads. Correlation is one
exact stable string or `null`; there is no semantic join or instance merge.

## Wire the runtime

```ts
import { MonitorRuntime } from "eve-ambient";
import { createAiSdkMonitorInvoker } from "eve-ambient/ai-sdk";
import { PostgresMonitorStore } from "eve-ambient/postgres";

const monitors = new MonitorRuntime({
  applicationId: "engineering-agent",
  deployment: { monitors: [compiled] },
  channels: [slackEvents],
  deliveryChannels: [slackDelivery],
  store: new PostgresMonitorStore({ pool }),
  modelInvoker: createAiSdkMonitorInvoker(),
  observer: telemetryObserver,
  // Hard cap for one immutable projected evidence object (default: 1,000,000).
  maxEvidenceBytes: 1_000_000,
  budgets: {
    platformId: "eve-production",
    platform: { maxModelCallsPerMinute: 5_000 },
    tenant: tenantId => tenantBudgets.get(tenantId),
    application: { maxWakesPerHour: 100 },
    overflow: "buffer",
  },
});

await monitors.initialize();
```

Run `drain()` from short-lived workers or a frequent scheduler. PostgreSQL is
the mailbox and timer authority; there is no sleeping workflow per active key.
Due scans are fair across tenants, claims have leases, and processing is
serialized per correlation key while different keys run in parallel. PostgreSQL
uses point reads, an indexed tenant cardinality count, and a global sequence
behind a lightweight per-domain commit-order fence; the ingress transaction
does not scan instance state or update one sequence row per tenant.

```ts
const result = await monitors.drain();
```

### Push ingress

After verifying the provider request, normalize it and publish:

```ts
const result = await monitors.publish(datadogEvents, "alert.changed", {
  tenantId,
  installationId,
  id: deliveryId,
  occurredAt: alert.timestamp,
  data: alert,
  subjects: [{ namespace: "service", key: alert.service }],
  origin: { kind: "external" },
});
```

`publish()` returns after the event and matching subscription snapshots commit.
It does not wait for filtering, a model, or an agent turn. A pull consumer may
commit its source offset after `accepted` or `duplicate`.

### Chat direct dispatch

Use `publishChat()` for chat events. `observed` subscriptions are accepted
first. `undispatched` subscriptions are created only after every awaited direct
handler succeeds and none returns a durable turn receipt.

```ts
const result = await monitors.publishChat(
  slackEvents,
  "message",
  normalized,
  directHandlers.map(handler => async () => handler(normalized)),
);
```

Provider acknowledgement must remain outside this completion path: acknowledge
according to the channel's deadline, then let the direct-dispatch operation
finish durably. A failed or unknown direct outcome is dead-lettered and never
emits `undispatched`. Direct handlers must deduplicate their turn command by the
provider event ID: `publishChat()` durably leases the direct-dispatch attempt, and
a duplicate resumes it after a worker crash or `TransientMonitorError`. The
result reports `pending` while a lease or retry backoff is active and otherwise
returns the persisted `dispatched`, `undispatched`, or `failed` outcome.

## Delivery adapter

A delivery channel implements `MonitorDeliveryChannel`. It receives static
trusted task instructions and a separate untrusted `MonitorEvidenceSnapshot`.
It must:

- resolve the canonical target through its own conversation-binding registry;
- reject a non-terminal binding/target conflict;
- refresh a stale reference only after the old generation is terminal;
- idempotently return the same receipt for `monitor:<run-id>:0`;
- put human and monitor requests on the same durable session ingress queue;
- coalesce monitor evidence into at most one pending follow-up while a turn is
  active, without merging or dropping human input; and
- execute only as the application principal.

`MemoryConversationChannel` in `eve-ambient/testing` is a binding and
coalescing conformance implementation for tests.

## Model boundary

`modelDecision()` always names its model, reasoning level, timeout, input and
output budgets, metadata schemas, one-or-zero repair attempts, and fallback.
`createAiSdkMonitorInvoker()` performs one structured, tool-less model step. It
places source data in an untrusted user payload and keeps classifier
instructions separate. Unknown actions, invalid confidence, long reasons, and
invalid action-specific metadata are rejected before policy or delivery.

Each initial or repair attempt consumes a separate model-call reservation.
Input-token budgets reserve the declared per-attempt `maxInputTokens` before the
call, so the hard ceiling is conservative even when provider tokenization differs
from the runtime's preflight estimate. Only invalid structured output consumes
the optional schema-repair attempt; timeouts and other provider failures apply
`onError` immediately.

For a different model stack, implement `MonitorModelInvoker`. That interface
contains no tool, credential, session-history, or delivery capability.

## Durability and operations

- The correlation-instance mailbox lifecycle (idle, collecting, evaluating,
  cooldown) is an explicit XState statechart in `src/instance-machine.ts`. The
  machine is a pure transition table: every event carries its own clock
  reading, the state value is derived from durable instance fields at
  hydration, and the store's `nextEvaluationAt` due-scan timer is computed from
  machine context. Persistence stays in the `MonitorStore`; no live actors or
  in-process timers are involved. The same machine can run in celld cells
  instead — see "celld mailbox backend" below.
- Ingress, subscription results, mailboxes, timer generations, runs, evidence
  snapshots, quotas, dead letters, and deployment identity are durable.
- Debounce closes on quiet period, mandatory maximum wait, count, or byte
  threshold. The overflowing event starts the next batch. A single oversized
  monitor event is dead-lettered rather than trimmed.
- Cooldown accumulates per key and schedules an evaluation at expiry even if no
  later event arrives.
- Transient store and target failures retry under stable leases and delivery
  keys. Model-provider failures use the declared fallback. Deterministic
  callback failures dead-letter immediately and cannot block other keys or
  tenants.
- Raw event content is redacted at payload expiry. The source dedupe tombstone
  remains through the longer dedupe window. Delivered evidence is copied into
  the channel/session request and follows decision/session retention.
- Dedupe expiry records unfinished subscriptions as retention dead letters.
  Reaccepting the provider ID preserves the expired tombstone until normal
  purging so older buffered audit references are not orphaned.
- Lifecycle events expose separate classifier tokens/cost estimates and
  delivery outcomes. Model prices remain an application/provider concern;
  pass `estimatedCost` from a custom invoker when available.

Call `listRuns()`, `listDeadLetters()`, `replay()`, and `purgeExpired()` for
operator tooling. Recorded replay never routes to production: delivery requires
an explicit canary channel and target. Live replay is labeled separately and is
not represented as deterministic. Runs expose `replayExpiresAt`; recorded and
live replay require the normalized source payloads and therefore share their
shorter payload-retention lifetime even though decision records remain available
for the configured decision retention.

## celld mailbox backend (experimental)

The correlation mailbox — the per-key buffer that accumulates post-filter
events and decides when a batch is due — can run in
[celld](https://github.com/denoland/celld) cells instead of in the store. One
cell per correlation instance, holding the same `StoredMonitorInstance` record
and running the same statechart, with the cell's durable alarm replacing the
`nextEvaluationAt` due-scan. Nothing else moves: the store remains the system
of record for runs, decisions, dead letters, and audit.

```text
channels
    │  publish()
    ▼
ingress pipeline (unchanged)        schema, dedupe, ingress sequence, filter,
    │                              correlate, loop prevention, event budgets
    │  POST /cells/<instanceKey>/append  {ref, bytes, seq, config}
    ▼
celld cells                        the statechart, buffer/cooldown, alarms.
    │                              No model credentials in the fleet.
    │  alarm() → CLAIM → POST evaluation {runId, batch refs, instanceView}
    ▼
runtime.handleEvaluation()         decision, budgets, evidence, route,
    │                              delivery; writes the run to the store
    │  {status, decision, binding} → cell dispatches RUN_COMPLETED
    ▼
delivery channels                  unchanged: idempotency keys, coalescing
```

Only post-filter appends leave the runtime. Payloads stay in the event store
from ingress and the evaluator reads them by ref; the cell keeps its own copy
for inspection only. Because run records are written identically in both
tiers, `replay()`, `listRuns()`, and `listDeadLetters()` behave the same.

### When to choose it

Choose it when per-key serialization is the bottleneck: many concurrent
correlation keys, a due-scan that no longer keeps up, or advisory-lock traffic
coupling the mailbox to your database's connection pool. Cells scale with
nodes rather than with one database, timers are native instead of swept, and
idle keys cost bucket storage rather than resident memory.

Stay on the store tier otherwise. It is the default, it is the small-deployment
answer, and it stays conformance-tested — the two tiers execute the same
`dispatchLifecycle`, so moving between them is a configuration change.

### Setup

1. Deploy the worker. It ships in the package at `celld-worker/`; see
   `celld-worker/README.md`. It carries no monitor configuration — cells learn
   theirs from the first append — so one deployment serves every monitor.

   ```sh
   cp -r node_modules/eve-ambient/celld-worker ./mailbox   # edit its vars
   CELLD_ESBUILD=/path/to/esbuild node ./mailbox/build.mjs # pre-flight bundle
   celld deploy --config ./mailbox/wrangler.jsonc
   ```

   The copied `index.ts` re-exports `eve-ambient/celld-worker`, so it resolves
   through your own `node_modules` and stays in step with the installed
   version.

2. Mount the evaluator on a route the fleet can reach.

   ```ts
   import { createEvaluationFetchHandler } from "eve-ambient/celld";

   const evaluate = createEvaluationFetchHandler(runtime, {
     secret: process.env.MAILBOX_SECRET!,
     path: "/monitor-evaluations",
   });
   ```

   `handleEvaluation(request)` is available directly if your server is not
   fetch-shaped; it takes and returns plain objects.

3. Point the runtime at the fleet.

   ```ts
   const runtime = new MonitorRuntime({
     // ...as before
     mailbox: {
       mode: "celld",
       fleetUrl: "http://fleet.internal:8787",
       evaluatorUrl: "https://app.internal/monitor-evaluations",
       secret: process.env.MAILBOX_SECRET!,
     },
   });
   ```

   Keep calling `drain()`: ingress, filtering, correlation, and appends still
   run there. It stops sweeping due instances and due runs, because claiming
   them would race the cells.

### Tuning

| Setting | Why |
|---|---|
| `CELLD_TTL_MS=5000` | Owner takeover costs a lease TTL. Measured p95 9.7s / 4.7s / 2.9s at TTL 10s / 5s / 3s; 5s is the knee, and the dial is noise against workload cost. |
| `CELLD_WAKER_TICK_MS=5000` | How fast an orphaned alarm is adopted: 8.8s at 5s, versus 56s at the 60s default. |
| Stable node identities across restarts | A node restarting with the same ID resumes in ~740ms. A *new* ID makes it a node loss, costing a full TTL. |
| Ingress key affinity, warm cells | Churn plus round-robin routing measured ≈2.5× the S3 operations of an affinity-routed fleet. |
| `CELLD_LTX_COMPACTION` configured | ~10⁸ segment objects per month at the RFC's rate cap. A requirement, not an optimization. |
| Internal listener firewalled | celld's internal listener exposes unauthenticated `/shutdown` and `/evict`. The public `/cells` routes are bearer-authenticated by this worker; the internal one is not celld's to authenticate. |

### Limitations

> - **Per-key correlation cardinality is not enforced.** The store tier caps
>   active keys per tenant with a `countInstances` under a tenant-wide lock;
>   celld mode has no instance table to count, and the cap is silently
>   inactive. Event, model-call, model-token, and wake budgets are unaffected
>   and remain the rate controls. Size the fleet for unbounded key growth, or
>   cap keys upstream in `correlate()`.
> - **celld abandons an alarm after six counted handler failures.** A cell that
>   exhausts the ladder keeps its buffered events and its instance record but
>   has no timer left. Mitigation: `POST /cells/<instanceKey>/rearm`, which
>   recomputes the due time with the statechart's own derivation and re-arms.
>   Alert on runs stuck in `retry` status, and on cells whose
>   `nextEvaluationAt` is in the past with no `pendingAlarm` in `/state`.
> - **Deploys are fleet restarts.** celld's staged rollout is not exposed;
>   changing the worker stops and restarts every node. Cells resume from
>   durable storage, and a deploy does not rewrite the configuration already
>   pinned into existing cells.
> - **The celld#144 workaround is active.** Alarm handlers can overlap
>   ([celld#144](https://github.com/denoland/celld/issues/144)), so the worker
>   wraps evaluation in `blockConcurrencyWhile`. That closes the cell's input
>   gate for the duration of the evaluator call, so appends queue behind an
>   in-flight evaluation. The block can narrow once the bug is fixed upstream.
> - **Sink-side idempotency is mandatory.** Delivery is at-least-once: a node
>   lost mid-delivery produces exactly one duplicate per interruption, with the
>   same `monitor:<runId>:0` key. Delivery adapters must dedupe on it.
> - **celld is alpha, and this tier is experimental.** Production adoption is
>   gated on the four conditions in the spike's Phase 4 decision record: an AWS
>   latency segment, celld#144 resolved or its workaround formally accepted, a
>   governance mitigation (pinned audited commit, vendored source, patch
>   capability), and a measured throughput ceiling.

## Definition identity and rollout

Monitor IDs are durable and independent of file paths. `initialize()` rejects a
missing active ID unless the deployment declares `move-state` or
`discard-state`. Keep old compiled versions as inactive while they own active
runs. To move idle mailbox state across a compatible code version, declare it:

```ts
compileMonitor(newDefinition, "v2", { compatibleWith: ["v1"] });
```

Use `mode: "shadow"` to run the full decision, quota, evidence, and route path
without binding or delivery. Use `replay(..., { canary: ... })` to exercise
binding, evidence persistence, and coalescing against an isolated target before
production activation.

## Security boundary

Event text and classifier output are always untrusted evidence. The runtime
never concatenates them into task instructions and routes cannot carry prompts
or messages. Source actors remain provenance and are not promoted to execution
identity. Same-application agent and monitor origins are ignored by default;
after an external platform round-trip, applications must also filter bots and
use wake limits because cross-application causation cannot be guaranteed.

All keys, routes, budgets, bindings, and delivery requests are scoped by tenant
and application before monitor or correlation identity. Delivery adapters must
enforce the same boundary rather than trusting a source actor or target alone.

## Deliberate version-one limits

There is no polling source, arbitrary I/O correlation, semantic re-keying,
mutable public instance state, `hold`, window/watermark processing, source-user
delegation, direct subagent invocation, multi-route wake, monitor interruption,
or cross-application loop guarantee. Those capabilities need separate durable
and authorization designs.
