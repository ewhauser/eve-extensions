import { describe, expect, it } from "vitest";

import { hasSentenceInitialSlackUserMention } from "../extension/lib/addressing.js";

describe("sentence-initial Slack user addressing", () => {
  it.each([
    "<@U123> can you rerun the test?",
    "  <@W123|alex>, can you rerun the test?",
    "hey <@U123> - can you rerun the test?",
    "Hi, <@U123>: can you rerun the test?",
    "I checked the failure. <@U123>, can you rerun it?",
    "I checked the failure. hey <@U123>, can you rerun it?",
    "First line\n<@U123> can you rerun it?",
  ])("recognizes %j", (text) => {
    expect(hasSentenceInitialSlackUserMention(text)).toBe(true);
  });

  it.each([
    "I asked <@U123> to rerun the test.",
    "The reviewers are <@U123> and <@U456>.",
    "Can someone in <!channel> rerun the test?",
    "Hey @alex - can you rerun the test?",
    "Eve, what did <@U123> find?",
    "Hey <@X123> - this is not a canonical Slack user id.",
    "The literal <@> is malformed.",
  ])("does not treat %j as an explicit addressee", (text) => {
    expect(hasSentenceInitialSlackUserMention(text)).toBe(false);
  });
});
