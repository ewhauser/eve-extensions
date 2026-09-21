# Eve 0.63.0 compatibility patches

The workspace pins `eve@0.63.0`, upstream commit
`d004e6d47e9d25d0380c24b5a47b65a18f8b2784`.

`eve@0.63.0.patch` is the combined patch installed by pnpm. Its reviewable
TypeScript equivalent is `eve@0.63.0-source.patch`, applied at the upstream
repository root. It carries:

- Custom compaction strategy loading and execution, preserving Eve's message
  provenance validation, the request-overhead-adjusted history budget, and
  current authorization/provider options.
- Connector tool-name projection, upstream-name filtering, approval annotations,
  descriptor validation before execution, call-input transformation, optional
  connection-name qualification, and deterministic collision priority. The
  0.63.0 scoped authorization lifecycle remains in place.
- An optional-property declaration correction for `AlsContext.localDevRequest`
  so `ContextContainer` satisfies it with `exactOptionalPropertyTypes` enabled.

The compaction and connectors packages ship their own standalone npm patches.
An application using both must install the combined workspace patch; pnpm allows
one patch per dependency version.

To inspect or rebuild the source changes, check out the exact upstream tag,
apply the source patch, install its locked dependencies, and run:

```sh
pnpm --filter eve build:js
```

Generate the installable diff against the pristine npm tarball, using only the
changed runtime files and declarations and canonical `a/` and `b/` prefixes.
The published tarball includes assets that the source-only compilation does not
produce. Verify each standalone patch against a fresh tarball, update pnpm's
lockfile hash, then run `pnpm check` in this repository.

Focused upstream validation covers the tool loop, manifest normalization,
authored agent definitions, MCP client, connection search, and connection
resolution suites. The carried compaction tests include classified user history
and framework state, automatic request-budget adjustment, and dynamic connector
name projection.
