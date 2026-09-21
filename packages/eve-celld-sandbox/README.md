# Eve celld sandboxes

Two [Eve](https://eve.dev) sandbox backends hosted by
[celld](https://github.com/denoland/celld):

| Backend | Execution | Filesystem lifetime |
| --- | --- | --- |
| `celldJustBash()` | just-bash inside a Durable Object | `/workspace` persists in AgentFS / object SQLite |
| `celldContainer()` | Cloudflare Sandbox SDK in a Linux container | Files last for that physical container; replacement starts fresh |

Both implement Eve's public `SandboxBackend`, including file I/O, commands,
process cancellation, prewarm, capture, stop, shutdown, and deletion. Eve still
runs in the application host. Its Workflow World is configured independently.

## Install and configure

This package targets Eve **0.63.0**, celld **0.5.1**, and Node **24+**.
The Worker bundles pin just-bash **3.4.2**, AgentFS **0.6.4**, and
Cloudflare Sandbox **0.12.9**. The container image and SDK versions must match.
The example image includes Node. Add other runtimes, such as Python, in your
application's Dockerfile when needed.

```sh
pnpm add eve@0.63.0 eve-celld-sandbox
```

In `agent/sandbox/sandbox.ts`, select a backend explicitly:

```ts
import { defineSandbox } from "eve/sandbox";
import { celldJustBash, celldContainer } from "eve-celld-sandbox";

const connection = {
  endpoint: process.env.CELLD_ENDPOINT!,
  token: process.env.CELLD_TOKEN!,
  namespace: "my-application",
};

export default defineSandbox({
  backend: celldJustBash(connection),
  // Or: celldContainer({ ...connection, commandTimeoutMs: 60_000 })
});
```

Keep the namespace, deployment script name, and Durable Object class names
stable. Session identities include the namespace, template key, and Eve session
key. The two backends use separate DO namespaces and backend identifiers.
Relative paths resolve under `/workspace`. Nonempty provider options passed to
`use()` are rejected. `fetch` can be supplied in connection settings for tracing
or a custom transport.

## Deploy the Worker

Copy the combined deployment example into an application-owned directory:

```sh
mkdir celld-sandbox
cp node_modules/eve-celld-sandbox/deploy/worker.js celld-sandbox/
cp node_modules/eve-celld-sandbox/deploy/wrangler.jsonc celld-sandbox/
cp node_modules/eve-celld-sandbox/deploy/Dockerfile celld-sandbox/
```

Set `SERVICE_TOKEN` in that project's `.dev.vars` to a random secret of at
least 32 characters, and use the same value for the application's `CELLD_TOKEN`.
Keep the file private and out of source control. The token authorizes all
application namespaces; the gateway is for trusted application servers.
Credentials are never stored in Eve reconnect metadata.

With celld installed and Docker or Podman running:

```sh
# celld uses a daemon socket directly; this also handles Colima Docker contexts.
export DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
celld dev celld-sandbox --host 127.0.0.1 --port 9876 --no-watch
```

Point the application at `http://127.0.0.1:9876`. The combined gateway serves
just-bash at `/v1` and containers at `/container/v1`; the adapters choose the
route. Configure `endpoint` as an origin, without a path. Non-loopback endpoints
require HTTPS.

For just-bash without a container engine, copy `deploy/just-bash/worker.js` and
`deploy/just-bash/wrangler.jsonc` instead. Its Worker bundle omits the Sandbox SDK.

For a fleet, use celld's normal deployment process and provision `SERVICE_TOKEN`
through its configuration mechanism. Put authenticated HTTPS in front of the
Worker listener and keep the internal listener private. Configure the container
image, instance type, and OCI runtime in the deployment. The default container
runtime shares the node kernel; celld supports configured runtimes such as
gVisor and Kata. Choose the runtime appropriate to the code you execute.

## Lifecycle and initialization

**just-bash:** seed files and the Eve bootstrap callback prepare a temporary
build cell. Prewarm publishes an immutable AgentFS template. New sessions copy
it once; reconnecting never overwrites session edits. Commands run on isolated
snapshots and commit workspace changes with their terminal journal result.
Cancellation, interpreter errors, and resource failures discard the snapshot.
A normal nonzero shell exit commits preceding writes.

**Containers:** prewarm validates seed files and the bootstrap callback in a
temporary container, recording the successful file writes, removals, and command
invocations as a bounded initialization recipe. New physical containers replay
that recipe. This is initialization, not a snapshot: generated values may differ,
the callback's Node-side logic is not rerun, and commands can repeat external
effects. Keep initialization deterministic and idempotent. Bake dependencies
into the Dockerfile to avoid reinstalling them on each replacement. Up to 256
steps and a 6 MiB encoded recipe are supported. Failed/cancelled initialization
cannot be published. Concurrent prewarm attempts use separate build containers;
the first publication wins.

Container files, installed runtime packages, and processes are ephemeral.
`stop()` and `shutdown()` destroy the physical container. Node restart, object
movement, or container failure can also lose all files. A subsequent `create()`
reopens the logical session with a fresh container and reapplies initialization.
Already-open handles reject operations after their container is replaced.
Reconnect metadata identifies the session and physical incarnation; it is not
a filesystem checkpoint. There is no container backup or restore in v1.

`delete()` removes a session and fences its old handles. Templates remain
available to other sessions. `captureState()` is supported after a successful
stop/shutdown. Deletion retains generation tombstones; container initialization
records and bounded command journals are retained in the Durable Object.
Interrupted
prewarm builds require operational cleanup if the application crashes before
deleting them.

## Commands and limits

Both adapters expose Eve's `run()` and `spawn()` APIs. Output is buffered UTF-8
and delivered when execution settles; streams are not live log tails. Use file
methods for binary data. Commands use a fresh shell environment; pass `env` and
`workingDirectory` per invocation. Long-running container processes can execute
while another request reads or writes files. Stopping the sandbox terminates
its compute.

| Limit | just-bash | Container |
| --- | --- | --- |
| Command deadline | 10 seconds | 60 seconds default, configurable up to 15 minutes |
| Adapter file transfer | 1 MiB | 1 MiB |
| Combined command output transfer | 128 KiB | 128 KiB |
| Durable workspace file bytes | 4 MiB | No durable workspace |
| HTTP request / response | 6 MiB | 6 MiB |

The container transfer limits do not bound its on-disk workspace; resource
limits come from the container deployment. Native command cancellation can
leave partial writes and external effects. Native commands are never
automatically replayed after an uncertain HTTP failure. The service journals
operation IDs to detect explicit duplicate requests; that does not provide
exactly-once external effects. A controller interruption returns an unknown
outcome rather than rerunning the command.

just-bash supports its checked-in command allowlist (`jq`, `awk`, `sed`, file and
text commands, shell builtins). Native binaries, Python/JS evaluation, package
installation, networking, symlinks, hard links, and detached jobs are unavailable
there. `/tmp` is temporary per command. Cancellation is cooperative; interpreter
work/depth/allocation limits supplement the timer. A hash-checked build
transformation preserves typed interpreter failures; upgrades must review it.
AgentFS inode metadata handling is pinned to schema 0.4.

just-bash accepts only `setNetworkPolicy("deny-all")`. The container backend
rejects all dynamic network policy requests, including credential-header
injection; configure networking at deployment. No gateway secret is passed to
the agent's command environment.

## Development and validation

From this package directory:

```sh
pnpm build
pnpm test
pnpm typecheck
pnpm setup:celld
pnpm test:integration
pnpm test:containers # requires Docker / Podman
```

`CELLD_BIN` can point at an existing celld 0.5.1 binary. Setup downloads a pinned,
checksum-verified binary on macOS arm64 or Linux arm64/x64. Integration tests
create isolated temporary celld projects with random credentials under the
system temporary directory (`eve-celld-sandbox-*`); these directories can be
removed after the tests finish. Keeping runtime state outside the workspace
prevents Eve's development watcher from treating SQLite writes as code changes.

The just-bash suite exercises real SQLite/AgentFS, atomic commit failure,
cancellation, concurrent operations, lost responses, graceful restart, SIGKILL,
and a real Eve mock-model tool loop. The container suite exercises the published
Cloudflare image, native commands, files, cancellation, initialization replay,
warm reconnection, replacement, and the shared gateway. Fleet replication,
multi-node failover, and production load qualification are separate from these
local tests.

The source example and licenses are credited in `NOTICE`. The package is MIT
licensed; bundled dependencies retain their respective licenses.
