# Project presets

Project presets separate Eve's invariant channel-link lifecycle from the shape
of an external project manager. A configured preset is plain data and never
contains credentials, a provider client, or executable tool callbacks.

## Three layers

1. The core owns reservation, idempotency, ambiguity handling, trust boundaries,
   external-write policy, and completion.
2. A preset definition owns provider-specific tool hints and operation guidance.
3. A configured preset instance supplies installation parameters and narrow
   overrides.

Bindings refer directly to a configured preset ID. There is no separate system
and profile hierarchy.

## Built-in comparison

| Concern | Notion project hub | Linear project |
|---|---|---|
| Definition key | `notion/project-hub@1` | `linear/project@1` |
| Resource | Project page | Project |
| Scope parameters | Container, template | Workspace, team, initiative |
| Stable identity | Page property | Description or metadata marker |
| Retrieval | Page plus related records | Project plus issues, milestones, updates, docs |
| Authentication | Mounted Notion tools | Mounted Linear tools |

## Notion

```ts
import { notionProjectHub } from "eve-project-link/notion";
import { preset } from "eve-project-link/presets";

const contextHub = preset(notionProjectHub, {
  id: "context-hub",
  parameters: {
    container: "https://www.notion.so/acme/projects",
    template: "Linked channel project",
    linkProperty: "Eve Link ID",
    contextDestination: "Eve context",
  },
});
```

The preset instructs the agent to use mounted Notion tools, scope retrieval to
the linked page and its relations, and use the optional template only when the
mounted tool supports template selection.

## Linear

```ts
import { linearProject } from "eve-project-link/linear";
import { preset } from "eve-project-link/presets";

const productProject = preset(linearProject, {
  id: "product-engineering",
  parameters: {
    workspace: "Acme",
    team: "Product Engineering",
    initiative: "2026 product roadmap",
    linkMarker: "Eve Link ID",
  },
});
```

The preset links a Linear project and points deeper retrieval at project
updates, milestones, issues, cycles, documents, ownership, status, and dates.

## Installation overrides

Use `tools.add` for exact authored tool names and `guidance` for local project
conventions:

```ts
const contextHub = preset(notionProjectHub, {
  id: "context-hub",
  tools: {
    add: {
      toolNames: ["acme_notion__find_project", "acme_notion__create_project"],
    },
  },
  guidance: {
    retrieve: {
      append: ["Also inspect the Launches and Risks relations."],
    },
    update: {
      append: ["Replace only the generated Eve context block."],
    },
  },
});
```

`replace` replaces preset-specific guidance for an operation; it does not
replace core lifecycle instructions. Replacing `create` with an empty list
turns the configured instance into an existing-resource-only preset. `locate`
and `retrieve` must remain non-empty.

## Custom static preset

```ts
import {
  defineStaticProjectPreset,
  preset,
} from "eve-project-link/presets";

const acmeProject = defineStaticProjectPreset({
  key: "acme/project@1",
  name: "Acme project",
  system: {
    kind: "acme",
    name: "Acme PM",
    description: "The internal project registry.",
  },
  resourceLabel: "Acme project",
  toolHints: {
    toolNames: ["acme__find_project", "acme__create_project"],
  },
  operations: {
    locate: ["Search the project registry by binding ID."],
    create: ["Create one standard project in the registry."],
    retrieve: [
      "Read the project, owners, decisions, milestones, meetings, and sources.",
    ],
    update: ["Replace only the generated context section."],
  },
});

const standard = preset(acmeProject, { id: "standard" });
```

Exact tool names may refer to authored Eve tools or qualified connection tools.
Hints aid discovery; they are not an allow-list or authorization boundary.

## Parameterized custom preset

Preset packages can expose validated parameters just like the built-ins:

```ts
import { defineProjectPreset } from "eve-project-link/presets";
import { z } from "zod";

export const acmeProject = defineProjectPreset({
  key: "acme/project@1",
  parameters: z.object({
    registry: z.string().trim().min(1),
  }),
  resolve: ({ registry }) => ({
    name: "Acme project",
    system: {
      kind: "acme",
      name: "Acme PM",
      description: "The internal project registry.",
    },
    resourceLabel: "Acme project",
    operations: {
      locate: [`Search ${registry} by binding ID.`],
      create: [`Create one project in ${registry}.`],
      retrieve: ["Read the project and related records."],
    },
  }),
});
```

Preset parameters and metadata are model-visible and must not contain secrets.
Tenant routing and access-control decisions belong in mounted tools or
connections.
