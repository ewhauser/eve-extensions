// Derived from vercel/eve PR #208 (Apache-2.0); adapted to current Eve lifecycle semantics.
import { describe, expect, it, vi } from "vitest";

import type { AwsLambdaMicrovmApi, AwsLambdaMicrovmRecord } from "./api.js";
import {
  AWS_LAMBDA_MICROVM_BACKEND_NAME,
  createAwsLambdaMicrovmSandbox,
  type AwsLambdaMicrovmBackendServices,
} from "./backend.js";
import type {
  AwsLambdaMicrovmController,
  ControllerCheckpointPreparation,
  ControllerProcess,
} from "./controller-client.js";
import type { AwsLambdaMicrovmStorage, StoredJson } from "./storage.js";

const OPTIONS = {
  applicationId: "integration-agent",
  artifactBucket: "sandbox-artifacts",
  buildRoleArn: "arn:aws:iam::123456789012:role/eve-build",
  region: "us-east-1",
} as const;

describe("AWS Lambda MicroVM backend", () => {
  it("requires and reuses an empty build-time template", async () => {
    const fixture = createServicesFixture();
    const backend = createAwsLambdaMicrovmSandbox({ options: OPTIONS, services: fixture.services });

    expect(backend.name).toBe(AWS_LAMBDA_MICROVM_BACKEND_NAME);
    expect(backend.provisioning).toEqual({
      prewarmAtBuild: true,
      requiresTemplate: true,
      scopeKey: "integration-agent",
    });

    await expect(
      backend.prewarm({
        runtimeContext: { appRoot: "/app" },
        seedFiles: [],
        templateKey: "template-empty",
      }),
    ).resolves.toEqual({ reused: false });
    await expect(
      backend.prewarm({
        runtimeContext: { appRoot: "/app" },
        seedFiles: [],
        templateKey: "template-empty",
      }),
    ).resolves.toEqual({ reused: true });

    expect(fixture.api.createImage).toHaveBeenCalledTimes(1);
    expect(fixture.api.createImage).toHaveBeenCalledWith(
      expect.objectContaining({ logging: { cloudWatch: {} } }),
    );
    expect(fixture.api.runMicrovm).not.toHaveBeenCalled();
    expect(fixture.storage.bytes.size).toBe(1);
  });

  it("re-scopes Eve template keys to the stable application id", async () => {
    const fixture = createServicesFixture();
    const backend = createAwsLambdaMicrovmSandbox({ options: OPTIONS, services: fixture.services });
    const suffix = "0123456789abcdef0123";

    await expect(
      backend.prewarm({
        runtimeContext: { appRoot: "/build/root" },
        seedFiles: [],
        templateKey: `eve-sbx-tpl-aws-lambda-microvms-1111111111111111-${suffix}`,
      }),
    ).resolves.toEqual({ reused: false });
    await expect(
      backend.prewarm({
        runtimeContext: { appRoot: "/deployment/root" },
        seedFiles: [],
        templateKey: `eve-sbx-tpl-aws-lambda-microvms-2222222222222222-${suffix}`,
      }),
    ).resolves.toEqual({ reused: true });

    expect(fixture.api.createImage).toHaveBeenCalledTimes(1);
  });

  it("lazily provisions an empty template when Eve supplies no template key", async () => {
    const fixture = createServicesFixture();
    const backend = createAwsLambdaMicrovmSandbox({ options: OPTIONS, services: fixture.services });

    const handle = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-default",
      templateKey: null,
    });

    expect(handle.session.id).toBe("session-default");
    expect(fixture.api.createImage).toHaveBeenCalledTimes(1);
    expect(fixture.api.runMicrovm).toHaveBeenCalledTimes(1);
    await handle.shutdown();
    expect(fixture.api.suspendMicrovm).toHaveBeenCalledTimes(1);
  });

  it("bootstraps, checkpoints, suspends, and restores a terminated session", async () => {
    const fixture = createServicesFixture();
    const backend = createAwsLambdaMicrovmSandbox({ options: OPTIONS, services: fixture.services });

    await backend.prewarm({
      async bootstrap({ use }) {
        const session = await use();
        await session.writeTextFile({ content: "installed", path: "/usr/local/eve-marker" });
      },
      runtimeContext: { appRoot: "/app" },
      seedFiles: [{ content: "seed", path: "/workspace/seed.txt" }],
      templateKey: "template-full",
    });

    expect(fixture.api.runMicrovm).toHaveBeenCalledTimes(1);
    expect(fixture.api.runMicrovm).toHaveBeenCalledWith(
      expect.objectContaining({ logging: { disabled: true } }),
    );
    expect(fixture.api.terminateMicrovm).toHaveBeenCalledTimes(1);
    expect(fixture.api.tagResource).toHaveBeenCalledWith(
      "arn:aws:lambda:us-east-1:123456789012:microvm:mvm-1",
      expect.objectContaining({
        "eve:application": expect.any(String),
        "eve:controller": "1",
        "eve:owner": "eve",
        "eve:template": expect.any(String),
      }),
    );

    const handle = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-one",
      templateKey: "template-full",
    });
    expect(fixture.controllers.at(-1)?.restored).toHaveLength(1);

    await handle.session.writeTextFile({ content: "changed", path: "/etc/eve.conf" });
    const state = await handle.captureState();

    expect(state.backendName).toBe(AWS_LAMBDA_MICROVM_BACKEND_NAME);
    expect(state.metadata).toMatchObject({
      checkpoint: { generation: 2 },
      imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:eve-test",
      imageVersion: "1",
      manifestEtag: expect.any(String),
    });
    expect(fixture.storage.completedSha256s).toEqual(["a".repeat(64), "a".repeat(64)]);
    expect(fixture.api.suspendMicrovm).toHaveBeenCalledTimes(1);

    await handle.shutdown();
    expect(fixture.api.terminateMicrovm).toHaveBeenCalledTimes(1);

    // Simulate provider retention expiry after Eve has safely suspended the session.
    await fixture.api.terminateMicrovm("mvm-2");

    const restored = await backend.create({
      existingMetadata: state.metadata,
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-one",
      templateKey: "template-full",
    });
    expect(fixture.api.runMicrovm).toHaveBeenCalledTimes(3);
    expect(fixture.controllers.at(-1)?.restored.at(-1)?.sha256).toBe("a".repeat(64));
    await restored.shutdown();
  });

  it("rejects runtime network-policy mutation", async () => {
    const fixture = createServicesFixture();
    const backend = createAwsLambdaMicrovmSandbox({ options: OPTIONS, services: fixture.services });
    await backend.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-network",
    });
    const handle = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-network",
      templateKey: "template-network",
    });

    await expect(handle.session.setNetworkPolicy("deny-all")).rejects.toThrow(
      /immutable after launch/,
    );
  });

  it("terminates a newly launched MicroVM when controller startup fails", async () => {
    const fixture = createServicesFixture({ controllerReadyError: new Error("not ready") });
    const backend = createAwsLambdaMicrovmSandbox({ options: OPTIONS, services: fixture.services });
    await backend.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-failing-controller",
    });

    await expect(
      backend.create({
        runtimeContext: { appRoot: "/app" },
        sessionKey: "session-failing-controller",
        templateKey: "template-failing-controller",
      }),
    ).rejects.toThrow("not ready");
    expect(fixture.api.terminateMicrovm).toHaveBeenCalledWith("mvm-1");
  });
});

function createServicesFixture(input: { readonly controllerReadyError?: Error } = {}): {
  readonly api: ReturnType<typeof createFakeApi>;
  readonly controllers: FakeController[];
  readonly services: AwsLambdaMicrovmBackendServices;
  readonly storage: FakeStorage;
} {
  const api = createFakeApi();
  const storage = new FakeStorage();
  const controllers: FakeController[] = [];
  return {
    api,
    controllers,
    services: {
      api,
      createController() {
        const controller = new FakeController(input.controllerReadyError);
        controllers.push(controller);
        return controller;
      },
      storage,
    },
    storage,
  };
}

function createFakeApi() {
  const microvms = new Map<string, AwsLambdaMicrovmRecord>();
  let imageCreated = false;
  let nextMicrovm = 1;
  const imageArn = "arn:aws:lambda:us-east-1:123456789012:microvm-image:eve-test";

  return {
    createAuthToken: vi.fn(async () => "token"),
    createImage: vi.fn(async () => {
      imageCreated = true;
      return { imageArn, imageVersion: "1", state: "PENDING" as const };
    }),
    destroy: vi.fn(),
    getImageVersion: vi.fn(async () => ({
      imageArn,
      imageVersion: "1",
      state: "SUCCESSFUL" as const,
      status: "ACTIVE" as const,
    })),
    getMicrovm: vi.fn(async (microvmId: string) => microvms.get(microvmId) ?? null),
    listImages: vi.fn(async (name: string) =>
      imageCreated ? [{ imageArn, latestActiveImageVersion: "1", name }] : [],
    ),
    listImageVersions: vi.fn(async () =>
      imageCreated ? [{ imageArn, imageVersion: "1", state: "PENDING" as const }] : [],
    ),
    listManagedImages: vi.fn(async () => [
      { imageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1" },
    ]),
    listManagedImageVersions: vi.fn(async (managedImageArn: string) => [
      { imageArn: managedImageArn, imageVersion: "0" },
    ]),
    resumeMicrovm: vi.fn(async (microvmId: string) => {
      const current = microvms.get(microvmId);
      if (current !== undefined) microvms.set(microvmId, { ...current, state: "RUNNING" });
    }),
    runMicrovm: vi.fn(async (input) => {
      const microvmId = `mvm-${nextMicrovm++}`;
      const record: AwsLambdaMicrovmRecord = {
        endpoint: `https://${microvmId}.example.test`,
        imageArn: input.imageArn,
        imageVersion: input.imageVersion,
        microvmId,
        state: "RUNNING",
      };
      microvms.set(microvmId, record);
      return record;
    }),
    suspendMicrovm: vi.fn(async (microvmId: string) => {
      const current = microvms.get(microvmId);
      if (current !== undefined) microvms.set(microvmId, { ...current, state: "SUSPENDED" });
    }),
    tagResource: vi.fn(async () => {}),
    terminateMicrovm: vi.fn(async (microvmId: string) => {
      const current = microvms.get(microvmId);
      if (current !== undefined) microvms.set(microvmId, { ...current, state: "TERMINATED" });
    }),
  } satisfies AwsLambdaMicrovmApi;
}

class FakeStorage implements AwsLambdaMicrovmStorage {
  readonly bytes = new Map<string, Uint8Array>();
  readonly completedSha256s: string[] = [];
  readonly json = new Map<string, StoredJson<unknown>>();
  readonly objects = new Map<string, { readonly etag?: string; readonly size: number }>();
  #etag = 0;

  async abortMultipartUpload(): Promise<void> {}
  async assertBucketRegion(): Promise<void> {}
  async completeMultipartUpload(
    key: string,
    _uploadId: string,
    _parts: readonly { readonly etag: string; readonly partNumber: number }[],
    sha256: string,
  ): Promise<{ etag?: string }> {
    this.completedSha256s.push(sha256);
    const etag = `object-${++this.#etag}`;
    this.objects.set(key, { etag, size: 12 });
    return { etag };
  }
  async createMultipartUpload(): Promise<string> {
    return "upload-1";
  }
  async deleteObject(key: string, condition: { readonly etag?: string } = {}): Promise<void> {
    const current = this.json.get(key);
    if (condition.etag !== undefined && current?.etag !== condition.etag) {
      throw new Error("precondition failed");
    }
    this.bytes.delete(key);
    this.json.delete(key);
    this.objects.delete(key);
  }
  destroy(): void {}
  async getJson<T>(key: string): Promise<StoredJson<T> | null> {
    return (this.json.get(key) as StoredJson<T> | undefined) ?? null;
  }
  async hasObject(key: string): Promise<boolean> {
    return this.bytes.has(key);
  }
  async getObjectInfo(key: string): Promise<{ etag?: string; size: number } | null> {
    const object = this.objects.get(key);
    if (object !== undefined) return object;
    const bytes = this.bytes.get(key);
    return bytes === undefined ? null : { size: bytes.byteLength };
  }
  async presignGet(key: string): Promise<string> {
    return `https://s3.example.test/${key}`;
  }
  async presignUploadParts(
    _key: string,
    _uploadId: string,
    count: number,
  ): Promise<readonly string[]> {
    return Array.from({ length: count }, (_, index) => `https://s3.example.test/part/${index + 1}`);
  }
  async putBytes(key: string, bytes: Uint8Array): Promise<void> {
    this.bytes.set(key, bytes);
    this.objects.set(key, { size: bytes.byteLength });
  }
  async putJson(
    key: string,
    value: unknown,
    condition: { readonly absent?: boolean; readonly etag?: string } = {},
  ): Promise<{ etag: string }> {
    const current = this.json.get(key);
    if (condition.absent === true && current !== undefined) throw new Error("precondition failed");
    if (condition.etag !== undefined && current?.etag !== condition.etag) {
      throw new Error("precondition failed");
    }
    const etag = `json-${++this.#etag}`;
    this.json.set(key, { etag, value });
    return { etag };
  }
}

class FakeController implements AwsLambdaMicrovmController {
  dirty = false;
  readonly restored: { sha256: string; url: string }[] = [];
  readonly #readyError?: Error;

  constructor(readyError?: Error) {
    this.#readyError = readyError;
  }

  async checkpointCommitted(): Promise<void> {
    this.dirty = false;
  }
  async checkpointRelease(): Promise<void> {}
  async checkpointUpload(): Promise<readonly { etag: string; partNumber: number }[]> {
    return [{ etag: '"part-1"', partNumber: 1 }];
  }
  pauseHeartbeats(): void {}
  async prepareCheckpoint(): Promise<ControllerCheckpointPreparation> {
    return this.dirty
      ? {
          checkpointId: "checkpoint-1",
          dirty: true,
          partCount: 1,
          partSize: 64 * 1024 * 1024,
          sha256: "a".repeat(64),
          size: 12,
        }
      : { dirty: false };
  }
  async readFile(): Promise<ReadableStream<Uint8Array> | null> {
    return null;
  }
  async removePath(): Promise<void> {
    this.dirty = true;
  }
  async restoreCheckpoint(input: { sha256: string; size: number; url: string }): Promise<void> {
    this.restored.push(input);
  }
  resumeHeartbeats(): void {}
  async spawn(): Promise<ControllerProcess> {
    this.dirty = true;
    return {
      async kill() {},
      stderr: byteStream(""),
      stdout: byteStream(""),
      async wait() {
        return { exitCode: 0 };
      },
    };
  }
  async waitUntilReady(): Promise<void> {
    if (this.#readyError !== undefined) throw this.#readyError;
  }
  async writeFile(): Promise<void> {
    this.dirty = true;
  }
}

function byteStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}
