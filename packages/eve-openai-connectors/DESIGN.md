# eve-openai-connectors — Design & Implementation Specification

This document specifies the design of `eve-openai-connectors`, a package that exposes a ChatGPT Enterprise user's authorized connector catalog to an [Eve](https://eve.dev) agent as dynamically discovered tools.

It is written for someone implementing or reviewing the package. [README.md](README.md) is the user-facing guide.

The core protocol claims were validated 2026-08-06 against the live ChatGPT plugin service. The mounted-extension build was validated 2026-08-29 against `eve` 0.45.0. Claims marked *(validated)* were executed against the real endpoint.

---

## 1. Problem and approach

An agent is only as useful as the systems it can reach. The conventional path is to build a connector catalog: an integration per service, an OAuth flow per service, a token store, and ongoing maintenance as each API drifts. That work scales linearly with the number of services and never finishes.

ChatGPT Enterprise users have already done it. Each user authorizes GitHub, Google Drive, Notion, and the rest **once, in ChatGPT**, and those grants live server-side against their ChatGPT account. OpenAI exposes them through a single remote MCP server. If an agent can present the user's ChatGPT workspace credential to that server, it inherits the entire catalog with zero per-service integration work.

That is what this package does. The scope is deliberately narrow:

- **In scope:** speaking the protocol, discovering the catalog, mapping tool names into something the model API accepts, surfacing tools to Eve with progressive discovery, and tiering approvals.
- **Out of scope:** obtaining credentials. The package takes a `getToken(ctx)` callback and never sees how the token was acquired or where it lives. Credential acquisition varies too much by deployment — and carries too much security weight — to bake in.

---

## 2. The connector service

### 2.1 Endpoint and contract

The catalog is a single **streamable-HTTP MCP server** hosted by OpenAI, identifying itself as `plugin-runtime` v0.1.0. All connector fan-out happens server-side inside it, using the OAuth grants stored against the user's ChatGPT account. Nothing connector-related executes on your host, and no per-service credential ever reaches it.

```
POST https://chatgpt.com/backend-api/ps/mcp
Authorization: Bearer <ChatGPT workspace credential>
X-OpenAI-Product-Sku: codex
originator: codex_cli_rs
Content-Type: application/json
Accept: application/json, text/event-stream
```

*(validated)* A plain `fetch`-based MCP client completes `initialize` → `notifications/initialized` → `tools/list` → `tools/call` with no other software involved. Protocol version `2025-06-18`. A live `github.search_repositories` call returns real, user-scoped data — results carry the caller's own repository permissions, confirming the request is executing as that user.

Workspace administrator policy is enforced **server-side, per call**. A malformed call returns an error citing "constraints configured by your ChatGPT workspace admin," which means an organization's connector governance applies automatically without the agent implementing anything.

The endpoint, headers, and auth mode are derived from the open-source [OpenAI Codex CLI](https://github.com/openai/codex) (`codex-rs/codex-mcp/src/mcp/mod.rs`: `CODEX_APPS_MCP_SERVER_NAME`, `codex_apps_mcp_url_for_base_url`, `McpServerAuth::ChatGpt`), which speaks to the same service.

### 2.2 Catalog shape

*(validated, one representative enterprise account)* `tools/list` returns **189 tools in a single response** — `nextCursor` is absent, so there is **no pagination to implement**. Namespaces observed:

| Namespace | Tools |
|---|---:|
| `github` | 89 |
| `google_drive` | 45 |
| `sites` | 28 |
| `notion` | 19 |
| `plugin_management` | 4 |
| `codex_document_control` | 3 |
| `hotline` | 1 |

Each tool carries `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, `_meta`.

*(validated)* **All 189 tools carry `annotations`** with `readOnlyHint`, `destructiveHint`, and `openWorldHint`. **105 are `readOnlyHint: true`**; the remaining 84 are writes. This is load-bearing: approval tiering can be annotation-driven rather than inferred from name patterns.

*(validated)* The longest tool name is **48 characters** (`codex_document_control.get_document_tool_schemas`). Mapping `.` → `_` across all 189 names produces **zero collisions**.

Treat these counts as one account's snapshot, not a fixed contract. The catalog varies by workspace configuration and grows over time; the design must not assume a specific size or namespace set.

### 2.3 Credentials

The bearer must be a **ChatGPT workspace credential with Codex scope**. Two kinds work:

- **Codex access tokens** — long-lived per-user PATs created in the ChatGPT admin console. Admin-gated, expiration-capped, revocable, and attributed to the user in workspace governance. *(validated)* These work as **raw bearers** against this endpoint, requiring no refresh handling.
- **ChatGPT session access tokens** — obtained through an interactive OAuth or device-code flow. Short-lived; refresh is the integrator's problem.

An OpenAI **API key does not work**: it carries no ChatGPT session, so the catalog is unavailable.

The validation that access tokens work as raw bearers is what makes a headless deployment practical — otherwise every integrator would need to reimplement OpenAI's token-refresh machinery.

---

## 3. The tool-name constraint

This constraint dictates the entire architecture, so it comes before the design rather than after it.

**The Claude Messages API requires every tool name to match `^[a-zA-Z0-9_-]{1,64}$`.** Dots are illegal; the ceiling is 64 characters.

Connector tools are dot-namespaced — `github.search_repositories`. Eve builds qualified names for connection tools by direct concatenation (`` `${connection}__${tool}` `` in its `connection-search-dynamic` runtime) with **no sanitization anywhere in the path**. So the natural approach — declare an Eve MCP connection pointed at the endpoint — produces:

```
github.search_repositories  →  chatgpt-connectors__github.search_repositories
```

which the API rejects with a 400. Two independent violations:

1. **The dot.** Every tool in the catalog is affected, with no exceptions.
2. **The length.** Eve derives connection names from filenames and rejects underscores in them, so a descriptive hyphenated name yields roughly a 20-character prefix. Against the 48-character longest tool name that is 68 — over the limit. This is not theoretical headroom; it fails on tools that exist today.

Neither is fixable from within an Eve connection definition. The `tools` filter selects *which* tools are exposed but cannot rename them, and there is no naming hook.

**This failure is invisible to static checks.** A connection-based implementation typechecks and passes `eve build` — the name is only constructed and sent at model-call time. Any test plan for this package must exercise the generated names directly (§8).

The consequence: the package cannot use Eve's connection system. It implements discovery and tool materialization itself, over the same `defineDynamic` primitive Eve uses internally, which gives complete control of naming.

---

## 4. Architecture

```
Consumer agent
   │  agent/extensions/connectors.ts
   │
   ▼
eve-openai-connectors (mounted Eve extension)
   │  defineDynamic (step.started), before every model call:
   │    • client-executed tool search       primary OpenAI discovery
   │    • connectors__search                fallback discovery
   │    • connectors__status                catalog + auth health
   │    • <service>__<tool>                 bounded loaded tools
   │
   │  getToken(ctx) ──► consumer-supplied
   ▼
ChatGPT connector service  ──►  GitHub · Drive · Notion · …
```

Two properties define the shape.

**Client-executed tool search is the default.** A catalog of ~189 tools still makes the initial wire request grow even when its schemas are deferred, because hosted search receives every name and description. The extension therefore advertises one fixed OpenAI `tool_search` marker with `execution: "client"`. A `tool_search_call` carries `{ arguments, call_id }`; the extension searches the current user's authorized catalog and returns `{ tools }`, which the AI SDK emits as `tool_search_output` with the same call id. Only a count- and byte-bounded exact subset is loaded, so initial request size is independent of catalog size.

Every successful search also writes a small Eve `defineState` manifest containing the authority, complete normalized catalog fingerprint, mapped/upstream names, and discovery source. On the next step, those references are joined against the current authorized catalog; schemas, descriptions, annotations, and approval policy come only from that catalog. Catalog or credential drift invalidates the working set and forces a new search. Execution still reauthorizes through the normal connector call path and uses the same approval policy.

**Progressive search remains the fallback.** On providers without OpenAI client tool search, the marker remains a normal bounded search function. With `discovery: "search"`, the model instead sees `connectors__search`, receives exact service-qualified names and short summaries, and calls materialized definitions on the next step. Transcript results never carry schemas or serve as persistence. `discovery: "deferred"` preserves the earlier full-catalog hosted-search behavior as an explicit compatibility mode.

The connector mapper turns the upstream service boundary into the public namespace (`zoom.search_meetings` becomes `zoom__search_meetings`). The Eve patch recognizes only the extension's explicit absolute-name marker, strips it, and leaves every ordinary dynamic extension tool under its mount namespace.

### 4.1 Eve 0.45 patch for provider-native discovery

Eve 0.45.0 does not preserve per-tool `providerOptions` through every durable dynamic-tool hop, automatically add a provider search tool when deferred tools are advertised, or let a dynamic extension publish an explicitly qualified tool name. This monorepo carries an additive pnpm patch at `packages/eve-openai-connectors/patches/eve@0.45.0.patch`. It forwards those options through serialized dynamic metadata and replay, recognizes the extension's private absolute-name marker, recognizes and removes the internal client-search marker, and mounts `openai.tools.toolSearch({ execution: "client" })` with the marker's execute closure. It still injects hosted Anthropic or OpenAI search for explicit deferred mode. The deferred scan examines every tool so an unrelated deferred tool cannot mask a later client marker.

The published package includes that patch, but a dependency cannot modify its consumer's Eve installation. Consumers must copy it into their repository, register it under top-level `patchedDependencies`, and keep Eve pinned to 0.45.0. The patch corresponds to [vercel/eve#1741](https://github.com/vercel/eve/pull/1741) and must be revalidated for every Eve upgrade.

### 4.2 Rejected alternatives

**Eve's native `defineMcpClientConnection`.** The idiomatic option, and the first thing anyone will reach for. Invalid for the reason in §3. Worth stating explicitly so it is not re-attempted.

**A local name-rewriting MCP proxy.** Run an in-process HTTP shim that speaks MCP toward Eve, forwards upstream, and rewrites names in both directions; point a native connection at `localhost`. This preserves Eve's native machinery and passes the bearer straight through. Rejected because it requires implementing the MCP **server** side in addition to the client side — session-id relaying, SSE fallback, framing — for a protocol we otherwise only consume, plus a port to manage and a self-referential HTTP hop. Roughly double the protocol surface to save a modest amount of discovery code. Reconsider only if Eve adds a tool-naming hook, which would make the native path viable outright.

**Eager tool exposure.** Skipping discovery and exposing all tools directly. Fails on context budget, and would make every unrelated request more expensive.

---

## 5. Components

The package is a built Eve extension. Its authored contribution lives in `extension/tools/connectors.ts`; protocol, catalog, replay, naming, and policy code live under `extension/lib/`.

### 5.1 `protocol` — MCP-over-HTTPS client

A minimal streamable-HTTP MCP client with no dependencies beyond `fetch`.

- `initialize()`, `listTools()`, `callTool(name, args, { signal })`, `close()`.
- Request shape exactly as §2.1. If the server returns an `Mcp-Session-Id` header, echo it on subsequent requests; tolerate its absence (*(validated)* the observed deployment did not return one).
- **Response bodies may be `application/json` or `text/event-stream`.** Handle both — for SSE, scan `data:` lines and take the frame carrying `result` or `error`. This is not optional; it varies by deployment and is a silent failure if missed.
- Map JSON-RPC errors to a typed `ConnectorProtocolError` with `code` and `message`. Map HTTP 401/403 to a distinct `ConnectorAuthError` so callers can surface "token invalid or expired" instead of a generic failure.
- Timeouts: 30s for `initialize` and `tools/list`, 60s for `tools/call`, always with an `AbortSignal`.
- **Never log the token. Never log tool arguments or results** — they carry user data from Drive, Notion, and GitHub. Log tool name, duration, and outcome only.

### 5.2 `config` — options and the credential seam

The extension validates mount configuration with a synchronous Zod schema, then passes the connector-specific options to `createConnectors`. The only required option is `getToken(ctx)`.

`getToken` is the single credential surface. It is called per operation, so integrators can rotate tokens without a restart. It returns `string | null`; `null` means "this user has no access," which must flow through as a clean no-op rather than an error. Failures inside `getToken` are caught, logged once per principal, and treated as `null` — a broken credential lookup must never break the agent. `protocolClientLifetime: "operation"` retains only a credential hash and authorization inventory between calls; every network operation creates and closes its token-bearing client in `finally`.

The bounded integration hooks are lifecycle-specific: `transformCallInput` can alter arguments only after current-catalog reauthorization; `onAuthError` runs after package state invalidation and receives no token, arguments, results, or response body; `onResolution` runs at most once per step with status, discovery mode, and counts only. Hook failures cannot replace connector errors or break resolution. Eve's `abortSignal` is threaded through every network path, and cancellation is never negatively cached.

The package must not read files, environment variables, or secret stores for credentials. That belongs to the integrator.

### 5.3 `catalog` — inventory, naming, search

**Split authorization and immutable content caches.** Per-user state is keyed by a principal identifier — derived by default from `ctx.session.auth` using Eve's convention (`user:<issuer>:<principalId>`), overridable via `getPrincipal(ctx)` — with `inventoryTtlMs` (default 5 minutes). It retains only the current token/client state and a reference to that principal's authorized catalog. Concurrent loads are deduplicated; failures are cached briefly (~30s); principal and client maps are size-bounded. Credential rotation invalidates only that principal's protocol session and inventory, and stale in-flight loads cannot repopulate it.

Normalized catalogs are SHA-256 content-addressed after applying the tool prefix, name limit, service allowlist/denylist, and complete upstream tool metadata. Both service policies run before fingerprinting and materialization, so an excluded service cannot be recovered through search, deferred discovery, status, direct generated names, or stale durable state. A process-wide bounded interner retains frozen descriptor arrays and deeply frozen raw input-schema objects. Equivalent catalogs therefore hit Eve's schema identity cache even when they came from different principals or tokens; annotation, filter, prefix, or metadata divergence produces a distinct content address. A second bounded cache reuses connector-scoped `defineTool()` records for an unchanged catalog, avoiding per-step rematerialization without sharing execution clients or approval policies across connector configurations. Aggregate hit, miss, entry, eviction, and estimated-byte metrics contain no principal, token, or schema labels.

**Name mapping — the load-bearing part.**

```
serviceName(upstream) = upstream.slice(0, upstream.indexOf("."))
toolName(upstream)    = serviceName(upstream) + "__" + sanitizedOperation(upstream)
```

- The first upstream dotted segment is the service namespace; remaining dots and illegal characters in the operation are sanitized to `_`.
- Complete names are capped at 64 characters.
- *(validated)* Zero collisions today. Handle them anyway, deterministically: sort upstream names, first wins, log the dropped name at warn level. A collision must never produce a mapping that differs between restarts.
- If a name would exceed 64 characters, truncate it and append `_` plus the first 6 hex characters of the SHA-256 of the **full upstream name**. Deterministic across processes; no counters, no state.
- Sanitize any character outside `[a-zA-Z0-9_-]` to `_` as a final pass, in case a future connector introduces one.

**The reverse mapping must be authoritative — never reconstruct it by string surgery.** `google_drive_foo` is ambiguous: it could be `google_drive.foo` or `google.drive_foo`. The exact `upstream` string travels alongside every mapped name in the inventory and durable reference manifest, but is not exposed in the compact model-facing search result. **Any code that derives the dotted name by splitting on `_` is a bug.**

**`search(inventory, { service?, keywords, limit })`.** Token-overlap scoring: tokenize on `[\s_\-./]+`, drop tokens of length ≤ 1, score 3 per name-token hit and 1 per description-token hit, sort descending, take `limit`. If `service` is given but unknown, throw an error listing the available services — a wrong service name should be self-correcting for the model.

Each current-catalog item used internally is exactly:

```ts
{
  name: string;          // github__search_repositories (exact callable name)
  upstream: string;      // github.search_repositories  ← authoritative reverse mapping
  service: string;       // github
  description: string;
  inputSchema: object;   // as returned upstream; {type:"object"} when absent
  readOnly: boolean;     // annotations.readOnlyHint
  destructive: boolean;  // annotations.destructiveHint
}
```

Search returns two views inside the executor: these complete current-catalog items for the state update, and a model-facing `{ loaded: [{ name, summary }] }` value. Only `{ name, upstream, source }` references enter the durable manifest. Callable definitions are reconstructed by joining those references with a matching current catalog, never from the model-visible result or manifest alone.

### 5.4 `policy` — approval tiering

Annotation-driven, failing closed:

| Condition | Treatment |
|---|---|
| `readOnlyHint === true` | Auto-allow. Covers 105 of 189 tools in the observed catalog. |
| Write, `destructiveHint === false` | Require human approval. |
| `destructiveHint === true` | Require human approval, flagged destructive. |
| Annotations missing or unparseable | **Treat as a destructive write.** Never assume read-only. |

Exposed as `approvalFor(item)`, overridable so integrators can insert their own gate — for example an LLM review before the human prompt.

Two notes from the Eve approval and dynamic-tool contracts:

- **Eve's approval channel has no severity flag.** `ApprovalStatus` is `"user-approval"` / `"not-applicable"` / `"denied"` (and the `"user-approval"` object form explicitly forbids a `reason`), so "flagged destructive" cannot travel through the approval API. The destructive tier is instead surfaced by tagging the materialized tool's *description* (`[destructive write — requires approval]`), which both the model and any approval UI can see.
- **A declarative layer sits between the default and a custom `approvalFor`.** `approvals: { mode: "simple" }` (default) is the table above; `mode: "detailed"` takes ordered rules matched by glob against the upstream dotted name (`github.delete_*` → `deny` / `approve` / `allow`), with unmatched tools falling back to the simple policy. A custom `approvalFor` overrides both.

Approval is only honored by Eve for **step-scoped** dynamic tools, whose live `execute` closures survive into the harness; session- and turn-scoped tools replay from durable metadata and cannot carry a function across replay. This is a further reason the resolver is `step.started` (§5.5).

`openWorldHint` is not used for tiering — it signals the tool reaches external entities, which informs §7.1 but does not change who approves.

### 5.5 The `step.started` resolver

Composed inside the extension from `connectors.begin`, `connectors.search`, `connectors.call`, and `connectors.approvalFor`. The contract, in order, with a hard rule that **the resolver never throws**:

1. Return `null` immediately when disabled, when there is no principal, or when `getToken` yields `null`. These are the common paths and must cost nothing.
2. Attempt an inventory load under a short overall budget (~5s). **On failure, do not return `null`** — continue to step 4 with an empty catalog and no materialized connector tools. Durable references are never treated as authority without a current catalog. Log once per principal.
3. In default client mode, emit one relative `client_tool_search` marker. The Eve patch replaces it with OpenAI's client-executed provider tool while retaining its execute closure. Search input is validated strictly, catalog lookup is latency-bounded, result count uses `searchLimitMax`, and serialized output uses `clientSearchMaxBytes`.
4. Outside client mode, emit relative `search` and optional `status` control entries. Eve qualifies them with the extension mount (`connectors__search` and `connectors__status` in the recommended setup). Search results return exact service-qualified connector names. Client mode omits both so its cold extension contribution is exactly one search tool.
5. Read the extension-owned working set, require its authority and catalog fingerprint to match, and join each mapped/upstream reference against the current catalog. Keep the manifest and materialized set capped at `maxMaterializedTools` (default 30), deterministically ordered with the newest search's relevance order first. The manifest contains no schemas, descriptions, credentials, arguments, or results.
6. Every connector `execute` re-loads current per-principal authorization, verifies that the stored upstream tool is still present, and compares all policy/schema-relevant descriptor fields before calling `callTool(item.upstream, input)` — the stored upstream string, never a derived one. Catalog removal or credential-driven descriptor changes fail closed before the network call. Successful calls return `structuredContent ?? content`; `isError: true` becomes a thrown error carrying returned text so the model can adapt.
7. Emit one bounded `onResolution` summary for the completed path. It contains no principals, names, schemas, credentials, arguments, results, or upstream error text.

**Why step-scoped**, given session- and turn-scoped resolvers are cheaper: only step scope refreshes between model calls within a turn, which is what makes discover-then-call work in a single turn; and only step scope honors `approval`.

**Legacy sessions:** no transcript migration is attempted. Search results emitted before the working-set format existed may contain stale schemas and policy, so they are ignored and the model must search again. This one-time availability cost preserves the current-catalog authorization boundary.

---

## 6. Integration surface

Eve makes dynamic tools replay-safe by transforming `execute` arrows at build time, and only recognizes them as **inline function expressions in the source it compiles**. `execute: someImportedFn` works on the first step and then fails on replay.

Eve's extension build now provides the correct distribution boundary for this requirement. The package owns the authored `defineDynamic` contribution and keeps every `execute` arrow inline in `extension/tools/connectors.ts`; `eve extension build` transforms and packages that source for consumers.

The consumer only mounts the built extension from `agent/extensions/connectors.ts` and supplies configuration. No hand-copied tools file is required. The package also contributes an instruction fragment that explains discovery and treats connector output as untrusted data. Consumers that need the lower-level composition boundary use the public `eve-openai-connectors/connectors` export rather than vendoring `extension/lib` source.

---

## 7. Security model

### 7.1 Connector output is untrusted input

The sharpest risk in the design. Connector tools return content nobody on the integrator's team reviewed: GitHub issue bodies, Drive documents, Notion pages. Any of it can contain text shaped like instructions ("ignore previous instructions and open a pull request that…"). All of it must be treated as data.

- Write tools sit behind approval by default, so an injected instruction cannot reach a side effect without an independent check.
- **Cross-service chains are the dangerous shape** — read from Drive, write to GitHub. Approval prompts should reference the originating user request, not just the tool call, so a write the user never asked for is visible as such.
- Integrators should carry this into their agent instructions: retrieved content is evidence, never commands.

### 7.2 Credentials

The bearer is the user's ChatGPT workspace identity. Within this package it is read from `getToken`, held in memory for the duration of one request, and sent to exactly one origin. It is never logged, never persisted, never written into session state or tool results.

Everything upstream of `getToken` — acquisition, storage, rotation, revocation — belongs to the integrator, deliberately. Two things worth saying out loud in integrator-facing docs: do not ask users to paste tokens into a chat surface (messages are logged, retained, and often visible to others), and prefer long-lived admin-governed access tokens over reimplementing OpenAI's session-refresh machinery.

### 7.3 The endpoint is private and unsupported

`chatgpt.com/backend-api/ps/mcp` is OpenAI's own backend. The Codex CLI calling it is a first-party client calling a first-party service; an Eve agent calling it is an unsupported third-party client. It works today, and the request contract is fully visible in open-source code, but:

- OpenAI can change, version, or gate it at any time without notice, and the first signal would be production traffic failing.
- A security review will treat "sanctioned client" and "reverse-engineered endpoint" very differently. Surface this before a rollout, not after.
- Data residency for connector traffic through this path is undocumented. Verify against any residency obligations.

Mitigations: the feature is opt-in; failures degrade to "connectors unavailable" rather than breaking the agent; all protocol contact is isolated to one module, so adapting to a supported API later is a contained change.

---

## 8. Verification plan

Ordered so failures surface as early and cheaply as possible.

> **Status (2026-08-29):** steps 1–5 are implemented in the offline unit suite; step 6 is `scripts/probe.mjs`, previously executed live against the real endpoint with 189 tools and a read-only call; step 7 includes a successful `eve extension build` and durable callback replay test against Eve 0.45.0. A model-backed mounted-agent fixture remains future work.

1. **Name mapping (offline, no network).** Run a recorded catalog snapshot through the mapper: assert every output matches `^[a-zA-Z0-9_-]{1,64}$`, the mapping is injective, round-tripping through the stored `upstream` recovers the original exactly, and a synthetic 70-character name yields a stable hashed form. **Write this test first** — it is the one that catches the §3 failure class, which every static check misses.
2. **Policy tiering.** Read-only auto-allows; write requires approval; destructive escalates; **absent annotations are treated as destructive**.
3. **Resolver resilience.** With a catalog stub that throws, the resolver returns search metadata but no tools from durable state or synthetic transcript history, and never throws. With `getToken` returning `null`, it returns `null` without touching the network.
4. **Protocol client.** Against a local fake MCP server: JSON and SSE response bodies both parse; `Mcp-Session-Id` is echoed when present and omitted when absent; 401 maps to `ConnectorAuthError`; `isError: true` results throw with the upstream text.
5. **Client tool search and durable working set.** Assert the patched Eve bridge emits `openai.tool_search` with `execution: "client"`, the initial serialized provider tool is identical for synthetic 10- and 200-tool catalogs, malformed/no-match/oversized/unauthorized/stale/failing searches fail closed, and latency is bounded. Assert the reference-only manifest survives Eve serialization, opaque transcript compaction, turns, and cold-worker replay; principal/catalog changes, removed tools, outages, duplicate discoveries, and caps fail closed or remain bounded as appropriate.
6. **Bounded integration hooks.** Assert service exclusion before fingerprint/materialization and direct network calls; live-descriptor transform ordering; auth invalidation before a callback that cannot replace the original error; one schema-free resolution summary; cancellation without negative caching; and operation-client cleanup after success, tool error, auth rejection, and abort.
7. **Live integration.** A probe script against a real token: initialize, list, namespace counts, one read-only call. Not a unit test — an operational tool for verifying a token and endpoint health.
8. **End-to-end in a real Eve agent.** Mount the package as `openai`, drive a session that performs `tool_search` and then calls a loaded read-only tool, and **assert on the complete tools payload the model API actually receives**. The first request must contain no connector catalog names or schemas; the subsequent request must contain only the selected definitions.

---

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Private endpoint changes or is gated | High | Opt-in; graceful degradation; protocol isolated to one module; probe script for fast diagnosis |
| Prompt injection via connector content | High | Untrusted-data framing in docs; approval required on every write; approval prompts reference the originating request |
| Catalog grows past the 64-character budget | Low | Service-qualified names use deterministic hash truncation; asserted in tests |
| Tool-name collisions from a future connector | Low | Deterministic sorted first-wins with a warn log; injectivity asserted in tests |
| Workspace policy blocks parts of the catalog | Low | Server-side enforcement is expected behavior; the mount-qualified status tool surfaces catalog health |
| Client or progressive search changes the tool set between steps | Medium | Reference-only durable state is count-bounded, catalog-versioned, authority-bound, and joined against current authorization before materialization |
| A large or slow client-search response expands latency/context | Medium | `searchLimitMax`, `clientSearchMaxBytes`, and `clientSearchTimeoutMs` impose independent bounds |
| Eve patch drifts on upgrade | Medium | Eve is pinned exactly; the patch is registered through pnpm and shipped with the package; revalidate against upstream PR #1741 before upgrading |
| Integrator supplies an OpenAI API key | Low | Documented prominently; an authentication failure is visible through the mount-qualified status tool |

---

## 10. Open questions

- **Catalog variance across workspaces.** All counts here come from one enterprise account. Namespace sets and annotation coverage should be confirmed against a second workspace before publishing, so nothing hard-codes an assumption.
- ~~**Should status be optional?**~~ Resolved: `includeStatus` is configurable and defaults on; the extension omits the tool when disabled.
- **Connector authorization.** When a connector is unauthorized, ChatGPT exposes an install URL through a separate, experimental API this package does not speak. Surfacing "authorize it here" would be a real UX improvement — worth revisiting if that API stabilizes.
