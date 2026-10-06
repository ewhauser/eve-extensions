# Design

## Runtime boundary

`extension/connections/connectors.ts` is the complete runtime contribution. Its `session.started` resolver returns one caller-specific `defineMcpClientConnection()` definition. Eve owns MCP initialization and transport, `tools/list`, `tools/call`, authorization, discovery through `connection_search`, dynamic materialization, durable state, approvals, abort propagation, and tracing.

The extension retains only OpenAI-connector-specific policy:

1. resolve or evict the application's current user token;
2. select the experimental endpoint and required headers;
3. restrict exact upstream dotted names by service;
4. project those names into deterministic provider-legal names;
5. interpret MCP annotations and application overrides for approval.
6. optionally alias the model-facing service segment and transform call input.

There is no extension-owned protocol client, catalog cache, search tool, materialized working set, transcript restoration, or provider-native tool-search marker.

## Carried Eve primitives

Eve 0.71.2 is patched in three general places.

### Tool-name projection

`defineMcpClientConnection({ toolName: { toModelName } })` projects an upstream name for the model. Eve keeps the exact upstream string in connection metadata. Upstream identity is used for filtering, execution, and approval context; the mapped identity is used for `connection_search` and `connection_execute`.

Eve validates the projected name against the 64-character contract and rejects collisions deterministically. `connection_execute` also receives the connection name and resolves the projected name against current metadata before execution.

Predicate filters receive exact upstream names. That permits fail-closed service allowlists without preloading the catalog in the extension.

### Approval annotations

Discovered connection approval contexts add optional `toolAnnotations` and `upstreamToolName`. Annotations are normalized across the JSON durability boundary; malformed values are omitted and therefore unsafe under the extension policy. Request and response approval callbacks receive the same retained identity.

### Call-input transform

`toolCall.transformInput` runs after authorization and metadata revalidation, after application-provided arguments are resolved, and immediately before the MCP executor. It receives the exact upstream name. A rejected transform stops the call.

These patches are deliberately protocol- and provider-neutral. They contain no OpenAI search integration, `providerOptions` bridge, private name marker, or connector endpoint behavior.

## Naming

`github.search_repositories` becomes `github__search_repositories`. An alias can change only the model-facing service segment, such as `datadog_preview.search_logs` becoming `datadog__search_logs`. Names are bounded to 64 characters. Long names end in a six-hex SHA-256 suffix derived from the complete upstream name. Eve retains the exact upstream name for filtering, approval, and execution.

## Authorization and durability

The dynamic connection uses Eve's `principalType: "user"` auth and a stable, non-secret `instanceKey` containing the principal authority, service policy, sorted aliases, and name-mapping version. Eve also includes endpoint/source identity when deriving the internal instance ID. Changes invalidate pending/stored authorization and stale discovered tools.

`getToken` returning `null` becomes `ConnectionAuthorizationRequiredError`; the bearer itself is returned only from the auth callback. `evictToken` is a best-effort hook for application caches below Eve's cache.

## Approval policy

The default is fail closed:

| Annotation state | Treatment |
|---|---|
| `readOnlyHint: true` | no approval |
| explicit write | user approval |
| `destructiveHint: true` | user approval |
| missing or invalid | user approval as unsafe write |

Detailed application rules match the exact dotted upstream name. Deny rules return a reason; otherwise the first match wins, then an explicit fallback, then the annotation default. A custom `approval` uses Eve's normal connection approval contract.

## Discovery

Correctness depends only on Eve's ordinary progressive `connection_search`. The complete connector catalog stays out of the initial model request. Provider-native search may return later only through released upstream Eve/AI SDK APIs; it is not implemented by a permanent package patch.
