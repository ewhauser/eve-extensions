import test from "node:test";
import assert from "node:assert/strict";
import { celldJustBash, CelldClient } from "eve-celld-sandbox";
import { runtime } from "./runtime.js";

test(
  "large entry counts survive templates, direct writes, and celld restart",
  { timeout: 60_000 },
  async (t) => {
    const server = await runtime();
    t.after(() => server.stop());
    await server.start();
    const backend = celldJustBash(server.options);
    const client = new CelldClient(server.options);
    const runtimeContext = { appRoot: process.cwd() };
    await backend.prewarm({
      templateKey: "many-entries",
      runtimeContext,
      seedFiles: [],
      async bootstrap({ use }) {
        const session = await use();
        const result = await session.run({
          command:
            "mkdir directory{1..1100}; printf retained > directory1100/saved",
        });
        assert.equal(result.exitCode, 0, result.stderr);
      },
    });
    const input = {
      sessionKey: "large",
      templateKey: "many-entries",
      runtimeContext,
    };
    const handle = await backend.create(input);
    await handle.session.writeTextFile({
      path: "extra",
      content: "direct write",
    });
    const state = await handle.captureState();
    await handle.shutdown();
    await server.stop();
    await server.start();
    const reopened = await backend.create({
      ...input,
      existingMetadata: state.metadata,
    });
    assert.equal(
      await reopened.session.readTextFile({ path: "directory1100/saved" }),
      "retained",
    );
    assert.equal(
      await reopened.session.readTextFile({ path: "extra" }),
      "direct write",
    );
    assert.equal(
      (
        await reopened.session.run({
          command: "test -d directory1 && test -d directory1100",
        })
      ).exitCode,
      0,
    );
    const identity = {
      namespace: server.options.namespace,
      kind: "session" as const,
      template: input.templateKey,
      key: input.sessionKey,
    };
    const { generation } = await client.request(identity, { op: "open" });
    const entries = await client.request(identity, {
      op: "snapshot",
      generation,
    });
    assert.equal(entries.length, 1103); // root, 1100 directories, and two files
    const fromTemplate = await backend.create({
      ...input,
      sessionKey: "another",
    });
    assert.equal(
      await fromTemplate.session.readTextFile({ path: "directory1100/saved" }),
      "retained",
    );
    assert.equal(
      await fromTemplate.session.readTextFile({ path: "extra" }),
      null,
    );
  },
);
