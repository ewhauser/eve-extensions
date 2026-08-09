import { describe, expect, it, vi } from "vitest";

import {
  createImage,
  detectImageMediaType,
  isValidGptImage2Size,
  MAX_TOTAL_INPUT_IMAGE_BYTES,
} from "../extension/lib/image-api.js";
import type { ImagegenClientOptions } from "../extension/lib/types.js";

const tinyPng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

describe("createImage", () => {
  it("generates one GPT Image 2 artifact with late-bound credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(String(request)).toBe("https://api.openai.test/v1/images/generations");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-key");
      expect(headers.get("openai-project")).toBe("project-test");
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        background: "auto",
        model: "gpt-image-2",
        moderation: "auto",
        n: 1,
        output_format: "png",
        prompt: "Draw a tiny otter",
        quality: "auto",
        size: "auto",
      });
      return jsonResponse(
        {
          created: 123,
          data: [
            {
              b64_json: Buffer.from(tinyPng).toString("base64"),
              revised_prompt: "Draw a tiny, friendly otter.",
            },
          ],
          usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
        },
        { headers: { "x-request-id": "req_generate" } },
      );
    });
    const apiKey = vi.fn(async () => "test-key");
    const result = await createImage(
      { prompt: "  Draw a tiny otter  ", referencedImagePaths: [] },
      [],
      options(fetch, {
        apiKey,
        headers: async () => ({ "OpenAI-Project": "project-test" }),
      }),
    );

    expect(apiKey).toHaveBeenCalledOnce();
    expect(result).toEqual({
      action: "generate",
      base64: Buffer.from(tinyPng).toString("base64"),
      created: 123,
      mediaType: "image/png",
      model: "gpt-image-2",
      requestId: "req_generate",
      revisedPrompt: "Draw a tiny, friendly otter.",
      usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
    });
  });

  it("uses multipart edits for one or more referenced sandbox images", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(String(request)).toBe("https://api.openai.test/v1/images/edits");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBeNull();
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("gpt-image-2");
      expect(form.get("prompt")).toBe("Keep the subject; make the sky orange");
      expect(form.get("quality")).toBe("high");
      expect(form.get("size")).toBe("1024x1024");
      expect(form.getAll("image[]")).toHaveLength(2);
      const images = form.getAll("image[]") as File[];
      expect(images.map((image) => [image.name, image.type])).toEqual([
        ["subject.png", "image/png"],
        ["palette.webp", "image/webp"],
      ]);
      return jsonResponse({
        data: [{ b64_json: Buffer.from(tinyPng).toString("base64") }],
      });
    });
    const result = await createImage(
      {
        prompt: "Keep the subject; make the sky orange",
        referencedImagePaths: ["subject.png", "palette.webp"],
      },
      [
        { bytes: tinyPng, filename: "subject.png", mediaType: "image/png" },
        {
          bytes: new Uint8Array([
            0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
          ]),
          filename: "palette.webp",
          mediaType: "image/webp",
        },
      ],
      options(fetch, {
        headers: async () => ({ "Content-Type": "application/json" }),
        quality: "high",
        size: "1024x1024",
      }),
    );

    expect(result.action).toBe("edit");
    expect(result.mediaType).toBe("image/png");
  });

  it("surfaces stable error metadata without retrying user errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(
        {
          error: {
            code: "moderation_blocked",
            message: "Request blocked.",
            moderation_details: {
              categories: ["harassment"],
              moderation_stage: "input",
            },
            type: "image_generation_user_error",
          },
        },
        { headers: { "x-request-id": "req_blocked" }, status: 400 },
      ),
    );

    await expect(
      createImage(
        { prompt: "blocked prompt", referencedImagePaths: [] },
        [],
        options(fetch),
      ),
    ).rejects.toMatchObject({
      code: "moderation_blocked",
      message: "Request blocked.",
      moderationDetails: {
        categories: ["harassment"],
        moderation_stage: "input",
      },
      requestId: "req_blocked",
      status: 400,
      type: "image_generation_user_error",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects malformed successful responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ data: [] }));
    await expect(
      createImage(
        { prompt: "draw", referencedImagePaths: [] },
        [],
        options(fetch),
      ),
    ).rejects.toThrow("exactly one data item");
  });

  it("rejects reference images over the combined memory budget before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const firstBytes = new Uint8Array(MAX_TOTAL_INPUT_IMAGE_BYTES / 2);
    const secondBytes = new Uint8Array(MAX_TOTAL_INPUT_IMAGE_BYTES / 2 + 1);

    await expect(
      createImage(
        { prompt: "combine", referencedImagePaths: ["first.png", "second.png"] },
        [
          { bytes: firstBytes, filename: "first.png", mediaType: "image/png" },
          { bytes: secondBytes, filename: "second.png", mediaType: "image/png" },
        ],
        options(fetch),
      ),
    ).rejects.toThrow("Referenced images exceed the 50 MiB combined input limit");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GPT Image 2 validation", () => {
  it.each([
    "auto",
    "1024x1024",
    "1536x1024",
    "1024x1536",
    "2048x2048",
    "3840x2160",
    "2160x3840",
  ])("accepts %s", (size) => {
    expect(isValidGptImage2Size(size)).toBe(true);
  });

  it.each([
    "1024*1024",
    "1025x1024",
    "4096x1024",
    "3840x1024",
    "512x512",
    "3840x3840",
  ])("rejects %s", (size) => {
    expect(isValidGptImage2Size(size)).toBe(false);
  });

  it("detects supported image byte formats instead of trusting extensions", () => {
    expect(detectImageMediaType(tinyPng, "wrong.txt")).toBe("image/png");
    expect(detectImageMediaType(new Uint8Array([0xff, 0xd8, 0xff]), "photo")).toBe(
      "image/jpeg",
    );
    expect(
      detectImageMediaType(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
        "image.bin",
      ),
    ).toBe("image/webp");
    expect(() => detectImageMediaType(new Uint8Array([1, 2, 3]), "bad.gif")).toThrow(
      "Unsupported input image",
    );
  });
});

function options(
  fetch: typeof globalThis.fetch,
  overrides: Partial<ImagegenClientOptions> = {},
): ImagegenClientOptions {
  return {
    apiKey: async () => "test-key",
    baseURL: "https://api.openai.test/v1/",
    fetch,
    moderation: "auto",
    outputCompression: 100,
    outputFormat: "png",
    quality: "auto",
    size: "auto",
    ...overrides,
  };
}

function jsonResponse(
  value: unknown,
  init: { readonly headers?: Record<string, string>; readonly status?: number } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), {
    headers,
    status: init.status ?? 200,
  });
}
