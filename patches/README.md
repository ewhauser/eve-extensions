# Eve 0.83.0 compatibility patches

The workspace pins `eve@0.83.0`, upstream commit
`261043d87ef0844a705c2ccf90ce5ea77d1c0bf9` (tag `eve@0.83.0`).

`eve@0.83.0.patch` is the combined patch installed by pnpm. Its reviewable
TypeScript equivalent is `eve@0.83.0-source.patch`, applied at the upstream
repository root. It carries:

- Custom compaction strategy loading and execution, preserving Eve's message
  provenance validation, the request-overhead-adjusted history budget, and
  current authorization/provider options.
- Connector tool-name projection, upstream-name filtering, approval annotations,
  descriptor validation before execution across direct MCP calls and
  `eve__search`/`eve__tool`, plus call-input transformation.
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

Focused upstream validation covers compaction strategy execution, prompt and budget accounting,
MCP client, and connection tool suites. The workspace's installed-patch unit tests,
built-host evals, and package gate verify this repository's use of the patch.
