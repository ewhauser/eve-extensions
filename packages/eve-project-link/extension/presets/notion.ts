import { z } from "zod";

import { defineProjectPreset } from "./preset.js";

const notionProjectHubParameters = z.object({
  container: z.string().trim().min(1).default("the configured Notion project hub"),
  template: z.string().trim().min(1).optional(),
  linkProperty: z.string().trim().min(1).default("Eve Link ID"),
  contextDestination: z.string().trim().min(1).optional(),
});

/** A Notion project page, optionally created from a database template. */
export const notionProjectHub = defineProjectPreset({
  key: "notion/project-hub@1",
  parameters: notionProjectHubParameters,
  resolve: (parameters) => ({
    name: "Notion project hub",
    description:
      "A project page and related workspace records accessed through mounted Notion tools.",
    system: {
      kind: "notion",
      name: "Notion",
      description:
        "Notion pages and databases accessed through tools mounted by the consuming agent.",
    },
    resourceLabel: "Notion project page",
    toolHints: {
      connectionNames: ["notion"],
      discoveryQueries: [
        "Search and fetch Notion pages and databases",
        "Create and update Notion pages and database records",
      ],
    },
    operations: {
      locate: [
        `Search ${parameters.container} for a page whose ${parameters.linkProperty} equals the binding ID.`,
      ],
      create: [
        `Create the project page in ${parameters.container}.`,
        `Set its title, channel reference, and ${parameters.linkProperty} to the binding ID.`,
        ...(parameters.template === undefined
          ? []
          : [
              `Apply the ${parameters.template} template when the mounted tool supports template selection.`,
            ]),
      ],
      retrieve: [
        "Read the linked page and its related decisions, people, sources, meetings, milestones, and updates.",
        "Follow relations from the linked page instead of searching the entire workspace when a scoped relation is available.",
      ],
      update: [
        "Update the linked page and related records while preserving human-authored content and existing relations.",
        ...(parameters.contextDestination === undefined
          ? []
          : [
              `Mirror the compact curated context in ${parameters.contextDestination}.`,
            ]),
      ],
    },
    metadata: {
      "notion.container": parameters.container,
      "notion.linkProperty": parameters.linkProperty,
      ...(parameters.template === undefined
        ? {}
        : { "notion.template": parameters.template }),
      ...(parameters.contextDestination === undefined
        ? {}
        : { "notion.contextDestination": parameters.contextDestination }),
    },
  }),
});

export type NotionProjectHubParameters = z.input<
  typeof notionProjectHubParameters
>;

export default notionProjectHub;
