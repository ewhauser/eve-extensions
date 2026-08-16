import { mockModel } from "eve/evals";

import {
  ROOT_INSTRUCTION_MARKER,
  SAVED_INSTRUCTION_MARKER,
} from "./fixture.js";

export function roleIsolationModel(input: {
  readonly role: "pm" | "implementor" | "qa" | "test_runner";
  readonly personaMarker: string;
  readonly executionTools: readonly string[];
}) {
  return mockModel((request) => {
    const toolNames = request.tools.map(({ name }) => name).sort();
    const system = request.messages
      .filter(({ role }) => role === "system")
      .map(({ text }) => text)
      .join("\n");
    if (system.includes(ROOT_INSTRUCTION_MARKER) || toolNames.includes("root-private")) {
      throw new Error(`ROOT_SLOT_LEAKED_TO_${input.role}`);
    }
    if (!system.includes(input.personaMarker)) {
      throw new Error(`STATIC_PERSONA_MISSING_FOR_${input.role}`);
    }
    if (request.userMessageCount === 1) {
      const redeemed = request.toolResults.find(
        ({ name }) => name === "agent_builder__bootstrap_redeem",
      );
      if (redeemed === undefined) {
        if (
          JSON.stringify(toolNames) !==
            JSON.stringify(["agent_builder__bootstrap_redeem", "final_output"]) ||
          system.includes(SAVED_INSTRUCTION_MARKER)
        ) {
          throw new Error(`BOOTSTRAP_SURFACE_NOT_ISOLATED_FOR_${input.role}`);
        }
        return {
          toolCalls: [
            {
              id: `redeem-${input.role}`,
              name: "agent_builder__bootstrap_redeem",
              input: {},
            },
          ],
        };
      }
      return {
        toolCalls: [
          {
            id: `structured-ready-${input.role}`,
            name: "final_output",
            input: { status: "ready", receipt: redeemed.output },
          },
        ],
      };
    }
    if (request.userMessageCount === 2) {
      if (
        request.lastUserMessage !== `ROLE_EXECUTE:${input.role}` ||
        !system.includes(SAVED_INSTRUCTION_MARKER) ||
        JSON.stringify(toolNames) !== JSON.stringify([...input.executionTools].sort())
      ) {
        throw new Error(
          `EXECUTION_SURFACE_NOT_ISOLATED_FOR_${input.role}:${JSON.stringify(toolNames)}`,
        );
      }
      return `ROLE_ISOLATION_OK ${input.role}`;
    }
    throw new Error(`ROLE_RECEIVED_MORE_THAN_TWO_TURNS_${input.role}`);
  });
}
