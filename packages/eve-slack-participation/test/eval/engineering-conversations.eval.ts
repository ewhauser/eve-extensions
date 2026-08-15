import { afterAll, describe, expect, it } from "vitest";

import { classifyParticipation } from "../../extension/lib/classifier.js";
import { buildClassifierContext } from "../../extension/lib/context.js";
import type { ClassifierSlackParticipationConfig } from "../../extension/lib/types.js";
import {
  engineeringConversationEvalCases,
  gradeEngineeringConversation,
  materializeEngineeringConversation,
} from "./engineering-conversations.js";

const model = process.env.EVE_SLACK_PARTICIPATION_EVAL_MODEL?.trim();
if (!model) {
  throw new Error(
    "Set EVE_SLACK_PARTICIPATION_EVAL_MODEL to an AI SDK gateway model id before running pnpm eval.",
  );
}

const requestedIds = new Set(
  (process.env.EVE_SLACK_PARTICIPATION_EVAL_CASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedCases = requestedIds.size === 0
  ? engineeringConversationEvalCases
  : engineeringConversationEvalCases.filter((testCase) => requestedIds.has(testCase.id));

if (selectedCases.length === 0 || selectedCases.length !== (requestedIds.size || selectedCases.length)) {
  throw new Error(
    `No exact eval-case match for: ${[...requestedIds].join(", ")}. ` +
      `Available ids: ${engineeringConversationEvalCases.map((testCase) => testCase.id).join(", ")}`,
  );
}

const completed: string[] = [];

describe.sequential(`engineering Slack participation eval (${model})`, () => {
  for (const testCase of selectedCases) {
    it(
      testCase.id,
      async () => {
        const materialized = materializeEngineeringConversation(testCase);
        const context = buildClassifierContext({
          ...materialized,
          maxMessages: 12,
          maxCharacters: 12_000,
          groupRequests: testCase.groupRequests,
        });
        const config: ClassifierSlackParticipationConfig = {
          strategy: "classifier",
          model,
          mode: "enforce",
          recentMessages: 12,
          maxContextCharacters: 12_000,
          timeoutMs: 10_000,
          groupRequests: testCase.groupRequests,
        };
        const actual = await classifyParticipation({ config, context });
        const grade = gradeEngineeringConversation(testCase, actual);
        completed.push(testCase.id);

        expect(
          grade.mismatches,
          `${testCase.description}\nActual: ${JSON.stringify({
            decision: actual.decision,
            addressee: actual.addressee,
            reason: actual.reason,
          })}`,
        ).toEqual([]);
      },
      15_000,
    );
  }

  afterAll(() => {
    console.log(
      `Evaluated ${completed.length}/${selectedCases.length} synthetic engineering threads with ${model}.`,
    );
  });
});
