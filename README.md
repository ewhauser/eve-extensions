# Eve Extensions

Reusable extensions, sandbox backends, and supporting integrations for
[Eve](https://eve.dev).

This pnpm monorepo collects capabilities that can be used with Eve without
being part of Eve core. Each package is independently consumable and documents
its own installation requirements, operational constraints, and license.

`eve-ambient` now lives in the standalone
[`ewhauser/eve-ambient`](https://github.com/ewhauser/eve-ambient) repository and
is published as [`@ewhauser/eve-ambient`](https://www.npmjs.com/package/@ewhauser/eve-ambient).

## Packages

- [`eve-agent-builder`](packages/eve-agent-builder) — an unreleased,
  experimental PR-02 foundation for private saved-agent identity, versioned
  domain state, lifecycle services, and durable store conformance. It does not
  yet ship Eve runtime roles, runners, skills, capabilities, or triggers. It is
  licensed under MIT.
- [`eve-project-link`](packages/eve-project-link) — links an entire Eve context
  channel to a durable external project hub, injects a compact project context
  card on every turn, and guides the agent to use already-mounted Notion,
  Linear, or custom tools without owning provider credentials.
  It is licensed under MIT.
- [`eve-progress`](packages/eve-progress) — projects Eve's durable built-in
  todo state into transport-neutral agent progress, with one independently
  mutable Slack plan message per agent or subagent. It is licensed under MIT.
- [`eve-slack-participation`](packages/eve-slack-participation) — gives Eve a
  bounded, fail-quiet participation policy for active multi-human Slack
  threads while preserving direct messages, explicit mentions, and dyadic
  follow-ups. It is licensed under MIT.
- [`eve-openai-compaction`](packages/eve-openai-compaction) — replaces Eve's
  built-in prose-summary compaction with OpenAI's remote encrypted checkpoint
  strategy, using Codex's retained-user-message window. It is remote-only,
  targets `eve@0.38.0`, and is licensed under MIT.
- [`eve-openai-connectors`](packages/eve-openai-connectors) — exposes a user's
  authorized ChatGPT connectors through provider-native deferred tool search.
  It requires ChatGPT Enterprise or Business with Codex access and is licensed
  under MIT. The extension depends on an undocumented OpenAI endpoint and
  should be treated as experimental.
- [`eve-openai-plugins`](packages/eve-openai-plugins) — safely compiles trusted
  OpenAI Codex plugin skills, commands, agents, app requirements, and eligible
  HTTP MCP definitions into an Eve agent, with lockfile ownership and dynamic
  per-principal skill/subagent gates. It is licensed under MIT.
- [`eve-openai-imagegen`](packages/eve-openai-imagegen) — packages a Codex-style
  imagegen skill and Eve tool backed by OpenAI's public `gpt-image-2` Image API.
  It supports generation, reference-based edits, durable sandbox artifacts,
  and iterative visual refinement, and is licensed under MIT.
- [`eve-aws-lambda-microvms`](packages/eve-aws-lambda-microvms) — provides a
  durable Eve sandbox backend using AWS Lambda MicroVMs. It is an explicit
  opt-in backend, requires application-owned AWS infrastructure, and is
  licensed under Apache-2.0. The package was extracted from
  [`vercel/eve#208`](https://github.com/vercel/eve/pull/208); its `NOTICE` file
  contains the upstream attribution.

Package READMEs are the source of truth for setup, compatibility, security
considerations, and production use.

## Repository layout

- `packages/` contains the independently licensed, publishable packages.
- `apps/` contains fixtures and end-to-end test applications used to validate
  packages in realistic Eve projects.
- `docs/rfcs/` contains tracked design proposals and their executable
  acceptance contracts before or alongside implementation.
- `patches/` contains workspace-level patches needed for development and
  validation against the currently supported Eve version.

## Development

The workspace requires Node.js 24 or newer and pnpm 11. Install dependencies
and run the offline validation suite from the repository root:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Shared dependency ranges are defined once in the default `catalog` in
`pnpm-workspace.yaml`; package manifests reference them with `catalog:`. Update
the catalog entry when upgrading a shared dependency. Version-keyed settings
such as Eve's patch path and `minimumReleaseAgeExclude` must still be updated
alongside the catalog entry.

Tests that require external credentials or cloud resources are opt-in. See the
relevant package README for prerequisites and teardown behavior before running
an integration or end-to-end suite.

CI runs the same type checking, tests, builds, package-content checks, and a
high-severity dependency audit on every pull request and push to `main`.
Dependency changes and GitHub Actions workflows receive additional security
review. See [`RELEASING.md`](RELEASING.md) for the npm trusted-publishing and
release process.

## Licensing

There is no single license covering every package in this repository. Refer to
the `LICENSE` file in each package directory. In particular,
`eve-agent-builder`, `eve-project-link`, `eve-progress`,
`eve-slack-participation`, `eve-openai-compaction`, `eve-openai-connectors`,
`eve-openai-plugins`, and `eve-openai-imagegen` are MIT-licensed, while
`eve-aws-lambda-microvms` is Apache-2.0-licensed.
