# eve-openai-connectors

An Eve extension that contributes the current user's authorized ChatGPT connectors as one dynamic MCP connection.

The OpenAI connector endpoint used here is undocumented and experimental. Pin and test upgrades; do not treat it as a stable public API.

## Eve 0.49 patch

This version still carries two small, provider-neutral Eve 0.49.0 patches:

- reversible MCP tool-name projection, with Eve retaining the exact upstream name for filtering and execution;
- MCP annotations and exact upstream identity on connection approval callbacks.

The old provider-native search/private-marker patch is gone. Discovery always uses Eve's ordinary `connection_search` path. Install the carried patch in an application because pnpm does not apply a dependency's patch automatically:

```sh
mkdir -p patches
cp node_modules/eve-openai-connectors/patches/eve@0.49.0.patch patches/eve@0.49.0.patch
```

```yaml
# pnpm-workspace.yaml
patchedDependencies:
  eve@0.49.0: patches/eve@0.49.0.patch
```

Keep Eve pinned to `0.49.0` until both primitives are released upstream. Annotation context is tracked by [vercel/eve#1890](https://github.com/vercel/eve/issues/1890).

## Mount

```ts
// agent/extensions/connectors.ts
import connectors from "eve-openai-connectors";

export default connectors({
  getToken: async ({ session }) =>
    loadChatGptWorkspaceToken(session.auth.current?.principalId),
  evictToken: async ({ session }) =>
    evictChatGptWorkspaceToken(session.auth.current?.principalId),
  allowedServices: ["github", "google_drive", "notion"],
});
```

The model initially sees Eve's `connection_search`, not the complete connector catalog. A search result materializes an exact callable name such as `connectors__github__search_repositories` on the next step.

## Configuration

| Option | Default | Purpose |
|---|---|---|
| `getToken(ctx)` | required | Return the current user's bearer, or `null` when unavailable. Tokens are returned only to Eve's auth layer. |
| `evictToken(ctx)` | none | Evict application-owned credential state after Eve sees a rejected bearer. |
| `getPrincipal(ctx)` | authenticated Eve user | Stable, non-secret authority key for the dynamic connection. Return `null` to omit it. |
| `enabled` | `true` | Disable the connection contribution. |
| `baseUrl` | ChatGPT connector MCP endpoint | Override the experimental endpoint. |
| `allowedServices` | all well-formed services | Case-insensitive allowlist over the exact upstream dotted-name prefix. |
| `excludedServices` | none | Case-insensitive denylist; deny wins over allow. |
| `approvals` | simple | Annotation-driven policy or ordered detailed rules over exact dotted names. |
| `approval` | none | Fully custom ordinary Eve connection approval; overrides `approvals`. |

Simple approval mode allows only `readOnlyHint: true` without approval. Writes require approval. Missing, invalid, or ambiguous annotations fail closed as unsafe writes. Detailed rules use `*` globs and first-match wins:

```ts
export default connectors({
  getToken,
  approvals: {
    mode: "detailed",
    rules: [
      { match: "*.delete_*", action: "deny" },
      { match: "github.search_*", action: "allow" },
    ],
    fallback: "approve",
  },
});
```

## Breaking migration from 0.6

Remove `discovery`, `protocolClientLifetime`, inventory/search/materialization limits, `includeStatus`, `approvalFor`, `transformCallInput`, `onAuthError`, `onResolution`, and `logger`. Use Eve connection behavior directly; replace `onAuthError` with `evictToken`, and replace `approvalFor(item)` with `approval(ctx)` or declarative `approvals`.

The `eve-openai-connectors/tools` and `eve-openai-connectors/connectors` subpaths are removed. Mount the extension package and use Eve's `connection_search` plus the returned qualified names.

## Security boundary

- Eve owns MCP transport, list/call lifecycle, aborts, auth cache isolation, authorization pauses, discovery state, approval parking/resumption, and observability.
- The extension owns only endpoint configuration, application token lookup/eviction, service policy, deterministic legal names, and annotation-driven approval defaults.
- Tokens never enter tool results, model context, or extension durable state.
- Filtering and detailed rules use the exact upstream name. Execution routes through that retained name; sanitized names are never reversed heuristically.
- Mapping collisions, malformed services, stale connection instances, changed mappings, and invalid provider names fail closed.
- Connector output is untrusted data, never instructions.

See [DESIGN.md](./DESIGN.md) for the boundary and patch contract.
