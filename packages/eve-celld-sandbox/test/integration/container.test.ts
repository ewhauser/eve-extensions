import test from "node:test";
import assert from "node:assert/strict";
import { celldContainer, celldJustBash } from "eve-celld-sandbox";
import { runtime } from "./runtime.js";

test(
  "Cloudflare Sandbox on real celld and Docker",
  // ARM hosts may emulate the published AMD64 image during each cold start.
  { skip: process.env.EVE_CELLD_CONTAINERS !== "1", timeout: 600_000 },
  async (t) => {
    const server = await runtime("dist/worker/index.js", true);
    t.after(() => server.stop());
    await server.start();
    const backend = celldContainer(server.options);
    const input = (sessionKey: string, templateKey: string | null = null) => ({
      sessionKey,
      templateKey,
      runtimeContext: { appRoot: process.cwd() },
    });
    await t.test(
      "prewarm validates and stores initialization, and fresh containers replay it",
      async () => {
        assert.deepEqual(
          await backend.prewarm({
            templateKey: "template",
            runtimeContext: input("unused").runtimeContext,
            seedFiles: [{ path: "seed.txt", content: "seed\n" }],
            async bootstrap({ use }) {
              const session = await use();
              const result = await session.run({
                command:
                  "cat seed.txt > prepared.txt; echo initialized >> prepared.txt",
              });
              assert.equal(result.exitCode, 0, result.stderr);
            },
          }),
          { reused: false },
        );
        assert.deepEqual(
          await backend.prewarm({
            templateKey: "template",
            runtimeContext: input("unused").runtimeContext,
            seedFiles: [],
            bootstrap() {
              throw new Error("must reuse");
            },
          }),
          { reused: true },
        );
        const first = await backend.create(input("first", "template"));
        assert.equal(
          await first.session.readTextFile({ path: "prepared.txt" }),
          "seed\ninitialized\n",
        );
        await first.session.writeTextFile({
          path: "runtime.txt",
          content: "ephemeral",
        });
        const state = await first.captureState();
        const warm = await backend.create({
          ...input("first", "template"),
          existingMetadata: state.metadata,
        });
        assert.equal(
          await warm.session.readTextFile({ path: "runtime.txt" }),
          "ephemeral",
        );
        await first.stop();
        assert.deepEqual(await first.captureState(), state);
        const fresh = await backend.create({
          ...input("first", "template"),
          existingMetadata: state.metadata,
        });
        assert.equal(
          await fresh.session.readTextFile({ path: "runtime.txt" }),
          null,
        );
        assert.equal(
          await fresh.session.readTextFile({ path: "prepared.txt" }),
          "seed\ninitialized\n",
        );
        assert.notEqual(
          (await fresh.captureState()).metadata.incarnation,
          state.metadata.incarnation,
        );
        await assert.rejects(
          async () => await warm.session.run({ command: "echo stale" }),
          /replaced|stopped/i,
        );
        await fresh.delete();
        await assert.rejects(
          backend.create({
            ...input("first", "template"),
            existingMetadata: state.metadata,
          }),
          /deleted|replaced/i,
        );
      },
    );
    await t.test(
      "native programs, binary files, command environment, and nonzero exit",
      async () => {
        const handle = await backend.create(input("native"));
        try {
          const bytes = Uint8Array.from({ length: 4097 }, (_, i) => i % 256);
          await handle.session.writeBinaryFile({
            path: "nested/binary",
            content: bytes,
          });
          assert.deepEqual(
            await handle.session.readBinaryFile({ path: "nested/binary" }),
            bytes,
          );
          const result = await handle.session.run({
            command:
              'node -e \'console.log(process.env.TEST_VALUE); require("node:fs").writeFileSync("saved", "native")\'; echo warning >&2; exit 7',
            env: { TEST_VALUE: "hello ✓" },
          });
          assert.equal(result.stdout, "hello ✓\n", JSON.stringify(result));
          assert.equal(result.stderr, "warning\n");
          assert.equal(result.exitCode, 7);
          assert.equal(
            await handle.session.readTextFile({ path: "saved" }),
            "native",
          );
          assert.equal(
            (
              await handle.session.run({
                command: 'test -z "$TEST_VALUE" && echo fresh',
              })
            ).stdout,
            "fresh\n",
          );
          await handle.session.run({
            command:
              'node -e \'require("node:fs").writeFileSync("large", Buffer.alloc(1048577))\'',
          });
          await assert.rejects(
            handle.session.readBinaryFile({ path: "large" }),
            /limit/i,
          );
          await handle.session.removePath({ path: "nested", recursive: true });
          assert.equal(
            await handle.session.readBinaryFile({ path: "nested/binary" }),
            null,
          );
          await assert.rejects(
            handle.session.setNetworkPolicy("deny-all"),
            /unsupported/i,
          );
        } finally {
          await handle.shutdown();
        }
      },
    );
    await t.test(
      "cancellation settles the native process and preserves partial writes",
      async () => {
        const handle = await backend.create(input("cancel"));
        try {
          const process = await handle.session.spawn({
            command: "echo partial > partial; sleep 30; echo late > late",
          });
          const stopped = assert.rejects(
            async () => await process.wait(),
            /stopped|cancel|abort/i,
          );
          for (let i = 0; i < 100; i++) {
            if (await handle.session.readTextFile({ path: "partial" })) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.equal(
            await handle.session.readTextFile({ path: "partial" }),
            "partial\n",
          );
          await process.kill();
          await stopped;
          assert.equal(
            await handle.session.readTextFile({ path: "late" }),
            null,
          );
          assert.equal(
            (await handle.session.run({ command: "echo alive" })).stdout,
            "alive\n",
          );
        } finally {
          await handle.shutdown();
        }
      },
    );
    await t.test(
      "node restart preserves the DO identity and initialization but loses container writes",
      async () => {
        const handle = await backend.create(input("restart", "template"));
        await handle.session.writeTextFile({
          path: "temporary",
          content: "discard",
        });
        const state = await handle.captureState();
        await server.stop();
        await server.start();
        const replacement = await backend.create({
          ...input("restart", "template"),
          existingMetadata: state.metadata,
        });
        assert.equal(
          await replacement.session.readTextFile({ path: "temporary" }),
          null,
        );
        assert.equal(
          await replacement.session.readTextFile({ path: "prepared.txt" }),
          "seed\ninitialized\n",
        );
        await replacement.shutdown();
      },
    );
    await t.test(
      "both backends share a gateway without sharing filesystem state",
      async () => {
        const portable = await celldJustBash(server.options).create(
          input("same"),
        );
        const native = await backend.create(input("same"));
        try {
          await portable.session.writeTextFile({
            path: "which",
            content: "just-bash",
          });
          await native.session.writeTextFile({
            path: "which",
            content: "container",
          });
          assert.equal(
            await portable.session.readTextFile({ path: "which" }),
            "just-bash",
          );
          assert.equal(
            await native.session.readTextFile({ path: "which" }),
            "container",
          );
        } finally {
          await portable.shutdown();
          await native.shutdown();
        }
      },
    );
  },
);
