import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { AwsLambdaMicrovmApi, AwsLambdaMicrovmRecord } from "./api.js";

const TOKEN_REFRESH_MS = 55 * 60 * 1000;
const PROCESS_POLL_MS = 100;
const FILE_CHUNK_SIZE = 4 * 1024 * 1024;
const TRANSIENT_ATTEMPTS = 4;

export interface ControllerCheckpointPreparation {
  readonly checkpointId?: string;
  readonly dirty: boolean;
  readonly partCount?: number;
  readonly partSha256s?: readonly string[];
  readonly partSize?: number;
  readonly sha256?: string;
  readonly size?: number;
}

export interface ControllerProcess {
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  kill(): Promise<void>;
  wait(): Promise<{ readonly exitCode: number }>;
}

export interface AwsLambdaMicrovmController {
  checkpointCommitted(checkpointId: string): Promise<void>;
  checkpointRelease(): Promise<void>;
  checkpointUpload(
    checkpointId: string,
    urls: readonly string[],
  ): Promise<readonly { readonly etag: string; readonly partNumber: number }[]>;
  pauseHeartbeats(): void;
  prepareCheckpoint(): Promise<ControllerCheckpointPreparation>;
  readFile(path: string, abortSignal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
  removePath(input: {
    readonly abortSignal?: AbortSignal;
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
  }): Promise<void>;
  restoreCheckpoint(input: {
    readonly sha256: string;
    readonly size: number;
    readonly url: string;
  }): Promise<void>;
  resumeHeartbeats(): void;
  spawn(input: {
    readonly abortSignal?: AbortSignal;
    readonly command: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly workingDirectory?: string;
  }): Promise<ControllerProcess>;
  waitUntilReady(timeoutMs?: number): Promise<void>;
  writeFile(path: string, bytes: Uint8Array, abortSignal?: AbortSignal): Promise<void>;
}

export class HttpAwsLambdaMicrovmController implements AwsLambdaMicrovmController {
  readonly #api: AwsLambdaMicrovmApi;
  readonly #endpoint: string;
  readonly #microvmId: string;
  #heartbeatsEnabled = true;
  readonly #heartbeatWaiters = new Set<() => void>();
  #token?: { readonly expiresAt: number; readonly value: string };
  #tokenPromise?: Promise<string>;

  constructor(input: {
    readonly api: AwsLambdaMicrovmApi;
    readonly microvm: AwsLambdaMicrovmRecord;
  }) {
    this.#api = input.api;
    this.#endpoint = input.microvm.endpoint.replace(/\/+$/, "");
    this.#microvmId = input.microvm.microvmId;
  }

  async checkpointCommitted(checkpointId: string): Promise<void> {
    await this.#json(
      "/v1/checkpoints/commit",
      {
        body: { checkpointId },
        method: "POST",
      },
      true,
    );
  }

  async checkpointRelease(): Promise<void> {
    await this.#json("/v1/checkpoints/release", { method: "POST" }, true);
  }

  async checkpointUpload(
    checkpointId: string,
    urls: readonly string[],
  ): Promise<readonly { readonly etag: string; readonly partNumber: number }[]> {
    const output = await this.#json(
      "/v1/checkpoints/upload",
      {
        body: { checkpointId, urls },
        method: "POST",
      },
      true,
    );
    if (!Array.isArray(output.parts)) {
      throw new Error("AWS Lambda MicroVM controller returned invalid checkpoint parts.");
    }
    return output.parts.map((value, index) => {
      const record = expectRecord(value, `parts[${index}]`);
      return {
        etag: expectString(record.etag, `parts[${index}].etag`),
        partNumber: expectPositiveInteger(record.partNumber, `parts[${index}].partNumber`),
      };
    });
  }

  pauseHeartbeats(): void {
    this.#heartbeatsEnabled = false;
  }

  async prepareCheckpoint(): Promise<ControllerCheckpointPreparation> {
    const output = await this.#json("/v1/checkpoints/prepare", { method: "POST" });
    if (output.dirty === false) return { dirty: false };
    if (output.dirty !== true) {
      throw new Error("AWS Lambda MicroVM controller returned invalid checkpoint state.");
    }
    const partCount = expectPositiveInteger(output.partCount, "partCount");
    const partSha256s = expectSha256Array(output.partSha256s, "partSha256s");
    if (partSha256s.length !== partCount) {
      throw new Error(
        `AWS Lambda MicroVM controller returned ${partSha256s.length} part checksums; expected ${partCount}.`,
      );
    }
    return {
      checkpointId: expectString(output.checkpointId, "checkpointId"),
      dirty: true,
      partCount,
      partSha256s,
      partSize: expectPositiveInteger(output.partSize, "partSize"),
      sha256: expectSha256(output.sha256),
      size: expectNonNegativeInteger(output.size, "size"),
    };
  }

  async readFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const first = await this.#readFileChunk(path, 0, abortSignal);
    if (first === null) return null;
    let next = first;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const current = next;
          if (current.bytes.byteLength > 0) controller.enqueue(current.bytes);
          if (current.complete) {
            controller.close();
            return;
          }
          next = expectDefined(
            await this.#readFileChunk(path, current.nextOffset, abortSignal),
            "file chunk",
          );
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  async removePath(input: {
    readonly abortSignal?: AbortSignal;
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
  }): Promise<void> {
    const query = new URLSearchParams({
      force: String(input.force === true),
      path: input.path,
      recursive: String(input.recursive === true),
    });
    await this.#json(`/v1/files?${query}`, { method: "DELETE", signal: input.abortSignal });
  }

  async restoreCheckpoint(input: {
    readonly sha256: string;
    readonly size: number;
    readonly url: string;
  }): Promise<void> {
    await this.#json("/v1/checkpoints/restore", { body: input, method: "POST" }, true);
  }

  resumeHeartbeats(): void {
    if (this.#heartbeatsEnabled) return;
    this.#heartbeatsEnabled = true;
    for (const resolve of this.#heartbeatWaiters) resolve();
    this.#heartbeatWaiters.clear();
  }

  async spawn(input: {
    readonly abortSignal?: AbortSignal;
    readonly command: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly workingDirectory?: string;
  }): Promise<ControllerProcess> {
    const requestId = randomUUID();
    const output = await this.#json(
      "/v1/processes",
      {
        body: {
          command: input.command,
          env: input.env,
          requestId,
          workingDirectory: input.workingDirectory,
        },
        method: "POST",
        signal: input.abortSignal,
      },
      true,
    );
    const processId = expectString(output.processId, "processId");
    const process = this.#createProcess(processId);
    input.abortSignal?.addEventListener("abort", () => void process.kill().catch(() => undefined), {
      once: true,
    });
    return process;
  }

  async waitUntilReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const output = await this.#json("/v1/health");
        if (output.status === "ready" && output.protocolVersion === 1) return;
        lastError = new Error("Controller returned an incompatible protocol response.");
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw new Error(
      `AWS Lambda MicroVM controller did not become ready: ${errorMessage(lastError)}`,
      {
        cause: lastError,
      },
    );
  }

  async writeFile(path: string, bytes: Uint8Array, abortSignal?: AbortSignal): Promise<void> {
    const output = await this.#json("/v1/files/writes", {
      body: { path },
      method: "POST",
      signal: abortSignal,
    });
    const writeId = expectString(output.writeId, "writeId");
    try {
      for (let offset = 0; offset < bytes.byteLength || offset === 0; offset += FILE_CHUNK_SIZE) {
        const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + FILE_CHUNK_SIZE));
        const response = await this.#request(
          `/v1/files/writes/${encodeURIComponent(writeId)}?offset=${offset}`,
          {
            body: new Uint8Array(chunk),
            headers: { "content-type": "application/octet-stream" },
            method: "PUT",
            signal: abortSignal,
          },
        );
        await expectOk(response);
        if (bytes.byteLength === 0) break;
      }
      await this.#json(`/v1/files/writes/${encodeURIComponent(writeId)}/commit`, {
        method: "POST",
        signal: abortSignal,
      });
    } catch (error) {
      await this.#json(`/v1/files/writes/${encodeURIComponent(writeId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
      throw error;
    }
  }

  #createProcess(processId: string): ControllerProcess {
    const stdout = this.#createLogStream(processId, "stdout");
    const stderr = this.#createLogStream(processId, "stderr");
    const waitPromise = this.#waitForProcess(processId);
    let killPromise: Promise<void> | undefined;
    return {
      stderr,
      stdout,
      kill: () =>
        (killPromise ??= this.#json(
          `/v1/processes/${encodeURIComponent(processId)}`,
          {
            method: "DELETE",
          },
          true,
        ).then(() => undefined)),
      wait: () => waitPromise,
    };
  }

  async #waitForProcess(processId: string): Promise<{ readonly exitCode: number }> {
    for (;;) {
      await this.#waitForHeartbeats();
      const output = await this.#json(`/v1/processes/${encodeURIComponent(processId)}`, {}, true);
      if (output.state === "exited") {
        return { exitCode: expectInteger(output.exitCode, "exitCode") };
      }
      if (output.state !== "running") {
        throw new Error(`AWS Lambda MicroVM process returned state ${String(output.state)}.`);
      }
      await sleep(PROCESS_POLL_MS);
    }
  }

  #createLogStream(processId: string, outputName: "stderr" | "stdout"): ReadableStream<Uint8Array> {
    let canceled = false;
    return new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
      start: (controller) => {
        void (async () => {
          let offset = 0;
          try {
            while (!canceled) {
              await this.#waitForHeartbeats();
              const response = await this.#request(
                `/v1/processes/${encodeURIComponent(processId)}/logs/${outputName}?offset=${offset}`,
                {},
                true,
              );
              await expectOk(response);
              const chunk = new Uint8Array(await response.arrayBuffer());
              const nextOffset = Number(response.headers.get("x-eve-next-offset"));
              if (!Number.isInteger(nextOffset) || nextOffset < offset) {
                throw new Error("AWS Lambda MicroVM controller returned an invalid log offset.");
              }
              offset = nextOffset;
              if (chunk.byteLength > 0) controller.enqueue(chunk);
              if (response.headers.get("x-eve-complete") === "true") break;
              if (chunk.byteLength === 0) await sleep(PROCESS_POLL_MS);
            }
            if (!canceled) controller.close();
          } catch (error) {
            if (!canceled) controller.error(error);
          }
        })();
      },
    });
  }

  async #json(
    path: string,
    init: Omit<RequestInit, "body"> & { readonly body?: unknown } = {},
    retryTransient = false,
  ): Promise<Record<string, unknown>> {
    const response = await this.#request(
      path,
      {
        ...init,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        headers:
          init.body === undefined
            ? init.headers
            : { ...init.headers, "content-type": "application/json" },
      },
      retryTransient,
    );
    await expectOk(response);
    const value = (await response.json()) as unknown;
    return expectRecord(value, "response");
  }

  async #request(path: string, init: RequestInit = {}, retryTransient = false): Promise<Response> {
    let lastError: unknown;
    const attempts = retryTransient ? TRANSIENT_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.#authenticatedRequest(path, init);
        if (!isTransientStatus(response.status) || attempt === attempts - 1) {
          return response;
        }
        await response.body?.cancel().catch(() => undefined);
        await sleep(retryDelayMs(attempt, response.headers.get("retry-after")));
      } catch (error) {
        if (init.signal?.aborted || attempt === attempts - 1) throw error;
        lastError = error;
        await sleep(retryDelayMs(attempt));
      }
    }
    throw new Error("AWS Lambda MicroVM controller request exhausted transient retries.", {
      cause: lastError,
    });
  }

  async #authenticatedRequest(path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#getToken(attempt > 0);
      const response = await fetch(`${this.#endpoint}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          "x-aws-proxy-auth": token,
          "x-aws-proxy-port": "8080",
        },
      });
      if (response.status !== 403 || attempt > 0) return response;
      this.#token = undefined;
    }
    throw new Error("AWS Lambda MicroVM controller authentication failed.");
  }

  async #getToken(force: boolean): Promise<string> {
    if (force) {
      this.#token = undefined;
      this.#tokenPromise = undefined;
    }
    if (!force && this.#token !== undefined && this.#token.expiresAt > Date.now()) {
      return this.#token.value;
    }
    if (this.#tokenPromise !== undefined) return await this.#tokenPromise;
    this.#tokenPromise = this.#api.createAuthToken(this.#microvmId).then((value) => {
      this.#token = { expiresAt: Date.now() + TOKEN_REFRESH_MS, value };
      return value;
    });
    try {
      return await this.#tokenPromise;
    } finally {
      this.#tokenPromise = undefined;
    }
  }

  async #readFileChunk(
    path: string,
    offset: number,
    abortSignal?: AbortSignal,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly complete: boolean;
    readonly nextOffset: number;
  } | null> {
    const query = new URLSearchParams({
      limit: String(FILE_CHUNK_SIZE),
      offset: String(offset),
      path,
    });
    const response = await this.#request(`/v1/files?${query}`, { signal: abortSignal }, true);
    if (response.status === 404) return null;
    await expectOk(response);
    const nextOffset = Number(response.headers.get("x-eve-next-offset"));
    if (!Number.isInteger(nextOffset) || nextOffset < offset) {
      throw new Error("AWS Lambda MicroVM controller returned an invalid file offset.");
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      complete: response.headers.get("x-eve-complete") === "true",
      nextOffset,
    };
  }

  async #waitForHeartbeats(): Promise<void> {
    if (this.#heartbeatsEnabled) return;
    await new Promise<void>((resolve) => this.#heartbeatWaiters.add(resolve));
  }
}

async function expectOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(
    `AWS Lambda MicroVM controller request failed with HTTP ${response.status}${body ? `: ${body}` : ""}.`,
  );
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`AWS Lambda MicroVM controller returned invalid ${name}.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`AWS Lambda MicroVM controller returned invalid ${name}.`);
  }
  return value;
}

function expectInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`AWS Lambda MicroVM controller returned invalid ${name}.`);
  }
  return Number(value);
}

function expectPositiveInteger(value: unknown, name: string): number {
  const result = expectInteger(value, name);
  if (result < 1) throw new Error(`AWS Lambda MicroVM controller returned invalid ${name}.`);
  return result;
}

function expectNonNegativeInteger(value: unknown, name: string): number {
  const result = expectInteger(value, name);
  if (result < 0) throw new Error(`AWS Lambda MicroVM controller returned invalid ${name}.`);
  return result;
}

function expectSha256(value: unknown): string {
  const digest = expectString(value, "sha256");
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("AWS Lambda MicroVM controller returned invalid sha256.");
  }
  return digest;
}

function expectSha256Array(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`AWS Lambda MicroVM controller returned invalid ${name}.`);
  }
  return value.map((entry, index) => {
    try {
      return expectSha256(entry);
    } catch {
      throw new Error(`AWS Lambda MicroVM controller returned invalid ${name}[${index}].`);
    }
  });
}

function expectDefined<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(`AWS Lambda MicroVM controller omitted ${name}.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, retryAfter: string | null = null): number {
  const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(1000, retryAfterSeconds * 1000);
  }
  return 50 * 2 ** attempt + Math.floor(Math.random() * 26);
}
