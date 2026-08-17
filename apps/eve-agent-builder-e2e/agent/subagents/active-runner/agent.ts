import { mockModel } from "eve/evals";
import { defineAgentBuilderRoleAgent } from "eve-agent-builder/mounts/runner-agent";

import {
  FIXTURE_TASK,
  ROOT_INSTRUCTION_MARKER,
  ROOT_TOOL_MARKER,
  SAVED_INSTRUCTION_MARKER,
  fixtureState,
} from "../../lib/fixture.js";

const model = mockModel((request) => {
  fixtureState.activeModelCalls += 1;
  const toolNames = request.tools.map(({ name }) => name).sort();
  const system = request.messages
    .filter(({ role }) => role === "system")
    .map(({ text }) => text)
    .join("\n");
  if (system.includes(ROOT_INSTRUCTION_MARKER) || toolNames.includes("root-private")) {
    throw new Error("ROOT_SLOT_LEAKED_TO_ACTIVE_CHILD");
  }
  if (request.userMessageCount === 1) {
    if (request.lastUserMessage?.includes(FIXTURE_TASK) === true) {
      throw new Error("TASK_LEAKED_INTO_BOOTSTRAP_TURN");
    }
    const redeemed = request.toolResults.find(
      ({ name }) => name === "agent_builder__bootstrap_redeem",
    );
    if (redeemed === undefined) {
      if (
        JSON.stringify(toolNames) !==
          JSON.stringify(["agent_builder__bootstrap_redeem", "final_output"]) ||
        system.includes(SAVED_INSTRUCTION_MARKER) ||
        request.lastUserMessage?.includes("protocolVersion") !== true
      ) {
        throw new Error("BOOTSTRAP_SURFACE_NOT_ISOLATED");
      }
      return {
        toolCalls: [
          { id: "redeem-bootstrap", name: "agent_builder__bootstrap_redeem", input: {} },
        ],
      };
    }
    return {
      toolCalls: [
        {
          id: "structured-ready",
          name: "final_output",
          input: { status: "ready", receipt: redeemed.output },
        },
      ],
    };
  }
  if (request.userMessageCount === 2) {
    const expectedExecutionTools = toolNames.includes("fixture_notify")
      ? ["agent_builder__run_context", "fixture_notify", "fixture_read"]
      : ["agent_builder__run_context", "fixture_read"];
    if (
      request.lastUserMessage !== FIXTURE_TASK ||
      !system.includes(SAVED_INSTRUCTION_MARKER) ||
      system.includes(ROOT_INSTRUCTION_MARKER) ||
      JSON.stringify(toolNames) !== JSON.stringify(expectedExecutionTools)
    ) {
      throw new Error(`EXECUTION_SURFACE_NOT_ISOLATED:${JSON.stringify(toolNames)}`);
    }
    const capability = request.toolResults.find(({ name }) => name === "fixture_read");
    if (capability === undefined) {
      return {
        toolCalls: [
          { id: "read-weather", name: "fixture_read", input: { city: "Denver" } },
        ],
      };
    }
    const output = capability.output as { forecast?: unknown };
    if (output.forecast !== "clear" || fixtureState.capabilityCalls < 1) {
      throw new Error(`REAL_CAPABILITY_ADAPTER_NOT_USED:${ROOT_TOOL_MARKER}`);
    }
    return "DIRECT_EXECUTION_OK forecast=clear selected=fixture_read";
  }
  throw new Error("ACTIVE_RUNNER_RECEIVED_MORE_THAN_TWO_TURNS");
});

export default defineAgentBuilderRoleAgent({
  role: "active_runner",
  mode: "direct",
  model,
  modelContextWindowTokens: 32_000,
  description: "Isolated two-turn runner for an immutable active saved-agent version.",
});
