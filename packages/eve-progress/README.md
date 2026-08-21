# eve-progress

`eve-progress` projects Eve's durable built-in `todo` state into a
transport-neutral `AgentProgressSnapshot`. Its first transport adapter renders
one independently mutable Slack `plan` message per root agent or subagent and
updates that message in place with `task_card` blocks.

Normal assistant replies are unchanged. The model uses only Eve's `todo` tool;
it does not know about Slack message IDs, blocks, or transport retries.

## Install

```sh
pnpm add eve@0.38.0 eve-progress
```

Eve 0.38 does not expose channel metadata to authored hooks. Until that hook
field lands upstream, copy the included compatibility patch into the
application repository and configure pnpm to use that checked-in copy:

```sh
mkdir -p patches
cp node_modules/eve-progress/patches/eve@0.38.0.patch \
  patches/eve-progress-eve@0.38.0.patch
```

```yaml
patchedDependencies:
  eve@0.38.0: patches/eve-progress-eve@0.38.0.patch
```

If the application already patches Eve, merge the two small hook-metadata
hunks into its existing patch instead; pnpm accepts only one patch per package
version.

Create `agent/extensions/progress.ts`:

```ts
import progress from "eve-progress";
import { createSlackProgressPublisher } from "eve-progress/slack";

import { progressSurfaceStore } from "../../src/progress-surface-store.js";

export default progress({
  publisher: createSlackProgressPublisher({
    store: progressSurfaceStore,
    // Omit botToken to use SLACK_BOT_TOKEN. Multi-workspace hosts can instead
    // provide resolveBotToken(binding).
  }),
  onError: ({ error, phase, context }) => {
    console.warn("Progress publication failed", {
      error,
      phase,
      sessionId: context.sessionId,
    });
  },
});
```

Mount the extension explicitly in every declared long-running subagent, for
example `agent/subagents/researcher/extensions/progress.ts`. Each Eve session
has its own durable projection state; the shared surface store routes child
messages to the root session's Slack thread without sharing task namespaces.

## Store contract

The Slack publisher requires an application-owned `ProgressSurfaceStore`.
Use durable storage in production with these unique keys:

- root binding: `rootSessionId` to Slack channel and thread;
- progress surface: `(rootSessionId, sessionId)` to Slack message `ts`, applied
  revision, and render fingerprint.

Writes should be linearizable per key. Slack updates are naturally repeatable,
and initial posts carry a deterministic `client_msg_id`; durable surface state
suppresses ordinary hook replay. The included memory store is only for tests
and local development:

```ts
import { createMemoryProgressSurfaceStore } from "eve-progress/stores/memory";

export const progressSurfaceStore = createMemoryProgressSurfaceStore();
```

For multi-workspace Slack installations, use the projected `teamId` to resolve
the correct credential:

```ts
createSlackProgressPublisher({
  store: progressSurfaceStore,
  resolveBotToken: async ({ teamId }) => {
    if (teamId === undefined) throw new Error("Slack teamId is required");
    return tokenStore.requireSlackBotToken(teamId);
  },
});
```

## Projection semantics

- The built-in `todo` result is authoritative and uses full-list replacement.
- The host must not shadow or disable the built-in `todo` tool on agents that
  mount this extension.
- Task IDs belong to the projection. Equal normalized content is matched by
  duplicate occurrence, so status and priority changes retain identity.
- Renaming a task removes the old identity and creates a new one.
- Repeated event IDs and semantically identical full snapshots do not create
  another revision. They may retry the idempotent publisher after an earlier
  fail-quiet delivery error.
- Todo `completed` maps to Slack `complete`; todo `cancelled`, failed active
  work, and cancelled active work render as Slack `error` without changing the
  authoritative todo value.
- Slack renders at most 50 task cards, matching the platform limit.

## Agent policy

The extension includes a small always-on instruction: use `todo` for
substantial multi-step work, keep the full list current, and skip plans for
simple requests. The optional `work-plan` skill gives the agent the detailed
replacement, status, rename, and final-reconciliation rules only when needed.

## Core adapter API

Non-Slack transports implement `ProgressPublisher`:

```ts
import type { ProgressPublisher } from "eve-progress/types";

export const publisher: ProgressPublisher = {
  async bind(context) {
    // Optionally capture transport routing visible on lifecycle events.
  },
  async publish(snapshot, context) {
    // Materialize this agent's complete snapshot idempotently.
  },
};
```

Publisher and telemetry errors are fail-quiet: they are reported through
`onError` but never fail the agent turn.
