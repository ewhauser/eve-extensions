# eve-agent-builder

`eve-agent-builder` is an unreleased, experimental control plane for private,
owner-scoped saved agents in Eve 0.49. PR 04 adds a durable PM → implementor →
QA workflow, isolated test evidence, fail-closed consequential test policy,
and explicit atomic publication on top of PR 03's declared runners,
single-use leases, capability registry, discovery, and immutable direct runs.

It does not generate agent code or subagent directories. The host declares
every child boundary and mounts only the package helpers intended for that
role.

## Host configuration

Mount the pinned extension configuration in the root and in every declared
child. The package root has the conventional extension default plus the
domain/service/store named exports; `eve-agent-builder/extension` is the
explicit equivalent.

```ts
// agent/extensions/agent_builder.ts
import agentBuilder from "eve-agent-builder";
import { config } from "../lib/agent-builder-config.js";

export default agentBuilder(config);
```

`config` requires an `AgentBuilderStore`, a current-user-only `resolveOwner`,
and a `RunnerCapabilityRegistry`. Production hosts must provide durable store
transactions. `createMemoryAgentBuilderStore` from
`eve-agent-builder/stores/memory` is for tests and local development only.

`verifiedTestInputPolicy` supplies request-input availability and any
additional response validation Eve 0.49 does not expose to dynamic approval
callbacks. `ask_question` output is never accepted as authorization.
Consequential test tools retain their host schema, credential closure, and
approval while Builder adds an exact-call, single-use check.

Publication uses Eve's exact-call approval by default. A runtime that cannot
settle it may provide `verifiedPublishApprovalPolicy`; the callback receives
the exact owner, agent, session, turn, call, and current authenticated user
input, must fail closed, and runs before the transaction. Agent Builder does
not persist that input.

The root mounts the dynamic roster and control tools explicitly:

```ts
// agent/instructions/agent-builder-roster.ts
export { default } from "eve-agent-builder/mounts/root-instructions";

// agent/tools/agent-builder.ts
export { default } from "eve-agent-builder/mounts/root-tools";
```

Each role or runner directory mounts its matching static persona, dynamic
saved-context instructions, role tools, and lease hooks. Its `agent.ts` uses
`defineAgentBuilderRoleAgent` from
`eve-agent-builder/mounts/runner-agent`. The host must also explicitly disable
any Eve framework defaults that role does not receive. See the complete built
fixture in `apps/eve-agent-builder-e2e`.

## Bootstrap and lease contract

The root issues an opaque grant bound to the current owner, role, exact draft
revision or immutable spec/version, parent session, and available turn/call
lineage. Default tokens contain 256 bits of cryptographic entropy; only their
SHA-256 digest is stored. Grants cannot live longer than five minutes.

A fresh declared child receives only `{ protocolVersion, token }`. Its first
step exposes only `agent_builder__bootstrap_redeem` plus Eve's non-executing
`final_output` protocol tool when structured output was requested; atomic
redemption binds a ready lease to that exact child session. The real task is
sent on a second call to the same parked child. The execution turn injects
saved text beneath the static security policy and exposes only the selected
registry adapters.
Completion, failure, cancellation, or expiry closes the single-run lease.
Each later authenticated workflow turn issues a fresh grant/child. A parked
child is reused only inside that parent turn; Eve 0.49 does not refresh
`auth.current` on a later persistent-child resume.

## Build workflow and publication

`agent_builder__workflow_allocate` creates system-owned family, draft, and
workflow IDs. PM owns only `name`, `description`, `kind`, and `pmBrief`;
implementor owns only `instructions`, `toolRequirements`, and `triggers`; QA
owns only `testChecklist`, `qaFindings`, and its typed outcome. Each submit is
one atomic patch plus role handoff/verdict.

Records bind complete owner scope, workflow/family/draft identity, exact
revisions, role, trusted operation ID, and timestamps. CAS conflicts, stale
leases/handoffs, owner changes, and replay mismatches stop explicitly. An edit
after QA approval begins with `agent_builder__workflow_reopen`: its atomic CAS
transition clears test/approval evidence and returns the exact draft to PM
work. A fresh PM child then authors the requested edit, which creates a new
draft revision and requires implementation, test, and QA approval again.

QA approval is bound to the exact tested revision and required capability
plan. Publication atomically appends the immutable max-history version, moves
the active pointer, clears the draft, and records the workflow result. Exact
retries replay the typed result; a failed transaction publishes nothing.

The clear credential necessarily crosses Eve's model-mediated root-tool and
subagent-message transport. Agent Builder persists only its SHA-256 digest and
does not include clear credentials in typed errors or package logs. Hosts must
apply secret-bearing transcript retention/redaction controls; on normal command
completion, the built fixture redacts retained eval artifacts. That fixture
hygiene does not make Eve's in-flight transcript a secret-free transport.

An unknown Eve `agentId` starts a fresh child in Eve 0.49. That child has no
lease, so the package's dynamic model guard fails before a model call with a
message containing `BOOTSTRAP_REQUIRED`. Eve projects that public guard
failure through its framework model/subagent error codes.

## Capabilities and discovery

Stable `capabilityId` values exist only in saved specifications and registry
metadata. The registry resolves them per owner and mode (`test`, `direct`, or
`unattended`) to real Eve tool definitions with their host-selected model
names. Lowering preserves the original schema, credential closure, approval,
and result projection. Required missing, unauthorized,
disabled, or incompatible capabilities block before model execution. Optional
drift is omitted with a system note and result-disclosure requirement.
`unknown` host classification is consequential, and model-authored metadata
cannot downgrade it.

Active discovery is owner-scoped and sorted by canonical name then stable
`agentId`. The roster defaults to 25 entries and 12,000 JavaScript characters,
stops before the first violating entry, and reports the exact omitted count.
Bounded prefix/token search uses an owner- and query-bound opaque cursor. A
saved skill is distinguishable in search/get and returns
`load_skill_required` from run-by-ID admission instead of entering a runner.

## Store adapters and public exports

New bootstrap operations are atomic and owner-scoped: reserve a hash-only
grant, redeem it once while creating a lease, claim the one execution turn,
and close it terminally. Adapter authors should run all reusable suites:

- `eve-agent-builder/testing/store-conformance`
- `eve-agent-builder/testing/bootstrap-conformance`
- `eve-agent-builder/testing/workflow-conformance`
- `eve-agent-builder/testing/test-policy-conformance`

Core contracts are available from the package root and from `/domain`,
`/service`, `/store`, `/bootstrap`, `/capabilities`, `/discovery`, `/roles`,
`/workflow`, `/workflow-service`, and `/test-policy`.
Explicit host helpers are under `/mounts/*` and `/runtime/*`.

## Current limits

This PR proves durable build orchestration, side-effect-free isolated testing,
fail-closed consequential policy, explicit publication, and immediate
observation with deterministic models. It does not claim live-model obedience.
Eve 0.49 has no public binding from an `ask_question` answer to a later call,
and its local Workflow/eval runtime did not settle the tested nested approval
continuation. Unavailable consequential test capabilities are blocked and
recorded; reusable conformance proves exact grant consumption and
zero-execution negatives.

Saved-skill materialization remains PR 05. External
invocation envelopes, schedules/events, provisioning, production audit, and
release readiness remain later work.

The package targets `eve@0.49.0`, Node.js 24 or newer, strict TypeScript, Zod
validation, injected clocks/IDs, and typed result errors. See
[RFC 0001](https://github.com/ewhauser/eve-extensions/blob/main/docs/rfcs/0001-eve-agent-builder.md)
for the full boundary.
