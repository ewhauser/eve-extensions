import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { celldJustBash, CelldClient, ProtocolError } from "eve-celld-sandbox";
import {
  LIMITS,
  VERSION,
  base64,
  type Identity,
} from "eve-celld-sandbox/protocol";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runtime } from "./runtime.js";
const exec = promisify(execFile);
const rejects = (
  value: PromiseLike<unknown>,
  error?: Parameters<typeof assert.rejects>[1],
) =>
  error === undefined
    ? assert.rejects(Promise.resolve(value))
    : assert.rejects(Promise.resolve(value), error);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("real celld integration", { timeout: 180_000 }, async (t) => {
  const server = await runtime();
  await server.start();
  t.after(() => server.stop());
  const b = celldJustBash(server.options);
  const client = new CelldClient(server.options);
  const input = (sessionKey: string, templateKey: string | null = null) => ({
    sessionKey,
    templateKey,
    runtimeContext: { appRoot: process.cwd() },
  });
  async function raw(key: string, template: string | null = null) {
    const identity: Identity = {
      namespace: "integration",
      kind: "session",
      key,
      template,
    };
    const opened = await client.request(identity, { op: "open" });
    return { identity, generation: opened.generation };
  }
  async function waitRunning(ref: Awaited<ReturnType<typeof raw>>, id: string) {
    for (let i = 0; i < 200; i++) {
      const s = await client.request(ref.identity, {
        op: "status",
        generation: ref.generation,
        id,
      });
      if (s?.state === "running") return;
      await delay(10);
    }
    throw new Error("Command did not start");
  }

  await t.test(
    "pipelines, redirections, remote marker, stderr, normal nonzero writes",
    async () => {
      const h = await b.create(input("shell"));
      assert.deepEqual(
        await h.session.run({
          command: `echo '[{"n":2},{"n":3}]' > data; cat data | jq '[.[].n] | add' > answer; cat answer; echo warning >&2; exit 7`,
        }),
        { stdout: "5\n", stderr: "warning\n", exitCode: 7 },
      );
      assert.equal(await h.session.readTextFile({ path: "answer" }), "5\n");
      assert.match(
        (await h.session.run({ command: "celld-runtime" })).stdout,
        /^celld\/just-bash [a-f0-9]{64}\n$/,
      );
      assert.equal(
        (await h.session.run({ command: "echo normal > exit126; exit 126" }))
          .exitCode,
        126,
      );
      assert.equal(
        await h.session.readTextFile({ path: "exit126" }),
        "normal\n",
      );
      assert.equal(
        (
          await h.session.run({
            command:
              "echo normal > exit126-message; echo limit exceeded >&2; exit 126",
          })
        ).exitCode,
        126,
      );
      assert.equal(
        await h.session.readTextFile({ path: "exit126-message" }),
        "normal\n",
      );
    },
  );
  await t.test(
    "AgentFS backs agent-visible files and preserves chunked binary data",
    async () => {
      const h = await b.create(input("agentfs"));
      const bytes = Uint8Array.from(
        { length: 3 * 4096 + 17 },
        (_, i) => i % 256,
      );
      await h.session.writeBinaryFile({ path: "chunks", content: bytes });
      assert.equal(
        (
          await h.session.run({
            command: "cp chunks copied; chmod 600 copied; mkdir empty",
          })
        ).exitCode,
        0,
      );
      const info = JSON.parse(
        (await h.session.run({ command: "agentfs-info" })).stdout,
      );
      assert.equal(info.engine, "agentfs");
      assert.equal(info.sdkVersion, "0.6.4");
      assert.equal(info.schemaVersion, "0.4");
      assert.equal(info.chunkSize, 4096);
      assert.equal(info.bytesUsed, bytes.length * 2);
      assert.deepEqual(
        await h.session.readBinaryFile({ path: "copied" }),
        bytes,
      );
      assert.equal(
        (await h.session.run({ command: "stat -c %a copied" })).stdout.trim(),
        "600",
      );
      await h.session.run({
        command: "rm -r empty; echo changed > empty; rm chunks; mkdir chunks",
      });
      const reopened = await b.create(input("agentfs"));
      assert.equal(
        await reopened.session.readTextFile({ path: "empty" }),
        "changed\n",
      );
      assert.equal(
        (await reopened.session.run({ command: "test -d chunks" })).exitCode,
        0,
      );
    },
  );
  await t.test(
    "templates seed, bootstrap, immutable reuse, collision-free identities, deletion",
    async () => {
      let boot = 0;
      const prewarm = {
        templateKey: "seed-v1",
        runtimeContext: { appRoot: process.cwd() },
        seedFiles: [{ path: "seed", content: "template" }],
        bootstrap: async ({
          use,
        }: {
          use: () => Promise<import("eve/sandbox").SandboxSession>;
        }) => {
          boot++;
          const s = await use();
          await s.run({ command: "mkdir empty; echo boot > boot" });
        },
      };
      assert.equal((await b.prewarm(prewarm)).reused, false);
      assert.equal((await b.prewarm(prewarm)).reused, true);
      assert.equal(boot, 1);
      const a = await b.create(input("same-key", "seed-v1"));
      const bb = await b.create(input("other", "seed-v1"));
      assert.equal(await a.session.readTextFile({ path: "boot" }), "boot\n");
      await a.session.writeTextFile({ path: "seed", content: "edited" });
      const state = await a.captureState();
      assert.ok(!JSON.stringify(state).includes(server.token));
      const again = await celldJustBash(server.options).create({
        ...input("same-key", "seed-v1"),
        existingMetadata: state.metadata,
      });
      assert.equal(again.session.id, a.session.id);
      assert.equal(
        await again.session.readTextFile({ path: "seed" }),
        "edited",
      );
      const noTemplate = await b.create(input("same-key"));
      assert.equal(
        await noTemplate.session.readTextFile({ path: "seed" }),
        null,
      );
      const otherNamespace = await celldJustBash({
        ...server.options,
        namespace: "other-app",
      }).create(input("same-key"));
      assert.equal(
        await otherNamespace.session.readTextFile({ path: "seed" }),
        null,
      );
      await a.delete();
      assert.equal(await bb.session.readTextFile({ path: "seed" }), "template");
      const fresh = await b.create(input("third", "seed-v1"));
      assert.equal(
        await fresh.session.readTextFile({ path: "seed" }),
        "template",
      );
      await rejects(
        again.session.readTextFile({ path: "seed" }),
        /deleted|replaced/,
      );
      await rejects(b.create(input("missing", "absent")), {
        name: "SandboxTemplateNotProvisionedError",
      });
      await rejects(
        celldJustBash({ ...server.options, namespace: "other-app" }).create({
          ...input("same-key", "seed-v1"),
          existingMetadata: state.metadata,
        }),
        /metadata/,
      );
    },
  );
  await t.test(
    "binary, text encodings, empty directories, rename and removal",
    async () => {
      const h = await b.create(input("files"));
      const all = Uint8Array.from({ length: 256 }, (_, i) => i);
      await h.session.writeBinaryFile({ path: "bytes", content: all });
      assert.equal(
        (
          await h.session.run({
            command:
              "cat bytes > copied; mkdir -p empty/nested; mv copied renamed; chmod 640 renamed",
          })
        ).exitCode,
        0,
      );
      assert.deepEqual(
        await h.session.readBinaryFile({ path: "renamed" }),
        all,
      );
      await h.session.writeTextFile({
        path: "lines",
        content: "one\r\ntwo\rthree\nlast",
      });
      assert.equal(
        await h.session.readTextFile({
          path: "lines",
          startLine: 2,
          endLine: 3,
        }),
        "two\rthree\n",
      );
      assert.equal(
        await h.session.readTextFile({ path: "lines", startLine: 99 }),
        "",
      );
      await rejects(h.session.readTextFile({ path: "bytes" }));
      await rejects(h.session.readTextFile({ path: "lines", startLine: 0 }));
      await h.session.writeTextFile({
        path: "latin",
        content: "é",
        encoding: "latin1",
      });
      assert.equal(
        await h.session.readTextFile({ path: "latin", encoding: "latin1" }),
        "é",
      );
      await h.session.writeFile({
        path: "stream",
        content: new ReadableStream({
          start(c) {
            c.enqueue(all);
            c.close();
          },
        }),
      });
      assert.deepEqual(
        new Uint8Array(
          await new Response(
            await h.session.readFile({ path: "stream" }),
          ).arrayBuffer(),
        ),
        all,
      );
      assert.match(
        (await h.session.run({ command: "ln -s bytes symbolic" })).stderr,
        /ENOTSUP/,
      );
      assert.match(
        (await h.session.run({ command: "ln bytes hard" })).stderr,
        /ENOTSUP/,
      );
      await h.session.removePath({ path: "empty", recursive: true });
      await h.session.removePath({ path: "renamed" });
      assert.equal(await h.session.readBinaryFile({ path: "renamed" }), null);
    },
  );
  await t.test(
    "fresh interpreter resets cd, exports, functions, temporary files; overrides are per command",
    async () => {
      const h = await b.create(input("shell-state"));
      assert.equal(
        (
          await h.session.run({
            command:
              "mkdir dir; cd dir; export TEST_VALUE=kept; f(){ echo func; }; f; echo scratch >/tmp/once; pwd",
          })
        ).stdout,
        "func\n/workspace/dir\n",
      );
      assert.equal(
        (
          await h.session.run({
            command:
              'pwd; echo "${TEST_VALUE-unset}"; test ! -f /tmp/once; type f',
          })
        ).stdout.startsWith("/workspace\nunset\n"),
        true,
      );
      const reset = await h.session.run({
        command: "test ! -f /tmp/once && ! type f >/dev/null 2>&1",
      });
      assert.equal(reset.exitCode, 0);
      assert.equal(
        (
          await h.session.run({
            command: 'pwd; echo "$TEST_VALUE"',
            workingDirectory: "dir",
            env: { TEST_VALUE: "override" },
          })
        ).stdout,
        "/workspace/dir\noverride\n",
      );
      assert.equal(
        (await h.session.run({ command: 'pwd; echo "${TEST_VALUE-unset}"' }))
          .stdout,
        "/workspace\nunset\n",
      );
    },
  );
  await t.test(
    "same-ID retry, in-flight retry, lost response after commit, conflicting reuse",
    async () => {
      const ref = await raw("retries");
      const c = client.command({
        id: "once",
        command: "sleep 0.1; echo once >> counter",
      });
      const op = {
        op: "execute" as const,
        generation: ref.generation,
        command: c,
      };
      assert.deepEqual(
        await Promise.all([
          client.request(ref.identity, op),
          client.request(ref.identity, op),
        ]).then((r) => r[0]),
        await client.request(ref.identity, op),
      );
      await rejects(
        client.request(ref.identity, {
          ...op,
          command: { ...c, command: "echo twice >> counter" },
        }),
        /different input/,
      );
      let dropped = false;
      const lossy = new CelldClient({
        ...server.options,
        fetch: async (...args) => {
          const response = await fetch(...args);
          if (!dropped) {
            dropped = true;
            await response.arrayBuffer();
            throw new TypeError("Deliberately lost response AFTER commit");
          }
          return response;
        },
      });
      await lossy.request(ref.identity, {
        ...op,
        command: client.command({
          id: "lost",
          command: "echo lost >> counter",
        }),
      });
      const h = await b.create(input("retries"));
      assert.equal(
        await h.session.readTextFile({ path: "counter" }),
        "once\nlost\n",
      );
    },
  );
  await t.test(
    "serialize concurrent commands and direct file writes",
    async () => {
      const h = await b.create(input("concurrent"));
      const first = h.session.run({ command: "sleep 0.15; echo first >> log" });
      await delay(20);
      await Promise.all([
        first,
        h.session.run({ command: "echo second >> log" }),
        h.session.writeTextFile({ path: "direct", content: "present" }),
      ]);
      assert.equal(
        await h.session.readTextFile({ path: "log" }),
        "first\nsecond\n",
      );
      assert.equal(await h.session.readTextFile({ path: "direct" }), "present");
    },
  );
  await t.test(
    "spawn, cancellation, abort, timeout, stop, shutdown settle and rollback",
    async () => {
      const h = await b.create(input("cancellation"));
      const start = Date.now();
      const p = await h.session.spawn({
        command: "echo bad > cancelled; sleep 4",
      });
      assert.ok(Date.now() - start < 1500);
      const wait = rejects(p.wait(), /discarded|Cancelled/);
      await delay(50);
      await p.kill();
      await wait;
      assert.equal(await h.session.readTextFile({ path: "cancelled" }), null);
      const controller = new AbortController();
      const aborted = await h.session.spawn({
        command: "sleep 3",
        abortSignal: controller.signal,
      });
      const rejected = rejects(aborted.wait(), { name: "AbortError" });
      controller.abort();
      await rejected;
      const ref = await raw("timeout");
      const result = await client.request(ref.identity, {
        op: "execute",
        generation: ref.generation,
        command: client.command({
          id: "timeout",
          command: "echo bad > timeout; sleep 2",
          timeoutMs: 75,
        }),
      });
      assert.equal(result.state, "timeout");
      assert.equal(
        await client.request(ref.identity, {
          op: "read",
          generation: ref.generation,
          path: "/workspace/timeout",
        }),
        null,
      );
      for (const method of ["stop", "shutdown"] as const) {
        const current = await b.create(input("lifecycle"));
        const proc = await current.session.spawn({
          command: "echo bad > stopped; sleep 4",
        });
        const done = rejects(proc.wait());
        await delay(50);
        await current[method]();
        await done;
        const stoppedState = await current.captureState();
        const reopened = await b.create({
          ...input("lifecycle"),
          existingMetadata: stoppedState.metadata,
        });
        assert.equal(
          await reopened.session.readTextFile({ path: "stopped" }),
          null,
        );
        assert.equal(
          (await reopened.session.run({ command: "echo recovered" })).stdout,
          "recovered\n",
        );
      }
    },
  );
  await t.test(
    "limits, authentication, schema validation, network and unsupported commands",
    async () => {
      const ref = await raw("limits");
      const unauthorized = await fetch(`${server.endpoint}/v1`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(unauthorized.status, 401);
      assert.ok((await unauthorized.text()).length < 500);
      const invalid = await fetch(`${server.endpoint}/v1`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ version: 999 }),
      });
      assert.equal(invalid.status, 400);
      const oversized = await fetch(`${server.endpoint}/v1`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}` },
        body: "x".repeat(LIMITS.requestBytes + 1),
      });
      assert.equal(oversized.status, 413);
      const h = await b.create(input("limits"));
      await rejects(
        h.session.writeBinaryFile({
          path: "big",
          content: new Uint8Array(LIMITS.fileBytes + 1),
        }),
        /limit/i,
      );
      for (const [id, command] of [
        ["output", "echo bad > marker; seq 1 100000"],
        ["loop", "echo bad > marker; while true; do :; done"],
      ] as const) {
        const r = await client.request(ref.identity, {
          op: "execute",
          generation: ref.generation,
          command: client.command({ id, command }),
        });
        assert.equal(r.state, "failed", `${id}: ${JSON.stringify(r)}`);
        assert.equal(await h.session.readTextFile({ path: "marker" }), null);
      }
      await h.session.setNetworkPolicy("deny-all");
      await rejects(h.session.setNetworkPolicy("allow-all"), /Only deny-all/);
      assert.equal(
        (await h.session.run({ command: "curl https://example.com" })).exitCode,
        127,
      );
      assert.equal(
        (await h.session.run({ command: "python3 -V" })).exitCode,
        127,
      );
      await rejects(
        h.session.writeTextFile({ path: "/etc/passwd", content: "no" }),
        /workspace/,
      );
      assert.equal(
        (await h.session.run({ command: "echo later" })).stdout,
        "later\n",
      );
    },
  );

  await t.test(
    "oversized whole snapshot is rejected atomically and retry journal is bounded",
    async () => {
      const h = await b.create(input("snapshot-size"));
      for (let i = 0; i < 4; i++)
        await h.session.writeBinaryFile({
          path: `block${i}`,
          content: new Uint8Array(LIMITS.fileBytes),
        });
      await rejects(
        h.session.writeTextFile({ path: "overflow", content: "x" }),
        /snapshot byte limit/,
      );
      assert.equal(await h.session.readTextFile({ path: "overflow" }), null);
      assert.equal(
        (await h.session.readBinaryFile({ path: "block0" }))?.byteLength,
        LIMITS.fileBytes,
      );
      const ref = await raw("retention");
      const cancelled = client.command({
        id: "pre-cancelled",
        command: "echo bad > cancelled",
      });
      assert.equal(
        (
          await client.request(ref.identity, {
            op: "cancel",
            generation: ref.generation,
            command: cancelled,
          })
        ).state,
        "cancelled",
      );
      assert.equal(
        (
          await client.request(ref.identity, {
            op: "execute",
            generation: ref.generation,
            command: cancelled,
          })
        ).state,
        "cancelled",
      );
      for (let i = 0; i < LIMITS.journalCount; i++)
        await client.request(ref.identity, {
          op: "execute",
          generation: ref.generation,
          command: client.command({ id: `retained-${i}`, command: ":" }),
        });
      assert.equal(
        await client.request(ref.identity, {
          op: "status",
          generation: ref.generation,
          id: "pre-cancelled",
        }),
        null,
      );
      assert.equal(
        (
          await client.request(ref.identity, {
            op: "status",
            generation: ref.generation,
            id: `retained-${LIMITS.journalCount - 1}`,
          })
        )?.state,
        "completed",
      );
    },
  );
  await t.test(
    "Node host and celld restart preserve bytes and empty directories",
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CELLD_ENDPOINT: server.endpoint,
        CELLD_TOKEN: server.token,
      };
      await exec(
        process.execPath,
        ["--import", "tsx", "test/integration/process-fixture.ts", "write"],
        { env },
      );
      await server.stop();
      await server.start();
      await exec(
        process.execPath,
        ["--import", "tsx", "test/integration/process-fixture.ts", "read"],
        { env },
      );
    },
  );
  await t.test(
    "SIGKILL during command recovers interruption without partial changes or replay",
    async () => {
      const ref = await raw("crash");
      const completed = client.command({
        id: "acknowledged",
        command: "echo durable > committed",
      });
      await client.request(ref.identity, {
        op: "execute",
        generation: ref.generation,
        command: completed,
      });
      const command = client.command({
        id: "crash",
        command: "echo partial > committed; echo partial > new; sleep 9",
      });
      // Use a single attempt for the killed connection; exercise explicit retry after restart.
      const pending = fetch(`${server.endpoint}/v1`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}` },
        body: JSON.stringify({
          version: VERSION,
          identity: ref.identity,
          operation: { op: "execute", generation: ref.generation, command },
        }),
      }).catch(() => null);
      await waitRunning(ref, "crash");
      await delay(50);
      await server.stop("SIGKILL");
      await pending;
      await server.start();
      const result = await client.request(ref.identity, {
        op: "execute",
        generation: ref.generation,
        command,
      });
      assert.equal(result.state, "interrupted");
      assert.deepEqual(
        await client.request(ref.identity, {
          op: "status",
          generation: ref.generation,
          id: "crash",
        }),
        result,
      );
      assert.equal(
        await client.request(ref.identity, {
          op: "read",
          generation: ref.generation,
          path: "/workspace/committed",
        }),
        base64(new TextEncoder().encode("durable\n")),
      );
      assert.equal(
        await client.request(ref.identity, {
          op: "read",
          generation: ref.generation,
          path: "/workspace/new",
        }),
        null,
      );
      assert.equal(
        (
          await client.request(ref.identity, {
            op: "execute",
            generation: ref.generation,
            command: completed,
          })
        ).state,
        "completed",
      );
    },
  );
  await t.test(
    "actual Eve mock-model tool loop uses the remote backend across turns",
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CELLD_ENDPOINT: server.endpoint,
        CELLD_TOKEN: server.token,
        CELLD_NAMESPACE: "eve-integration",
        EVE_TELEMETRY_DISABLED: "1",
      };
      delete env.EVE_MODEL;
      delete env.AI_GATEWAY_API_KEY;
      const bin = resolve(
        dirname(createRequire(import.meta.url).resolve("eve/package.json")),
        "bin/eve.js",
      );
      const { stdout, stderr } = await exec(
        process.execPath,
        [bin, "eval", "--strict", "--skip-report", "--verbose"],
        {
          cwd: resolve("../../apps/eve-celld-sandbox-e2e"),
          env,
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      await writeFile(`${server.directory}/eve-eval.log`, stdout + stderr);
      assert.match(stdout, /Results: 1 passed/);
      assert.match(stdout, /Gates: 6 passed/);
      assert.match(stdout + stderr, /backend "celld-just-bash-v1"/);
    },
  );
  await t.test(
    "actual Eve process resumes the same sandbox after Eve and celld restart",
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CELLD_ENDPOINT: server.endpoint,
        CELLD_TOKEN: server.token,
        CELLD_NAMESPACE: "eve-restart",
        EVE_TELEMETRY_DISABLED: "1",
      };
      delete env.EVE_MODEL;
      delete env.AI_GATEWAY_API_KEY;
      const bin = resolve(
        dirname(createRequire(import.meta.url).resolve("eve/package.json")),
        "bin/eve.js",
      );
      async function invoke(args: string[], stdin?: string): Promise<string> {
        return new Promise((resolveResult, reject) => {
          const child = execFile(
            process.execPath,
            [
              "--import",
              "tsx",
              resolve("../../apps/eve-celld-sandbox-e2e/eve.ts"),
              "invoke",
              ...args,
            ],
            {
              cwd: process.cwd(),
              env,
              timeout: 60_000,
              maxBuffer: 2 * 1024 * 1024,
            },
            (error, stdout, stderr) =>
              error
                ? reject(new Error(stderr, { cause: error }))
                : resolveResult(stdout),
          );
          child.stdin?.end(stdin);
        });
      }
      const first = await invoke(["calculate and save"]);
      const before = JSON.parse(first);
      assert.equal(before.outcome.status, "completed");
      const firstOutput = JSON.parse(before.outcome.message).stdout;
      assert.match(firstOutput, /template-ready\n5\n/);
      await server.stop();
      await server.start();
      const second = JSON.parse(
        await invoke(["--resume", "read saved"], first),
      );
      assert.equal(second.outcome.status, "completed");
      const secondOutput = JSON.parse(second.outcome.message).stdout;
      const firstLines = firstOutput.trim().split("\n");
      const secondLines = secondOutput.trim().split("\n");
      assert.equal(secondLines[0], firstLines[0]); // same remote cell after restart
      assert.equal(secondLines[2], "5");
      const firstFs = JSON.parse(firstLines[1]);
      const secondFs = JSON.parse(secondLines[1]);
      assert.equal(secondFs.engine, "agentfs");
      // agentfs-info observes committed state, so the second turn also sees
      // the result.txt file created by the first command.
      assert.equal(secondFs.inodes, firstFs.inodes + 1);
      assert.equal(secondFs.bytesUsed, firstFs.bytesUsed + 2);
      assert.equal(
        second.resume.session.sessionId,
        before.resume.session.sessionId,
      );
    },
  );
});
