# eve-slack-participation

An Eve-only Slack participation policy. It decides whether Eve should join a
human conversation in an already-active Slack thread without turning the
package into a general-purpose bot framework.

The extension registers configuration only. It adds no agent tools, skills,
instructions, Slack client, or alternate runtime. Its exported handler is
composed directly into Eve's `slackChannel({ onMessage })` hook.

## Install

```sh
pnpm add ai eve@0.38.0 eve-slack-participation
```

Create an authored extension, for example
`agent/extensions/slack_participation.ts`:

```ts
import slackParticipation from "eve-slack-participation";

export default slackParticipation({
  strategy: "classifier",
  model: "openai/gpt-5-mini",
  mode: "shadow",
  groupRequests: "silent",
});
```

For model-free routing, omit the model and select the deterministic strategy:

```ts
import slackParticipation from "eve-slack-participation";

export default slackParticipation({
  strategy: "deterministic",
});
```

Then compose its handler into the Slack channel:

```ts
import { slackChannel } from "eve/channels/slack";
import { createSlackParticipationHandler } from "eve-slack-participation/slack";

export default slackChannel({
  onMessage: createSlackParticipationHandler(),
  threadContext: { since: "thread-root" },
});
```

The `threadContext` option is not required by this extension. Eve's participant
snapshot refreshes the thread before a multi-party decision. When classification
is enabled, the extension selects its own bounded root/recent/latest classifier
view from that snapshot.

## Policy

The hot path is deterministic wherever Slack and Eve already provide enough
information:

- Direct messages and explicit mentions dispatch without classification.
- Unmentioned messages outside an active Eve session are dropped.
- In an active channel thread, a canonical Slack user mention used as a
  sentence-initial non-Eve addressee is dropped without classification.
- An active thread with one visible human dispatches model-free.
- An active thread with multiple visible humans uses the configured model under
  `strategy: "classifier"` and stays silent under `strategy: "deterministic"`.
- Empty or unavailable participant snapshots fail quiet.
- A 50-message snapshot with fewer than two visible humans is treated as
  truncated and fails quiet instead of being misclassified as dyadic.
- Bot, system, and Eve-authored messages are ignored.

For an accepted follow-up in an active thread, the handler calls `ctx.cancel()`
before returning `{ auth }`. An enforced silent decision never cancels the
current turn. Cancellation is best-effort: failure is recorded but does not
reverse a valid dispatch decision.

The non-Eve addressee rule recognizes canonical `<@USER_ID>` Slack syntax at
the start of a message or sentence, optionally after a short greeting such as
`hey`. Mid-sentence mentions remain classifier input. Direct messages and any
message that explicitly mentions Eve take precedence over this rule.

`mode: "shadow"` records the decision while preserving the existing behavior
of subscribed threads under the classifier strategy. In shadow mode, a
classifier or snapshot decision of `SILENT` still dispatches and cancels the
active turn. Messages confirmed not to be subscribed remain dropped. The
deterministic non-Eve addressee rule is enforced in both modes. Use telemetry
to evaluate the classifier policy before switching to `mode: "enforce"`.

`strategy: "deterministic"` never calls the classifier. Direct messages and
explicit Eve mentions dispatch, subscribed dyadic threads dispatch, and
subscribed multi-party threads stay silent. A missing, failed, empty, or visibly
truncated participant snapshot also stays silent because the handler cannot
prove the thread is dyadic. These outcomes are enforced even when `mode` is
`"shadow"`.

## Configuration

```ts
import type { LanguageModel } from "ai";
import type { SlackParticipationDecisionRecord } from "eve-slack-participation/types";

interface SharedConfig {
  mode?: "shadow" | "enforce";           // default: "shadow"
  recentMessages?: number;                // 2..50, default: 12
  maxContextCharacters?: number;          // 1,000..100,000, default: 12,000
  timeoutMs?: number;                     // 100..30,000, default: 2,000
  groupRequests?: "respond" | "silent";  // default: "silent"
  onDecision?: (record: SlackParticipationDecisionRecord) => void | Promise<void>;
}

type Config = SharedConfig & (
  | {
      strategy?: "classifier";            // default
      model: string | LanguageModel;
    }
  | {
      strategy: "deterministic";
      model?: string | LanguageModel;      // optional and unused
    }
);
```

The default strategy is `"classifier"`, preserving the original configuration
shape where only `model` is specified. A string model id is resolved through
the AI SDK gateway, and a `LanguageModel` instance is used directly.
Classification uses structured output, temperature zero, a small output cap,
no tools, no retries, and a hard abort timeout. Provider errors, timeouts,
invalid output, inconsistent output, and ambiguous content all fail quiet.

Under the classifier strategy, group-wide asks are the only configurable
semantic category. With
`groupRequests: "respond"`, requests addressed to the whole channel may wake
Eve; with `"silent"`, they do not.

## Auth

By default the handler uses Eve's `defaultSlackAuth(message, ctx)`. A host can
provide an application-specific resolver without replacing the policy:

```ts
createSlackParticipationHandler({
  auth: async (message, ctx) => resolveWorkspaceAuth(message.teamId, ctx),
});
```

The resolver returns the same auth value accepted by Eve's Slack inbound
result, including `null` when the host intentionally dispatches without a
bound auth context.

## Classifier data and privacy

Only the classifier strategy sends data to a model. Its input is a bounded,
text-only transcript: the root when
available, recent messages, and the triggering message. Slack user ids are
replaced with stable per-thread labels (`THREAD_AUTHOR`, `HUMAN_2`, and so on),
Eve is labeled `EVE`, and mentions are normalized to those labels. Attachments,
profiles, tools, credentials, full Slack events, and hidden model reasoning are
excluded. Old middle messages are removed before retained text is truncated to
the configured character limit.

The classifier returns only `decision`, `addressee`, and a closed-set `reason`.
No confidence score or free-form rationale is generated or retained.

## Telemetry

`onDecision` receives one content-free record per eligible human message. It
contains Slack routing ids, observed thread mode and participant count, the
configured strategy, decision source, structured classifier fields when present,
bounded-context sizes, model id, latency, safe error code, and whether the
configuration uses shadow mode.
It never contains message text. Callback errors are logged and cannot change
the routing decision.

Deterministic non-Eve addressee drops use source
`explicit_non_eve_addressee`, reason `HUMAN_TO_HUMAN`, and addressee `HUMAN`.
Their thread mode is `unknown` because the guard intentionally skips the
participant snapshot.

Deterministic multi-party drops use source `deterministic_multi_party`, mode
`multi_party`, and include the observed human count. They contain no model or
classifier fields.

Recommended classifier rollout:

1. Start in `shadow` and inspect false-positive and false-negative rates by
   decision source and reason.
2. Confirm timeout and snapshot fallbacks are rare enough for the workspace.
3. Switch to `enforce` explicitly.
4. Keep alerts on classifier failures, latency, and snapshot-limit fallbacks.

## Engineering conversation evals

The repository includes a reproducible corpus of 20 synthetic multi-human
engineering threads in
[`test/eval/engineering-conversations.ts`](test/eval/engineering-conversations.ts).
It is balanced between `RESPOND` and `SILENT`, covers every structured reason,
and includes both group-request policies. Cases exercise terse answers,
interrupted answers, follow-up work, named requests for Eve, group asks,
human-to-human assignments, acknowledgements, social chatter, completed
incidents, and ambiguous technical questions.

The corpus materializes real Eve `SlackMessage` and `SlackThreadMessage` shapes.
It intentionally contains only classifier-eligible active multi-party threads;
DM, explicit-mention, dyadic, subscription, and snapshot routing remain in the
deterministic unit suite.

Offline `pnpm test` validates corpus coverage, participant topology,
pseudonymization, context bounds, and the decision/addressee/reason grading
contract. To evaluate the production classifier against a live AI SDK gateway
model:

```sh
AI_GATEWAY_API_KEY=... \
EVE_SLACK_PARTICIPATION_EVAL_MODEL=openai/gpt-5-mini \
pnpm --filter eve-slack-participation eval
```

For a correctness, latency, and cost comparison, pass comma-separated model
ids. This example spans several useful price/quality tiers from the current AI
Gateway catalog:

```sh
AI_GATEWAY_API_KEY=... \
EVE_SLACK_PARTICIPATION_EVAL_MODELS=openai/gpt-5-nano,google/gemini-2.5-flash-lite,alibaba/qwen3.5-flash,openai/gpt-5.6-luna,google/gemini-3.1-flash-lite,openai/gpt-5-mini,anthropic/claude-haiku-4.5 \
pnpm --filter eve-slack-participation eval
```

The runner makes one request per model and selected case. It fails individual
tests on a wrong decision, addressee, or reason, but continues through the
matrix. Its final human-readable table and JSON summary include exact structured
accuracy, decision accuracy, false and missed wakes, safe error counts, p50/p95
latency, input/output tokens, estimated total cost, and projected cost per 1,000
classified messages. Decision metrics treat classifier errors as `SILENT`,
matching the production fail-quiet route, while exact accuracy and error counts
still expose those failures. Cost covers responses that report token usage and
uses live list prices from the public AI Gateway model catalog; accuracy and
latency still report if that catalog is unavailable.

Run a subset by passing exact comma-separated case ids:

```sh
AI_GATEWAY_API_KEY=... \
EVE_SLACK_PARTICIPATION_EVAL_MODEL=openai/gpt-5-mini \
EVE_SLACK_PARTICIPATION_EVAL_CASES=terse-answer-to-eve,human-answers-human \
pnpm --filter eve-slack-participation eval
```

Live model evals are opt-in and are not part of the offline CI gate.

## License

MIT
