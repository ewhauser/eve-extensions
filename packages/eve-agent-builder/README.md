# eve-agent-builder

This unreleased package currently contains only the PR-02 foundation from
[RFC 0001][rfc]: owner resolution,
validated saved-agent domain types, a lifecycle service, a transactional store
contract, a tests/dev in-memory adapter, and a reusable store conformance suite.

It does **not** yet provide Eve extension mounts, PM/implementor/QA roles,
active or test runners, bootstrap leases, capability resolution, saved-skill
materialization, audit capture, invocation admission, or schedule/event
provisioning. There is no production runtime to install from this package yet.

## Name and retry contracts

`canonicalizeAgentName` is the only alias canonicalization rule. It applies
Unicode NFKC normalization, converts every Unicode `White_Space` run to one
ASCII space, trims the ends, and then applies JavaScript's locale-independent
Unicode lowercase mapping. It does not perform locale-sensitive casing or full
Unicode case folding.

A canonical alias in any current draft or published version is reserved to its
owner-scoped family. The same family may reuse an alias, archived families keep
their reservations, and this PR conservatively keeps deleted-family aliases
reserved until PR 06 has durable trigger-cleanup confirmation. An unpublished
alias stops being reserved when a non-deleted draft is renamed away from it.

Every lifecycle mutation requires a trusted `operationId` outside its
model-authored input. The service derives a stable SHA-256 request fingerprint.
A store atomically persists that pair with the successful result, so an exact
retry returns the original result without allocating another family, draft,
specification, version, or lifecycle transition. Reusing an operation ID for a
different request is a typed error.

## Store adapters

Production hosts must implement `AgentBuilderStore` with durable transactions.
The `createMemoryAgentBuilderStore` export is intentionally limited to tests
and local development. Adapter authors should run
`runAgentBuilderStoreConformanceSuite` from
`eve-agent-builder/testing/store-conformance` against a fresh store factory.

This package targets `eve@0.38.0`, Node.js 24 or newer, and strict TypeScript
with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.

[rfc]: https://github.com/ewhauser/eve-extensions/blob/main/docs/rfcs/0001-eve-agent-builder.md
