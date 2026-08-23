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

export default progress({
  publisher: createSlackProgressPublisher({
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
has its own durable projection and Slack surface state. Eve propagates the
originating channel metadata to child sessions, so each child can route its own
message to the root Slack thread without sharing task namespaces or requiring
application database tables.

## Durable state

The Slack publisher keeps these values in Eve's session-scoped extension state:

- the inherited Slack channel, thread, and optional team binding;
- that session's Slack message `ts`, applied revision, and render fingerprint.

This state is serialized with the rest of the Eve session, including across
worker restarts. Slack updates are naturally repeatable, and initial posts carry
a deterministic `client_msg_id`; the stored revision and fingerprint suppress
ordinary hook replay. No external progress store is required.

For multi-workspace Slack installations, use the projected `teamId` to resolve
the correct credential:

```ts
createSlackProgressPublisher({
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
substantial multi-step work, keep it current, and skip plans for simple
requests. The built-in tool definition supplies the replacement and status
rules.

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
