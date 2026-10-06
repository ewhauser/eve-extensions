# celld sandbox lifecycle example

This mock-model Eve application exercises the durable `celldJustBash()` backend.
The package's integration suite starts an isolated celld gateway, runs this
application, and verifies resume across Eve and celld restarts.

To run manually, deploy the just-bash Worker as described in
[`eve-celld-sandbox`](../../packages/eve-celld-sandbox/README.md), and set
`CELLD_ENDPOINT`, `CELLD_TOKEN`, and optionally `CELLD_NAMESPACE` in your shell.
From this directory:

```sh
pnpm exec eve dev --no-ui --no-default-extensions --host 127.0.0.1 --port 2000
# In another shell:
pnpm exec eve remote invoke --url http://127.0.0.1:2000 "calculate and save"
pnpm eval
pnpm exec tsx smoke.ts
```

`eve remote invoke` returns resumable JSON. To continue a session, pass that
JSON on stdin with `--resume` and a follow-up prompt. The direct smoke script
also verifies AgentFS metadata and binary persistence.

Native containers have a separate real Docker integration suite under
`packages/eve-celld-sandbox/test/integration/container.test.ts`; their filesystem
is ephemeral and does not satisfy this example's durable resume assertions.
