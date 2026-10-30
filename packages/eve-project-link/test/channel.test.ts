import type { DynamicContext } from "eve/tools";
import { describe, expect, it } from "vitest";

import {
  defaultProjectChannelResolver,
  projectChannelKey,
} from "../extension/lib/channel.js";

function context(
  kind: string | undefined,
  metadata: Readonly<Record<string, unknown>> | undefined,
): DynamicContext {
  return {
    session: { id: "session", auth: {} },
    channel: {
      ...(kind === undefined ? {} : { kind }),
      ...(metadata === undefined ? {} : { metadata }),
    },
    messages: [],
  } as unknown as DynamicContext;
}

describe("defaultProjectChannelResolver", () => {
  it("uses Slack team and channel metadata while ignoring thread identity", () => {
    const result = defaultProjectChannelResolver(
      context("channel:slack", {
        teamId: "T123",
        channelId: "C456",
        threadTs: "1710000000.001",
      }),
    );

    expect(result).toEqual({
      kind: "slack",
      workspaceId: "T123",
      channelId: "C456",
    });
  });

  it("supports provider-neutral workspace metadata", () => {
    expect(
      defaultProjectChannelResolver(
        context("teams", { workspaceId: "tenant", channelId: "channel" }),
      ),
    ).toEqual({ kind: "teams", workspaceId: "tenant", channelId: "channel" });
  });

  it("does not link an identity missing workspace scope", () => {
    expect(
      defaultProjectChannelResolver(context("slack", { channelId: "C456" })),
    ).toBeNull();
  });
});

describe("projectChannelKey", () => {
  it("does not collide when identifiers contain separators", () => {
    expect(
      projectChannelKey({ kind: "a:b", workspaceId: "c", channelId: "d" }),
    ).not.toBe(
      projectChannelKey({ kind: "a", workspaceId: "b:c", channelId: "d" }),
    );
  });
});
