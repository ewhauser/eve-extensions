// Derived from vercel/eve PR #208 (Apache-2.0); adapted to current Eve lifecycle semantics.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AwsLambdaMicrovmApi, AwsLambdaMicrovmRecord } from "./api.js";
import { createAwsLambdaMicrovmActivationEnvelope } from "./activation.js";
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
const STRICT_OPTIONS = {
  ...OPTIONS,
  buildEgressNetworkConnectorArns: [
    "arn:aws:lambda:us-east-1:123456789012:network-connector:build",
  ],
  buildNetworkLaneId: "build-lane",
  networkingMode: "customer-managed",
  runtimeEgressNetworkConnectorArns: [
    "arn:aws:lambda:us-east-1:123456789012:network-connector:runtime",
  ],
  runtimeNetworkLaneId: "runtime-lane",
} as const;
const PUBLIC_TEST_CA = `-----BEGIN CERTIFICATE-----
MIICwjCCAaoCCQCw/VQlcDz3ETANBgkqhkiG9w0BAQsFADAjMSEwHwYDVQQDDBhl
dmUtZWdyZXNzLXByb3h5LXRlc3QtY2EwHhcNMjYwODE2MDIyNjU1WhcNMjYwODE3
MDIyNjU1WjAjMSEwHwYDVQQDDBhldmUtZWdyZXNzLXByb3h5LXRlc3QtY2EwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDH54ZSUg+WtgJgZjc2J31thXm6
+TDaJbwbCifCWrlIVaCmX9tccLuZnYVw0w/R/x8EE4l64hGQjQWDbDS3xcg4kfC1
66rVz7hDa80DmlHSLlARtNLQmQ689/UPLjbjp0pXeKWYe1r7KieWjawIzPliKGZ0
FfHNJ3YrvuCo4z1NIM+EfxOS31OfJ/+GOGzKSKDr+V/TQdLM1h8pIinZ7FifM92c
E3xAg0qKPyDKqUI1dlWqLFDPb0EnBnK+yLw7/McFlrEAbYXXoy9NA/PnEmhUW+We
TjVU/Vp2ZCjswZhIUC4VCOST9p1bNO2p10uLsK1XTpxkqynSuz0fI25/L/qtAgMB
AAEwDQYJKoZIhvcNAQELBQADggEBALQGo9CVTIPk07qLs2X0CAsw10rdyrGIxO+v
pc4n/JkxMbVCyV8wmFve7FYN97HLhJ9swKKHdh6m31+TXRq//ENxIHZD0X2SjeKv
ZS1JPcafAkeSBtGFZL7VZhBacvERuHrXK7iJd17vgznby0PH8DqUiGbbooIceBxd
GMiISlsOMCvnG7TqtrGWbGl84Wr57IQsEpvLphCTGISNT9ebHodjq2XwTiah1Ke1
vXE4cllUUkfTZrB8cfG0qIYWBG32sz3IkoOdZJa8jtKNsjhCwsX+/mi5PuUIENDk
cvKZSIRd5mmzmvNtQgWJanxamFuq2VD4N3Syvyplb/BiY46nN04=
-----END CERTIFICATE-----`;

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
    await handle.stop();
    expect(fixture.api.terminateMicrovm).toHaveBeenCalledTimes(1);
  });

  it("bootstraps, checkpoints, terminates, freshly launches, and restores a session", async () => {
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

    await handle.shutdown();
    expect(fixture.api.terminateMicrovm).toHaveBeenCalledTimes(2);

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

  it("permanently deletes session state without deleting shared template state", async () => {
    const fixture = createServicesFixture();
    const backend = createAwsLambdaMicrovmSandbox({ options: OPTIONS, services: fixture.services });

    await backend.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-delete",
    });
    const handle = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-delete",
      templateKey: "template-delete",
    });
    await handle.session.writeTextFile({ content: "delete me", path: "/tmp/session.txt" });
    await handle.captureState();

    const sessionKeys = [...fixture.storage.json.keys(), ...fixture.storage.objects.keys()].filter(
      (key) => key.includes("/sessions/"),
    );
    const templateKeys = [...fixture.storage.json.keys(), ...fixture.storage.objects.keys()].filter(
      (key) => key.includes("/templates/"),
    );
    expect(sessionKeys).not.toHaveLength(0);
    expect(templateKeys).not.toHaveLength(0);

    await handle.delete();

    for (const key of sessionKeys) {
      if (key.endsWith("/lease.json")) {
        expect(fixture.storage.json.get(key)?.value).toMatchObject({ expiresAt: 0, state: { metadata: null } });
        continue;
      }
      expect(fixture.storage.json.has(key) || fixture.storage.objects.has(key)).toBe(false);
    }
    for (const key of templateKeys) {
      expect(fixture.storage.json.has(key) || fixture.storage.objects.has(key)).toBe(true);
    }
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

  it.each([
    { returnedConnectorArns: [] },
    {
      returnedConnectorArns: [
        "arn:aws:lambda:us-east-1:123456789012:network-connector:unexpected",
      ],
    },
  ] as const)("rejects strict connector activation mismatch %# before controller traffic", async ({ returnedConnectorArns }) => {
    const fixture = createServicesFixture({
      returnedConnectorArns,
    });
    const backend = createAwsLambdaMicrovmSandbox({
      options: STRICT_OPTIONS,
      services: fixture.services,
    });
    await backend.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-strict-activation",
    });

    await expect(
      backend.create({
        runtimeContext: { appRoot: "/app" },
        sessionKey: "session-strict-activation",
        templateKey: "template-strict-activation",
      }),
    ).rejects.toThrow(/terminated .* before controller traffic/);
    expect(fixture.api.terminateMicrovm).toHaveBeenCalledWith("mvm-1");
    expect(fixture.controllers).toHaveLength(0);
  });

  it("injects an activation provider without replacing the other backend services", async () => {
    const fixture = createServicesFixture();
    const { activationProvider, ...services } = fixture.services;
    expect(activationProvider).toBeDefined();
    const backend = createAwsLambdaMicrovmSandbox({
      activationProvider: activationProvider!,
      options: STRICT_OPTIONS,
      services,
    });

    await backend.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-injected-activation-provider",
    });
    const handle = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-injected-activation-provider",
      templateKey: "template-injected-activation-provider",
    });

    expect(fixture.api.runMicrovm).toHaveBeenCalledTimes(1);
    expect(fixture.controllers).toHaveLength(1);
    await handle.stop();
  });

  it("persists placeholder binding generations and installs fresh replacement material", async () => {
    const fixture = createServicesFixture();
    const backend = createAwsLambdaMicrovmSandbox({
      options: STRICT_OPTIONS,
      services: fixture.services,
    });
    await backend.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-strict-reattach",
    });
    const first = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-strict-reattach",
      templateKey: "template-strict-reattach",
    });
    const state = await first.captureState();
    expect(state.metadata).toMatchObject({
      activationId: expect.any(String),
      controllerCaSha256: "c".repeat(64),
      egressNetworkConnectorArn: STRICT_OPTIONS.runtimeEgressNetworkConnectorArns[0],
      networkLaneId: "runtime-lane",
      placeholderGeneration: 1,
      placeholderPlacement: { environmentVariable: "OPENAI_API_KEY" },
      trustedBindingGeneration: 1,
    });
    expect(fixture.api.runMicrovm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        idlePolicy: expect.objectContaining({ autoResumeEnabled: false }),
      }),
    );

    const changed = createAwsLambdaMicrovmSandbox({
      options: { ...STRICT_OPTIONS, runtimeNetworkLaneId: "runtime-lane-v2" },
      services: fixture.services,
    });
    const replacement = await changed.create({
      existingMetadata: state.metadata,
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-strict-reattach",
      templateKey: "template-strict-reattach",
    });

    expect(fixture.api.terminateMicrovm).toHaveBeenCalledWith("mvm-1");
    expect(fixture.api.runMicrovm).toHaveBeenCalledTimes(2);
    expect(fixture.controllers).toHaveLength(2);
    expect((await replacement.captureState()).metadata).not.toMatchObject({
      activationId: state.metadata.activationId,
      placeholderGeneration: state.metadata.placeholderGeneration,
      trustedBindingGeneration: state.metadata.trustedBindingGeneration,
    });
    expect(fixture.revokeTrustedBinding).toHaveBeenCalledWith({
      activationId: "activation-fixture-1",
      placeholderGeneration: 1,
      trustedBindingGeneration: 1,
    });
    expect(fixture.revokeTrustedBinding.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.api.terminateMicrovm.mock.invocationCallOrder[0]!,
    );
    await replacement.shutdown();
  });

  it("moves replacement restore onto the image identity for a newly provisioned public CA", async () => {
    const fixture = createServicesFixture();
    const initial = createAwsLambdaMicrovmSandbox({
      options: STRICT_OPTIONS,
      services: fixture.services,
    });
    await initial.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-ca-rotation",
    });
    const first = await initial.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-ca-rotation",
      templateKey: "template-ca-rotation",
    });
    await first.session.writeTextFile({ content: "durable", path: "/workspace/state" });
    const before = await first.captureState();
    expect(before.metadata).not.toHaveProperty("egressProxyCaSha256");

    const updated = createAwsLambdaMicrovmSandbox({
      options: { ...STRICT_OPTIONS, egressProxyCaBundlePem: PUBLIC_TEST_CA },
      services: fixture.services,
    });
    await expect(
      updated.create({
        existingMetadata: before.metadata,
        runtimeContext: { appRoot: "/app" },
        sessionKey: "session-ca-rotation",
        templateKey: "template-ca-rotation",
      }),
    ).rejects.toThrow(/provision the updated template/);
    await updated.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-ca-rotation",
    });
    const replacement = await updated.create({
      existingMetadata: before.metadata,
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-ca-rotation",
      templateKey: "template-ca-rotation",
    });
    const after = await replacement.captureState();

    expect(after.metadata.configHash).not.toBe(before.metadata.configHash);
    expect(after.metadata.egressProxyCaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.controllers.at(-1)?.restored.at(-1)?.sha256).toBe("a".repeat(64));
  });

  it("rejects a replacement that reuses stale placeholder and trusted-binding generations", async () => {
    const fixture = createServicesFixture({ staleActivation: true });
    const backend = createAwsLambdaMicrovmSandbox({
      options: STRICT_OPTIONS,
      services: fixture.services,
    });
    await backend.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-stale-authority",
    });
    const first = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-stale-authority",
      templateKey: "template-stale-authority",
    });
    const state = await first.captureState();
    await expect(
      backend.create({
        existingMetadata: state.metadata,
        runtimeContext: { appRoot: "/app" },
        sessionKey: "session-stale-authority",
        templateKey: "template-stale-authority",
      }),
    ).rejects.toThrow(/stale placeholder\/binding generations/);
  });

  it("terminates and preserves the checkpoint when trusted-binding revocation fails", async () => {
    const fixture = createServicesFixture({
      revokeError: new Error("trusted control unavailable"),
    });
    const backend = createAwsLambdaMicrovmSandbox({
      options: STRICT_OPTIONS,
      services: fixture.services,
    });
    await backend.prewarm({
      runtimeContext: { appRoot: "/app" },
      seedFiles: [],
      templateKey: "template-revoke-failure",
    });
    const handle = await backend.create({
      runtimeContext: { appRoot: "/app" },
      sessionKey: "session-revoke-failure",
      templateKey: "template-revoke-failure",
    });
    await handle.session.writeTextFile({ content: "changed", path: "/workspace/state" });

    await expect(handle.captureState()).rejects.toThrow(/revoking its trusted proxy binding failed/);
    expect(fixture.api.terminateMicrovm).toHaveBeenCalledWith("mvm-1");
    expect(fixture.storage.completedSha256s).toEqual(["a".repeat(64)]);
  });
});

describe("bounded session launch authority", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(strict = false) {
    const fixture = createServicesFixture();
    const events: import("./types.js").AwsLambdaMicrovmLifecycleEvent[] = [];
    const backend = createAwsLambdaMicrovmSandbox({
      options: { ...(strict ? STRICT_OPTIONS : OPTIONS), launchTimeoutMs: 3000, onLifecycleEvent: (event) => events.push(event) },
      services: fixture.services,
    });
    await backend.prewarm({ runtimeContext: { appRoot: "/app" }, seedFiles: [], templateKey: "bounded" });
    vi.useFakeTimers();
    const createInput = { runtimeContext: { appRoot: "/app" }, sessionKey: "bounded-session", templateKey: "bounded" };
    return { ...fixture, backend, events, createInput };
  }

  it.each([
    { name: "ResourceNotFoundException" },
    { $metadata: { httpStatusCode: 404 } },
  ])("recovers when a recorded VM is already gone (%j)", async (details) => {
    const f = await setup();
    await f.backend.create(f.createInput);
    vi.setSystemTime(Date.now() + 600001);
    f.api.terminateMicrovm.mockRejectedValueOnce(Object.assign(new Error("VM already removed"), details));
    const handle = await f.backend.create(f.createInput);
    expect(f.api.runMicrovm).toHaveBeenCalledTimes(2);
    expect(f.api.runMicrovm.mock.calls[1]![0].clientToken).not.toBe(f.api.runMicrovm.mock.calls[0]![0].clientToken);
    await handle.stop();
  });

  it.each([
    { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } },
    { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } },
    { name: "ConflictException", $metadata: { httpStatusCode: 409 } },
    { name: "Error" },
  ])("retains the launch when retirement is not confirmed (%j)", async (details) => {
    const f = await setup();
    await f.backend.create(f.createInput);
    vi.setSystemTime(Date.now() + 600001);
    const error = Object.assign(new Error("retirement not confirmed"), details);
    f.api.terminateMicrovm.mockRejectedValueOnce(error);
    await expect(f.backend.create(f.createInput)).rejects.toBe(error);
    expect(f.api.runMicrovm).toHaveBeenCalledTimes(1);
    const authority = [...f.storage.json.entries()].find(([key]) => key.includes("/sessions/") && key.endsWith("lease.json"))![1];
    expect(authority.value).toMatchObject({ state: { launch: { microvmId: "mvm-1" } } });
    await vi.advanceTimersByTimeAsync(0);
    const recovered = await f.backend.create(f.createInput);
    expect(f.api.terminateMicrovm).toHaveBeenNthCalledWith(2, "mvm-1");
    await recovered.stop();
  });

  it("keeps a stalled final ownership check bounded and fences its late response", async () => {
    const f = await setup();
    const deadline = Date.now() + 3000;
    let ready = false;
    let confirmationWrites = 0;
    let delayedResult!: { etag: string };
    const delayed = deferred<{ etag: string }>();
    vi.spyOn(FakeController.prototype, "waitUntilReady").mockImplementation(async () => { ready = true; });
    const original = f.storage.putJson.bind(f.storage);
    vi.spyOn(f.storage, "putJson").mockImplementation(async (key, value, condition) => {
      const result = await original(key, value, condition);
      if (ready && key.includes("/sessions/") && ++confirmationWrites === 2) {
        delayedResult = result;
        return await delayed.promise;
      }
      return result;
    });
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    expect(confirmationWrites).toBe(2);
    const key = [...f.storage.json.keys()].find((key) => key.includes("/sessions/") && key.endsWith("lease.json"))!;
    expect((f.storage.json.get(key)!.value as { expiresAt: number }).expiresAt).toBeLessThanOrEqual(deadline);
    const successor = await f.backend.create(f.createInput);
    const before = f.storage.json.get(key);
    delayed.resolve(delayedResult);
    await vi.advanceTimersByTimeAsync(0);
    // Promotion may renew the successor; its authority and VM must remain intact.
    expect(f.storage.json.get(key)!.value).toMatchObject({
      generation: (before!.value as { generation: number }).generation,
      state: { launch: { microvmId: "mvm-2" } },
    });
    expect(f.api.terminateMicrovm.mock.calls.every(([id]) => id === "mvm-1")).toBe(true);
    await successor.stop();
  });

  it("does not dispatch an uncapped renewal before handing off a ready session", async () => {
    const f = await setup();
    const deadline = Date.now() + 3000;
    const original = f.storage.putJson.bind(f.storage);
    let handedOff = false;
    let renewedBeforeHandoff: boolean | undefined;
    vi.spyOn(f.storage, "putJson").mockImplementation(async (key, value, condition) => {
      const result = await original(key, value, condition);
      if (key.includes("/sessions/") && Number((value as { expiresAt?: number }).expiresAt) > deadline) {
        renewedBeforeHandoff = !handedOff;
        return await new Promise(() => {});
      }
      return result;
    });
    const creating = f.backend.create(f.createInput).then((handle) => {
      handedOff = true;
      return handle;
    });
    void creating.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(renewedBeforeHandoff).toBe(false);
    expect(handedOff).toBe(true);
    await creating;
  });

  it("rejects a never-settling RunMicrovm and stops persisted launch renewal", async () => {
    const f = await setup();
    f.api.runMicrovm.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const result = f.backend.create(f.createInput);
    const failure = expect(result).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(0);
    const request = f.api.runMicrovm.mock.calls[0]![0];
    expect(request.abortSignal?.aborted).toBe(false);
    const key = [...f.storage.json.keys()].find((key) => key.includes("/sessions/") && key.endsWith("lease.json"))!;
    expect(f.storage.json.get(key)?.value).toMatchObject({ expiresAt: started + 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    await failure;
    expect(request.abortSignal?.aborted).toBe(true);
    const after = f.storage.json.get(key);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(f.storage.json.get(key)).toEqual(after);
    expect(f.events).toContainEqual(expect.objectContaining({ phase: "launch", status: "deadline", durationMs: 3000 }));
  });

  it("replays the exact durable request and activation after a retry; rejects a stale copy of the adopted VM", async () => {
    const f = await setup(true);
    const first = deferred<AwsLambdaMicrovmRecord>();
    const realRun = f.api.runMicrovm.getMockImplementation()!;
    let shared: AwsLambdaMicrovmRecord;
    f.api.runMicrovm.mockImplementationOnce(async (request) => {
      shared = await realRun(request);
      return await first.promise;
    }).mockImplementationOnce(async () => shared);
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    const handle = await f.backend.create(f.createInput);
    const [a, b] = f.api.runMicrovm.mock.calls.map(([request]) => request);
    expect(a!.clientToken).toBe(b!.clientToken);
    const { abortSignal: _aSignal, onRequestMetadata: _aLog, ...aRequest } = a!;
    const { abortSignal: _bSignal, onRequestMetadata: _bLog, ...bRequest } = b!;
    expect(bRequest).toEqual(aRequest);
    expect(JSON.parse(b!.runHookPayload).activationId).toBe("activation-fixture-1");
    first.resolve(shared!);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.terminateMicrovm).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ phase: "late-result", status: "rejected" }));
    await handle.stop();
    const next = await f.backend.create(f.createInput);
    expect(f.api.runMicrovm.mock.calls[2]![0].clientToken).not.toBe(a!.clientToken);
    await next.stop();
  });

  it("terminates an unowned late success without publishing a checkpoint", async () => {
    const f = await setup();
    const late = deferred<AwsLambdaMicrovmRecord>();
    const realRun = f.api.runMicrovm.getMockImplementation()!;
    let record: AwsLambdaMicrovmRecord;
    f.api.runMicrovm.mockImplementationOnce(async (request) => {
      record = await realRun(request);
      return await late.promise;
    });
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    late.resolve(record!);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.terminateMicrovm).toHaveBeenCalledWith(record!.microvmId);
    expect(f.controllers).toHaveLength(0);
    expect(f.events).toContainEqual(expect.objectContaining({ phase: "late-result", status: "terminated" }));
    const authority = [...f.storage.json.entries()].find(([key]) => key.includes("/sessions/") && key.endsWith("lease.json"))![1];
    expect(authority.value).toMatchObject({ state: { metadata: null }, expiresAt: 0 });
    expect((authority.value as { state: object }).state).not.toHaveProperty("launch");
  });

  it("clears a late launch record when the returned VM was already removed", async () => {
    const f = await setup();
    const late = deferred<AwsLambdaMicrovmRecord>();
    const realRun = f.api.runMicrovm.getMockImplementation()!;
    let record!: AwsLambdaMicrovmRecord;
    f.api.runMicrovm.mockImplementationOnce(async (request) => {
      record = await realRun(request);
      return await late.promise;
    });
    f.api.terminateMicrovm.mockRejectedValueOnce(Object.assign(new Error("already removed"), {
      name: "ResourceNotFoundException",
    }));
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    late.resolve(record);
    await vi.advanceTimersByTimeAsync(0);
    const authority = [...f.storage.json.entries()].find(([key]) => key.includes("/sessions/") && key.endsWith("lease.json"))![1];
    expect((authority.value as { state: unknown }).state).toEqual({ metadata: null });
    expect(f.events).toContainEqual(expect.objectContaining({ phase: "late-result", status: "terminated" }));
    const successor = await f.backend.create(f.createInput);
    await successor.stop();
  });

  it("never adopts a VM targeted by an in-flight late-result termination", async () => {
    const f = await setup();
    const late = deferred<AwsLambdaMicrovmRecord>();
    const termination = deferred<void>();
    const realRun = f.api.runMicrovm.getMockImplementation()!;
    let oldVm: AwsLambdaMicrovmRecord;
    f.api.runMicrovm.mockImplementationOnce(async (request) => {
      oldVm = await realRun(request);
      return await late.promise;
    });
    f.api.terminateMicrovm.mockImplementationOnce(() => termination.promise);
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    late.resolve(oldVm!);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.terminateMicrovm).toHaveBeenCalledWith(oldVm!.microvmId);
    await vi.advanceTimersByTimeAsync(3000);
    const successor = await f.backend.create(f.createInput);
    expect(f.api.runMicrovm.mock.calls[1]![0].clientToken).not.toBe(f.api.runMicrovm.mock.calls[0]![0].clientToken);
    termination.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.terminateMicrovm.mock.calls.every(([id]) => id === oldVm!.microvmId)).toBe(true);
    await successor.stop();
  });

  it("keeps confirmed session authority renewable beyond both the launch budget and sliding TTL", async () => {
    const f = await setup();
    const handle = await f.backend.create(f.createInput);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await handle.session.writeTextFile({ path: "/workspace/alive", content: "yes" });
    await expect(handle.captureState()).resolves.toMatchObject({ metadata: { checkpoint: { generation: 1 } } });
  });

  it("bounds blocked metadata reads without later issuing RunMicrovm", async () => {
    const f = await setup();
    const read = deferred<StoredJson<unknown> | null>();
    const original = f.storage.getJson.bind(f.storage);
    vi.spyOn(f.storage, "getJson").mockImplementation(async (key) => {
      if (key.includes("/templates/") && key.endsWith("manifest.json")) return await read.promise as never;
      return await original(key) as never;
    });
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    read.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.runMicrovm).not.toHaveBeenCalled();
  });

  it("bounds blocked activation creation and cannot launch when it eventually returns", async () => {
    const f = await setup(true);
    const provider = f.services.activationProvider!;
    const activation = await provider.createActivation({ networkLaneId: "runtime-lane", purposeHash: "a".repeat(64) });
    const late = deferred<typeof activation>();
    vi.spyOn(provider, "createActivation").mockReturnValue(late.promise);
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    late.resolve(activation);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.runMicrovm).not.toHaveBeenCalled();
  });

  it("bounds a controller that never becomes ready and retires its MicroVM", async () => {
    const f = await setup();
    vi.spyOn(FakeController.prototype, "waitUntilReady").mockImplementation(() => new Promise(() => {}));
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.terminateMicrovm).toHaveBeenCalledWith("mvm-1");
    expect(f.events).toContainEqual(expect.objectContaining({ phase: "late-result", status: "terminated" }));
  });

  it("fails closed if a retry changes the pending launch configuration", async () => {
    const f = await setup();
    f.api.runMicrovm.mockImplementationOnce(() => new Promise(() => {}));
    const failed = expect(f.backend.create(f.createInput)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    const changed = createAwsLambdaMicrovmSandbox({ options: { ...OPTIONS, maximumDurationSeconds: 60 }, services: f.services });
    await expect(changed.create(f.createInput)).rejects.toThrow(/pending launch configuration changed/);
    expect(f.api.runMicrovm).toHaveBeenCalledTimes(1);
  });

  it("does not let a diagnostics callback failure affect the session", async () => {
    const f = await setup();
    const backend = createAwsLambdaMicrovmSandbox({ options: { ...OPTIONS, onLifecycleEvent() { throw new Error("observer failed"); } }, services: f.services });
    const handle = await backend.create(f.createInput);
    await handle.stop();
  });

  it("propagates caller cancellation to a non-cooperative API", async () => {
    const f = await setup();
    const abort = new AbortController();
    f.api.runMicrovm.mockImplementation(() => new Promise(() => {}));
    const failed = expect(f.backend.create({ ...f.createInput, abortSignal: abort.signal })).rejects.toThrow("caller cancelled");
    await vi.advanceTimersByTimeAsync(0);
    abort.abort(new Error("caller cancelled"));
    await failed;
    expect(f.api.runMicrovm.mock.calls[0]![0].abortSignal?.aborted).toBe(true);
    expect(f.events).toContainEqual(expect.objectContaining({ phase: "launch", status: "cancelled" }));
  });

  it("restores authoritative state ahead of stale workflow metadata and retains deletion tombstones", async () => {
    const f = await setup();
    const first = await f.backend.create(f.createInput);
    await first.session.writeTextFile({ path: "/workspace/one", content: "one" });
    const oldState = await first.captureState();
    const second = await f.backend.create(f.createInput);
    expect(f.controllers.at(-1)!.restored).toHaveLength(1);
    await second.session.writeTextFile({ path: "/workspace/two", content: "two" });
    const newState = await second.captureState();
    await expect(first.delete()).rejects.toThrow(/replaced by another holder/);
    const third = await f.backend.create({ ...f.createInput, existingMetadata: oldState.metadata });
    const expectedKey = (newState.metadata.checkpoint as { key: string }).key;
    expect(f.controllers.at(-1)!.restored[0]!.url).toContain(expectedKey);
    await third.delete();
    const fourth = await f.backend.create({ ...f.createInput, existingMetadata: oldState.metadata });
    expect(f.controllers.at(-1)!.restored).toHaveLength(0);
    await fourth.stop();
  });

  it("fences a checkpoint CAS already in flight when a successor takes ownership", async () => {
    const f = await setup();
    const first = await f.backend.create(f.createInput);
    await first.session.writeTextFile({ path: "/workspace/old", content: "old" });
    const gate = deferred<void>();
    const original = f.storage.putJson.bind(f.storage);
    let blocked = false;
    vi.spyOn(f.storage, "putJson").mockImplementation(async (key, value, condition) => {
      if (!blocked && key.includes("/sessions/") && (value as { state?: { metadata?: unknown } }).state?.metadata) {
        blocked = true;
        await gate.promise;
      }
      return await original(key, value, condition);
    });
    const captured = first.captureState();
    const failed = expect(captured).rejects.toThrow(/expired|released|precondition/);
    await vi.advanceTimersByTimeAsync(0);
    expect(blocked).toBe(true);
    vi.setSystemTime(Date.now() + 600001);
    const second = await f.backend.create(f.createInput);
    await second.session.writeTextFile({ path: "/workspace/new", content: "new" });
    const successor = await second.captureState();
    const key = [...f.storage.json.keys()].find((key) => key.includes("/sessions/") && key.endsWith("lease.json"))!;
    const before = f.storage.json.get(key);
    gate.resolve();
    await failed;
    expect(f.storage.json.get(key)).toEqual(before);
    expect(before?.value).toMatchObject({ state: { metadata: successor.metadata } });
    // Same content/generation still has distinct object names across owners.
    expect([...f.storage.objects.keys()].filter((key) => key.includes("/sessions/") && key.endsWith(".tar.zst"))).toHaveLength(2);
  });

  it("emits allowlisted timings and SDK metadata without activation or error credentials", async () => {
    const f = await setup(true);
    f.api.runMicrovm.mockImplementationOnce(async (request) => {
      request.onRequestMetadata?.({ requestId: "aws-request-1", attempts: 3, totalRetryDelay: 41, secret: request.runHookPayload } as never);
      throw new Error(request.runHookPayload);
    });
    await expect(f.backend.create(f.createInput)).rejects.toThrow();
    expect(f.events).toContainEqual(expect.objectContaining({ phase: "run-microvm", requestId: "aws-request-1", attempts: 3, totalRetryDelay: 41 }));
    expect(f.events.map((event) => event.phase)).toEqual(expect.arrayContaining(["lease-acquisition", "metadata-read", "activation", "run-microvm", "launch"]));
    expect(JSON.stringify(f.events)).not.toMatch(/eve_local|eve_placeholder|controllerSessionToken|runHookPayload|secret/);
  });
});

function createServicesFixture(
  input: {
    readonly controllerReadyError?: Error;
    readonly returnedConnectorArns?: readonly string[];
    readonly revokeError?: Error;
    readonly staleActivation?: boolean;
  } = {},
): {
  readonly api: ReturnType<typeof createFakeApi>;
  readonly controllers: FakeController[];
  readonly revokeTrustedBinding: ReturnType<typeof vi.fn>;
  readonly services: AwsLambdaMicrovmBackendServices;
  readonly storage: FakeStorage;
} {
  const api = createFakeApi(input.returnedConnectorArns);
  const storage = new FakeStorage();
  const controllers: FakeController[] = [];
  let activationGeneration = 0;
  const revokeTrustedBinding = vi.fn(async () => {
    if (input.revokeError !== undefined) throw input.revokeError;
  });
  return {
    api,
    controllers,
    services: {
      activationProvider: {
        async createActivation() {
          if (!input.staleActivation || activationGeneration === 0) activationGeneration++;
          return createAwsLambdaMicrovmActivationEnvelope({
            activationId: `activation-fixture-${activationGeneration}`,
            controllerCaSha256: "c".repeat(64),
            controllerSessionToken: `eve_local_fixture_${activationGeneration}`,
            placeholder: {
              generation: activationGeneration,
              placement: { environmentVariable: "OPENAI_API_KEY" },
              token: `eve_placeholder_fixture_${activationGeneration}`,
              trustedBindingGeneration: activationGeneration,
            },
          });
        },
        revokeTrustedBinding,
      },
      api,
      createController() {
        const controller = new FakeController(input.controllerReadyError);
        controllers.push(controller);
        return controller;
      },
      storage,
    },
    revokeTrustedBinding,
    storage,
  };
}

function createFakeApi(returnedConnectorArns?: readonly string[]) {
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
    runMicrovm: vi.fn(async (input) => {
      const microvmId = `mvm-${nextMicrovm++}`;
      const record: AwsLambdaMicrovmRecord = {
        egressNetworkConnectorArns:
          returnedConnectorArns ?? [...input.egressNetworkConnectorArns],
        endpoint: `https://${microvmId}.example.test`,
        imageArn: input.imageArn,
        imageVersion: input.imageVersion,
        microvmId,
        state: "RUNNING",
      };
      microvms.set(microvmId, record);
      return record;
    }),
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
    _parts: readonly {
      readonly etag: string;
      readonly partNumber: number;
      readonly sha256: string;
    }[],
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
    const currentEtag = current?.etag ?? this.objects.get(key)?.etag;
    if (condition.etag !== undefined && currentEtag !== condition.etag) {
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
    partSha256s: readonly string[],
  ): Promise<readonly string[]> {
    return partSha256s.map((_, index) => `https://s3.example.test/part/${index + 1}`);
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
          partSha256s: ["b".repeat(64)],
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
