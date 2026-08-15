import { describe, expect, it } from "vitest";

import { buildClassifierContext } from "../extension/lib/context.js";
import type { SlackParticipationReason } from "../extension/lib/types.js";
import {
  engineeringConversationEvalCases,
  gradeEngineeringConversation,
  materializeEngineeringConversation,
} from "./eval/engineering-conversations.js";

const everyReason = new Set<SlackParticipationReason>([
  "QUESTION_OR_REQUEST_FOR_EVE",
  "FOLLOW_UP_TO_EVE",
  "ANSWER_TO_EVE",
  "GROUP_REQUEST",
  "HUMAN_TO_HUMAN",
  "ACKNOWLEDGEMENT_OR_AGREEMENT",
  "SOCIAL_CHATTER",
  "CONVERSATION_COMPLETE",
  "AMBIGUOUS",
]);

describe("engineering conversation eval corpus", () => {
  it("has unique ids and balanced routing outcomes", () => {
    const ids = engineeringConversationEvalCases.map((testCase) => testCase.id);
    const respond = engineeringConversationEvalCases.filter(
      (testCase) => testCase.expected.decision === "RESPOND",
    );
    const silent = engineeringConversationEvalCases.filter(
      (testCase) => testCase.expected.decision === "SILENT",
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(engineeringConversationEvalCases).toHaveLength(20);
    expect(respond).toHaveLength(10);
    expect(silent).toHaveLength(10);
  });

  it("covers every structured reason and both group-request policies", () => {
    const coveredReasons = new Set<SlackParticipationReason>();
    for (const testCase of engineeringConversationEvalCases) {
      for (const reason of testCase.expected.reasons) coveredReasons.add(reason);
    }
    expect(coveredReasons).toEqual(everyReason);
    expect(
      engineeringConversationEvalCases.some(
        (testCase) =>
          testCase.groupRequests === "respond" &&
          (testCase.expected.reasons as readonly SlackParticipationReason[]).includes(
            "GROUP_REQUEST",
          ),
      ),
    ).toBe(true);
    expect(
      engineeringConversationEvalCases.some(
        (testCase) =>
          testCase.groupRequests === "silent" &&
          (testCase.expected.reasons as readonly SlackParticipationReason[]).includes(
            "GROUP_REQUEST",
          ),
      ),
    ).toBe(true);
  });

  it.each(engineeringConversationEvalCases)(
    "$id is a classifier-eligible synthetic Slack thread",
    (testCase) => {
      const materialized = materializeEngineeringConversation(testCase);
      const root = testCase.turns[0];
      const latest = testCase.turns.at(-1);

      expect(root?.speaker).toBe(testCase.participants[0]);
      expect(latest?.speaker).not.toBe("eve");
      expect(new Set(testCase.participants).size).toBe(testCase.participants.length);
      expect(testCase.participants.length).toBeGreaterThanOrEqual(2);
      expect(materialized.message.raw.channel_type).toBe("channel");
      expect(materialized.message.text).not.toContain("<@U_EVE>");
      expect(materialized.participantIds).toHaveLength(testCase.participants.length);
    },
  );

  it.each(engineeringConversationEvalCases)(
    "$id produces bounded pseudonymous classifier context",
    (testCase) => {
      const materialized = materializeEngineeringConversation(testCase);
      const context = buildClassifierContext({
        ...materialized,
        maxMessages: 12,
        maxCharacters: 12_000,
        groupRequests: testCase.groupRequests,
      });

      expect(context.messageCount).toBeLessThanOrEqual(12);
      expect(context.characterCount).toBeLessThanOrEqual(12_000);
      expect(context.prompt).toContain(
        materialized.message.text.split(/\s+/u).slice(-4).join(" "),
      );
      expect(context.prompt).not.toMatch(/U_(?:AUTHOR|REVIEWER|RELEASE|EVE)/u);
    },
  );

  it("grades decision, addressee, and reason independently", () => {
    const testCase = engineeringConversationEvalCases[0];
    expect(testCase).toBeDefined();
    if (!testCase) return;

    expect(
      gradeEngineeringConversation(testCase, {
        decision: "RESPOND",
        addressee: "EVE",
        reason: "ANSWER_TO_EVE",
      }),
    ).toEqual({ passed: true, mismatches: [] });
    expect(
      gradeEngineeringConversation(testCase, {
        decision: "SILENT",
        addressee: "HUMAN",
        reason: "HUMAN_TO_HUMAN",
      }),
    ).toMatchObject({
      passed: false,
      mismatches: expect.arrayContaining([expect.stringContaining("decision")]),
    });
  });
});
