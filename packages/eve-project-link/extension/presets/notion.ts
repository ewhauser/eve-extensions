import { z } from "zod";

import { defineProjectPreset } from "./preset.js";

const notionTemplateReferenceSchema = z
  .object({
    kind: z.enum(["database-template", "page"]),
    reference: z.string().trim().min(1).max(2_000),
    expectedStructure: z
      .array(z.string().trim().min(1).max(150))
      .min(1)
      .max(10)
      .optional(),
  })
  .strict();

const notionTemplateSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .transform((reference) => ({
      kind: "detect" as const,
      reference,
      expectedStructure: undefined,
    })),
  notionTemplateReferenceSchema,
]);

const notionProjectHubParameters = z.object({
  container: z.string().trim().min(1).default("the configured Notion project hub"),
  template: notionTemplateSchema.optional(),
  linkProperty: z.string().trim().min(1).default("Eve Link ID"),
  contextDestination: z.string().trim().min(1).optional(),
});

type NotionTemplate = z.output<typeof notionTemplateSchema>;

function expectedStructure(template: NotionTemplate): string {
  if (!template.expectedStructure?.length) {
    return "the template's defining properties, headings, and embedded or linked databases";
  }
  return template.expectedStructure.join(", ");
}

function templateDiscoveryQueries(
  template: NotionTemplate | undefined,
): readonly string[] {
  if (!template) return [];
  if (template.kind === "database-template") {
    return [
      "Create a Notion database page using a registered database template, then fetch the created page",
    ];
  }
  if (template.kind === "page") {
    return [
      "Duplicate a Notion page into another location, wait for asynchronous completion, and fetch the duplicated page",
    ];
  }
  return [
    "Inspect a Notion template reference to distinguish a registered database template from an ordinary page",
    "Create a Notion database page using a registered database template, then fetch the created page",
    "Duplicate a Notion page into another location, wait for asynchronous completion, and fetch the duplicated page",
  ];
}

function templateCreateGuidance(
  template: NotionTemplate,
  container: string,
  linkProperty: string,
): readonly string[] {
  const verify = `Fetch the resulting page and verify ${expectedStructure(template)} before completion.`;
  const update = `Only after that fetch succeeds, set the final title, channel reference, and ${linkProperty} to the binding ID.`;

  if (template.kind === "database-template") {
    return [
      `Use ${template.reference} as a registered database template selected directly while creating the page in ${container}.`,
      verify,
      update,
    ];
  }
  if (template.kind === "page") {
    return [
      `Duplicate the ordinary Notion page ${template.reference} into ${container}; do not replace it with hand-authored fallback content.`,
      "If duplication is asynchronous, wait or poll until it succeeds and resolve the new page ID.",
      verify,
      update,
    ];
  }
  return [
    `Inspect ${template.reference} and first determine whether it is a registered database template or an ordinary Notion page.`,
    `For a registered database template, select it directly while creating the page in ${container}.`,
    `For an ordinary page, duplicate it into ${container}; if duplication is asynchronous, wait or poll until it succeeds and resolve the new page ID.`,
    verify,
    update,
  ];
}

function templateCompletionRequirement(template: NotionTemplate) {
  const method =
    template.kind === "database-template"
      ? "selected directly during database-page creation"
      : template.kind === "page"
        ? "duplicated as an ordinary page"
        : "classified as a registered database template or ordinary page and applied with the matching method";
  return {
    id: "notion-template-structure",
    description: `The configured ${template.kind === "database-template" ? "registered database template" : template.kind === "page" ? "ordinary page template" : "Notion template reference"} ${template.reference} was ${method}; the resulting page was fetched after any asynchronous work completed and contains ${expectedStructure(template)}.`,
  } as const;
}

/** A Notion project page, optionally created from a database template or page. */
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
        ...templateDiscoveryQueries(parameters.template),
      ],
    },
    operations: {
      locate: [
        `Search ${parameters.container} for a page whose ${parameters.linkProperty} equals the binding ID.`,
      ],
      create: [
        ...(parameters.template === undefined
          ? [
              `Create the project page in ${parameters.container}.`,
              `Set its title, channel reference, and ${parameters.linkProperty} to the binding ID.`,
            ]
          : templateCreateGuidance(
              parameters.template,
              parameters.container,
              parameters.linkProperty,
            )),
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
    ...(parameters.template === undefined
      ? {}
      : {
          completionRequirements: [
            templateCompletionRequirement(parameters.template),
          ],
        }),
    metadata: {
      "notion.container": parameters.container,
      "notion.linkProperty": parameters.linkProperty,
      ...(parameters.template === undefined
        ? {}
        : {
            "notion.template": parameters.template.reference,
            "notion.templateKind": parameters.template.kind,
            "notion.templateReference": parameters.template.reference,
            ...(parameters.template.expectedStructure === undefined
              ? {}
              : {
                  "notion.templateExpectedStructure":
                    parameters.template.expectedStructure.join(", "),
                }),
          }),
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
