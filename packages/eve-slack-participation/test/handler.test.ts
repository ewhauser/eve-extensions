import type {
  SlackInboundMessageContext,
  SlackMessage,
  SlackThreadMessage,
} from "eve/channels/slack";
import { describe, expect, it, vi } from "vitest";

import { createSlackParticipationHandlerWithDependencies } from "../extension/lib/handler.js";
import type {
  ParticipationClassifier,
  SlackParticipationConfig,
  SlackParticipationDecisionRecord,
} from "../extension/lib/types.js";

function slackMessage(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    text: "What do you think?",
    markdown: "What do you think?",
    ts: "4",
    threadTs: "1",
    channelId: "C1",
    teamId: "T1",
    author: {
      userId: "U2",
      userName: "second",
      fullName: "Second Human",
      isBot: false,
      isMe: false,
    },
    attachments: [],
    raw: {},
    ...overrides,
  };
}

function threadMessage(ts: string, user: string, text = "prior"): SlackThreadMessage {
  return {
    text,
    markdown: text,
    user,
    botId: undefined,
    ts,
    threadTs: "1",
    isMe: false,
    raw: {},
  };
}

function context(input: {
  subscribed?: boolean;
  mentioned?: boolean;
  participants?: readonly string[];
  recent?: readonly SlackThreadMessage[];
  subscriptionError?: boolean;
  snapshotError?: boolean;
  cancelError?: boolean;
} = {}) {
  const cancel = input.cancelError
    ? vi.fn().mockRejectedValue(new Error("cancel failed"))
    : vi.fn().mockResolvedValue(undefined);
  const isSubscribed = input.subscriptionError
    ? vi.fn().mockRejectedValue(new Error("lookup failed"))
    : vi.fn().mockResolvedValue(input.subscribed ?? true);
  const listParticipants = input.snapshotError
    ? vi.fn().mockRejectedValue(new Error("snapshot failed"))
    : vi.fn().mockResolvedValue(input.participants ?? ["U1", "U2"]);
  const ctx = {
    isSubscribed,
    isBotMentioned: vi.fn().mockReturnValue(input.mentioned ?? false),
    cancel,
    thread: {
      recentMessages: input.recent ?? [threadMessage("1", "U1")],
      listParticipants,
    },
  } as unknown as SlackInboundMessageContext;
  return { ctx, cancel, isSubscribed, listParticipants };
}

function harness(input: {
  mode?: "shadow" | "enforce";
  classifier?: ParticipationClassifier;
  onDecision?: (record: SlackParticipationDecisionRecord) => void | Promise<void>;
} = {}) {
  const config: SlackParticipationConfig = {
    model: "openai/gpt-5-mini",
    mode: input.mode ?? "enforce",
    recentMessages: 12,
    maxContextCharacters: 12_000,
    timeoutMs: 2_000,
    groupRequests: "silent",
    ...(input.onDecision ? { onDecision: input.onDecision } : {}),
  };
  const classifier = input.classifier ?? vi.fn().mockResolvedValue({
    decision: "SILENT",
    addressee: "HUMAN",
    reason: "HUMAN_TO_HUMAN",
    modelId: "test-model",
    latencyMs: 4,
  });
  const auth = vi.fn().mockReturnValue({ principalId: "workspace:T1" });
  const handler = createSlackParticipationHandlerWithDependencies(
    { auth },
    { getConfig: () => config, classify: classifier },
  );
  return { handler, auth, classifier };
}

describe("Slack participation handler", () => {
  it("ignores bot, Eve, and system-authored messages", async () => {
    const onDecision = vi.fn();
    const { handler } = harness({ onDecision });
    const { ctx } = context();

    await expect(handler(ctx, slackMessage({ author: undefined }))).resolves.toBeNull();
    await expect(
      handler(ctx, slackMessage({ author: { ...slackMessage().author!, isBot: true } })),
    ).resolves.toBeNull();
    await expect(
      handler(ctx, slackMessage({ author: { ...slackMessage().author!, isMe: true } })),
    ).resolves.toBeNull();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it.each([
    ["direct message", { raw: { channel_type: "im" } }, false, "direct_message"],
    ["explicit mention", {}, true, "explicit_mention"],
  ] as const)("dispatches a %s without classification", async (_name, messageOverrides, mentioned, source) => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler, classifier } = harness({ onDecision: (record) => { records.push(record); } });
    const { ctx, cancel, listParticipants } = context({ subscribed: false, mentioned });

    await expect(handler(ctx, slackMessage(messageOverrides))).resolves.toMatchObject({
      auth: { principalId: "workspace:T1" },
    });
    expect(classifier).not.toHaveBeenCalled();
    expect(listParticipants).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ source, decision: "RESPOND" });
  });

  it("preserves not-subscribed routing before the non-Eve addressee rule", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler, auth, classifier } = harness({ onDecision: (record) => { records.push(record); } });
    const { ctx, listParticipants } = context({ subscribed: false });

    await expect(
      handler(ctx, slackMessage({ text: "hey <@U1> - can you rerun it?" })),
    ).resolves.toBeNull();
    expect(auth).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(listParticipants).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ source: "not_subscribed", decision: "SILENT" });
  });

  it("deterministically drops a sentence-initial non-Eve addressee even in shadow mode", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler, auth, classifier } = harness({
      mode: "shadow",
      onDecision: (record) => { records.push(record); },
    });
    const message = slackMessage({
      text: "hey <@U2> - can you rerun it with the fake clock enabled?",
      author: { ...slackMessage().author!, userId: "U1" },
    });
    const { ctx, cancel, listParticipants } = context({ participants: ["U1"] });

    await expect(handler(ctx, message)).resolves.toBeNull();
    expect(auth).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(listParticipants).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      source: "explicit_non_eve_addressee",
      mode: "unknown",
      decision: "SILENT",
      reason: "HUMAN_TO_HUMAN",
      addressee: "HUMAN",
      shadow: true,
    });
  });

  it("keeps mid-sentence Slack user references classifier-eligible", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler, classifier } = harness({
      onDecision: (record) => { records.push(record); },
    });
    const { ctx, listParticipants } = context();

    await expect(
      handler(ctx, slackMessage({ text: "I asked <@U1> to review it. What do you think?" })),
    ).resolves.toBeNull();
    expect(listParticipants).toHaveBeenCalledOnce();
    expect(classifier).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({ source: "classifier", decision: "SILENT" });
  });

  it("gives an explicit Eve mention precedence over a leading human addressee", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler, auth, classifier } = harness({
      onDecision: (record) => { records.push(record); },
    });
    const { ctx, cancel, listParticipants } = context({ mentioned: true });

    await expect(
      handler(ctx, slackMessage({ text: "hey <@U1> - can you ask <@UEVE123> to check this?" })),
    ).resolves.toMatchObject({ auth: expect.anything() });
    expect(auth).toHaveBeenCalledOnce();
    expect(classifier).not.toHaveBeenCalled();
    expect(listParticipants).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({ source: "explicit_mention", decision: "RESPOND" });
  });

  it("dispatches a trustworthy dyadic thread model-free and cancels first", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler, classifier } = harness({ onDecision: (record) => { records.push(record); } });
    const message = slackMessage({
      author: { ...slackMessage().author!, userId: "U1" },
    });
    const { ctx, cancel } = context({ participants: ["U1"] });

    await expect(handler(ctx, message)).resolves.toMatchObject({ auth: expect.anything() });
    expect(classifier).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({
      source: "dyadic_rule",
      mode: "dyadic",
      distinctHumans: 1,
      decision: "RESPOND",
    });
  });

  it("adds a missing latest human to a non-empty snapshot before classifying", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const classifier = vi.fn().mockResolvedValue({
      decision: "RESPOND",
      addressee: "EVE",
      reason: "QUESTION_OR_REQUEST_FOR_EVE",
      modelId: "test-model",
      latencyMs: 3,
    });
    const { handler } = harness({ classifier, onDecision: (record) => { records.push(record); } });
    const { ctx, cancel } = context({ participants: ["U1"] });

    await expect(handler(ctx, slackMessage())).resolves.toMatchObject({ auth: expect.anything() });
    expect(classifier).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({
      mode: "multi_party",
      distinctHumans: 2,
      source: "classifier",
      decision: "RESPOND",
      reason: "QUESTION_OR_REQUEST_FOR_EVE",
    });
  });

  it("does not cancel or dispatch an enforced silent classification", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler } = harness({ onDecision: (record) => { records.push(record); } });
    const { ctx, cancel } = context();

    await expect(handler(ctx, slackMessage())).resolves.toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      source: "classifier",
      decision: "SILENT",
      addressee: "HUMAN",
      reason: "HUMAN_TO_HUMAN",
      contextMessages: 2,
    });
  });

  it("preserves subscribed-thread dispatch in shadow mode", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler } = harness({
      mode: "shadow",
      onDecision: (record) => { records.push(record); },
    });
    const { ctx, cancel } = context();

    await expect(handler(ctx, slackMessage())).resolves.toMatchObject({ auth: expect.anything() });
    expect(cancel).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({ decision: "SILENT", shadow: true });
  });

  it("fails quiet on empty and 50-message single-human snapshots", async () => {
    const emptyRecords: SlackParticipationDecisionRecord[] = [];
    const emptyHarness = harness({ onDecision: (record) => { emptyRecords.push(record); } });
    const empty = context({ participants: [] });
    await expect(emptyHarness.handler(empty.ctx, slackMessage())).resolves.toBeNull();
    expect(emptyRecords[0]).toMatchObject({ source: "failure_fallback", decision: "SILENT" });

    const cappedRecords: SlackParticipationDecisionRecord[] = [];
    const cappedHarness = harness({ onDecision: (record) => { cappedRecords.push(record); } });
    const recent = Array.from({ length: 50 }, (_, index) =>
      threadMessage(String(index + 1), "U1"),
    );
    const capped = context({ participants: ["U1"], recent });
    const message = slackMessage({ author: { ...slackMessage().author!, userId: "U1" } });
    await expect(cappedHarness.handler(capped.ctx, message)).resolves.toBeNull();
    expect(cappedRecords[0]).toMatchObject({ source: "snapshot_limit", decision: "SILENT" });
  });

  it("fails quiet on classifier errors and records only a safe error code", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const classifier = vi.fn().mockRejectedValue(new Error("provider included secret text"));
    const { handler } = harness({ classifier, onDecision: (record) => { records.push(record); } });
    const { ctx, cancel } = context();

    await expect(handler(ctx, slackMessage())).resolves.toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      source: "failure_fallback",
      decision: "SILENT",
      errorCode: "classifier_error",
      modelId: "openai/gpt-5-mini",
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(records[0])).not.toContain("secret text");
  });

  it("keeps a valid dispatch when cancellation or telemetry fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const records: SlackParticipationDecisionRecord[] = [];
    const onDecision = vi.fn(async (record: SlackParticipationDecisionRecord) => {
      records.push(record);
      throw new Error("sink unavailable");
    });
    const classifier = vi.fn().mockResolvedValue({
      decision: "RESPOND",
      addressee: "EVE",
      reason: "FOLLOW_UP_TO_EVE",
      modelId: "test-model",
      latencyMs: 2,
    });
    const { handler } = harness({ classifier, onDecision });
    const { ctx } = context({ cancelError: true });

    await expect(handler(ctx, slackMessage())).resolves.toMatchObject({ auth: expect.anything() });
    expect(records[0]).toMatchObject({ errorCode: "cancel_failed", decision: "RESPOND" });
    expect(warn).toHaveBeenCalledWith("eve-slack-participation onDecision callback failed");
    warn.mockRestore();
  });

  it("still dispatches direct messages when subscription lookup fails", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler } = harness({ onDecision: (record) => { records.push(record); } });
    const { ctx, cancel } = context({ subscriptionError: true });

    await expect(
      handler(ctx, slackMessage({ raw: { channel_type: "im" } })),
    ).resolves.toMatchObject({ auth: expect.anything() });
    expect(cancel).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      source: "direct_message",
      errorCode: "subscription_check_failed",
    });
  });

  it("fails quiet when an application auth resolver throws", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const config: SlackParticipationConfig = {
      model: "openai/gpt-5-mini",
      mode: "enforce",
      recentMessages: 12,
      maxContextCharacters: 12_000,
      timeoutMs: 2_000,
      groupRequests: "silent",
      onDecision: (record) => { records.push(record); },
    };
    const handler = createSlackParticipationHandlerWithDependencies(
      { auth: vi.fn().mockRejectedValue(new Error("credential detail")) },
      {
        getConfig: () => config,
        classify: vi.fn().mockResolvedValue({
          decision: "RESPOND",
          addressee: "EVE",
          reason: "FOLLOW_UP_TO_EVE",
          modelId: "test-model",
          latencyMs: 1,
        }),
      },
    );
    const { ctx, cancel } = context();

    await expect(handler(ctx, slackMessage())).resolves.toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      decision: "RESPOND",
      errorCode: "auth_resolver_failed",
    });
    expect(JSON.stringify(records[0])).not.toContain("credential detail");
  });

  it("drops unmentioned messages when subscription state is unavailable", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler } = harness({ onDecision: (record) => { records.push(record); } });
    const { ctx, listParticipants } = context({ subscriptionError: true });

    await expect(handler(ctx, slackMessage())).resolves.toBeNull();
    expect(listParticipants).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      source: "failure_fallback",
      decision: "SILENT",
      errorCode: "subscription_check_failed",
    });
  });

  it("preserves subscribed behavior after a snapshot exception in shadow mode", async () => {
    const records: SlackParticipationDecisionRecord[] = [];
    const { handler } = harness({
      mode: "shadow",
      onDecision: (record) => { records.push(record); },
    });
    const { ctx, cancel } = context({ snapshotError: true });

    await expect(handler(ctx, slackMessage())).resolves.toMatchObject({ auth: expect.anything() });
    expect(cancel).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({
      source: "failure_fallback",
      decision: "SILENT",
      errorCode: "participant_snapshot_failed",
      shadow: true,
    });
  });
});
