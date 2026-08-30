# eve-openai-plugins

`eve-openai-plugins` compiles a trusted [OpenAI Codex plugin](https://developers.openai.com/plugins/build/plugins)
into an Eve agent's filesystem graph. It complements
[`eve-openai-connectors`](../eve-openai-connectors): connectors provide the
current ChatGPT user's app tools at runtime; this package installs the rest of
a plugin's declared capabilities at build time and uses Eve's dynamic
resolvers to decide which caller can see them.

The package targets `eve@0.45.0` and Node.js 24 or newer.

## Capability mapping

| OpenAI plugin content | Generated Eve content | Availability |
| --- | --- | --- |
| `skills/*/SKILL.md` plus sibling files | `agent/skills/*.ts` using `defineSkill` | Dynamic per turn |
| `commands/*.md` | Explicit-use Eve skills | Dynamic per turn |
| `agents/*.md` | Declared `agent/subagents/*` graphs | Dynamic per turn |
| `.app.json` | Connector requirements in the lockfile; connector extension mounted in imported children | The connector extension's user auth and discovery policy |
| Unauthenticated HTTP `.mcp.json` servers | Eve MCP client connections, only with `--allow-static-connections` | Static; authorize separately |
| Plugin hooks, stdio MCP, OAuth MCP | Reported as unsupported | Never executed |

Eve must compile a subagent's filesystem graph before serving traffic, so a
plugin cannot invent a brand-new subagent directory during a turn. The
importer declares that graph at install/build time, then generates a dynamic
`agent.ts` that returns `defineAgent(...)` or `null` for every turn. This gives
Eve dynamic subagent availability without runtime code installation.

## Install a plugin

Add both packages to the Eve application when the plugin uses ChatGPT apps:

```sh
pnpm add eve-openai-plugins 'eve-openai-connectors@^0.2.0'
```

Connector 0.2.0 or newer is required because generated subagents pass the
plugin's declared `.app.json` services as an enforced allowlist.

Mount `eve-openai-connectors` in the root agent as `agent/extensions/openai.ts`.
Then inspect and apply a local plugin:

```sh
pnpm exec eve-openai-plugins plan ../plugins/figma --root .
pnpm exec eve-openai-plugins apply ../plugins/figma --root .
pnpm exec eve-openai-plugins check --root .
```

For the OpenAI plugin monorepo, select a plugin within the Git checkout:

```sh
pnpm exec eve-openai-plugins plan \
  'git+https://github.com/openai/plugins.git#main' \
  --plugin-path plugins/figma \
  --root .
```

npm sources use an `npm:` prefix. `npm pack` lifecycle scripts are disabled:

```sh
pnpm exec eve-openai-plugins apply npm:@example/plugin@1.2.3 --root .
```

If a plugin contains agents, the importer reuses a literal model string from
the root `agent/agent.ts`. Pass `--model openai/your-model` when the root model
is dynamic or otherwise not a literal.

## Dynamic access policy

The first apply creates `agent/lib/openai-plugin-access.ts`. Generated skills
and subagents call this function at `turn.started`; the importer never
overwrites it. The initial policy enables installed capabilities for the whole
deployment. Replace it with the application's tenant and principal policy:

```ts
import type { DynamicResolveContext } from "eve/tools";

export interface OpenAIPluginCapability {
  readonly pluginId: string;
  readonly kind: "skill" | "subagent";
  readonly id: string;
}

export function isOpenAIPluginEnabled(
  ctx: DynamicResolveContext,
  capability: OpenAIPluginCapability,
): boolean {
  const attributes = ctx.session.auth.current?.attributes;
  return attributes?.tenant === "design" && capability.pluginId === "figma";
}

export async function getOpenAIPluginConnectorToken(
  ctx: Pick<DynamicResolveContext, "session">,
): Promise<string | null> {
  const userId = ctx.session.auth.current?.attributes?.user_id;
  return userId ? await mySecretStore.get(userId) : null;
}
```

This is a composition gate, not the sole authorization boundary. Child tools,
connections, and channels must still enforce their own authorization and
approval policy.

Declared Eve subagents do not inherit the root agent's mounted extensions. For
a plugin with `.app.json`, the importer mounts `eve-openai-connectors` again in
each generated child. Implement `getOpenAIPluginConnectorToken` in the same
access-policy file using the application's external per-user secret store. Its
safe generated default returns `null`, so connector tools stay disabled in the
child until the credential seam is deliberately wired.

## Sync and removal

`eve-openai-plugins.lock.json` records the resolved source, plugin digest,
requirements, options, generated paths, and a SHA-256 hash for every owned
file.

```sh
# Refresh all locked local, Git, and npm sources.
pnpm exec eve-openai-plugins sync --root .

# Fail when a source would regenerate files or an owned file drifted.
pnpm exec eve-openai-plugins sync --check --root .
pnpm exec eve-openai-plugins check --root .

# Delete only unchanged files owned by this plugin.
pnpm exec eve-openai-plugins remove figma --root .
```

Apply and removal refuse to overwrite or delete a generated file whose content
no longer matches the lockfile. The shared access-policy file is deliberately
not owned or removed.

## MCP and hooks

Remote HTTP MCP definitions with no auth configuration can be translated with
`--allow-static-connections`. Eve connections are currently static, so those
connections are not hidden by the dynamic plugin policy. Authenticated MCP
definitions are reported for manual porting to an Eve connection auth
resolver.

The importer never runs plugin lifecycle scripts or hooks, never launches
stdio MCP processes, rejects symlinks and archive traversal, and bounds source
file and total plugin sizes. Hooks often contain arbitrary code and need a
separate trust review before being expressed as Eve hooks.

## Library API

The CLI is backed by exported functions for application-specific installers:

```ts
import { applyPluginImport, planPluginImport } from "eve-openai-plugins";

const options = {
  projectRoot: process.cwd(),
  source: { kind: "local" as const, path: "/trusted/plugins/figma" },
};

console.log(await planPluginImport(options));
await applyPluginImport(options);
```
