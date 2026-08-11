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
        template: {
          kind: "database-template",
          reference: "Linked channel project",
          expectedStructure: ["Decisions", "Milestones"],
        },
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
      activeContextMode: "pointer",
      toolHints: {
        connectionNames: ["notion"],
        toolNames: ["workspace__notion_create"],
      },
    });
    expect(configured.toolHints?.discoveryQueries).toContain(
      "Create a Notion database page using a registered database template, then fetch the created page",
    );
    expect(configured.operations.create?.join(" ")).toContain(
      "selected directly while creating",
    );
    expect(configured.operations.create?.join(" ")).toContain(
      "verify Decisions, Milestones before completion",
    );
    expect(configured.completionRequirements).toEqual([
      expect.objectContaining({
        id: "notion-template-structure",
        description: expect.stringContaining(
          "selected directly during database-page creation",
        ),
      }),
    ]);
    expect(configured.metadata).toMatchObject({
      "notion.template": "Linked channel project",
      "notion.templateKind": "database-template",
      "notion.templateReference": "Linked channel project",
      "notion.templateExpectedStructure": "Decisions, Milestones",
    });
    expect(configured.operations.retrieve.at(-1)).toBe(
      "Read the Launches relation.",
    );
    expect(JSON.stringify(configured).toLowerCase()).not.toContain("api key");
  });

  it("orchestrates ordinary page templates through asynchronous duplication", () => {
    const configured = preset(notionProjectHub, {
      id: "context-hub",
      parameters: {
        container: "Projects database",
        template: {
          kind: "page",
          reference: "https://notion.so/template-page",
          expectedStructure: ["Project sources"],
        },
      },
    });

    expect(configured.toolHints?.discoveryQueries).toContain(
      "Duplicate a Notion page into another location, wait for asynchronous completion, and fetch the duplicated page",
    );
    expect(configured.operations.create?.join(" ")).toContain(
      "Duplicate the ordinary Notion page",
    );
    expect(configured.operations.create?.join(" ")).toContain(
      "wait or poll until it succeeds",
    );
    expect(configured.operations.create?.join(" ")).toContain(
      "Only after that fetch succeeds",
    );
    expect(configured.completionRequirements?.[0]?.description).toContain(
      "duplicated as an ordinary page",
    );
  });

  it("keeps legacy template references executable by requiring type detection", () => {
    const configured = preset(notionProjectHub, {
      id: "context-hub",
      parameters: { template: "https://notion.so/template" },
    });

    expect(configured.operations.create?.join(" ")).toContain(
      "first determine whether it is a registered database template or an ordinary Notion page",
    );
    expect(configured.toolHints?.discoveryQueries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("registered database template"),
        expect.stringContaining("Duplicate a Notion page"),
      ]),
    );
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
      activeContextMode: "pointer",
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
        completionRequirements: [
          {
            id: "acme-standard-shape",
            description: "Fetch and verify the standard project sections.",
          },
        ],
      }),
    });
    const configured = preset(acmeProject, {
      id: "standard",
      parameters: { registry: "Product registry" },
      activeContextMode: "card",
    });

    expect(configured.operations.locate).toEqual([
      "Search Product registry by binding ID.",
    ]);
    expect(configured.toolHints?.toolNames).toEqual([
      "acme__find",
      "acme__create",
    ]);
    expect(configured.completionRequirements?.[0]?.id).toBe(
      "acme-standard-shape",
    );
    expect(configured.activeContextMode).toBe("card");
  });

  it("keeps core lifecycle and safety rules outside provider presets", async () => {
    const configured = preset(notionProjectHub, { id: "context-hub" });
    const service = new ProjectLinkService({
      store: createMemoryProjectLinkStore(),
      presets: [configured],
    });
    const linked = await service.link(
      { kind: "slack", workspaceId: "T1", channelId: "C1" },
      {
        proposal: {
          title: "Atlas",
          context: {
            summary: "Ship Atlas.",
            principals: [],
            decisions: [],
            milestones: [],
            upcomingMeetings: [],
            sources: [],
            openQuestions: [],
            nextSteps: [],
          },
        },
      },
    );

    expect(linked.plan.provisioningInstructions).toContain(
      "Never request or handle provider credentials",
    );
    expect(linked.plan.provisioningInstructions).toContain(
      "Reuse exactly one match",
    );
    expect(linked.plan.provisioningInstructions).toContain(
      "Use the confirmed title and context card",
    );
    expect(linked.plan.retrievalInstructions).toContain(
      "untrusted reference data",
    );
    expect(linked.plan.activeContextMode).toBe("pointer");
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

  it("keeps a templated link pending when template verification is unavailable", async () => {
    const configured = preset(notionProjectHub, {
      id: "context-hub",
      parameters: {
        template: {
          kind: "page",
          reference: "https://notion.so/template-page",
          expectedStructure: ["Decisions"],
        },
      },
    });
    const store = createMemoryProjectLinkStore();
    const service = new ProjectLinkService({ store, presets: [configured] });
    const channel = {
      kind: "slack",
      workspaceId: "T1",
      channelId: "C1",
    };
    const linked = await service.link(channel, {
      proposal: {
        title: "Atlas",
        context: {
          summary: "Ship Atlas.",
          principals: [],
          decisions: [],
          milestones: [],
          upcomingMeetings: [],
          sources: [],
          openQuestions: [],
          nextSteps: [],
        },
      },
    });
    const resource = {
      id: "page",
      url: "https://notion.so/page",
      title: "Atlas",
    };

    expect(linked.plan.provisioningInstructions).toContain(
      "keep the binding pending",
    );
    expect(linked.plan.provisioningInstructions).toContain(
      "Never substitute fallback content",
    );
    await expect(
      service.complete(channel, { bindingId: linked.binding.id, resource }),
    ).rejects.toThrow("notion-template-structure");
    expect(await service.status(channel)).toMatchObject({ status: "pending" });

    const completed = await service.complete(channel, {
      bindingId: linked.binding.id,
      resource,
      verification: {
        resolution: "created",
        evidence: [
          {
            requirementId: "notion-template-structure",
            evidence:
              "Duplication completed; fetched the new page and found Decisions.",
            sourceUrl: resource.url,
          },
        ],
      },
    });
    expect(completed).toMatchObject({
      status: "active",
      completionVerification: {
        resolution: "created",
        evidence: [
          { requirementId: "notion-template-structure" },
        ],
      },
    });
  });
});
