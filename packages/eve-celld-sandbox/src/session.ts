import type { SandboxSession, SandboxReadTextFileOptions } from "eve/sandbox";
import { LIMITS, ProtocolError, readBounded, resolvePath } from "./protocol.js";

export function decode(
  bytes: Uint8Array,
  options: SandboxReadTextFileOptions,
): string {
  const encoding = options.encoding ?? "utf-8";
  const text =
    encoding === "utf8" || encoding === "utf-8"
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : Buffer.from(bytes).toString(encoding as BufferEncoding);
  if (options.startLine === undefined && options.endLine === undefined)
    return text;
  for (const n of [options.startLine, options.endLine])
    if (n !== undefined && (!Number.isInteger(n) || n < 1))
      throw new Error("Line numbers must be positive integers (1-based)");
  if (
    options.startLine !== undefined &&
    options.endLine !== undefined &&
    options.startLine > options.endLine
  )
    throw new Error("startLine must not be greater than endLine");
  return (text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [])
    .slice((options.startLine ?? 1) - 1, options.endLine)
    .join("");
}

export function buildSession(
  input: Pick<
    SandboxSession,
    | "id"
    | "spawn"
    | "readBinaryFile"
    | "writeBinaryFile"
    | "removePath"
    | "setNetworkPolicy"
  >,
): SandboxSession {
  const session: SandboxSession = {
    ...input,
    resolvePath,
    async run(options) {
      const process = await session.spawn(options);
      const [stdout, stderr, status] = await Promise.all([
        readBounded(process.stdout, LIMITS.outputBytes),
        readBounded(process.stderr, LIMITS.outputBytes),
        process.wait(),
      ]);
      return {
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
        exitCode: status.exitCode,
      };
    },
    async readFile(options) {
      const bytes = await session.readBinaryFile(options);
      return bytes === null
        ? null
        : new ReadableStream({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          });
    },
    async readTextFile(options) {
      const bytes = await session.readBinaryFile(options);
      return bytes === null ? null : decode(bytes, options);
    },
    async writeFile(options) {
      await session.writeBinaryFile({
        ...options,
        content: await readBounded(options.content, LIMITS.fileBytes),
      });
    },
    async writeTextFile(options) {
      await session.writeBinaryFile({
        ...options,
        content: Buffer.from(
          options.content,
          (options.encoding ?? "utf-8") as BufferEncoding,
        ),
      });
    },
  };
  return session;
}

export function checkProviderOptions(options: unknown): void {
  if (options && Object.keys(options).length)
    throw new ProtocolError(
      "UNSUPPORTED",
      "This backend accepts no per-session provider options",
    );
}
