import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CelldClient, celldJustBash } from "eve-celld-sandbox";
import { base64, type Identity, type Entry } from "eve-celld-sandbox/protocol";
import { runtime } from "./runtime.js";

test(
  "AgentFS migration and atomic commit on real celld",
  { timeout: 60_000 },
  async (t) => {
    const dir = resolve(".test-state", crypto.randomUUID());
    await mkdir(dir, { recursive: true });
    await promisify(execFile)(process.execPath, [
      "scripts/build-worker.mjs",
      "test/integration/fixtures/agentfs-worker.ts",
      `${dir}/worker.js`,
    ]);
    const server = await runtime(`${dir}/worker.js`);
    t.after(() => server.stop());
    await server.start();
    const client = new CelldClient(server.options);
    const backend = celldJustBash(server.options);
    const identity: Identity = {
      namespace: "integration",
      kind: "session",
      template: null,
      key: "upgrade",
    };
    const generation = crypto.randomUUID();
    const bytes = Uint8Array.from({ length: 9001 }, (_, i) => i % 256);
    const mtime = 1_712_345_678_123;
    const entries: Entry[] = [
      { path: "/workspace", kind: "directory", data: "", mode: 0o755, mtime },
      {
        path: "/workspace/empty",
        kind: "directory",
        data: "",
        mode: 0o750,
        mtime,
      },
      {
        path: "/workspace/bytes",
        kind: "file",
        data: base64(bytes),
        mode: 0o640,
        mtime,
      },
    ];
    entries.sort((a, b) => a.path.localeCompare(b.path));
    async function fixture(body: Record<string, unknown>) {
      const response = await fetch(`${server.endpoint}/__fixture`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ identity, ...body }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    await fixture({ action: "legacy", entries, generation });
    await server.stop();
    await server.start();

    await t.test(
      "migrates bytes, empty directories, permissions, timestamps, identity and journal",
      async () => {
        const opened = await client.request(identity, {
          op: "open",
          generation,
        });
        assert.equal(opened.generation, generation);
        assert.deepEqual(
          await client.request(identity, { op: "snapshot", generation }),
          entries,
        );
        const inspected = await fixture({
          action: "inspect",
          path: "/workspace/bytes",
        });
        assert.equal(inspected.legacyTables, 0);
        assert.equal(inspected.data, base64(bytes));
        assert.equal(inspected.stats.mode & 0o7777, 0o640);
        assert.equal(
          inspected.stats.mtime * 1000 + inspected.metadata.mtime_nsec / 1e6,
          mtime,
        );
        assert.ok(
          inspected.config.some(
            (r: { key: string; value: string }) =>
              r.key === "schema_version" && r.value === "0.4",
          ),
        );
        const old = await client.request(identity, {
          op: "status",
          generation,
          id: "legacy-finished",
        });
        assert.equal(old?.state, "completed");
        await server.stop();
        await server.start();
        assert.deepEqual(
          await client.request(identity, { op: "snapshot", generation }),
          entries,
        );
      },
    );

    await t.test(
      "journal commit failure rolls back all AgentFS changes and records failure",
      async () => {
        await fixture({ action: "fail-commit" });
        const command = client.command({
          id: "commit-failure",
          command: "echo changed > bytes; echo new > partial; rm -r empty",
        });
        const result = await client.request(identity, {
          op: "execute",
          generation,
          command,
        });
        assert.equal(result.state, "failed");
        assert.match(result.stderr, /injected commit failure/);
        assert.deepEqual(
          await client.request(identity, { op: "snapshot", generation }),
          entries,
        );
        assert.equal(
          (await fixture({ action: "inspect", path: "/workspace/bytes" })).data,
          base64(bytes),
        );
        assert.deepEqual(
          await client.request(identity, {
            op: "execute",
            generation,
            command,
          }),
          result,
        );
        await fixture({ action: "repair" });
        const handle = await backend.create({
          sessionKey: identity.key,
          templateKey: null,
          runtimeContext: { appRoot: process.cwd() },
        });
        assert.equal(
          (await handle.session.run({ command: "echo works > after" }))
            .exitCode,
          0,
        );
        await server.stop();
        await server.start();
        assert.equal(
          (
            await client.request(identity, {
              op: "status",
              generation,
              id: command.id,
            })
          )?.state,
          "failed",
        );
        assert.equal(
          await handle.session.readTextFile({ path: "after" }),
          "works\n",
        );
        assert.equal(
          await handle.session.readTextFile({ path: "partial" }),
          null,
        );
      },
    );
  },
);
