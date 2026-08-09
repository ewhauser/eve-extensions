export type SecretResolver = () => string | PromiseLike<string>;

export type HeaderResolver = () =>
  | Record<string, string | undefined>
  | PromiseLike<Record<string, string | undefined>>;

export type ImageOutputFormat = "jpeg" | "png" | "webp";
export type ImageQuality = "auto" | "high" | "low" | "medium";
export type ImageModeration = "auto" | "low";

export interface ImagegenRequest {
  readonly prompt: string;
  readonly referencedImagePaths: readonly string[];
}

export interface ImagegenClientOptions {
  readonly apiKey?: SecretResolver;
  readonly baseURL: string;
  readonly fetch: typeof globalThis.fetch;
  readonly headers?: HeaderResolver;
  readonly moderation: ImageModeration;
  readonly outputCompression: number;
  readonly outputFormat: ImageOutputFormat;
  readonly quality: ImageQuality;
  readonly size: string;
}

export interface InputImage {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
}

export interface ImageUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly [key: string]: unknown;
}

export interface GeneratedImage {
  readonly action: "edit" | "generate";
  readonly base64: string;
  readonly created?: number;
  readonly mediaType: string;
  readonly model: "gpt-image-2";
  readonly requestId?: string;
  readonly revisedPrompt?: string;
  readonly usage?: ImageUsage;
}

export interface ImagegenToolResult extends GeneratedImage {
  readonly path: string;
  readonly reused: boolean;
}
