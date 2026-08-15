import { describe, expect, it } from "vitest";

import { evaluateRoutingPolicy } from "../extension/lib/policy.js";

describe("routing policy", () => {
  it("dispatches direct messages and mentions before subscription checks", () => {
    expect(
      evaluateRoutingPolicy({
        directMessage: true,
        explicitlyMentioned: false,
        subscribed: false,
        recentMessageCount: 0,
      }),
    ).toMatchObject({ action: "dispatch", source: "direct_message", decision: "RESPOND" });
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: true,
        subscribed: false,
        recentMessageCount: 0,
      }),
    ).toMatchObject({ action: "dispatch", source: "explicit_mention", decision: "RESPOND" });
  });

  it("drops unmentioned messages outside an active Eve thread", () => {
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        subscribed: false,
        recentMessageCount: 0,
      }),
    ).toEqual({
      action: "drop",
      decision: "SILENT",
      source: "not_subscribed",
      mode: "unknown",
    });
  });

  it("drops a non-Eve addressee after subscription and Eve-mention precedence", () => {
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        explicitlyAddressedNonEve: true,
        subscribed: true,
        recentMessageCount: 2,
      }),
    ).toEqual({
      action: "drop",
      decision: "SILENT",
      source: "explicit_non_eve_addressee",
      mode: "unknown",
    });
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: true,
        explicitlyAddressedNonEve: true,
        subscribed: true,
        recentMessageCount: 2,
      }).source,
    ).toBe("explicit_mention");
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        explicitlyAddressedNonEve: true,
        subscribed: false,
        recentMessageCount: 2,
      }).source,
    ).toBe("not_subscribed");
  });

  it("fails quiet for unavailable and visibly truncated snapshots", () => {
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        subscribed: true,
        participantIds: [],
        recentMessageCount: 2,
      }).source,
    ).toBe("failure_fallback");
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        subscribed: true,
        participantIds: ["U1"],
        recentMessageCount: 50,
      }),
    ).toMatchObject({ action: "drop", source: "snapshot_limit", decision: "SILENT" });
  });

  it("dispatches dyadic threads in either strategy", () => {
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        subscribed: true,
        participantIds: ["U1"],
        recentMessageCount: 10,
      }),
    ).toMatchObject({ action: "dispatch", source: "dyadic_rule", mode: "dyadic" });
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        strategy: "deterministic",
        subscribed: true,
        participantIds: ["U1"],
        recentMessageCount: 10,
      }),
    ).toMatchObject({ action: "dispatch", source: "dyadic_rule", mode: "dyadic" });
  });

  it("classifies or drops multi-party threads according to strategy", () => {
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        subscribed: true,
        participantIds: ["U1", "U2"],
        recentMessageCount: 10,
      }),
    ).toMatchObject({ action: "classify", source: "classifier", mode: "multi_party" });
    expect(
      evaluateRoutingPolicy({
        directMessage: false,
        explicitlyMentioned: false,
        strategy: "deterministic",
        subscribed: true,
        participantIds: ["U1", "U2"],
        recentMessageCount: 10,
      }),
    ).toEqual({
      action: "drop",
      decision: "SILENT",
      source: "deterministic_multi_party",
      mode: "multi_party",
      distinctHumans: 2,
    });
  });
});
