import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { FIXTURE_TASK, fixtureState } from "./lib/fixture.js";

const AGENT_ID_PATTERN = /<agent id="([^"]+)" name="active-runner">/u;
const ROLE_CASE_PATTERN = /^ROLE_ISOLATION:(pm|implementor|qa|test-runner)$/u;
const READY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { const: "ready" },
    receipt: {
      type: "object",
      properties: {
        ok: { const: true },
        value: {
          type: "object",
          properties: {
            status: { const: "ready" },
            protocolVersion: { const: 1 },
            leaseId: { type: "string", minLength: 1 },
            role: { type: "string", minLength: 1 },
            target: { type: "object" },
            childSessionId: { type: "string", minLength: 1 },
            expiresAt: { type: "string", minLength: 1 },
          },
          required: [
            "status",
            "protocolVersion",
            "leaseId",
            "role",
            "target",
            "childSessionId",
            "expiresAt",
          ],
          additionalProperties: false,
        },
      },
      required: ["ok", "value"],
      additionalProperties: false,
    },
  },
  required: ["status", "receipt"],
  additionalProperties: false,
} as const;
let unknownStart = 0;
let activeChildId: string | undefined;
let completedActiveModelCalls = 0;
let buildStage = 0;
let buildAgentId: string | undefined;
const buildChildren = new Map<string, string>();

function outputValue(output: unknown): Record<string, unknown> | null {
  if (typeof output !== "object" || output === null) return null;
  const direct = output as Record<string, unknown>;
  const value = direct.value;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : direct;
}

function latestChildId(messages: readonly string[], name: string): string {
  const pattern = new RegExp(`<agent id="([^"]+)" name="${name}">`, "gu");
  const matches = [...messages.join("\n").matchAll(pattern)];
  const id = matches.at(-1)?.[1];
  if (id === undefined) throw new Error(`BUILD_CHILD_ID_MISSING:${name}`);
  return id;
}

function assertStructuredReady(output: unknown): void {
  const receipt =
    typeof output === "object" && output !== null
      ? (output as Record<string, unknown>).receipt
      : undefined;
  const value =
    typeof receipt === "object" && receipt !== null
      ? (receipt as Record<string, unknown>).value
      : undefined;
  if (
    typeof output !== "object" ||
    output === null ||
    (output as Record<string, unknown>).status !== "ready" ||
    typeof receipt !== "object" ||
    receipt === null ||
    (receipt as Record<string, unknown>).ok !== true ||
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).status !== "ready" ||
    (value as Record<string, unknown>).protocolVersion !== 1 ||
    typeof (value as Record<string, unknown>).leaseId !== "string" ||
    typeof (value as Record<string, unknown>).childSessionId !== "string"
  ) {
    throw new Error("BOOTSTRAP_READY_RECEIPT_NOT_STRUCTURED");
  }
}

const model = mockModel(async (request) => {
  const scenarioMessages = request.messages.map((message) => message.text);
  const buildScenario = scenarioMessages.some((message) =>
    message.includes("BUILD_WORKFLOW_"),
  );
  if (buildScenario) {
    const latestResult = request.toolResults.at(-1);
    const latestNamed = (name: string) =>
      request.toolResults.filter((result) => result.name === name).at(-1);
    const agentId = () => {
      if (buildAgentId === undefined) throw new Error("BUILD_AGENT_ID_MISSING");
      return buildAgentId;
    };
    const prepare = (id: string) => ({
      toolCalls: [
        {
          id,
          name: "agent_builder__prepare_next_build_step",
          input: { agentId: agentId() },
        },
      ],
    });
    const bootstrap = (name: string, id: string, structured = true) => {
      const value = outputValue(
        latestNamed("agent_builder__prepare_next_build_step")?.output,
      );
      const bootstrapMessage = value?.bootstrapMessage;
      if (typeof bootstrapMessage !== "string") {
        throw new Error(`BUILD_BOOTSTRAP_MESSAGE_MISSING:${name}`);
      }
      return {
        toolCalls: [
          {
            id,
            name,
            input: structured
              ? { message: bootstrapMessage, outputSchema: READY_OUTPUT_SCHEMA }
              : { message: bootstrapMessage },
          },
        ],
      };
    };
    const execute = (name: string, id: string, message: string) => {
      const readyOutput = latestNamed(name)?.output;
      if (name === "test-runner" && readyOutput === "BUILD_BOOTSTRAP_READY") {
        // The test runner stays in conversation mode so Eve can park and resume
        // its later exact-call approval through the real nested lifecycle.
      } else {
        try {
          assertStructuredReady(readyOutput);
        } catch {
          throw new Error(`BUILD_READY_INVALID:${name}:${JSON.stringify(readyOutput)}`);
        }
      }
      const childId = latestChildId(scenarioMessages, name);
      buildChildren.set(id, childId);
      return { toolCalls: [{ id, name, input: { agentId: childId, message } }] };
    };
    if (request.lastUserMessage === "BUILD_WORKFLOW_OWNER_SWITCH") {
      const switched = latestNamed("agent_builder__workflow_get");
      if (switched === undefined) {
        return {
          toolCalls: [
            {
              id: "build-owner-switch-get",
              name: "agent_builder__workflow_get",
              input: { agentId: agentId() },
            },
          ],
        };
      }
      const output = switched.output as Record<string, unknown>;
      if (output.ok !== false) throw new Error("BUILD_OWNER_SWITCH_LEAKED");
      return "BUILD_OWNER_SWITCH_ISOLATED_OK";
    }
    switch (buildStage) {
      case 0:
        buildStage = 1;
        return {
          toolCalls: [
            { id: "build-allocate", name: "agent_builder__workflow_allocate", input: {} },
          ],
        };
      case 1: {
        const value = outputValue(latestNamed("agent_builder__workflow_allocate")?.output);
        const family = value?.family;
        buildAgentId =
          typeof family === "object" && family !== null
            ? String((family as Record<string, unknown>).agentId)
            : undefined;
        buildStage = 2;
        return "BUILD_WORKFLOW_ALLOCATED_OK";
      }
      case 2:
        buildStage = 3;
        return prepare("build-prepare-pm");
      case 3:
        buildStage = 4;
        return bootstrap("pm", "build-pm-bootstrap");
      case 4:
        buildStage = 5;
        return execute("pm", "build-pm-child", "BUILD_EXECUTE:pm");
      case 5:
        buildStage = 6;
        return "BUILD_PM_HANDOFF_OK";
      case 6:
        buildStage = 7;
        return prepare("build-prepare-implementor");
      case 7:
        buildStage = 8;
        return bootstrap("implementor", "build-implementor-bootstrap");
      case 8:
        buildStage = 9;
        return execute("implementor", "build-implementor-child", "BUILD_EXECUTE:implementor");
      case 9:
        buildStage = 10;
        return "BUILD_IMPLEMENTOR_HANDOFF_OK";
      case 10:
        buildStage = 11;
        return prepare("build-prepare-qa-test");
      case 11:
        buildStage = 12;
        return bootstrap("qa", "build-qa-test-bootstrap");
      case 12:
        buildStage = 13;
        return execute("qa", "build-qa-test-child", "BUILD_EXECUTE:qa-needs-test");
      case 13:
        buildStage = 14;
        return "BUILD_QA_TEST_REQUEST_OK";
      case 14:
        buildStage = 15;
        return prepare("build-prepare-test-runner");
      case 15:
        buildStage = 16;
        return bootstrap("test-runner", "build-test-bootstrap");
      case 16:
        buildStage = 17;
        return execute("test-runner", "build-test-child", "BUILD_EXECUTE:test_runner");
      case 17:
        buildStage = 18;
        return "BUILD_TEST_EVIDENCE_OK";
      case 18:
        buildStage = 180;
        return {
          toolCalls: [
            {
              id: "build-workflow-after-test",
              name: "agent_builder__workflow_get",
              input: { agentId: agentId() },
            },
          ],
        };
      case 180:
        buildStage = 19;
        return prepare("build-prepare-qa-approval");
      case 19:
        buildStage = 20;
        return bootstrap("qa", "build-qa-approval-bootstrap");
      case 20:
        buildStage = 21;
        return execute("qa", "build-qa-approval-child", "BUILD_EXECUTE:qa-approved");
      case 21:
        buildStage = 22;
        return "BUILD_QA_APPROVED_OK";
      case 22:
        buildStage = 23;
        return {
          toolCalls: [
            {
              id: "build-workflow-reopen",
              name: "agent_builder__workflow_reopen",
              input: { agentId: agentId() },
            },
          ],
        };
      case 23: {
        const value = outputValue(latestNamed("agent_builder__workflow_reopen")?.output);
        const workflow = value?.workflow;
        if (
          typeof workflow !== "object" ||
          workflow === null ||
          (workflow as Record<string, unknown>).phase !== "pm_work" ||
          "testEvidence" in workflow ||
          "qaApproval" in workflow
        ) {
          throw new Error("BUILD_WORKFLOW_REOPEN_DID_NOT_INVALIDATE_APPROVAL");
        }
        buildStage = 24;
        return "BUILD_WORKFLOW_REOPENED_OK";
      }
      case 24:
        buildStage = 25;
        return prepare("build-reprepare-pm");
      case 25:
        buildStage = 26;
        return bootstrap("pm", "build-revision-pm-bootstrap");
      case 26:
        buildStage = 27;
        return execute("pm", "build-revision-pm-child", "BUILD_EXECUTE:pm-revision");
      case 27:
        buildStage = 28;
        return "BUILD_PM_REVISION_HANDOFF_OK";
      case 28:
        buildStage = 29;
        return prepare("build-reprepare-implementor");
      case 29:
        buildStage = 30;
        return bootstrap("implementor", "build-revision-implementor-bootstrap");
      case 30:
        buildStage = 31;
        return execute(
          "implementor",
          "build-revision-implementor-child",
          "BUILD_EXECUTE:implementor",
        );
      case 31:
        buildStage = 32;
        return "BUILD_IMPLEMENTOR_REVISION_HANDOFF_OK";
      case 32:
        buildStage = 33;
        return prepare("build-reprepare-qa-test");
      case 33:
        buildStage = 34;
        return bootstrap("qa", "build-revision-qa-test-bootstrap");
      case 34:
        buildStage = 35;
        return execute(
          "qa",
          "build-revision-qa-test-child",
          "BUILD_EXECUTE:qa-needs-test",
        );
      case 35:
        buildStage = 36;
        return "BUILD_QA_REVISION_TEST_REQUEST_OK";
      case 36:
        buildStage = 37;
        return prepare("build-reprepare-test-runner");
      case 37:
        buildStage = 38;
        return bootstrap("test-runner", "build-revision-test-bootstrap");
      case 38:
        buildStage = 39;
        return execute(
          "test-runner",
          "build-revision-test-child",
          "BUILD_EXECUTE:test_runner",
        );
      case 39:
        buildStage = 40;
        return "BUILD_REVISION_TEST_EVIDENCE_OK";
      case 40:
        buildStage = 400;
        return {
          toolCalls: [
            {
              id: "build-workflow-after-retest",
              name: "agent_builder__workflow_get",
              input: { agentId: agentId() },
            },
          ],
        };
      case 400:
        buildStage = 41;
        return prepare("build-reprepare-qa-approval");
      case 41:
        buildStage = 42;
        return bootstrap("qa", "build-revision-qa-approval-bootstrap");
      case 42:
        buildStage = 43;
        return execute(
          "qa",
          "build-revision-qa-approval-child",
          "BUILD_EXECUTE:qa-approved",
        );
      case 43:
        buildStage = 44;
        return "BUILD_QA_REVISION_APPROVED_OK";
      case 44:
        buildStage = 440;
        return {
          toolCalls: [
            {
              id: "build-publish-denied",
              name: "agent_builder__workflow_publish",
              input: { agentId: agentId() },
            },
          ],
        };
      case 440:
        buildStage = 441;
        return "BUILD_PUBLISH_REFUSED_OK";
      case 441:
        buildStage = 45;
        return {
          toolCalls: [
            {
              id: "build-publish",
              name: "agent_builder__workflow_publish",
              input: { agentId: agentId() },
            },
          ],
        };
      case 45:
        buildStage = 46;
        return {
          toolCalls: [
            {
              id: "build-current-get",
              name: "agent_builder__agent_get",
              input: { agentId: agentId() },
            },
          ],
        };
      case 46:
        buildStage = 47;
        return {
          toolCalls: [
            {
              id: "build-prepare-active",
              name: "agent_builder__prepare_active_run",
              input: { agentId: agentId() },
            },
          ],
        };
      case 47: {
        const value = outputValue(latestNamed("agent_builder__prepare_active_run")?.output);
        const bootstrapMessage = value?.bootstrapMessage;
        if (typeof bootstrapMessage !== "string") throw new Error("BUILD_ACTIVE_BOOTSTRAP_MISSING");
        buildStage = 48;
        return {
          toolCalls: [
            {
              id: "build-active-bootstrap",
              name: "active-runner",
              input: { message: bootstrapMessage, outputSchema: READY_OUTPUT_SCHEMA },
            },
          ],
        };
      }
      case 48:
        buildStage = 49;
        return execute("active-runner", "build-active-child", FIXTURE_TASK);
      case 49:
        buildStage = 50;
        return `BUILD_WORKFLOW_PUBLISHED_CURRENT_RUN_OK ${JSON.stringify(
          latestNamed("active-runner")?.output,
        )}`;
      default: {
        const system = request.messages
          .filter(({ role }) => role === "system")
          .map(({ text }) => text)
          .join("\n");
        return system.includes("Published workflow witness")
          ? "BUILD_NEXT_TURN_ROSTER_OK Published workflow witness"
          : "BUILD_NEXT_TURN_ROSTER_MISSING";
      }
    }
  }
  const roleCase = scenarioMessages
    .map((message) => ROLE_CASE_PATTERN.exec(message))
    .find((match) => match !== null) ?? null;
  if (roleCase !== null) {
    const subagentName = roleCase[1];
    if (subagentName === undefined) throw new Error("Role fixture name missing");
    const leaseRole = subagentName === "test-runner" ? "test_runner" : subagentName;
    const preparedRole = request.toolResults.find(
      (result) => result.name === "agent_builder__prepare_role",
    );
    const roleResults = request.toolResults.filter(
      (result) => result.name === subagentName,
    );
    if (preparedRole === undefined) {
      return {
        toolCalls: [
          {
            id: `prepare-${subagentName}`,
            name: "agent_builder__prepare_role",
            input: { agentId: fixtureState.draftAgentId, role: leaseRole },
          },
        ],
      };
    }
    if (roleResults.length === 0) {
      const bootstrapMessage = (preparedRole.output as { bootstrapMessage?: unknown })
        .bootstrapMessage;
      if (typeof bootstrapMessage !== "string") {
        throw new Error("prepare role result omitted bootstrap message");
      }
      return {
        toolCalls: [
          {
            id: `bootstrap-${subagentName}`,
            name: subagentName,
            input: { message: bootstrapMessage, outputSchema: READY_OUTPUT_SCHEMA },
          },
        ],
      };
    }
    if (roleResults.length === 1) {
      assertStructuredReady(roleResults[0]?.output);
      const pattern = new RegExp(`<agent id="([^"]+)" name="${subagentName}">`, "u");
      const allMessages = request.messages.map((message) => message.text).join("\n");
      const agentId = pattern.exec(allMessages)?.[1];
      if (agentId === undefined) throw new Error(`Parked ${subagentName} child ID missing`);
      return {
        toolCalls: [
          {
            id: `execute-${subagentName}`,
            name: subagentName,
            input: { agentId, message: `ROLE_EXECUTE:${leaseRole}` },
          },
        ],
      };
    }
    return String(roleResults[1]?.output);
  }
  const unknown = scenarioMessages.some((message) => message.includes("UNKNOWN_CHILD_CASE"));
  const activeResults = request.toolResults.filter((result) => result.name === "active-runner");
  if (unknown) {
    if (activeResults.length === 0) {
      unknownStart = fixtureState.activeModelCalls;
      return {
        toolCalls: [
          {
            id: "unknown-child",
            name: "active-runner",
            input: { agentId: "not-a-known-child", message: "MUST_NOT_EXECUTE_UNKNOWN_TASK" },
          },
        ],
      };
    }
    const blocked = JSON.stringify(activeResults[0]?.output).includes("BOOTSTRAP_REQUIRED");
    const preModel = fixtureState.activeModelCalls === unknownStart;
    return blocked && preModel ? "UNKNOWN_CHILD_BLOCKED_PRE_MODEL" : "UNKNOWN_CHILD_ISOLATION_FAILED";
  }

  const prepared = request.toolResults.find(
    (result) => result.name === "agent_builder__prepare_active_run",
  );
  if (prepared === undefined) {
    return {
      toolCalls: [
        {
          id: "prepare-active",
          name: "agent_builder__prepare_active_run",
          input: { agentId: fixtureState.activeAgentId },
        },
      ],
    };
  }
  if (activeResults.length === 0) {
    const bootstrapMessage = (prepared.output as { bootstrapMessage?: unknown }).bootstrapMessage;
    if (typeof bootstrapMessage !== "string") throw new Error("prepare result omitted bootstrap message");
    return {
      toolCalls: [
        {
          id: "active-bootstrap",
          name: "active-runner",
          input: { message: bootstrapMessage, outputSchema: READY_OUTPUT_SCHEMA },
        },
      ],
    };
  }
  if (activeResults.length === 1) {
    assertStructuredReady(activeResults[0]?.output);
    const allMessages = request.messages.map((message) => message.text).join("\n");
    const agentId = AGENT_ID_PATTERN.exec(allMessages)?.[1];
    if (agentId === undefined) throw new Error("Parked active child ID missing");
    activeChildId = agentId;
    return {
      toolCalls: [
        {
          id: "active-execution",
          name: "active-runner",
          input: { agentId, message: FIXTURE_TASK },
        },
      ],
    };
  }
  if (activeResults.length === 2) {
    const agentId = activeChildId;
    if (agentId === undefined) throw new Error("Completed active child ID missing");
    completedActiveModelCalls = fixtureState.activeModelCalls;
    return {
      toolCalls: [
        {
          id: "reject-third-active-turn",
          name: "active-runner",
          input: { agentId, message: "MUST_NOT_REUSE_COMPLETED_LEASE" },
        },
      ],
    };
  }
  const reuseBlocked = JSON.stringify(activeResults[2]?.output).includes("LEASE_CLOSED");
  if (!reuseBlocked || fixtureState.activeModelCalls !== completedActiveModelCalls) {
    throw new Error("ACTIVE_LEASE_REUSE_NOT_BLOCKED_PRE_MODEL");
  }
  return `${String(activeResults[1]?.output)} LEASE_CLOSED_PROVED`;
});

export default defineAgent({
  model,
  modelContextWindowTokens: 32_000,
});
