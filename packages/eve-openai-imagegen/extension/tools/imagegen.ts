import { basename, posix } from "node:path";

import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import extension from "../extension.js";
import {
  createImage,
  detectImageMediaType,
  extensionFor,
  MAX_INPUT_IMAGE_BYTES,
  MAX_TOTAL_INPUT_IMAGE_BYTES,
} from "../lib/image-api.js";
import type {
  ImagegenClientOptions,
  ImagegenToolResult,
  InputImage,
} from "../lib/types.js";

const inputSchema = z.object({
  prompt: z.string().min(1).describe("A complete visual specification for the image."),
  referenced_image_paths: z
    .array(z.string().min(1))
    .max(16)
    .optional()
    .describe(
      "Sandbox paths for edit targets or visual references, up to 50 MiB combined. Omit when generating a new image.",
    ),
});

export default defineTool({
  description:
    "Generate a new raster image with GPT Image 2, or edit/composite sandbox images supplied as references. The final image is saved in the sandbox and returned for visual inspection.",
  inputSchema,
  async execute(input, ctx): Promise<ImagegenToolResult> {
    const config = extension.config;
    const sandbox = await ctx.getSandbox();
    const referencedImagePaths = input.referenced_image_paths ?? [];
    const action = referencedImagePaths.length === 0 ? "generate" : "edit";
    const filename = `${safeCallId(ctx.callId)}.${extensionFor(config.outputFormat)}`;
    const outputPath = posix.join(config.outputDirectory, filename);

    const existing = await sandbox.readBinaryFile({
      abortSignal: ctx.abortSignal,
      path: outputPath,
    });
    if (existing !== null) {
      const existingMediaType = detectImageMediaType(existing, outputPath);
      const configuredMediaType =
        config.outputFormat === "jpeg" ? "image/jpeg" : `image/${config.outputFormat}`;
      if (existingMediaType !== configuredMediaType) {
        throw new Error(
          `Existing image artifact ${sandbox.resolvePath(outputPath)} does not match ${configuredMediaType}`,
        );
      }
      return {
        action,
        base64: Buffer.from(existing).toString("base64"),
        mediaType: configuredMediaType,
        model: "gpt-image-2",
        path: sandbox.resolvePath(outputPath),
        reused: true,
      };
    }

    const inputImages: InputImage[] = [];
    let totalInputBytes = 0;
    for (const path of referencedImagePaths) {
      const bytes = await sandbox.readBinaryFile({
        abortSignal: ctx.abortSignal,
        path,
      });
      if (bytes === null) throw new Error(`Referenced image does not exist: ${path}`);
      if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
        throw new Error(`Referenced image exceeds 50 MiB: ${path}`);
      }
      totalInputBytes += bytes.byteLength;
      if (totalInputBytes > MAX_TOTAL_INPUT_IMAGE_BYTES) {
        throw new Error("Referenced images exceed 50 MiB combined");
      }
      inputImages.push({
        bytes,
        filename: basename(path),
        mediaType: detectImageMediaType(bytes, path),
      });
    }

    const clientOptions: ImagegenClientOptions = {
      baseURL: config.baseURL,
      fetch: config.fetch ?? globalThis.fetch,
      moderation: config.moderation,
      outputCompression: config.outputCompression,
      outputFormat: config.outputFormat,
      quality: config.quality,
      size: config.size,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    };
    const generated = await createImage(
      { prompt: input.prompt, referencedImagePaths },
      inputImages,
      clientOptions,
      ctx.abortSignal,
    );
    const outputBytes = Buffer.from(generated.base64, "base64");
    if (outputBytes.length === 0) {
      throw new Error("OpenAI returned empty image data");
    }
    const actualMediaType = detectImageMediaType(outputBytes, outputPath);
    if (actualMediaType !== generated.mediaType) {
      throw new Error(
        `OpenAI returned ${actualMediaType} bytes for requested ${generated.mediaType} output`,
      );
    }
    await sandbox.writeBinaryFile({
      abortSignal: ctx.abortSignal,
      content: outputBytes,
      path: outputPath,
    });

    return {
      ...generated,
      path: sandbox.resolvePath(outputPath),
      reused: false,
    };
  },
  toModelOutput(output) {
    const details = [
      `${output.action === "generate" ? "Generated" : "Edited"} image saved to ${output.path}.`,
      `Model: ${output.model}.`,
      output.revisedPrompt === undefined
        ? undefined
        : `Revised prompt: ${output.revisedPrompt}`,
    ].filter((value): value is string => value !== undefined);
    return toolOutput.content([
      toolOutputPart.text(details.join(" ")),
      toolOutputPart.file(output.base64, {
        filename: basename(output.path),
        mediaType: output.mediaType,
      }),
    ]);
  },
});

function safeCallId(callId: string): string {
  const safe = callId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length === 0 ? "image" : safe.slice(0, 120);
}
