import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, copyFile } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
const require = createRequire(import.meta.url);
export async function unusedPort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const address = s.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const port = address.port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
export async function runtime(
  worker = "dist/worker/just-bash.js",
  containers = false,
) {
  const port = await unusedPort();
  // Eve watches workspace dependencies during invoke. SQLite writes under the
  // package would trigger rebuilds while its own agent is using this backend.
  const directory = await mkdtemp(join(tmpdir(), "eve-celld-sandbox-"));
  await copyFile(resolve(worker), `${directory}/worker.js`);
  const token = Buffer.from(randomBytes(32)).toString("hex");
  const endpoint = `http://127.0.0.1:${port}`;
  const config = {
    name: "eve-durable-object-tests",
    main: "worker.js",
    compatibility_date: "2026-09-20",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: {
      bindings: [
        { name: "CELLS", class_name: "SandboxCell" },
        ...(containers
          ? [{ name: "CONTAINERS", class_name: "ContainerCell" }]
          : []),
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: containers
          ? ["SandboxCell", "ContainerCell"]
          : ["SandboxCell"],
      },
    ],
    ...(containers
      ? {
          containers: [
            {
              class_name: "ContainerCell",
              image: "./Dockerfile",
              instance_type: "standard-1",
              max_instances: 8,
            },
          ],
        }
      : {}),
  };
  await writeFile(`${directory}/wrangler.json`, JSON.stringify(config));
  if (containers)
    await writeFile(
      `${directory}/Dockerfile`,
      "FROM docker.io/cloudflare/sandbox:0.12.9\nEXPOSE 3000\n",
    );
  await writeFile(`${directory}/.dev.vars`, `SERVICE_TOKEN=${token}\n`, {
    mode: 0o600,
  });
  let child: ChildProcess | undefined;
  let output = "";
  // celld talks directly to the daemon and does not resolve Docker CLI contexts.
  const dockerHost = containers
    ? (process.env.DOCKER_HOST ??
      execFileSync(
        "docker",
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        { encoding: "utf8" },
      ).trim())
    : undefined;
  const esbuild = require.resolve(
    `@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
    { paths: [require.resolve("esbuild")] },
  );
  async function start() {
    output = "";
    child = spawn(
      resolve(process.env.CELLD_BIN ?? ".tools/celld"),
      [
        "dev",
        directory,
        "--no-watch",
        "--logs",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CELLD_ESBUILD: esbuild,
          ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}),
        },
      },
    );
    child.stdout!.on("data", (d) => {
      output = (output + d).slice(-16000);
    });
    child.stderr!.on("data", (d) => {
      output = (output + d).slice(-16000);
    });
    child.on("error", (e) => {
      output += e.message;
    });
    for (let i = 0; i < (containers ? 2400 : 300); i++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch(`${endpoint}/healthz`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`celld failed to start: ${output}`);
  }
  async function stop(signal: NodeJS.Signals = "SIGTERM") {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit");
    // celld dev gives its runtime child a separate process group. On macOS,
    // killing only the supervisor leaves that child alive. Kill the actual node.
    if (signal === "SIGKILL") {
      const rows = execFileSync("ps", ["-axo", "pid=,ppid="], {
        encoding: "utf8",
      })
        .trim()
        .split("\n");
      for (const row of rows) {
        const [pid, ppid] = row.trim().split(/\s+/).map(Number);
        if (ppid === child.pid)
          try {
            process.kill(-pid!, signal);
          } catch {}
      }
    }
    process.kill(-child.pid!, signal);
    await exit;
    child = undefined;
    await writeFile(`${directory}/celld.log`, output);
  }
  return {
    start,
    stop,
    endpoint,
    token,
    directory,
    options: { endpoint, token, namespace: "integration" },
    logs: () => output,
  };
}
