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
  experimental: { subagentPersistentSessions: true },
  model,
  modelContextWindowTokens: 32_000,
});
