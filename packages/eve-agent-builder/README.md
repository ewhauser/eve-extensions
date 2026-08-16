# eve-agent-builder

`eve-agent-builder` is an unreleased, experimental control plane for private,
owner-scoped saved agents in Eve 0.38. PR 03 adds host-declared PM,
implementor, QA, test-runner, and active-runner mounts; single-use bootstrap
grants and session leases; a stable host capability registry; deterministic
active-agent discovery; and direct two-turn execution of an immutable
published version.

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

The clear credential necessarily crosses Eve's model-mediated root-tool and
subagent-message transport. Agent Builder persists only its SHA-256 digest and
does not include clear credentials in typed errors or package logs. Hosts must
apply secret-bearing transcript retention/redaction controls; on normal command
completion, the built fixture redacts retained eval artifacts. That fixture
hygiene does not make Eve's in-flight transcript a secret-free transport.

An unknown Eve `agentId` starts a fresh child in Eve 0.38. That child has no
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
and close it terminally. Adapter authors should run both reusable suites:

- `eve-agent-builder/testing/store-conformance`
- `eve-agent-builder/testing/bootstrap-conformance`

Core contracts are available from the package root and from `/domain`,
`/service`, `/store`, `/bootstrap`, `/capabilities`, `/discovery`, and `/roles`.
Explicit host helpers are under `/mounts/*` and `/runtime/*`.

## Current limits

This PR proves direct execution and establishes test-runner infrastructure with
deterministic models. It does not claim live-model obedience. PM to implementor
to QA orchestration, handoffs/evaluation, and consequential interactive test
policy remain PR 04. Saved-skill materialization remains PR 05. External
invocation envelopes, schedules/events, provisioning, production audit, and
release readiness remain later work.

The package targets `eve@0.38.0`, Node.js 24 or newer, strict TypeScript, Zod
validation, injected clocks/IDs, and typed result errors. See
[RFC 0001](https://github.com/ewhauser/eve-extensions/blob/main/docs/rfcs/0001-eve-agent-builder.md)
for the full boundary.
