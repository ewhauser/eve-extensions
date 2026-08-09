import { defineExtension } from "eve/extension";
import { z } from "zod";

import { isValidGptImage2Size } from "./lib/image-api.js";
import type { HeaderResolver, SecretResolver } from "./lib/types.js";

const secretResolver = z.custom<SecretResolver>(
  (value) => typeof value === "function",
  { message: "apiKey must be a function." },
);

const headerResolver = z.custom<HeaderResolver>(
  (value) => typeof value === "function",
  { message: "headers must be a function." },
);

const fetchImplementation = z.custom<typeof globalThis.fetch>(
  (value) => typeof value === "function",
  { message: "fetch must be a function." },
);

const config = z
  .object({
    apiKey: secretResolver.optional(),
    baseURL: z.string().url().default("https://api.openai.com/v1"),
    fetch: fetchImplementation.optional(),
    headers: headerResolver.optional(),
    moderation: z.enum(["auto", "low"]).default("auto"),
    outputCompression: z.number().int().min(0).max(100).default(100),
    outputDirectory: z.string().min(1).default("generated_images"),
    outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
    quality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
    size: z.string().default("auto"),
  })
  .refine((value) => isValidGptImage2Size(value.size), {
    message:
      "size must be auto or WIDTHxHEIGHT within GPT Image 2 resolution constraints.",
    path: ["size"],
  });

export default defineExtension({ config });
