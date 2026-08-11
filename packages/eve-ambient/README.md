# eve-ambient

`eve-ambient` is a durable ambient-attention runtime for Eve applications. It
accepts typed events from channels, applies deterministic filtering and exact
correlation, buffers by key, makes a restricted rule or model decision, and
delivers immutable structured evidence through a channel-owned conversation
binding.

The package targets `eve@0.31.3` and Node.js 24 or newer. Eve 0.31.3 does not
yet expose first-class inbound-event, conversation-binding, or compiler hooks,
so this package supplies that runtime and its adapter contracts. The
application's existing Eve channel remains responsible for transport,
authentication, normalization, provider acknowledgement, canonical targets,
conversation bindings, and session ingress.

## Install

```sh
pnpm add eve-ambient
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
serialized per correlation key while different keys run in parallel.

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
emits `undispatched`.

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

For a different model stack, implement `MonitorModelInvoker`. That interface
contains no tool, credential, session-history, or delivery capability.

## Durability and operations

- Ingress, subscription results, mailboxes, timer generations, runs, evidence
  snapshots, quotas, dead letters, and deployment identity are durable.
- Debounce closes on quiet period, mandatory maximum wait, count, or byte
  threshold. The overflowing event starts the next batch. A single oversized
  monitor event is dead-lettered rather than trimmed.
- Cooldown accumulates per key and schedules an evaluation at expiry even if no
  later event arrives.
- Transient model and target failures retry under stable leases and delivery
  keys. Deterministic callback failures dead-letter immediately and cannot
  block other keys or tenants.
- Raw event content is redacted at payload expiry. The source dedupe tombstone
  remains through the longer dedupe window. Delivered evidence is copied into
  the channel/session request and follows decision/session retention.
- Lifecycle events expose separate classifier tokens/cost estimates and
  delivery outcomes. Model prices remain an application/provider concern;
  pass `estimatedCost` from a custom invoker when available.

Call `listRuns()`, `listDeadLetters()`, `replay()`, and `purgeExpired()` for
operator tooling. Recorded replay never routes to production: delivery requires
an explicit canary channel and target. Live replay is labeled separately and is
not represented as deterministic.

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
