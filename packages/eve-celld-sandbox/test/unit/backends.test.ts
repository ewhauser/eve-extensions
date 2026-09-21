import test from "node:test";
import assert from "node:assert/strict";
import { celldContainer, celldJustBash } from "../../src/index.js";
import { containerName } from "../../src/container-protocol.js";

const identity = {
  namespace: "app",
  kind: "session",
  key: "session",
  template: null,
};
const generation = "e3b1fe7b-1398-4217-8c18-f81362ce34ba";
const incarnation = "13f53410-5b97-4dcd-9908-7ce4759190be";
const input = {
  sessionKey: "session",
  templateKey: null,
  runtimeContext: { appRoot: "/unused" },
};
const options = {
  endpoint: "https://sandbox.example",
  token: "x".repeat(32),
  namespace: "app",
};
const reply = (value: unknown) =>
  Response.json({ version: 1, ok: true, value });

test("container identities obey SDK name limits without collapsing application keys", async () => {
  const ref = { ...identity, kind: "session" as const };
  const name = await containerName(ref);
  assert.match(name, /^[a-z0-9-]{1,63}$/);
  assert.equal(name, await containerName(ref));
  assert.notEqual(name, await containerName({ ...ref, namespace: "other" }));
  assert.notEqual(name, await containerName({ ...ref, template: "template" }));
});

test("backends have different persisted identities and validate connection settings", () => {
  assert.notEqual(celldContainer(options).name, celldJustBash(options).name);
  for (const factory of [celldContainer, celldJustBash]) {
    assert.throws(
      () => factory({ ...options, endpoint: "http://sandbox.example" }),
      /HTTPS/,
    );
    assert.throws(() => factory({ ...options, token: "short" }), /token/i);
    assert.throws(() => factory({ ...options, namespace: "" }), /namespace/i);
  }
});

test("container state captures identity without credentials and can be captured after stop", async () => {
  const calls: any[] = [];
  const backend = celldContainer({
    ...options,
    fetch: async (url, init) => {
      assert.equal(String(url), options.endpoint + "/container/v1");
      const request = JSON.parse(String(init?.body));
      calls.push(request);
      return reply(
        request.operation.op === "open" ? { generation, incarnation } : null,
      );
    },
  });
  const handle = await backend.create(input);
  await handle.stop();
  const state = await handle.captureState();
  assert.equal(state.backendName, backend.name);
  assert.deepEqual(state.metadata, {
    protocol: 1,
    schema: 1,
    identity,
    generation,
    incarnation,
  });
  assert.ok(!JSON.stringify(state).includes(options.token));
  assert.deepEqual(
    calls.map((c) => c.operation.op),
    ["open", "stop"],
  );
  await assert.rejects(
    async () => await handle.session.run({ command: "echo no" }),
    /stopped/i,
  );
});

test("container reconnect permits a replacement incarnation, but rejects unrelated metadata", async () => {
  const backend = celldContainer({
    ...options,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.operation.generation, generation);
      return reply({ generation, incarnation });
    },
  });
  const metadata = {
    protocol: 1,
    schema: 1,
    identity,
    generation,
    incarnation: crypto.randomUUID(),
  };
  const handle = await backend.create({ ...input, existingMetadata: metadata });
  await assert.rejects(
    backend.create({
      ...input,
      existingMetadata: {
        ...metadata,
        identity: { ...identity, namespace: "other" },
      },
    }),
    /metadata/i,
  );
  assert.equal(handle.session.id, "session");
});

test("uncertain container execution is never automatically replayed", async () => {
  let executions = 0;
  const backend = celldContainer({
    ...options,
    fetch: async (_url, init) => {
      const { operation } = JSON.parse(String(init?.body));
      if (operation.op === "open") return reply({ generation, incarnation });
      if (operation.op === "execute") {
        executions++;
        throw new Error("connection lost after write");
      }
      return reply(null);
    },
  });
  const handle = await backend.create(input);
  await assert.rejects(
    async () => await handle.session.run({ command: "echo once >> log" }),
    /connection lost/,
  );
  assert.equal(executions, 1);
});

test("failed container stop remains retryable and concurrent callers await teardown", async () => {
  let stops = 0;
  let finish: () => void = () => {};
  const teardown = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const backend = celldContainer({
    ...options,
    fetch: async (_url, init) => {
      const { operation } = JSON.parse(String(init?.body));
      if (operation.op === "open") return reply({ generation, incarnation });
      if (operation.op === "stop") {
        if (++stops === 1) throw new Error("temporary teardown failure");
        await teardown;
      }
      return reply(null);
    },
  });
  const handle = await backend.create(input);
  await assert.rejects(handle.stop(), /teardown failure/);
  const retry = handle.stop();
  const concurrent = handle.shutdown();
  let done = false;
  void concurrent.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(done, false);
  assert.equal(stops, 2);
  finish();
  await Promise.all([retry, concurrent]);
  await handle.stop();
  assert.equal(stops, 2);
});

test("container binary IO and text line slicing preserve bytes and newline boundaries", async () => {
  let data: string | null = null;
  const backend = celldContainer({
    ...options,
    fetch: async (_url, init) => {
      const { operation } = JSON.parse(String(init?.body));
      if (operation.op === "open") return reply({ generation, incarnation });
      if (operation.op === "write") data = operation.data;
      return reply(operation.op === "read" ? data : null);
    },
  });
  const { session } = await backend.create(input);
  assert.equal(await session.readTextFile({ path: "missing" }), null);
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  await session.writeBinaryFile({ path: "bytes", content: bytes });
  assert.deepEqual(await session.readBinaryFile({ path: "bytes" }), bytes);
  await session.writeTextFile({ path: "text", content: "one\r\ntwo\rthree\n" });
  assert.equal(
    await session.readTextFile({ path: "text", startLine: 2, endLine: 2 }),
    "two\r",
  );
  await assert.rejects(
    session.setNetworkPolicy("deny-all"),
    /unsupported|network/i,
  );
});
