# Eve 0.54.3 compatibility patches

The workspace pins `eve@0.54.3`, upstream commit
`543c3457e4b0f820db035211c2ac494070a7c5be`.

`eve@0.54.3.patch` is the combined patch installed by pnpm. Its reviewable
TypeScript equivalent is `eve@0.54.3-source.patch`, applied at the upstream
repository root. It carries:

- Custom compaction strategy loading and execution, preserving Eve's message
  provenance validation and current authorization/provider options.
- Connector tool-name projection, upstream-name filtering, approval annotations,
  and descriptor validation before execution. The 0.54.3 scoped authorization
  lifecycle remains in place.
- An optional-property declaration correction for `AlsContext.localDevRequest`
  so `ContextContainer` satisfies it with `exactOptionalPropertyTypes` enabled.

The compaction and connectors packages ship their own standalone npm patches.
An application using both must install the combined workspace patch; pnpm allows
one patch per dependency version.

To inspect or rebuild the source changes, check out the exact upstream tag,
apply the source patch, install its locked dependencies, and run:

```sh
pnpm --filter eve build:types
cd packages/eve
node --conditions=eve-source scripts/build-rolldown.mjs
```

Generate the installable diff against the pristine npm tarball, using only the
changed runtime files and declarations and canonical `a/` and `b/` prefixes.
The published tarball includes assets that the source-only compilation does not
produce. Verify each standalone patch against a fresh tarball, update pnpm's
lockfile hash, then run `pnpm check` in this repository.

Focused upstream validation covers the tool loop, manifest normalization,
authored agent definitions, MCP client, connection search, and connection
resolution suites. The carried compaction tests include classified user history
and framework state.
