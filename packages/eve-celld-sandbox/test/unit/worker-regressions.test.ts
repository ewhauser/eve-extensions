import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

// Bundle production workers, replacing only platform adapters unavailable in Node.
const directory = await mkdtemp(join(tmpdir(), "eve-worker-regressions-"));
after(() => rm(directory, { recursive: true, force: true }));
const mocks: Record<string, string> = {
  "cloudflare:workers": `export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }`,
  agentfs: `export class AgentFsWorkspace { entries=[]; async migrate(){} async load(){return this.entries} async save(entries){this.entries=entries} async clear(){this.entries=[]} }`,
  "@cloudflare/sandbox": `export class Sandbox { constructor(ctx,env){this.ctx=ctx;this.env=env;} async onStart(){} async exec(){this.ctx.container.running=true;return {exitCode:0,stdout:'',stderr:''}} async destroy(){this.ctx.container.running=false} } export function getSandbox(namespace){return namespace.stub}`,
};
async function worker(name: string) {
  const outfile = join(directory, `${name}.mjs`);
  await build({
    entryPoints: [
      new URL(`../../src/worker/${name}.ts`, import.meta.url).pathname,
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "platform-adapters",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(cloudflare:workers|@cloudflare\/sandbox)$|^\.\/agentfs\.js$/,
            },
            (args) => ({
              path: args.path === "./agentfs.js" ? "agentfs" : args.path,
              namespace: "mock",
            }),
          );
          builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
            contents: mocks[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href);
}
const { SandboxCell } = await worker("just-bash");
const { ContainerCell } = await worker("container");
function context() {
  const db = new DatabaseSync(":memory:");
  let initialized = Promise.resolve();
  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...bindings: Array<string | number | null>) {
          const rows = db.prepare(query).all(...bindings);
          return {
            toArray: () => rows,
            one: () => rows[0],
            [Symbol.iterator]: () => rows[Symbol.iterator](),
          };
        },
      },
      transactionSync: (fn: () => unknown) => fn(),
      transaction: (fn: () => unknown) => fn(),
      sync: async () => {},
    },
    container: { running: false },
    id: { toString: () => "cell" },
    blockConcurrencyWhile(fn: () => Promise<void>) {
      initialized = fn();
    },
  };
  return { ctx, ready: () => initialized, close: () => db.close() };
}
const identity = {
  namespace: "test",
  kind: "session",
  key: "session",
  template: null,
};
function invoke(
  cell: any,
  operation: unknown,
  ref: unknown = identity,
  route = "__eve",
) {
  return cell
    .fetch(
      new Request(`http://cell/${route}`, {
        method: "POST",
        body: JSON.stringify({ version: 1, identity: ref, operation }),
      }),
    )
    .then((r: Response) => r.json());
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a queued stale delete cannot erase a replacement just-bash session", async (t) => {
  const runtime = context();
  t.after(runtime.close);
  const cell = new SandboxCell(runtime.ctx, {});
  await runtime.ready();
  const old = await invoke(cell, { op: "open" }, identity, "v1");
  let release!: () => void;
  cell.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = invoke(
    cell,
    { op: "delete", generation: old.value.generation },
    identity,
    "v1",
  );
  await turn();
  const opened = invoke(cell, { op: "open" }, identity, "v1");
  await turn();
  const stale = invoke(
    cell,
    { op: "delete", generation: old.value.generation },
    identity,
    "v1",
  );
  await turn();
  release();
  const [deleted, replacement, rejected] = await Promise.all([
    first,
    opened,
    stale,
  ]);
  assert.equal(deleted.ok, true);
  assert.equal(replacement.ok, true);
  assert.notEqual(replacement.value.generation, old.value.generation);
  assert.equal(rejected.error?.code, "STALE_SESSION");
  const snapshot = await invoke(
    cell,
    { op: "snapshot", generation: replacement.value.generation },
    identity,
    "v1",
  );
  assert.equal(snapshot.ok, true);
  assert.ok(snapshot.value.length > 0, "replacement filesystem survives");
});

for (const expectedExitCode of [0, 7]) {
  test(`container recipes preserve and verify exit status ${expectedExitCode}`, async (t) => {
    const source = context();
    t.after(source.close);
    const cell = new ContainerCell(source.ctx, {});
    await source.ready();
    const buildIdentity = { ...identity, kind: "build" };
    const opened = await invoke(cell, { op: "open" }, buildIdentity);
    assert.equal(opened.ok, true);
    const command = {
      id: "install",
      command: "install-dependencies",
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
    };
    const terminal = (input: typeof command, exitCode: number) => ({
      id: input.id,
      state: "completed",
      exitCode,
      stdout: "",
      stderr: exitCode ? "dependency installation failed" : "",
    });
    cell.runNative = async (input: typeof command) =>
      terminal(input, expectedExitCode);
    assert.equal(
      (
        await invoke(
          cell,
          { op: "execute", ...opened.value, command },
          buildIdentity,
        )
      ).ok,
      true,
    );
    const recipe = await invoke(
      cell,
      { op: "recipe", ...opened.value },
      buildIdentity,
    );
    assert.equal(recipe.ok, true);
    assert.equal(recipe.value[0].expectedExitCode, expectedExitCode);
    for (const actualExitCode of [expectedExitCode, expectedExitCode + 1]) {
      const target = context();
      t.after(target.close);
      const replay = new ContainerCell(target.ctx, {
        CONTAINERS: { stub: { fetch: async () => Response.json(recipe) } },
      });
      await target.ready();
      replay.runNative = async (input: typeof command) =>
        terminal(input, actualExitCode);
      const result = await invoke(
        replay,
        { op: "open" },
        {
          ...identity,
          template: "template",
        },
      );
      const ready = target.ctx.storage.sql
        .exec("SELECT value FROM eve_meta WHERE key='ready'")
        .one().value;
      if (actualExitCode === expectedExitCode) {
        assert.equal(result.ok, true);
        assert.equal(ready, "true");
      } else {
        assert.equal(result.error?.code, "BOOTSTRAP");
        assert.equal(ready, "false");
        assert.equal(target.ctx.container.running, false);
      }
    }
  });
}
