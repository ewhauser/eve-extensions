import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../.eve/evals/", import.meta.url);
const tokenPattern = /ab1_[A-Za-z0-9_-]{30,}/gu;

async function redact(path) {
  const metadata = await stat(path);
  if (metadata.isDirectory()) {
    await Promise.all((await readdir(path)).map((entry) => redact(join(path, entry))));
    return;
  }
  if (!/\.(?:json|jsonl|ndjson)$/u.test(path)) return;
  const source = await readFile(path, "utf8");
  const redacted = source.replace(tokenPattern, "[REDACTED_BOOTSTRAP_TOKEN]");
  if (redacted !== source) await writeFile(path, redacted, "utf8");
  if (tokenPattern.test(redacted)) throw new Error(`Bootstrap token remained in ${path}`);
  tokenPattern.lastIndex = 0;
}

try {
  await redact(root.pathname);
  process.stdout.write("Redacted opaque bootstrap credentials from retained Eve eval artifacts.\n");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
