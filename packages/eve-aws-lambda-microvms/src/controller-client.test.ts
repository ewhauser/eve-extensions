import { afterEach, describe, expect, it, vi } from "vitest";

import type { AwsLambdaMicrovmApi, AwsLambdaMicrovmRecord } from "./api.js";
import { HttpAwsLambdaMicrovmController } from "./controller-client.js";

const MICROVM: AwsLambdaMicrovmRecord = {
  endpoint: "https://mvm.example.test",
  imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:test",
  imageVersion: "1.0",
  microvmId: "mvm-test",
  state: "RUNNING",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AWS Lambda MicroVM controller client", () => {
  it("refreshes a port-scoped token once after an authentication failure", async () => {
    const api = fakeApi();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(jsonResponse({ protocolVersion: 1, status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);

    const controller = new HttpAwsLambdaMicrovmController({ api, microvm: MICROVM });
    await controller.waitUntilReady(1000);

    expect(api.createAuthToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://mvm.example.test/v1/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-aws-proxy-auth": "token-2",
          "x-aws-proxy-port": "8080",
        }),
      }),
    );
  });

  it("streams file reads in bounded chunks", async () => {
    const api = fakeApi();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(byteResponse("first", 5, false))
      .mockResolvedValueOnce(byteResponse("second", 11, true));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new HttpAwsLambdaMicrovmController({ api, microvm: MICROVM });

    const stream = await controller.readFile("/workspace/data.bin");
    expect(stream).not.toBeNull();
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

    expect(new TextDecoder().decode(bytes)).toBe("firstsecond");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("offset=0"),
      expect.stringContaining("offset=5"),
    ]);
  });

  it("uploads large writes in chunks and commits atomically", async () => {
    const api = fakeApi();
    const requests: { readonly bodySize: number; readonly url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        const body = init?.body;
        requests.push({
          bodySize: body instanceof Uint8Array ? body.byteLength : 0,
          url: String(url),
        });
        if (String(url).endsWith("/v1/files/writes")) {
          return jsonResponse({ writeId: "write-1" }, 201);
        }
        return jsonResponse({ status: "ok" });
      }),
    );
    const controller = new HttpAwsLambdaMicrovmController({ api, microvm: MICROVM });

    await controller.writeFile("/workspace/data.bin", new Uint8Array(4 * 1024 * 1024 + 1));

    expect(requests).toEqual([
      { bodySize: 0, url: "https://mvm.example.test/v1/files/writes" },
      {
        bodySize: 4 * 1024 * 1024,
        url: "https://mvm.example.test/v1/files/writes/write-1?offset=0",
      },
      {
        bodySize: 1,
        url: `https://mvm.example.test/v1/files/writes/write-1?offset=${4 * 1024 * 1024}`,
      },
      { bodySize: 0, url: "https://mvm.example.test/v1/files/writes/write-1/commit" },
    ]);
  });

  it("retries an idempotent process start after a transient failure", async () => {
    const api = fakeApi();
    const processBodies: string[] = [];
    let startAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v1/processes" && init?.method === "POST") {
          processBodies.push(String(init.body));
          startAttempts++;
          return startAttempts === 1
            ? new Response("unavailable", { status: 503 })
            : jsonResponse({ processId: "process-1" }, 201);
        }
        if (path.endsWith("/logs/stdout") || path.endsWith("/logs/stderr")) {
          return byteResponse("", 0, true);
        }
        return jsonResponse({ exitCode: 0, state: "exited" });
      }),
    );
    const controller = new HttpAwsLambdaMicrovmController({ api, microvm: MICROVM });

    const process = await controller.spawn({ command: "true" });
    await Promise.all([
      process.wait(),
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).arrayBuffer(),
    ]);

    expect(startAttempts).toBe(2);
    expect(processBodies[1]).toBe(processBodies[0]);
  });
});

function fakeApi(): AwsLambdaMicrovmApi & { readonly createAuthToken: ReturnType<typeof vi.fn> } {
  let token = 0;
  return {
    createAuthToken: vi.fn(async () => `token-${++token}`),
    async createImage() {
      throw new Error("not used");
    },
    destroy() {},
    async getImageVersion() {
      throw new Error("not used");
    },
    async getMicrovm() {
      return MICROVM;
    },
    async listImages() {
      return [];
    },
    async listImageVersions() {
      return [];
    },
    async listManagedImages() {
      return [];
    },
    async listManagedImageVersions() {
      return [];
    },
    async resumeMicrovm() {},
    async runMicrovm() {
      return MICROVM;
    },
    async suspendMicrovm() {},
    async tagResource() {},
    async terminateMicrovm() {},
  };
}

function byteResponse(value: string, nextOffset: number, complete: boolean): Response {
  return new Response(new TextEncoder().encode(value), {
    headers: {
      "x-eve-complete": String(complete),
      "x-eve-next-offset": String(nextOffset),
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}
