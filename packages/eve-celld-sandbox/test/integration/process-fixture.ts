import assert from "node:assert/strict";
import { celldJustBash } from "eve-celld-sandbox";
const b = celldJustBash({
  endpoint: process.env.CELLD_ENDPOINT!,
  token: process.env.CELLD_TOKEN!,
  namespace: "process-restart",
});
const h = await b.create({
  sessionKey: "same-session",
  templateKey: null,
  runtimeContext: { appRoot: process.cwd() },
});
if (process.argv[2] === "write") {
  await h.session.writeTextFile({
    path: "text",
    content: "persistent ✓\r\nsecond\n",
  });
  await h.session.writeBinaryFile({
    path: "bytes",
    content: Uint8Array.from([0, 255, 128, 10, 0, 1]),
  });
  assert.equal(
    (
      await h.session.run({
        command: "mkdir empty; chmod 700 empty; mv text renamed",
      })
    ).exitCode,
    0,
  );
} else {
  assert.equal(
    await h.session.readTextFile({ path: "renamed" }),
    "persistent ✓\r\nsecond\n",
  );
  assert.deepEqual(
    await h.session.readBinaryFile({ path: "bytes" }),
    Uint8Array.from([0, 255, 128, 10, 0, 1]),
  );
  assert.equal(
    (
      await h.session.run({
        command:
          'test -d empty && test -z "$(ls -A empty)" && stat -c %a empty',
      })
    ).stdout,
    "700\n",
  );
}
await h.shutdown();
console.log("process fixture passed", process.argv[2]);
