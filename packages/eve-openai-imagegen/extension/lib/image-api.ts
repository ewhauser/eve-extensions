import { basename } from "node:path";

import type {
  GeneratedImage,
  ImagegenClientOptions,
  ImagegenRequest,
  ImageOutputFormat,
  ImageUsage,
  InputImage,
} from "./types.js";

export const GPT_IMAGE_2_MODEL = "gpt-image-2" as const;
export const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;

interface ImageDataItem {
  readonly b64_json?: unknown;
  readonly revised_prompt?: unknown;
}

interface ImageResponseBody {
  readonly created?: unknown;
  readonly data?: unknown;
  readonly usage?: unknown;
}

interface ErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly moderation_details?: unknown;
    readonly type?: unknown;
  };
}

export class OpenAIImagegenError extends Error {
  readonly code?: string;
  readonly moderationDetails?: unknown;
  readonly requestId?: string;
  readonly status: number;
  readonly type?: string;

  constructor(input: {
    readonly code?: string;
    readonly message: string;
    readonly moderationDetails?: unknown;
    readonly requestId?: string;
    readonly status: number;
    readonly type?: string;
  }) {
    super(input.message);
    this.name = "OpenAIImagegenError";
    this.status = input.status;
    if (input.code !== undefined) this.code = input.code;
    if (input.moderationDetails !== undefined) {
      this.moderationDetails = input.moderationDetails;
    }
    if (input.requestId !== undefined) this.requestId = input.requestId;
    if (input.type !== undefined) this.type = input.type;
  }
}

export async function createImage(
  request: ImagegenRequest,
  inputImages: readonly InputImage[],
  options: ImagegenClientOptions,
  abortSignal?: AbortSignal,
): Promise<GeneratedImage> {
  const prompt = request.prompt.trim();
  if (prompt.length === 0) throw new TypeError("prompt must not be empty");
  if (request.referencedImagePaths.length !== inputImages.length) {
    throw new TypeError("Every referenced image path must resolve to one input image");
  }
  validateInputImageSizes(inputImages);

  const action = inputImages.length === 0 ? "generate" : "edit";
  const response = await options.fetch(endpoint(options.baseURL, action), {
    body:
      action === "generate"
        ? JSON.stringify(generationBody(prompt, options))
        : editBody(prompt, inputImages, options),
    headers: await requestHeaders(options, action),
    method: "POST",
    ...(abortSignal === undefined ? {} : { signal: abortSignal }),
  });

  const requestId = response.headers.get("x-request-id") ?? undefined;
  const value = await parseJson(response);
  if (!response.ok) throw imagegenError(response.status, requestId, value);

  const body = expectObject(value, "OpenAI image response");
  const parsed = parseImageResponse(body as ImageResponseBody);
  return {
    action,
    base64: parsed.base64,
    mediaType: mediaType(options.outputFormat),
    model: GPT_IMAGE_2_MODEL,
    ...(parsed.created === undefined ? {} : { created: parsed.created }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(parsed.revisedPrompt === undefined
      ? {}
      : { revisedPrompt: parsed.revisedPrompt }),
    ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
  };
}

export function isValidGptImage2Size(size: string): boolean {
  if (size === "auto") return true;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (match === null) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  return (
    width > 0 &&
    height > 0 &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    longEdge <= 3840 &&
    longEdge / shortEdge <= 3 &&
    pixels >= 655_360 &&
    pixels <= 8_294_400
  );
}

export function detectImageMediaType(bytes: Uint8Array, path: string): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new TypeError(
    `Unsupported input image ${basename(path)}; expected PNG, JPEG, or WebP bytes`,
  );
}

export function extensionFor(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function generationBody(
  prompt: string,
  options: ImagegenClientOptions,
): Record<string, unknown> {
  return {
    background: "auto",
    model: GPT_IMAGE_2_MODEL,
    moderation: options.moderation,
    n: 1,
    output_format: options.outputFormat,
    prompt,
    quality: options.quality,
    size: options.size,
    ...(options.outputFormat === "png"
      ? {}
      : { output_compression: options.outputCompression }),
  };
}

function editBody(
  prompt: string,
  images: readonly InputImage[],
  options: ImagegenClientOptions,
): FormData {
  const form = new FormData();
  form.set("background", "auto");
  form.set("model", GPT_IMAGE_2_MODEL);
  form.set("moderation", options.moderation);
  form.set("n", "1");
  form.set("output_format", options.outputFormat);
  form.set("prompt", prompt);
  form.set("quality", options.quality);
  form.set("size", options.size);
  if (options.outputFormat !== "png") {
    form.set("output_compression", String(options.outputCompression));
  }
  for (const image of images) {
    const copy = new Uint8Array(image.bytes);
    form.append("image[]", new Blob([copy], { type: image.mediaType }), image.filename);
  }
  return form;
}

function validateInputImageSizes(images: readonly InputImage[]): void {
  let totalBytes = 0;
  for (const image of images) {
    if (image.bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
      throw new TypeError(
        `${image.filename} exceeds the 50 MiB OpenAI image input limit`,
      );
    }
    totalBytes += image.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_INPUT_IMAGE_BYTES) {
      throw new TypeError("Referenced images exceed the 50 MiB combined input limit");
    }
  }
}

async function requestHeaders(
  options: ImagegenClientOptions,
  action: "edit" | "generate",
): Promise<Headers> {
  const configured = await options.headers?.();
  const headers = new Headers();
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }

  const apiKey = (await options.apiKey?.()) ?? process.env.OPENAI_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  if (!headers.has("authorization")) {
    throw new Error(
      "OpenAI image generation requires apiKey() or OPENAI_API_KEY at execution time",
    );
  }
  if (action === "generate") {
    headers.set("content-type", "application/json");
  } else {
    // Let Fetch add the multipart boundary for FormData edits. A static
    // consumer header would make the request body undecodable upstream.
    headers.delete("content-type");
  }
  return headers;
}

function endpoint(baseURL: string, action: "edit" | "generate"): string {
  return `${baseURL.replace(/\/+$/, "")}/images/${
    action === "generate" ? "generations" : "edits"
  }`;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenAIImagegenError({
      message: `OpenAI image endpoint returned non-JSON HTTP ${response.status}`,
      status: response.status,
      ...(response.headers.get("x-request-id") === null
        ? {}
        : { requestId: response.headers.get("x-request-id")! }),
    });
  }
}

function imagegenError(
  status: number,
  requestId: string | undefined,
  value: unknown,
): OpenAIImagegenError {
  const body = isObject(value) ? (value as ErrorBody) : {};
  const error = isObject(body.error) ? body.error : {};
  const message =
    typeof error.message === "string"
      ? error.message
      : `OpenAI image endpoint failed with HTTP ${status}`;
  return new OpenAIImagegenError({
    message,
    status,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(error.moderation_details === undefined
      ? {}
      : { moderationDetails: error.moderation_details }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(typeof error.type === "string" ? { type: error.type } : {}),
  });
}

function parseImageResponse(body: ImageResponseBody): {
  readonly base64: string;
  readonly created?: number;
  readonly revisedPrompt?: string;
  readonly usage?: ImageUsage;
} {
  if (!Array.isArray(body.data) || body.data.length !== 1) {
    throw new Error("OpenAI image response must contain exactly one data item");
  }
  const item = expectObject(body.data[0], "OpenAI image data item") as ImageDataItem;
  if (typeof item.b64_json !== "string" || item.b64_json.length === 0) {
    throw new Error("OpenAI image response did not contain base64 image data");
  }
  return {
    base64: item.b64_json,
    ...(typeof body.created === "number" ? { created: body.created } : {}),
    ...(typeof item.revised_prompt === "string"
      ? { revisedPrompt: item.revised_prompt }
      : {}),
    ...(isObject(body.usage) ? { usage: body.usage as ImageUsage } : {}),
  };
}

function mediaType(format: ImageOutputFormat): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} was not an object`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
