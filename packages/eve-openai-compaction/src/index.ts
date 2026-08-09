import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type ModelMessage } from "ai";
import type { AgentCompactionStrategy, AgentCompactionStrategyInput } from "eve";

/** Codex CLI's remote-v2 retained-message budget at version 0.144.6. */
export const DEFAULT_RETAINED_USER_MESSAGE_TOKENS = 64_000;

/** Request credentials and transport are resolved only when compaction runs. */
export interface CodexRemoteCompactionOptions {
  /** Resolves the OpenAI API key. Defaults to the server-side `OPENAI_API_KEY`. */
  readonly apiKey?: () => string | PromiseLike<string>;
  /** OpenAI-compatible API root. Defaults to `https://api.openai.com/v1`. */
  readonly baseURL?: string;
  /** Injects a transport for tests, workload identity, or a controlled proxy. */
  readonly fetch?: typeof globalThis.fetch;
  /** Resolves additional request headers without persisting them in Eve state. */
  readonly headers?: () =>
    | Record<string, string | undefined>
    | PromiseLike<Record<string, string | undefined>>;
  /** Model passed to `/responses/compact`; inferred from the Eve model when omitted. */
  readonly model?: string;
  /** Approximate-token budget for recent genuine user messages. */
  readonly retainedUserMessageTokens?: number;
}

interface CompactionItem {
  readonly encrypted_content: string;
  readonly id: string;
  readonly type: "compaction";
}

interface CompactResponse {
  readonly created_at?: number;
  readonly id?: string;
  readonly object?: string;
  readonly output: readonly unknown[];
  readonly usage?: {
    readonly input_tokens: number;
    readonly input_tokens_details?: {
      readonly cache_write_tokens?: number | null;
      readonly cached_tokens?: number | null;
    } | null;
    readonly output_tokens: number;
    readonly output_tokens_details?: {
      readonly reasoning_tokens?: number | null;
    } | null;
  };
}

interface PreparedOptions {
  readonly apiKey?: CodexRemoteCompactionOptions["apiKey"];
  readonly baseURL?: string;
  readonly fetch: typeof globalThis.fetch;
  readonly headers?: CodexRemoteCompactionOptions["headers"];
  readonly model?: string;
  readonly retainedUserMessageTokens: number;
}

/**
 * Creates a remote-only Eve compaction strategy backed by OpenAI's stateless
 * `/responses/compact` endpoint. Remote failures are surfaced; there is no
 * prose-summary fallback.
 */
export function codexRemoteCompaction(
  options: CodexRemoteCompactionOptions = {},
): AgentCompactionStrategy {
  const retainedUserMessageTokens =
    options.retainedUserMessageTokens ?? DEFAULT_RETAINED_USER_MESSAGE_TOKENS;
  if (!Number.isSafeInteger(retainedUserMessageTokens) || retainedUserMessageTokens < 0) {
    throw new TypeError("retainedUserMessageTokens must be a non-negative safe integer");
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A Fetch API implementation is required for remote compaction");
  }

  const prepared: PreparedOptions = {
    fetch: fetchImplementation,
    retainedUserMessageTokens,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };

  return async (input) => compactRemotely(input, prepared);
}

async function compactRemotely(
  input: AgentCompactionStrategyInput,
  options: PreparedOptions,
): Promise<ModelMessage[]> {
  assertStatelessOpenAIContinuation(input.continuationProviderOptions);

  const modelId = options.model ?? inferOpenAIModelId(input.model);
  const apiKey = await options.apiKey?.();
  const headers = stripUndefinedHeaders(await options.headers?.());
  let compactResponse: CompactResponse | undefined;

  const compactionFetch: typeof globalThis.fetch = async (request, init) => {
    const requestBody = parseRequestBody(init?.body);
    const compactBody = compactRequestBody(requestBody);
    const response = await options.fetch(compactEndpoint(request), {
      ...init,
      body: JSON.stringify(compactBody),
    });
    if (!response.ok) return response;

    compactResponse = parseCompactResponse(await response.json());
    return syntheticGenerateResponse({
      compactResponse,
      headers: response.headers,
      modelId,
    });
  };

  const providerSettings: Parameters<typeof createOpenAI>[0] = {
    fetch: compactionFetch,
  };
  if (apiKey !== undefined) providerSettings.apiKey = apiKey;
  if (options.baseURL !== undefined) providerSettings.baseURL = options.baseURL;
  if (headers !== undefined) providerSettings.headers = headers;

  const openai = createOpenAI(providerSettings);
  await generateText({
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    messages: [...input.messages],
    model: openai.responses(modelId),
    providerOptions: {
      ...input.providerOptions,
      openai: { ...input.providerOptions?.openai, store: false },
    },
    system: input.system,
  });

  if (compactResponse === undefined) {
    throw new Error("OpenAI compaction transport completed without a compact response");
  }
  const compaction = expectSingleCompactionItem(compactResponse.output);

  return [
    ...selectRetainedUserMessages(input.messages, options.retainedUserMessageTokens),
    compactionMessage(compaction),
  ];
}

function assertStatelessOpenAIContinuation(
  providerOptions: AgentCompactionStrategyInput["continuationProviderOptions"],
): void {
  const openai = providerOptions?.openai;
  if (openai === undefined || openai.store !== false) {
    throw new Error(
      "Remote compaction requires modelOptions.providerOptions.openai.store to be false so the encrypted checkpoint is replayed instead of referenced by ID",
    );
  }
}

function inferOpenAIModelId(model: AgentCompactionStrategyInput["model"]): string {
  const raw =
    typeof model === "string"
      ? model
      : "modelId" in model && typeof model.modelId === "string"
        ? model.modelId
        : undefined;
  if (raw === undefined || raw.length === 0) {
    throw new Error("Unable to infer the OpenAI compaction model; set codexRemoteCompaction({ model })");
  }
  return raw.startsWith("openai/") ? raw.slice("openai/".length) : raw;
}

function parseRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("Expected the AI SDK OpenAI transport to produce a JSON request body");
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected the AI SDK OpenAI transport to produce a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function compactRequestBody(request: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    input: request.input,
    model: request.model,
  };
  if (request.instructions !== undefined) compact.instructions = request.instructions;
  if (request.service_tier !== undefined) compact.service_tier = request.service_tier;
  return compact;
}

function compactEndpoint(request: Parameters<typeof globalThis.fetch>[0]): string {
  const raw =
    typeof request === "string"
      ? request
      : request instanceof URL
        ? request.href
        : request.url;
  const url = new URL(raw);
  if (!url.pathname.endsWith("/responses")) {
    throw new Error(`Expected an OpenAI Responses request URL, received ${url.pathname}`);
  }
  url.pathname = `${url.pathname}/compact`;
  return url.href;
}

function parseCompactResponse(value: unknown): CompactResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OpenAI /responses/compact returned a non-object response");
  }
  const response = value as Partial<CompactResponse>;
  if (!Array.isArray(response.output)) {
    throw new Error("OpenAI /responses/compact response did not contain an output array");
  }
  return response as CompactResponse;
}

function expectSingleCompactionItem(output: readonly unknown[]): CompactionItem {
  const items = output.filter(
    (item): item is CompactionItem =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "compaction" &&
      "id" in item &&
      typeof item.id === "string" &&
      "encrypted_content" in item &&
      typeof item.encrypted_content === "string",
  );
  if (items.length !== 1) {
    throw new Error(
      `OpenAI /responses/compact returned ${items.length} valid compaction items; expected exactly one`,
    );
  }
  return items[0]!;
}

function syntheticGenerateResponse(input: {
  readonly compactResponse: CompactResponse;
  readonly headers: Headers;
  readonly modelId: string;
}): Response {
  const headers = new Headers(input.headers);
  headers.set("content-type", "application/json");
  return new Response(
    JSON.stringify({
      created_at: input.compactResponse.created_at ?? Math.floor(Date.now() / 1_000),
      id: input.compactResponse.id ?? "resp_compaction_transport",
      model: input.modelId,
      output: [
        {
          content: [
            {
              annotations: [],
              logprobs: [],
              text: "Remote compaction completed.",
              type: "output_text",
            },
          ],
          id: "msg_compaction_transport",
          phase: null,
          role: "assistant",
          status: "completed",
          type: "message",
        },
      ],
      usage: input.compactResponse.usage,
    }),
    { headers, status: 200 },
  );
}

function compactionMessage(item: CompactionItem): ModelMessage {
  return {
    content: [
      {
        kind: "openai.compaction",
        providerOptions: {
          openai: {
            encryptedContent: item.encrypted_content,
            itemId: item.id,
            type: "compaction",
          },
        },
        type: "custom",
      },
    ],
    role: "assistant",
  };
}

function selectRetainedUserMessages(
  messages: readonly ModelMessage[],
  maxTokens: number,
): ModelMessage[] {
  const users = messages.filter(
    (message): message is Extract<ModelMessage, { role: "user" }> => message.role === "user",
  );
  const retained: Extract<ModelMessage, { role: "user" }>[] = [];
  let remaining = maxTokens;

  for (let index = users.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = users[index]!;
    const tokenCount = Math.max(1, userMessageTokenCount(message));
    if (tokenCount <= remaining) {
      retained.push(message);
      remaining -= tokenCount;
      continue;
    }
    const truncated = truncateUserMessage(message, remaining);
    if (truncated !== undefined) retained.push(truncated);
    remaining = 0;
  }

  retained.reverse();
  return retained;
}

function userMessageTokenCount(message: Extract<ModelMessage, { role: "user" }>): number {
  if (typeof message.content === "string") return approximateTokenCount(message.content);
  return message.content.reduce(
    (tokens, part) => tokens + (part.type === "text" ? approximateTokenCount(part.text) : 0),
    0,
  );
}

function truncateUserMessage(
  message: Extract<ModelMessage, { role: "user" }>,
  maxTokens: number,
): Extract<ModelMessage, { role: "user" }> | undefined {
  if (typeof message.content === "string") {
    return { ...message, content: truncateMiddleToTokenBudget(message.content, maxTokens) };
  }

  let remaining = maxTokens;
  const content: typeof message.content = [];
  for (const part of message.content) {
    if (part.type !== "text") {
      content.push(part);
      continue;
    }
    if (remaining === 0) continue;
    const tokenCount = approximateTokenCount(part.text);
    if (tokenCount <= remaining) {
      remaining -= tokenCount;
      content.push(part);
      continue;
    }
    const text = truncateMiddleToTokenBudget(part.text, remaining);
    remaining = 0;
    if (text.length > 0) content.push({ ...part, text });
  }
  return content.length === 0 ? undefined : { ...message, content };
}

function stripUndefinedHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function approximateTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function truncateMiddleToTokenBudget(text: string, maxTokens: number): string {
  const maxBytes = maxTokens * 4;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (maxTokens > 0 && totalBytes <= maxBytes) return text;

  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const left = takeUtf8Prefix(text, leftBudget);
  const right = takeUtf8Suffix(text, rightBudget);
  const removedTokens = Math.ceil(Math.max(0, totalBytes - maxBytes) / 4);
  return `${left}…${removedTokens} tokens truncated…${right}`;
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function takeUtf8Suffix(text: string, maxBytes: number): string {
  const characters = [...text];
  let result = "";
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result = character + result;
    bytes += size;
  }
  return result;
}
