import { describe, expect, it } from "vitest";

import { createImage } from "../../extension/lib/image-api.js";

const enabled = process.env.EVE_RUN_OPENAI_IMAGEGEN_INTEGRATION === "1";

describe.skipIf(!enabled)("GPT Image 2 live integration", () => {
  it(
    "generates a low-quality PNG through the public Image API",
    async () => {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error(
          "EVE_RUN_OPENAI_IMAGEGEN_INTEGRATION=1 requires OPENAI_API_KEY",
        );
      }
      const result = await createImage(
        {
          prompt:
            "Draw a minimal flat blue circle centered on a plain white background. No text.",
          referencedImagePaths: [],
        },
        [],
        {
          baseURL: "https://api.openai.com/v1",
          fetch: globalThis.fetch,
          moderation: "auto",
          outputCompression: 100,
          outputFormat: "png",
          quality: "low",
          size: "1024x1024",
        },
      );
      const bytes = Buffer.from(result.base64, "base64");
      expect(result.model).toBe("gpt-image-2");
      expect(result.action).toBe("generate");
      expect(bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    },
    180_000,
  );
});
