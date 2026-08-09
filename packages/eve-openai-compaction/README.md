# eve-openai-compaction

`eve-openai-compaction` provides a remote Codex-style compaction strategy for
[Eve](https://eve.dev). It sends the current transcript to OpenAI's stateless
`/responses/compact` endpoint and carries the returned opaque encrypted
checkpoint into the next Eve model call.

There is deliberately no local prose-summary fallback. A remote failure fails
the compaction attempt.

## Compatibility

The package targets `eve@0.31.3`, `ai@7`, and `@ai-sdk/openai@4`. It requires
the included Eve patch to expose custom compaction strategies.

The package also ships `patches/eve@0.31.3-source.patch`, the reviewable
TypeScript source patch with focused Eve tests. The installable pnpm patch
targets Eve's published `dist` files.

The continuation model must be an OpenAI Responses model configured with
`providerOptions.openai.store: false`. AI SDK then replays the encrypted
checkpoint instead of trying to reference a server-stored item by ID.

## Install

```sh
pnpm add eve-openai-compaction @ai-sdk/openai
mkdir -p patches
cp node_modules/eve-openai-compaction/patches/eve@0.31.3.patch patches/eve@0.31.3.patch
```

Register the patch in `pnpm-workspace.yaml`:

```yaml
patchedDependencies:
  eve@0.31.3: patches/eve@0.31.3.patch
```

Then run `pnpm install`. pnpm permits only one patch entry per package version;
combine unified diffs if the application already patches `eve@0.31.3`.

## Use

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { codexRemoteCompaction } from "eve-openai-compaction";

const openai = createOpenAI();

export default defineAgent({
  model: openai.responses("gpt-5.3-codex"),
  modelOptions: {
    providerOptions: {
      openai: { store: false },
    },
  },
  compaction: {
    strategy: codexRemoteCompaction(),
    thresholdPercent: 0.9,
  },
});
```

By default, the compaction request reads `OPENAI_API_KEY` only when compaction
runs. To use workload identity or a secret manager, resolve credentials at the
last responsible moment:

```ts
strategy: codexRemoteCompaction({
  apiKey: async () => await resolveShortLivedOpenAIToken(),
  headers: async () => ({ "OpenAI-Project": await resolveProjectId() }),
})
```

Do not put credentials in source, logs, argv, persisted Eve context, or static
provider options.

## Strategy

The package follows Codex CLI 0.144.6's remote-v2 replacement shape:

1. Use AI SDK's OpenAI Responses serializer to turn Eve's full `ModelMessage`
   history and current system instructions into Responses input items.
2. POST that window to the official stateless `/responses/compact` endpoint.
3. Require exactly one valid opaque compaction item. Never decrypt or convert
   it to prose.
4. Retain the newest genuine user messages under Codex's 64,000-token budget,
   preserving images and midpoint-truncating the text at the budget boundary.
5. Replace Eve history with those user messages and an AI SDK
   `openai.compaction` custom part containing the encrypted checkpoint.

The 64k client-retention behavior is pinned to Codex
[`compact_remote_v2.rs`](https://github.com/openai/codex/blob/1e66aaa95b5ab39d3ef3057cd50bdecd576a8356/codex-rs/core/src/compact_remote_v2.rs).
The remote checkpoint semantics and canonical output are documented in the
official OpenAI [compaction guide](https://developers.openai.com/api/docs/guides/compaction).

Eve re-applies its current framework-owned post-compaction state after the
strategy returns, and its current system instructions remain outside durable
message history.
