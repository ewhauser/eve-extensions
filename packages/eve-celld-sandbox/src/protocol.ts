import { z } from "zod";

export const VERSION = 1 as const;
export const LIMITS = {
  fileBytes: 1024 * 1024,
  snapshotBytes: 4 * 1024 * 1024,
  requestBytes: 6 * 1024 * 1024,
  commandBytes: 64 * 1024,
  outputBytes: 128 * 1024,
  durationMs: 10_000,
  pending: 32,
  journalCount: 128,
  journalAgeMs: 24 * 60 * 60 * 1000,
} as const;
const key = z.string().min(1).max(200);
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !s.includes("\0"), "NUL in path");
export const Identity = z.strictObject({
  namespace: key,
  kind: z.enum(["session", "template", "build"]),
  key,
  template: key.nullable(),
});
export type Identity = z.infer<typeof Identity>;
export function cellName(i: Identity): string {
  return JSON.stringify([VERSION, i.namespace, i.kind, i.template, i.key]);
}
export const Command = z
  .strictObject({
    id: z.string().min(1).max(128),
    command: z.string().max(LIMITS.commandBytes),
    cwd: path.default("/workspace"),
    env: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .max(128),
        z.string().max(4096),
      )
      .default({}),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.durationMs)
      .default(LIMITS.durationMs),
  })
  .refine(
    (c) => Object.keys(c.env).length <= 64,
    "Too many environment variables",
  );
export type Command = z.infer<typeof Command>;
export const Entry = z.strictObject({
  path,
  kind: z.enum(["file", "directory"]),
  data: z.string().max(Math.ceil(LIMITS.fileBytes / 3) * 4),
  mode: z.number().int().min(0).max(0o7777),
  mtime: z.number().finite(),
});
export type Entry = z.infer<typeof Entry>;
export const Snapshot = z.array(Entry);
export const Terminal = z.strictObject({
  id: z.string(),
  state: z.enum(["completed", "cancelled", "timeout", "failed", "interrupted"]),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  error: z.string().optional(),
});
export type Terminal = z.infer<typeof Terminal>;
const generation = z.string().uuid();
export const Operation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("open"), generation: generation.optional() }),
  z.strictObject({ op: z.literal("peek") }),
  z.strictObject({ op: z.literal("publish"), source: Identity, generation }),
  z.strictObject({
    op: z.literal("snapshot"),
    generation: generation.optional(),
  }),
  z.strictObject({ op: z.literal("execute"), generation, command: Command }),
  z.strictObject({ op: z.literal("cancel"), generation, command: Command }),
  z.strictObject({
    op: z.literal("status"),
    generation,
    id: z.string().max(128),
  }),
  z.strictObject({ op: z.literal("read"), generation, path }),
  z.strictObject({
    op: z.literal("write"),
    generation,
    path,
    data: z.string().max(Math.ceil(LIMITS.fileBytes / 3) * 4),
  }),
  z.strictObject({
    op: z.literal("remove"),
    generation,
    path,
    recursive: z.boolean().default(false),
    force: z.boolean().default(false),
  }),
  z.strictObject({ op: z.literal("stop"), generation }),
  z.strictObject({ op: z.literal("delete"), generation }),
]);
export type Operation = z.infer<typeof Operation>;
export const RequestEnvelope = z.strictObject({
  version: z.literal(VERSION),
  identity: Identity,
  operation: Operation,
});
export const ResponseEnvelope = z.discriminatedUnion("ok", [
  z.strictObject({
    version: z.literal(VERSION),
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.strictObject({
    version: z.literal(VERSION),
    ok: z.literal(false),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);
export const responses = {
  open: z.strictObject({ generation, cellId: z.string() }),
  peek: z.strictObject({ exists: z.boolean() }),
  publish: z.strictObject({ reused: z.boolean() }),
  snapshot: Snapshot,
  execute: Terminal,
  cancel: Terminal,
  status: z.union([
    Terminal,
    z.strictObject({ id: z.string(), state: z.enum(["queued", "running"]) }),
    z.null(),
  ]),
  read: z.string().nullable(),
  write: z.null(),
  remove: z.null(),
  stop: z.null(),
  delete: z.null(),
};
export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
export function resolvePath(path: string): string {
  const parts: string[] = [];
  for (const p of (path.startsWith("/") ? path : `/workspace/${path}`).split(
    "/",
  )) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return "/" + parts.join("/");
}
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export function unbase64(s: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)
  )
    throw new ProtocolError("INVALID_BASE64", "Expected canonical base64");
  const value = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (base64(value) !== s)
    throw new ProtocolError("INVALID_BASE64", "Expected canonical base64");
  return value;
}
export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max)
        throw new ProtocolError("LIMIT", "Body exceeds byte limit", 413);
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}
export function failure(
  id: string,
  state: Exclude<Terminal["state"], "completed">,
  message: string,
  code = state.toUpperCase(),
): Terminal {
  return {
    id,
    state,
    stdout: "",
    stderr: message,
    exitCode: state === "timeout" ? 124 : state === "cancelled" ? 130 : 125,
    error: code,
  };
}
export function commandFingerprint(c: Command): string {
  return JSON.stringify([
    c.command,
    c.cwd,
    Object.entries(c.env).sort(([a], [b]) => a.localeCompare(b)),
    c.timeoutMs,
  ]);
}
