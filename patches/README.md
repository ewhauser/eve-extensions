# Eve 0.71.2 compatibility patches

The workspace pins `eve@0.71.2`, upstream commit
`143fe5717aa8a77d64185c00d1dbb363f307882f` (tag `eve@0.71.2`).

`eve@0.71.2.patch` is the combined patch installed by pnpm. Its reviewable
TypeScript equivalent is `eve@0.71.2-source.patch`, applied at the upstream
repository root. It carries:

- Custom compaction strategy loading and execution, preserving Eve's message
  provenance validation, the request-overhead-adjusted history budget, and
  current authorization/provider options.
- Connector tool-name projection, upstream-name filtering, approval annotations,
  descriptor validation before execution across direct MCP calls and
  `connection_search`/`connection_execute`, plus call-input transformation.
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

Focused upstream validation covers compaction prompt and budget accounting,
MCP client, and connection tool suites. Direct runs of the upstream
`compaction.test.ts` and `tool-loop.test.ts` currently fail to resolve the tag's
`#internal/testing/media-fixtures.js` alias. The workspace's installed-patch
unit tests, built-host evals, and package gate verify this repository's use of
the patch.
