import type { SlackMessage, SlackThreadMessage } from "eve/channels/slack";

import type {
  GroupRequestPolicy,
  SlackParticipationAddressee,
  SlackParticipationDecision,
  SlackParticipationDecisionValue,
  SlackParticipationReason,
} from "../../extension/lib/types.js";

export type EngineeringHuman = "author" | "reviewer" | "release";
export type EngineeringSpeaker = EngineeringHuman | "eve";

export interface EngineeringConversationTurn {
  readonly speaker: EngineeringSpeaker;
  readonly text: string;
}

export interface EngineeringConversationEvalCase {
  readonly id: string;
  readonly description: string;
  readonly participants: readonly EngineeringHuman[];
  readonly turns: readonly EngineeringConversationTurn[];
  readonly groupRequests: GroupRequestPolicy;
  readonly expected: {
    readonly decision: SlackParticipationDecisionValue;
    readonly addressees: readonly SlackParticipationAddressee[];
    readonly reasons: readonly SlackParticipationReason[];
  };
}

const humanIds: Readonly<Record<EngineeringHuman, string>> = {
  author: "U_AUTHOR",
  reviewer: "U_REVIEWER",
  release: "U_RELEASE",
};

export const engineeringConversationEvalCases = [
  {
    id: "answer-to-eve-root-cause",
    description: "A human directly answers Eve's diagnostic question.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "CI is failing only on the lockfile check." },
      { speaker: "reviewer", text: "I cannot reproduce it with my local install." },
      { speaker: "eve", text: "Which pnpm version generated the committed lockfile?" },
      { speaker: "author", text: "pnpm 11.15.0 generated it." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "RESPOND",
      addressees: ["EVE"],
      reasons: ["ANSWER_TO_EVE"],
    },
  },
  {
    id: "terse-answer-to-eve",
    description: "A terse technical value still answers Eve's immediately preceding question.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "The duplicate-key response changed during the API refactor." },
      { speaker: "reviewer", text: "I thought it was still a 400." },
      { speaker: "eve", text: "Which status code does the production path return now?" },
      { speaker: "reviewer", text: "409." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "RESPOND",
      addressees: ["EVE"],
      reasons: ["ANSWER_TO_EVE"],
    },
  },
  {
    id: "follow-up-request-on-eve-patch",
    description: "A reviewer asks Eve for another change after Eve describes its patch.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "The retry path still needs coverage." },
      { speaker: "eve", text: "I pushed a fix for the retry state transition." },
      { speaker: "reviewer", text: "Please add a regression test for a lost response too." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "RESPOND",
      addressees: ["EVE"],
      reasons: ["FOLLOW_UP_TO_EVE"],
    },
  },
  {
    id: "answer-to-eve-after-interruption",
    description: "A human answers Eve even after another human briefly interjects.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "The migration retry may retain the advisory lock." },
      { speaker: "eve", text: "Is the lock released before retry scheduling?" },
      { speaker: "reviewer", text: "I am checking the finally block now." },
      { speaker: "author", text: "Yes, the finally block releases it before scheduling the retry." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "RESPOND",
      addressees: ["EVE"],
      reasons: ["ANSWER_TO_EVE"],
    },
  },
  {
    id: "question-for-eve-by-name",
    description: "A human addresses Eve by name without an explicit Slack bot mention.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "We need a second opinion on the query plan." },
      { speaker: "reviewer", text: "Both indexes look plausible to me." },
      { speaker: "author", text: "Eve, can you compare the two EXPLAIN plans?" },
    ],
    groupRequests: "silent",
    expected: {
      decision: "RESPOND",
      addressees: ["EVE"],
      reasons: ["QUESTION_OR_REQUEST_FOR_EVE"],
    },
  },
  {
    id: "question-about-eve-work",
    description: "A possessive follow-up clearly refers to the patch Eve just described.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "Reviewing the context-trimming change now." },
      { speaker: "eve", text: "I changed it to retain the root and latest message." },
      { speaker: "reviewer", text: "Does your patch still preserve the root at the character limit?" },
    ],
    groupRequests: "silent",
    expected: {
      decision: "RESPOND",
      addressees: ["EVE"],
      reasons: ["FOLLOW_UP_TO_EVE"],
    },
  },
  {
    id: "correct-eve-and-request-rerun",
    description: "A human corrects Eve and asks Eve to repeat a check.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "The deploy check is reporting the old schema." },
      { speaker: "eve", text: "The staging database appears to be on schema version 18." },
      { speaker: "reviewer", text: "That assumption is stale. Please rerun the check against staging." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "RESPOND",
      addressees: ["EVE"],
      reasons: ["FOLLOW_UP_TO_EVE"],
    },
  },
  {
    id: "accept-eve-offer",
    description: "A human accepts Eve's offer and specifies the requested work.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "We still lack classifier failure metrics." },
      { speaker: "eve", text: "I can add metrics for timeout and decision source if useful." },
      { speaker: "reviewer", text: "Yes, add the timeout counter and the decision-source label." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "RESPOND",
      addressees: ["EVE"],
      reasons: ["ANSWER_TO_EVE", "FOLLOW_UP_TO_EVE"],
    },
  },
  {
    id: "group-request-summary-respond",
    description: "A group-wide synthesis request is accepted when group requests are enabled.",
    participants: ["author", "reviewer", "release"],
    turns: [
      { speaker: "author", text: "Postgres gives us queryability and transactional admission." },
      { speaker: "reviewer", text: "The durable lane gives us sticky ownership and replay." },
      { speaker: "release", text: "Can someone summarize the tradeoffs before design review?" },
    ],
    groupRequests: "respond",
    expected: {
      decision: "RESPOND",
      addressees: ["GROUP"],
      reasons: ["GROUP_REQUEST"],
    },
  },
  {
    id: "channel-request-respond",
    description: "A channel-wide engineering request is accepted when group requests are enabled.",
    participants: ["author", "reviewer", "release"],
    turns: [
      { speaker: "author", text: "The release candidate is deployed to staging." },
      { speaker: "reviewer", text: "The database migration completed cleanly." },
      { speaker: "release", text: "<!channel> please post your rollback concerns before the release call." },
    ],
    groupRequests: "respond",
    expected: {
      decision: "RESPOND",
      addressees: ["GROUP"],
      reasons: ["GROUP_REQUEST"],
    },
  },
  {
    id: "group-request-silent",
    description: "The same kind of group-wide request stays silent under conservative policy.",
    participants: ["author", "reviewer", "release"],
    turns: [
      { speaker: "author", text: "The canary has been healthy for thirty minutes." },
      { speaker: "reviewer", text: "Error rates and latency are both flat." },
      { speaker: "release", text: "Can someone volunteer to monitor the rollout for another hour?" },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["GROUP"],
      reasons: ["GROUP_REQUEST"],
    },
  },
  {
    id: "human-to-human-named-rerun",
    description: "A request addressed by name to another human should not wake Eve.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "The flaky test is still blocking the merge." },
      { speaker: "eve", text: "The failure is isolated to the clock assertion." },
      { speaker: "reviewer", text: "Marco, can you rerun it with the fake clock enabled?" },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["HUMAN"],
      reasons: ["HUMAN_TO_HUMAN"],
    },
  },
  {
    id: "human-to-human-by-name",
    description: "A named human assignment remains human-to-human without Slack mention syntax.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "The schema migration needs one more review." },
      { speaker: "eve", text: "The forward and rollback paths are both present." },
      { speaker: "reviewer", text: "Priya, please verify the rollback query before approval." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["HUMAN"],
      reasons: ["HUMAN_TO_HUMAN"],
    },
  },
  {
    id: "human-answers-human",
    description: "The latest message answers another human rather than Eve.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "Do we need to restart the worker after rotating the secret?" },
      { speaker: "eve", text: "The runbook describes secret rotation in the deploy section." },
      { speaker: "reviewer", text: "No, the worker reloads that binding on the next request." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["HUMAN"],
      reasons: ["HUMAN_TO_HUMAN"],
    },
  },
  {
    id: "discusses-eve-but-addresses-human",
    description: "Mentioning Eve's work does not address Eve when another human owns the request.",
    participants: ["author", "reviewer", "release"],
    turns: [
      { speaker: "author", text: "Eve's patch changes the retry boundary." },
      { speaker: "release", text: "I want a second reviewer on the failure path." },
      { speaker: "author", text: "I reviewed Eve's diff. Maya, can you check the cancellation branch?" },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["HUMAN"],
      reasons: ["HUMAN_TO_HUMAN"],
    },
  },
  {
    id: "acknowledges-eve",
    description: "A simple acknowledgement to Eve should end rather than restart the exchange.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "The generated types were missing from the tarball." },
      { speaker: "eve", text: "I added them to the required artifact list and rebuilt the package." },
      { speaker: "author", text: "Thanks, that fixes it." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["EVE"],
      reasons: ["ACKNOWLEDGEMENT_OR_AGREEMENT"],
    },
  },
  {
    id: "human-agreement",
    description: "Agreement with another human's proposal should not invite Eve to respond.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "I propose we keep shadow mode enabled for one week." },
      { speaker: "eve", text: "The telemetry fields can measure false positives during that period." },
      { speaker: "reviewer", text: "Yep, plus one to the one-week rollout." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["HUMAN"],
      reasons: ["ACKNOWLEDGEMENT_OR_AGREEMENT"],
    },
  },
  {
    id: "engineering-social-chatter",
    description: "Incidental social chatter in an engineering thread stays silent.",
    participants: ["author", "reviewer"],
    turns: [
      { speaker: "author", text: "The last flaky test passed on all runners." },
      { speaker: "eve", text: "The CI matrix is fully green now." },
      { speaker: "reviewer", text: "Nice, finally a quiet Friday." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["GROUP", "AMBIGUOUS"],
      reasons: ["SOCIAL_CHATTER"],
    },
  },
  {
    id: "conversation-complete",
    description: "A terminal incident update requires no response.",
    participants: ["author", "reviewer", "release"],
    turns: [
      { speaker: "author", text: "The rollback completed and traffic recovered." },
      { speaker: "eve", text: "Error rate has remained at baseline for twenty minutes." },
      { speaker: "release", text: "Production verification passed; no further action is needed." },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["GROUP", "AMBIGUOUS"],
      reasons: ["CONVERSATION_COMPLETE"],
    },
  },
  {
    id: "ambiguous-technical-question",
    description: "A context-poor question with several plausible addressees fails quiet.",
    participants: ["author", "reviewer", "release"],
    turns: [
      { speaker: "author", text: "The worker timeout is five seconds in staging." },
      { speaker: "eve", text: "The classifier timeout is configured separately." },
      { speaker: "reviewer", text: "The release job also has its own deadline." },
      { speaker: "release", text: "What about the timeout?" },
    ],
    groupRequests: "silent",
    expected: {
      decision: "SILENT",
      addressees: ["AMBIGUOUS"],
      reasons: ["AMBIGUOUS"],
    },
  },
] as const satisfies readonly EngineeringConversationEvalCase[];

export interface MaterializedEngineeringConversation {
  readonly message: SlackMessage;
  readonly recentMessages: readonly SlackThreadMessage[];
  readonly participantIds: readonly string[];
}

function timestamp(index: number): string {
  return `1700000000.${String(index + 1).padStart(6, "0")}`;
}

export function materializeEngineeringConversation(
  testCase: EngineeringConversationEvalCase,
): MaterializedEngineeringConversation {
  const rootTs = timestamp(0);
  const recentMessages: SlackThreadMessage[] = testCase.turns.map((turn, index) => {
    const isMe = turn.speaker === "eve";
    return {
      text: turn.text,
      markdown: turn.text,
      user: isMe ? "U_EVE" : humanIds[turn.speaker],
      botId: isMe ? "B_EVE" : undefined,
      ts: timestamp(index),
      threadTs: rootTs,
      isMe,
      raw: {},
    };
  });
  const latest = testCase.turns.at(-1);
  if (!latest || latest.speaker === "eve") {
    throw new Error(`Eval case ${testCase.id} must end with a human-authored message.`);
  }

  const latestTs = timestamp(testCase.turns.length - 1);
  return {
    message: {
      text: latest.text,
      markdown: latest.text,
      ts: latestTs,
      threadTs: rootTs,
      channelId: "C_ENGINEERING",
      teamId: "T_SYNTHETIC",
      author: {
        userId: humanIds[latest.speaker],
        userName: undefined,
        fullName: undefined,
        isBot: false,
        isMe: false,
      },
      attachments: [],
      raw: { channel_type: "channel" },
    },
    recentMessages,
    participantIds: testCase.participants.map((participant) => humanIds[participant]),
  };
}

export interface EngineeringEvalGrade {
  readonly passed: boolean;
  readonly mismatches: readonly string[];
}

export function gradeEngineeringConversation(
  testCase: EngineeringConversationEvalCase,
  actual: SlackParticipationDecision,
): EngineeringEvalGrade {
  const mismatches: string[] = [];
  if (actual.decision !== testCase.expected.decision) {
    mismatches.push(
      `decision expected ${testCase.expected.decision}, received ${actual.decision}`,
    );
  }
  if (!testCase.expected.addressees.includes(actual.addressee)) {
    mismatches.push(
      `addressee expected ${testCase.expected.addressees.join("|")}, received ${actual.addressee}`,
    );
  }
  if (!testCase.expected.reasons.includes(actual.reason)) {
    mismatches.push(
      `reason expected ${testCase.expected.reasons.join("|")}, received ${actual.reason}`,
    );
  }
  return { passed: mismatches.length === 0, mismatches };
}
