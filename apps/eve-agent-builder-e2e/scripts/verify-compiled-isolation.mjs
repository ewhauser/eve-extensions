import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const snapshots = new URL("../.eve/dev-runtime/snapshots/", import.meta.url);
const candidates = readdirSync(snapshots, { recursive: true })
  .filter((entry) =>
    String(entry).endsWith("/.eve/compile/compiled-agent-manifest.json"),
  )
  .map((entry) => join(snapshots.pathname, String(entry)))
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

const manifestPath = candidates[0];
if (manifestPath === undefined) {
  throw new Error("Eve eval did not produce a compiled agent manifest");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const failures = [];
const requiredDisabled = [
  "ask_question",
  "bash",
  "load_skill",
  "read_file",
  "todo",
  "web_fetch",
  "web_search",
  "write_file",
].sort();
const expectedChildren = ["active-runner", "implementor", "pm", "qa", "test-runner"];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

assert(manifest.kind === "eve-agent-compiled-manifest", "missing Eve compiled manifest");
assert(manifest.diagnosticsSummary?.errors === 0, "root manifest contains errors");
assert(manifest.diagnosticsSummary?.warnings === 0, "root manifest contains warnings");
assert(manifest.instructions?.some(({ content }) => content.includes("ROOT_PRIVATE_INSTRUCTION_03")), "root instruction canary missing");
assert(manifest.tools?.some(({ name }) => name === "root-private"), "root tool canary missing");
assert(manifest.connections?.some(({ connectionName }) => connectionName === "root-private"), "root connection canary missing");
assert(manifest.skills?.some(({ name }) => name === "root-private"), "root skill canary missing");
assert(manifest.sandbox !== null, "root sandbox canary missing");

for (const name of expectedChildren) {
  const child = manifest.subagents?.find((entry) => entry.name === name)?.agent;
  assert(child !== undefined, `declared child ${name} missing`);
  if (child === undefined) continue;
  assert(child.diagnosticsSummary?.errors === 0, `${name} manifest contains errors`);
  assert(child.diagnosticsSummary?.warnings === 0, `${name} manifest contains warnings`);
  assert(child.connections?.length === 0, `${name} inherited a root connection`);
  assert(child.skills?.length === 0, `${name} inherited a root skill`);
  assert(
    child.sandbox?.sourceId === "eve:defaults:sandbox.ts",
    `${name} did not retain only Eve's isolated default sandbox`,
  );
  assert(child.sandboxWorkspaces?.length === 0, `${name} inherited a root sandbox workspace`);
  assert(child.tools?.length === 0, `${name} inherited a root authored tool`);
  assert(
    !child.instructions?.some(({ content }) =>
      content.includes("ROOT_PRIVATE_INSTRUCTION_03"),
    ),
    `${name} inherited root instructions`,
  );
  assert(
    JSON.stringify(
      child.sourceComposition?.entries
        .filter(({ kind, source }) =>
          kind === "disabled" && source?.logicalPath?.startsWith("tools/"),
        )
        .map(({ source }) => source.logicalPath.slice("tools/".length, -".ts".length))
        .sort(),
    ) === JSON.stringify(requiredDisabled),
    `${name} did not explicitly disable every unmounted Eve framework tool`,
  );
  assert(
    JSON.stringify(child.dynamicTools?.map(({ slug }) => slug).sort()) ===
      JSON.stringify(["agent-builder", "connection_search"]),
    `${name} has an unexpected dynamic tool source`,
  );
  assert(child.dynamicInstructions?.length === 1, `${name} lacks its one saved-context mount`);
  assert(child.extensionMounts?.length === 1, `${name} lacks the pinned extension config mount`);
}

if (failures.length > 0) {
  throw new Error(`Built host isolation verification failed:\n- ${failures.join("\n- ")}`);
}
console.log(`Verified Eve 0.45 compiled isolation for ${expectedChildren.join(", ")}.`);
