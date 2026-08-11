import { z } from "zod";

import { defineProjectPreset } from "./preset.js";

const linearProjectParameters = z.object({
  workspace: z.string().trim().min(1).optional(),
  team: z.string().trim().min(1).optional(),
  initiative: z.string().trim().min(1).optional(),
  linkMarker: z.string().trim().min(1).default("Eve Link ID"),
});

/** A Linear project scoped to an optional workspace, team, and initiative. */
export const linearProject = defineProjectPreset({
  key: "linear/project@1",
  parameters: linearProjectParameters,
  resolve: (parameters) => {
    const scope =
      [parameters.workspace, parameters.team].filter(Boolean).join(" / ") ||
      "the configured Linear workspace";
    return {
      name: "Linear project",
      description:
        "A Linear project with project-scoped issues, milestones, documents, and updates.",
      system: {
        kind: "linear",
        name: "Linear",
        description:
          "Linear projects and related records accessed through tools mounted by the consuming agent.",
      },
      resourceLabel: "Linear project",
      toolHints: {
        connectionNames: ["linear"],
        discoveryQueries: [
          "Search and read Linear projects, issues, milestones, and updates",
          "Create and update Linear projects and project updates",
        ],
      },
      operations: {
        locate: [
          `Search ${scope} for a project whose description or metadata contains \"${parameters.linkMarker}: <binding ID>\".`,
        ],
        create: [
          `Create the project in ${scope} and set the requested title.`,
          `Include \"${parameters.linkMarker}: <binding ID>\" in its description or metadata.`,
          ...(parameters.initiative === undefined
            ? []
            : [
                `Associate it with the ${parameters.initiative} initiative when the mounted tool supports that relationship.`,
              ]),
        ],
        retrieve: [
          "Read the linked project, project updates, milestones, issues, cycles, documents, lead, members, status, and target dates.",
          "Prefer project-scoped queries and follow referenced issues or documents only when more detail is needed.",
        ],
        update: [
          "Update the linked project or publish a project update without overwriting issue state, assignments, or human-authored descriptions.",
        ],
      },
      metadata: {
        "linear.scope": scope,
        "linear.linkMarker": parameters.linkMarker,
        ...(parameters.initiative === undefined
          ? {}
          : { "linear.initiative": parameters.initiative }),
      },
    };
  },
});

export type LinearProjectParameters = z.input<typeof linearProjectParameters>;

export default linearProject;
