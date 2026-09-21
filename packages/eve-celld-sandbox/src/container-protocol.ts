import { z } from "zod";
import {
  cellName,
  Command,
  Identity,
  LIMITS,
  Terminal,
  VERSION,
} from "./protocol.js";

/** SDK names are DNS labels (at most 63 characters); retain 240 bits of SHA-256. */
export async function containerName(identity: Identity): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(cellName(identity)),
    ),
  );
  return Array.from(hash.subarray(0, 30), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export const CONTAINER_TIMEOUT_MS = 60_000;
export const MAX_CONTAINER_TIMEOUT_MS = 900_000;
export const ContainerCommand = Command.safeExtend({
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTAINER_TIMEOUT_MS)
    .default(CONTAINER_TIMEOUT_MS),
});
export type ContainerCommand = z.infer<typeof ContainerCommand>;
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !s.includes("\0"), "NUL in path");
const generation = z.string().uuid();
const handle = { generation, incarnation: generation };
export const RecipeStep = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("execute"), command: ContainerCommand }),
  z.strictObject({
    op: z.literal("write"),
    path,
    data: z.string().max(Math.ceil(LIMITS.fileBytes / 3) * 4),
  }),
  z.strictObject({
    op: z.literal("remove"),
    path,
    force: z.boolean(),
    recursive: z.boolean(),
  }),
]);
export type RecipeStep = z.infer<typeof RecipeStep>;
export const Recipe = z.array(RecipeStep).max(256);
export type Recipe = z.infer<typeof Recipe>;
export const ContainerOperation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("open"), generation: generation.optional() }),
  z.strictObject({ op: z.literal("peek") }),
  z.strictObject({ op: z.literal("publish"), source: Identity, ...handle }),
  z.strictObject({
    op: z.literal("recipe"),
    generation: generation.optional(),
    incarnation: generation.optional(),
  }),
  z.strictObject({ op: z.literal("capture"), ...handle }),
  z.strictObject({
    op: z.literal("execute"),
    ...handle,
    command: ContainerCommand,
  }),
  z.strictObject({
    op: z.literal("cancel"),
    ...handle,
    command: ContainerCommand,
  }),
  z.strictObject({ op: z.literal("read"), ...handle, path }),
  z.strictObject({
    op: z.literal("write"),
    ...handle,
    path,
    data: z.string().max(Math.ceil(LIMITS.fileBytes / 3) * 4),
  }),
  z.strictObject({
    op: z.literal("remove"),
    ...handle,
    path,
    recursive: z.boolean(),
    force: z.boolean(),
  }),
  z.strictObject({ op: z.literal("stop"), ...handle }),
  z.strictObject({ op: z.literal("delete"), ...handle }),
]);
export type ContainerOperation = z.infer<typeof ContainerOperation>;
export const ContainerEnvelope = z.strictObject({
  version: z.literal(VERSION),
  identity: Identity,
  operation: ContainerOperation,
});
export const containerResponses = {
  open: z.strictObject(handle),
  peek: z.strictObject({ exists: z.boolean() }),
  publish: z.strictObject({ reused: z.boolean() }),
  recipe: Recipe,
  capture: z.null(),
  execute: Terminal,
  cancel: Terminal,
  read: z.string().nullable(),
  write: z.null(),
  remove: z.null(),
  stop: z.null(),
  delete: z.null(),
};
