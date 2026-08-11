import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ProjectLinkService } from "../extension/lib/project-link.js";
import { linearProject } from "../extension/presets/linear.js";
import { notionProjectHub } from "../extension/presets/notion.js";
import {
  defineProjectPreset,
  preset,
} from "../extension/presets/preset.js";
import { createMemoryProjectLinkStore } from "../extension/stores/memory.js";

describe("project presets", () => {
  it("configures the Notion preset with parameters and narrow overrides", () => {
    const configured = preset(notionProjectHub, {
      id: "context-hub",
      parameters: {
        container: "Projects database",
        template: "Linked channel project",
        contextDestination: "Eve context",
      },
      tools: { add: { toolNames: ["workspace__notion_create"] } },
      guidance: {
        retrieve: { append: ["Read the Launches relation."] },
      },
    });

    expect(configured).toMatchObject({
      id: "context-hub",
      presetKey: "notion/project-hub@1",
      system: { kind: "notion" },
      toolHints: {
        connectionNames: ["notion"],
        toolNames: ["workspace__notion_create"],
      },
    });
    expect(configured.operations.create).toContain(
      "Apply the Linked channel project template when the mounted tool supports template selection.",
    );
    expect(configured.operations.retrieve.at(-1)).toBe(
      "Read the Launches relation.",
    );
    expect(JSON.stringify(configured).toLowerCase()).not.toContain("api key");
  });

  it("uses the same configured-preset model for Linear", () => {
    const configured = preset(linearProject, {
      id: "product",
      parameters: {
        team: "Product Engineering",
        initiative: "Roadmap",
      },
    });

    expect(configured).toMatchObject({
      id: "product",
      presetKey: "linear/project@1",
      system: { kind: "linear" },
      resourceLabel: "Linear project",
    });
    expect(configured.operations.locate[0]).toContain("Product Engineering");
    expect(configured.operations.create?.join(" ")).toContain("Roadmap");
    expect(configured.operations.retrieve.join(" ")).toContain("milestones");
  });

  it("supports parameterized custom presets without provider adapters", () => {
    const acmeProject = defineProjectPreset({
      key: "acme/project@1",
      parameters: z.object({ registry: z.string().trim().min(1) }),
      resolve: ({ registry }) => ({
        name: "Acme project",
        system: {
          kind: "acme",
          name: "Acme PM",
          description: "Internal project registry.",
        },
        resourceLabel: "Acme project",
        toolHints: { toolNames: ["acme__find", "acme__create"] },
        operations: {
          locate: [`Search ${registry} by binding ID.`],
          create: [`Create one project in ${registry}.`],
          retrieve: ["Read owners, decisions, milestones, and sources."],
        },
      }),
    });
    const configured = preset(acmeProject, {
      id: "standard",
      parameters: { registry: "Product registry" },
    });

    expect(configured.operations.locate).toEqual([
      "Search Product registry by binding ID.",
    ]);
    expect(configured.toolHints?.toolNames).toEqual([
      "acme__find",
      "acme__create",
    ]);
  });

  it("keeps core lifecycle and safety rules outside provider presets", async () => {
    const configured = preset(notionProjectHub, { id: "context-hub" });
    const service = new ProjectLinkService({
      store: createMemoryProjectLinkStore(),
      presets: [configured],
    });
    const linked = await service.link(
      { kind: "slack", workspaceId: "T1", channelId: "C1" },
      { title: "Atlas" },
    );

    expect(linked.plan.provisioningInstructions).toContain(
      "Never request or handle provider credentials",
    );
    expect(linked.plan.provisioningInstructions).toContain(
      "Reuse exactly one match",
    );
    expect(linked.plan.retrievalInstructions).toContain(
      "untrusted reference data",
    );
    expect(linked.plan.updateInstructions).toContain(
      "only when the user explicitly requests synchronization",
    );
  });

  it("does not allow overrides to remove required locate or retrieve guidance", () => {
    expect(() =>
      preset(notionProjectHub, {
        id: "invalid",
        guidance: { locate: { replace: [] } },
      }),
    ).toThrow("retain locate and retrieve guidance");
  });
});
