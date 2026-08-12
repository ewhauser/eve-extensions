# eve-openai-connectors

An [Eve](https://eve.dev) extension that gives an agent access to the current user's authorized ChatGPT connectors—GitHub, Google Drive, Notion, and every other connector available to that user—as dynamically discovered tools.

The user authorizes each service once in ChatGPT. The extension talks to OpenAI's connector service with that user's ChatGPT workspace credential, so the Eve application does not need a separate OAuth implementation for every connected service.

> Requires ChatGPT Enterprise or Business with Codex access. An OpenAI API key does not work because it does not carry the user's ChatGPT workspace identity.

## Install

Add the extension to the Eve agent project:

```sh
pnpm add eve@0.31.3 eve-openai-connectors
```

### Install the required Eve patch

Provider-native deferred discovery requires a small patch to Eve 0.31.3. The package ships the exact patch used by this monorepo, but pnpm does not apply patches from dependencies automatically. Copy it into your application:

```sh
mkdir -p patches
cp node_modules/eve-openai-connectors/patches/eve@0.31.3.patch patches/eve@0.31.3.patch
```

Register it in the top-level `pnpm-workspace.yaml`, preserving any existing settings:

```yaml
patchedDependencies:
  eve@0.31.3: patches/eve@0.31.3.patch
```

Then apply it:

```sh
pnpm install
```

The patch forwards per-tool `providerOptions` through Eve and injects the native tool-search implementation for Anthropic or OpenAI when deferred tools are present. It is version-specific: keep Eve pinned to `0.31.3` and revalidate or replace the patch before upgrading. The corresponding upstream work is [vercel/eve#1741](https://github.com/vercel/eve/pull/1741).

## Mount the extension

Create `agent/extensions/openai.ts`:

```ts
import openaiConnectors from "eve-openai-connectors";

export default openaiConnectors({
  discovery: "deferred",
  getToken: async (ctx) => {
    const userId = ctx.session.auth.current?.attributes?.user_id;
    return userId ? await mySecretStore.get(userId) : null;
  },
});
```

The mount file must be named `openai.ts`. Eve uses that filename as the extension namespace, producing names such as:

```text
openai__search
openai__status
openai__github_search_repositories
```

The short, fixed namespace also leaves enough room under model providers' 64-character tool-name limit. The extension's instruction fragment teaches the agent the discover-then-call flow automatically.

### Local development

The Eve development terminal may not have an authenticated principal. For a single-user local agent, supply a stable development principal and read the token from the environment:

```ts
import openaiConnectors from "eve-openai-connectors";

export default openaiConnectors({
  getToken: () => process.env.CODEX_ACCESS_TOKEN ?? null,
  getPrincipal: () => "local-dev",
});
```

Set the token before starting Eve:

```sh
export CODEX_ACCESS_TOKEN="<your ChatGPT workspace access token>"
pnpm dev
```

Do not ask users to paste access tokens into chat messages. Acquire and store them outside the conversation using the security controls appropriate for your deployment.

## How discovery works

The connector catalog can contain hundreds of tools. In the default `deferred` mode, the extension advertises the complete mapped catalog with each schema marked for deferred loading. The patched Eve runtime adds the provider's native tool-search tool, so Anthropic or OpenAI searches the catalog and loads only the schemas needed for the current request.

Equivalent normalized catalogs are content-addressed and interned across users. Their frozen descriptors, raw schema objects, and connector-scoped dynamic tool definitions retain stable identities, while tokens, protocol clients, catalog membership, and credential invalidation remain per-user. Both shared caches are TTL-, entry-, and estimated-byte-bounded. `openai__status` reports only aggregate hit, miss, entry, eviction, and estimated-byte counts; it never uses principals, tokens, or schemas as metric labels.

If the catalog is temporarily unavailable, the extension automatically falls back to progressive search:

1. The agent calls `openai__search` with a service and keywords.
2. The result identifies matching connector tools.
3. On the next step, those tools are materialized under the `openai__` namespace and become callable.

Set `discovery: "search"` to use that path all the time. Search-mode tools discovered earlier in the conversation are rebuilt from history without another catalog request.

Ask the agent, for example:

> Find the open pull requests on acme/web and summarize them.

## Credentials

`getToken(ctx)` is the extension's only credential surface. Return a bearer token for the current user or `null` when that user has no connector access.

The token must be one of:

- A Codex access token created for the user in the ChatGPT admin console under Access tokens. These are long-lived, admin-governed, revocable, and work as raw bearer tokens.
- A ChatGPT session access token obtained through an OAuth or device-code flow owned by your application. These are short-lived, so your application must handle refresh.

The extension never logs or persists the token. It holds tokens only in a bounded in-process per-user protocol-client cache. A changed token immediately invalidates that user's protocol session and authorization inventory; unchanged immutable catalog content can still be reused.

## Configuration

| Option | Default | Purpose |
|---|---|---|
| `getToken(ctx)` | required | Return the current user's ChatGPT workspace bearer token, or `null`. |
| `getPrincipal(ctx)` | derived from Eve auth | Return a stable per-user cache key. Useful for auth-less local development. |
| `enabled` | `true` | Disable all connector contributions when false. |
| `allowedServices` | all authorized services | Restrict discovery and calls to service names such as `github` or `google_drive`. |
| `discovery` | `"deferred"` | Use provider-native deferred tool search. Set to `"search"` for progressive extension search. |
| `baseUrl` | OpenAI connector service | Override the connector endpoint. |
| `inventoryTtlMs` | `300000` | Per-user connector catalog cache lifetime in milliseconds. |
| `maxMaterializedTools` | `30` | Maximum previously discovered tools restored on each step. |
| `searchLimitDefault` | `8` | Default number of search matches. |
| `searchLimitMax` | `25` | Maximum number of search matches. |
| `includeStatus` | `true` | Include the `openai__status` diagnostic tool. |
| `approvals` | simple policy | Configure declarative write-tool approval rules. |
| `approvalFor(item)` | none | Supply a fully custom Eve approval function for each tool. |
| `logger` | `console` | Receive operational warnings; arguments, results, and tokens are never logged. |

## Approvals

The default policy uses MCP annotations and fails closed:

| Connector tool | Default treatment |
|---|---|
| `readOnlyHint: true` | Run without approval. |
| Write tool | Require human approval. |
| `destructiveHint: true` | Require approval and mark the description as destructive. |
| Missing or invalid annotations | Treat as a destructive write. |

For per-tool rules, use detailed mode. Rules match the original dotted upstream name and the first match wins:

```ts
export default openaiConnectors({
  getToken,
  approvals: {
    mode: "detailed",
    rules: [
      { match: "github.delete_*", action: "deny" },
      { match: ["github.*", "notion.*"], action: "approve" },
      { match: "google_drive.search_*", action: "allow" },
    ],
  },
});
```

Anything unmatched falls back to the annotation-driven policy unless `fallback` is set.

## Operational probe

Verify a token and the live endpoint without running an agent:

```sh
CODEX_ACCESS_TOKEN="<token>" pnpm --filter eve-openai-connectors probe
```

Add `--call` to make one read-only live call. The probe reports catalog health and naming invariants without printing the token.

## Security and limitations

- Connector output is untrusted input. A GitHub issue, Drive document, or Notion page can contain instruction-shaped text. Treat retrieved content as data and keep writes behind approval.
- Cross-service chains deserve extra scrutiny: content read from one service must not silently authorize a write to another.
- Every connector call revalidates current per-user catalog membership and the policy-relevant descriptor. A tool removed or changed after discovery fails closed before any upstream `tools/call` request.
- The connector endpoint is an OpenAI backend used by Codex, not a documented public OpenAI API. OpenAI can change or gate it without notice. Review this dependency with your security team before production use.
- Connector traffic residency through this endpoint is undocumented. Verify it against any residency obligations.
- The extension does not authorize new connectors. Users authorize services in ChatGPT.

See [DESIGN.md](DESIGN.md) for the protocol, naming, replay, and security rationale.

## Development

From the monorepo root:

```sh
pnpm install
pnpm --filter eve-openai-connectors typecheck
pnpm --filter eve-openai-connectors test
pnpm --filter eve-openai-connectors build
```

The unit suite is offline. Connector-service integration tests are gated by `CODEX_ACCESS_TOKEN`:

```sh
CODEX_ACCESS_TOKEN="<token>" pnpm --filter eve-openai-connectors test:integration
```

Wire-level deferred-mode tests also run when `ANTHROPIC_API_KEY` or `AI_GATEWAY_API_KEY` is set.

## License

[MIT](LICENSE)
