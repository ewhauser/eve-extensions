// Derived from vercel/eve PR #208 (Apache-2.0); adapted for Eve's public API.
import { posix } from "node:path";

import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

import type { AwsLambdaMicrovmController, ControllerProcess } from "./controller-client.js";

const WORKSPACE_ROOT = "/workspace";
const BOOTSTRAP_FAILURE_EXIT_CODE = 1;
const MAX_LOG_VALUE_LENGTH = 240;

type SandboxReadTextFileOptions = Parameters<SandboxSession["readTextFile"]>[0];

export function createAwsLambdaMicrovmSession(input: {
  readonly beforeOperation?: () => Promise<void>;
  readonly controller: AwsLambdaMicrovmController;
  readonly id: string;
  readonly onMutate?: () => void;
}): SandboxSession {
  async function beforeMutation(): Promise<void> {
    await input.beforeOperation?.();
    input.onMutate?.();
  }

  async function spawn(options: Parameters<SandboxSession["spawn"]>[0]) {
    await beforeMutation();
    return await input.controller.spawn({
      ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      command: options.command,
      ...(options.env === undefined ? {} : { env: options.env }),
      workingDirectory: resolvePath(options.workingDirectory ?? WORKSPACE_ROOT),
    });
  }

  return {
    id: input.id,
    resolvePath,
    async run(options) {
      const process = await spawn(options);
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collectStreamToString(process.stdout),
        collectStreamToString(process.stderr),
        process.wait(),
      ]);
      return { exitCode, stderr, stdout };
    },
    spawn,
    async readFile(options) {
      await input.beforeOperation?.();
      return await input.controller.readFile(resolvePath(options.path), options.abortSignal);
    },
    async readBinaryFile(options) {
      await input.beforeOperation?.();
      const stream = await input.controller.readFile(resolvePath(options.path), options.abortSignal);
      return stream === null ? null : await streamToBuffer(stream);
    },
    async readTextFile(options) {
      validateReadTextFileOptions(options);
      await input.beforeOperation?.();
      const stream = await input.controller.readFile(resolvePath(options.path), options.abortSignal);
      if (stream === null) return null;
      const text = decodeBytes(await streamToBuffer(stream), options.encoding ?? "utf-8");
      return applyLineRange(text, options);
    },
    async writeFile(options) {
      await beforeMutation();
      await input.controller.writeFile(
        resolvePath(options.path),
        await streamToBuffer(options.content),
        options.abortSignal,
      );
    },
    async writeBinaryFile(options) {
      await beforeMutation();
      await input.controller.writeFile(
        resolvePath(options.path),
        options.content,
        options.abortSignal,
      );
    },
    async writeTextFile(options) {
      await beforeMutation();
      await input.controller.writeFile(
        resolvePath(options.path),
        encodeString(options.content, options.encoding ?? "utf-8"),
        options.abortSignal,
      );
    },
    async removePath(options) {
      await beforeMutation();
      await input.controller.removePath({
        ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
        ...(options.force === undefined ? {} : { force: options.force }),
        path: resolvePath(options.path),
        ...(options.recursive === undefined ? {} : { recursive: options.recursive }),
      });
    },
    async setNetworkPolicy(_policy: SandboxNetworkPolicy) {
      await input.beforeOperation?.();
      throw new Error(
        "AWS Lambda MicroVM network connectors are immutable after launch. Configure runtimeEgressNetworkConnectorArns in awsLambdaMicrovm().",
      );
    },
  };
}

export function createLoggingSandboxSession(input: {
  readonly log?: (message: string) => void;
  readonly session: SandboxSession;
}): SandboxSession {
  const { log, session } = input;
  return {
    ...session,
    async run(options) {
      log?.(`bootstrap run: ${truncateOneLine(options.command)}`);
      const result = await session.run(options);
      if (result.exitCode === BOOTSTRAP_FAILURE_EXIT_CODE) {
        throw new Error(
          [
            `Sandbox bootstrap failed because sandbox.run command exited with code ${BOOTSTRAP_FAILURE_EXIT_CODE}:`,
            options.command,
            "",
            "stdout:",
            result.stdout,
            "",
            "stderr:",
            result.stderr,
          ].join("\n"),
        );
      }
      return result;
    },
    async spawn(options) {
      log?.(`bootstrap spawn: ${truncateOneLine(options.command)}`);
      return await session.spawn(options);
    },
    async setNetworkPolicy(policy) {
      log?.(
        `bootstrap set network policy: ${truncateOneLine(
          typeof policy === "string" ? policy : JSON.stringify(policy),
        )}`,
      );
      return await session.setNetworkPolicy(policy);
    },
    async writeFile(options) {
      log?.(`bootstrap write file: ${options.path}`);
      return await session.writeFile(options);
    },
    async writeBinaryFile(options) {
      log?.(`bootstrap write binary file: ${options.path} (${options.content.byteLength} bytes)`);
      return await session.writeBinaryFile(options);
    },
    async writeTextFile(options) {
      log?.(`bootstrap write text file: ${options.path} (${options.content.length} chars)`);
      return await session.writeTextFile(options);
    },
    async removePath(options) {
      log?.(`bootstrap remove path: ${options.path}`);
      return await session.removePath(options);
    },
  };
}

function resolvePath(path: string): string {
  if (posix.isAbsolute(path)) return posix.normalize(path);
  return posix.resolve(WORKSPACE_ROOT, path);
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

async function collectStreamToString(stream: ControllerProcess["stdout"]): Promise<string> {
  return new TextDecoder().decode(await streamToBuffer(stream));
}

function validateReadTextFileOptions(options: SandboxReadTextFileOptions): void {
  const { endLine, startLine } = options;
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    throw new Error("startLine must be a positive integer (1-based).");
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
    throw new Error("endLine must be a positive integer (1-based).");
  }
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error("startLine must not be greater than endLine.");
  }
}

function applyLineRange(content: string, options: SandboxReadTextFileOptions): string {
  if (options.startLine === undefined && options.endLine === undefined) return content;
  const lines = content.match(/.*?(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
  const start = options.startLine ?? 1;
  const end = Math.min(options.endLine ?? lines.length, lines.length);
  return start > lines.length ? "" : lines.slice(start - 1, end).join("");
}

function decodeBytes(bytes: Uint8Array, encoding: string): string {
  if (encoding === "utf-8" || encoding === "utf8") {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    encoding as BufferEncoding,
  );
}

function encodeString(value: string, encoding: string): Uint8Array {
  if (encoding === "utf-8" || encoding === "utf8") return new TextEncoder().encode(value);
  return Buffer.from(value, encoding as BufferEncoding);
}

function truncateOneLine(value: string): string {
  const singleLine = value.replaceAll(/\s+/g, " ").trim();
  return singleLine.length <= MAX_LOG_VALUE_LENGTH
    ? singleLine
    : `${singleLine.slice(0, MAX_LOG_VALUE_LENGTH - 1)}…`;
}
