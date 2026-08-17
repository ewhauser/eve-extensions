import { mockModel } from "eve/evals";

import {
  CAPABILITY_ID,
  CONSEQUENTIAL_CAPABILITY_ID,
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
    if (request.userMessageCount > 1 && !system.includes(input.personaMarker)) {
      throw new Error(`STATIC_PERSONA_MISSING_FOR_${input.role}`);
    }
    if (request.userMessageCount === 1) {
      const redeemed = request.toolResults.find(
        ({ name }) => name === "agent_builder__bootstrap_redeem",
      );
      if (
        redeemed === undefined &&
        !(input.role === "test_runner" && toolNames.includes("fixture_read"))
      ) {
        const expectedBootstrapTools =
          input.role === "test_runner" && !toolNames.includes("final_output")
            ? ["agent_builder__bootstrap_redeem"]
            : ["agent_builder__bootstrap_redeem", "final_output"];
        if (
          JSON.stringify(toolNames) !== JSON.stringify(expectedBootstrapTools) ||
          system.includes(SAVED_INSTRUCTION_MARKER)
        ) {
          throw new Error(
            `BOOTSTRAP_SURFACE_NOT_ISOLATED_FOR_${input.role}:${JSON.stringify({ toolNames, saved: system.includes(SAVED_INSTRUCTION_MARKER) })}`,
          );
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
      if (input.role === "test_runner" && toolNames.includes("fixture_read")) {
        const draft = request.toolResults.find(
          ({ name }) => name === "agent_builder__draft_get",
        );
        if (draft === undefined) {
          return {
            toolCalls: [
              { id: "build-test-draft", name: "agent_builder__draft_get", input: {} },
            ],
          };
        }
        const read = request.toolResults.find(({ name }) => name === "fixture_read");
        if (read === undefined) {
          return {
            toolCalls: [
              { id: "build-test-read", name: "fixture_read", input: { city: "Denver" } },
            ],
          };
        }
        const notified = request.toolResults.find(({ name }) => name === "fixture_notify");
        if (toolNames.includes("fixture_notify") && notified === undefined) {
          return {
            toolCalls: [
              {
                id: "build-test-notify",
                name: "fixture_notify",
                input: { message: "approve-me" },
              },
            ],
          };
        }
        const submitted = request.toolResults.find(
          ({ name }) => name === "agent_builder__test_submit",
        );
        return submitted === undefined
          ? {
              toolCalls: [
                {
                  id: "build-test-submit",
                  name: "agent_builder__test_submit",
                  input: { status: "passed", errorCodes: [] },
                },
              ],
            }
          : "BUILD_TEST_EVIDENCE_OK";
      }
      if (!toolNames.includes("final_output")) return "BUILD_BOOTSTRAP_READY";
      if (redeemed === undefined) throw new Error("BOOTSTRAP_RECEIPT_MISSING");
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
      const build = /^BUILD_EXECUTE:(pm|pm-revision|implementor|qa-needs-test|qa-approved|test_runner)$/u.exec(
        request.lastUserMessage ?? "",
      );
      if (build !== null) {
        const step = build[1];
        if (step === "pm" || step === "pm-revision") {
          const submitted = request.toolResults.find(
            ({ name }) => name === "agent_builder__pm_submit",
          );
          return submitted === undefined
            ? {
                toolCalls: [
                  {
                    id: "build-pm-submit",
                    name: "agent_builder__pm_submit",
                    input: {
                      patch: {
                        name: "Published workflow witness",
                        kind: "agent",
                        description:
                          step === "pm-revision"
                            ? "PR04 revised deterministic workflow and publication witness"
                            : "PR04 deterministic workflow and publication witness",
                        pmBrief:
                          step === "pm-revision"
                            ? "Read Denver weather after an approved user-requested revision."
                            : "Read Denver weather and test one approved optional notification.",
                      },
                      result: "completed_handoff",
                    },
                  },
                ],
              }
            : "BUILD_PM_HANDOFF_OK";
        }
        if (step === "implementor") {
          const listed = request.toolResults.find(
            ({ name }) => name === "agent_builder__capability_list",
          );
          if (listed === undefined) {
            return {
              toolCalls: [
                { id: "build-capability-list", name: "agent_builder__capability_list", input: {} },
              ],
            };
          }
          const submitted = request.toolResults.find(
            ({ name }) => name === "agent_builder__implementor_submit",
          );
          return submitted === undefined
            ? {
                toolCalls: [
                  {
                    id: "build-implementor-submit",
                    name: "agent_builder__implementor_submit",
                    input: {
                      patch: {
                        instructions: `${SAVED_INSTRUCTION_MARKER}: Call fixture_read for Denver and return DIRECT_EXECUTION_OK with the forecast.`,
                        toolRequirements: [
                          {
                            capabilityId: CAPABILITY_ID,
                            level: "required",
                            displayNameSnapshot: "Fixture weather read",
                            schemaFingerprint: "sha256:fixture-weather-v1",
                            consequential: false,
                          },
                          {
                            capabilityId: CONSEQUENTIAL_CAPABILITY_ID,
                            level: "optional",
                            displayNameSnapshot: "Fixture consequential notification",
                            schemaFingerprint: "sha256:fixture-notify-v1",
                            consequential: true,
                          },
                        ],
                        triggers: [],
                      },
                      result: "completed_handoff",
                    },
                  },
                ],
              }
            : "BUILD_IMPLEMENTOR_HANDOFF_OK";
        }
        if (step === "qa-needs-test" || step === "qa-approved") {
          const submitted = request.toolResults.find(
            ({ name }) => name === "agent_builder__qa_submit",
          );
          if (submitted !== undefined) {
            return step === "qa-approved" ? "BUILD_QA_APPROVED_OK" : "BUILD_QA_TEST_REQUEST_OK";
          }
          return {
            toolCalls: [
              {
                id: step === "qa-approved" ? "build-qa-approve" : "build-qa-request-test",
                name: "agent_builder__qa_submit",
                input:
                  step === "qa-approved"
                    ? { patch: {}, result: "approved" }
                    : {
                        patch: {
                          testChecklist: ["Read Denver weather", "Approve optional notification"],
                          qaFindings: [],
                        },
                        result: "needs_test",
                      },
              },
            ],
          };
        }
        const read = request.toolResults.find(({ name }) => name === "fixture_read");
        if (read === undefined) {
          return {
            toolCalls: [
              { id: "build-test-read", name: "fixture_read", input: { city: "Denver" } },
            ],
          };
        }
        const notified = request.toolResults.find(({ name }) => name === "fixture_notify");
        if (toolNames.includes("fixture_notify") && notified === undefined) {
          return {
            toolCalls: [
              {
                id: "build-test-notify",
                name: "fixture_notify",
                input: { message: "approve-me" },
              },
            ],
          };
        }
        const submitted = request.toolResults.find(
          ({ name }) => name === "agent_builder__test_submit",
        );
        return submitted === undefined
          ? {
              toolCalls: [
                {
                  id: "build-test-submit",
                  name: "agent_builder__test_submit",
                  input: { status: "passed", errorCodes: [] },
                },
              ],
            }
          : "BUILD_TEST_EVIDENCE_OK";
      }
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
