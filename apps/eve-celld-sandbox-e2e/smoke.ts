import assert from "node:assert/strict";
import { backend } from "./config.js";
const b = backend();
const input = {
  sessionKey: process.env.SESSION_KEY ?? "smoke",
  templateKey: null,
  runtimeContext: { appRoot: process.cwd() },
};
let handle = await b.create(input);
await handle.session.writeTextFile({
  path: "records.json",
  content: JSON.stringify([
    { id: "synthetic-a", score: 2 },
    { id: "synthetic-b", score: 3 },
  ]),
});
const first = await handle.session.run({
  command:
    "celld-runtime; cat records.json | jq '[.[].score] | add' > result.txt; cat result.txt",
});
assert.equal(first.exitCode, 0);
assert.match(first.stdout, /celld\/just-bash [a-f0-9]+\n5\n/);
const info = JSON.parse(
  (await handle.session.run({ command: "agentfs-info" })).stdout,
);
assert.equal(info.engine, "agentfs");
assert.equal(info.sdkVersion, "0.6.4");
console.log("Filesystem:", info);
const state = await handle.captureState();
await handle.shutdown();
handle = await b.create({ ...input, existingMetadata: state.metadata });
assert.equal(await handle.session.readTextFile({ path: "result.txt" }), "5\n");
console.log(first.stdout.trim());
console.log(
  "Reconnected and read durable result:",
  await handle.session.readTextFile({ path: "result.txt" }),
);
await handle.shutdown();
