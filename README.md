# Eve Extensions

Reusable extensions, sandbox backends, and supporting integrations for
[Eve](https://eve.dev).

This pnpm monorepo collects capabilities that can be used with Eve without
being part of Eve core. Each package is independently consumable and documents
its own installation requirements, operational constraints, and license.

## Packages

- [`eve-openai-connectors`](packages/eve-openai-connectors) — exposes a user's
  authorized ChatGPT connectors through provider-native deferred tool search.
  It requires ChatGPT Enterprise or Business with Codex access and is licensed
  under MIT. The extension depends on an undocumented OpenAI endpoint and
  should be treated as experimental.
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

Tests that require external credentials or cloud resources are opt-in. See the
relevant package README for prerequisites and teardown behavior before running
an integration or end-to-end suite.

## Licensing

There is no single license covering every package in this repository. Refer to
the `LICENSE` file in each package directory. In particular,
`eve-openai-connectors` is MIT-licensed and `eve-aws-lambda-microvms` is
Apache-2.0-licensed.
