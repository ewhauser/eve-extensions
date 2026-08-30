# eve-openai-imagegen

`eve-openai-imagegen` gives an [Eve](https://eve.dev) agent a Codex-style
image workflow backed directly by OpenAI's `gpt-image-2` Image API. The
extension packages a load-on-demand imagegen skill and a typed tool that:

- generates an image from a prompt when no references are supplied;
- edits or composites one or more images when sandbox paths are supplied;
- saves the result under `/workspace/generated_images` by default; and
- returns the image as an Eve content part so a vision-capable agent can
  inspect it and make targeted follow-up edits.

This uses the application owner's OpenAI API credentials and API billing. It
does not use ChatGPT or Codex included usage.

## Compatibility

The package targets Node.js 24 or newer and `eve@0.45.0`. It calls the official
`/v1/images/generations` and `/v1/images/edits` endpoints with
`model: "gpt-image-2"`.

Your OpenAI organization may need
[API organization verification](https://help.openai.com/en/articles/10910291-api-organization-verification)
before it can use GPT Image models. See OpenAI's
[image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
for supported formats, current limits, and pricing behavior.

## Install and mount

```sh
pnpm add eve-openai-imagegen
```

Mount the extension as `imagegen`:

```ts title="agent/extensions/imagegen.ts"
import imagegen from "eve-openai-imagegen";

export default imagegen({});
```

By default, the API key is read from `OPENAI_API_KEY` only when the tool runs.
Do not place the key in source, tool input, prompts, logs, argv, or persisted
Eve state.

For workload identity, a secret manager, project routing, or a controlled
transport, resolve configuration at the last responsible moment:

```ts title="agent/extensions/imagegen.ts"
import imagegen from "eve-openai-imagegen";

export default imagegen({
  apiKey: async () => await resolveShortLivedOpenAIToken(),
  headers: async () => ({
    "OpenAI-Project": await resolveOpenAIProjectId(),
  }),
  quality: "auto",
  size: "auto",
});
```

The `apiKey` and `headers` resolvers run for each API call and their return
values are not placed in the tool result.

## Agent behavior

Eve advertises the packaged `imagegen` skill and loads it on demand. Mounted as
shown above, the runtime tool name is `imagegen__imagegen`.

For a new image the agent calls the tool with only a prompt:

```json
{
  "prompt": "Draw a warm editorial illustration of a reading nook. No text."
}
```

For an edit or a reference-based generation, it adds sandbox paths:

```json
{
  "prompt": "Edit the first image: keep the subject and composition unchanged; replace only the background with a quiet snowy forest.",
  "referenced_image_paths": [
    "/workspace/attachments/0123456789abcdef/source.png"
  ]
}
```

Inbound Eve attachments are staged under `/workspace/attachments`. Generated
files use the durable Eve tool-call ID as their filename, so replay after a
completed write reuses the same artifact instead of charging for another
generation. The skill instructs the agent to pass a generated image's returned
path into a later call for iterative editing.

The tool always requests one final image. For multiple distinct assets or
variants, the agent makes one tool call per asset, matching Codex's workflow.

## Configuration

All fields are optional:

| Field | Default | Purpose |
| --- | --- | --- |
| `apiKey` | `OPENAI_API_KEY` at execution time | Async API-key resolver. |
| `baseURL` | `https://api.openai.com/v1` | OpenAI-compatible API root. |
| `fetch` | `globalThis.fetch` | Controlled transport or test double. |
| `headers` | none | Late-bound additional request headers. |
| `moderation` | `auto` | OpenAI moderation mode: `auto` or `low`. |
| `outputDirectory` | `generated_images` | Sandbox-relative artifact directory. |
| `outputFormat` | `png` | `png`, `jpeg`, or `webp`. |
| `outputCompression` | `100` | JPEG/WebP compression value from 0–100. |
| `quality` | `auto` | `auto`, `low`, `medium`, or `high`. |
| `size` | `auto` | `auto` or a valid GPT Image 2 `WIDTHxHEIGHT`. |

Explicit dimensions are checked locally against GPT Image 2's documented
constraints: edges must be multiples of 16, the maximum edge is 3840 px, the
aspect ratio is at most 3:1, and the total pixel count must be between 655,360
and 8,294,400.

## Boundaries

- `gpt-image-2` does not currently support transparent output. The extension
  requests `background: "auto"` and does not silently switch models.
- Input references must be PNG, JPEG, or WebP files in the Eve sandbox. The
  tool validates magic bytes, the documented 50 MiB per-file limit, and a
  50 MiB combined limit that bounds extension memory use while constructing
  multipart edit requests.
- The returned image is persisted in Eve history so the model can inspect it.
  Large images therefore increase durable session size and subsequent
  vision-input costs; prefer `quality: "low"` for drafts.
- A successful API response must contain exactly one base64 image. Malformed
  responses and API errors are surfaced with the OpenAI request ID when
  available.
- User-correctable errors such as `moderation_blocked` are not retried
  automatically. A network interruption after OpenAI finishes but before the
  sandbox write can still cause a repeated request when Eve resumes the step.

## Development

Offline tests use an injected Fetch implementation and never call OpenAI:

```sh
pnpm --filter eve-openai-imagegen typecheck
pnpm --filter eve-openai-imagegen test
pnpm --filter eve-openai-imagegen build
```

The live smoke test is explicitly opt-in because it uses API quota and incurs
API charges:

```sh
EVE_RUN_OPENAI_IMAGEGEN_INTEGRATION=1 \
OPENAI_API_KEY=... \
pnpm --filter eve-openai-imagegen test:integration
```
