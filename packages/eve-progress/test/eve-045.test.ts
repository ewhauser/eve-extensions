import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "../node_modules/eve/dist/src/channel/adapter.js";
import { buildChannelInstrumentationProjection } from "../node_modules/eve/dist/src/channel/instrumentation.js";
import { buildResolveContext } from "../node_modules/eve/dist/src/context/dynamic-resolve-context.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionKey,
} from "../node_modules/eve/dist/src/context/keys.js";
import {
  ContextContainer,
  contextStorage,
} from "../node_modules/eve/dist/src/context/container.js";
import { dispatchStreamEventHooks } from "../node_modules/eve/dist/src/context/hook-lifecycle.js";
import {
  createActionResultEvent,
  createTurnStartedEvent,
  stampMessageStreamEvent,
} from "../node_modules/eve/dist/src/protocol/message.js";
import {
  BundleKey,
  ChannelKey,
} from "../node_modules/eve/dist/src/runtime/sessions/runtime-context-keys.js";
import { slackChannel } from "eve/channels/slack";
import type { HookDefinition } from "eve/hooks";

import progress from "../extension/extension.js";
import progressHook from "../extension/hooks/progress.js";
import binding from "../extension/instructions/binding.js";
import { createSlackProgressPublisher } from "../extension/slack.js";
import type { SlackProgressApiInput } from "../extension/lib/types.js";

const todo = (status: "in_progress" | "completed") => ({
  counts: {
    cancelled: 0,
    completed: status === "completed" ? 1 : 0,
    in_progress: status === "in_progress" ? 1 : 0,
    pending: 0,
    total: 1,
  },
  todos: [{ content: "Address issue 107", priority: "high", status }],
});

function registryFor(hook: HookDefinition) {
  const entries = Object.entries(hook.events ?? {}).map(([eventType, handler]) => ({
    eventType,
    handler,
    slug: "progress",
  }));
  return {
    streamEventsByType: new Map(
      entries.map((entry) => [entry.eventType, [entry]]),
    ),
    streamEventsWildcard: [],
  } as Parameters<typeof dispatchStreamEventHooks>[0]["registry"];
}

function eveSlackAdapter(input: {
  readonly channelId: string | null;
  readonly teamId: string | null;
  readonly threadTs: string | null;
}): ChannelAdapter {
  const definition = slackChannel();
  const adapter = (definition as unknown as { readonly adapter: ChannelAdapter })
    .adapter;
  return {
    ...adapter,
    kind: "channel:slack",
    state: {
      ...adapter.state,
      audience: "public",
      channelId: input.channelId,
      teamId: input.teamId,
      threadTs: input.threadTs,
    },
  };
}

describe("Eve 0.45 Slack lifecycle", () => {
  it("posts and updates todo progress using channel metadata captured outside hooks", async () => {
    const calls: SlackProgressApiInput[] = [];
    const api = vi.fn(async (input: SlackProgressApiInput) => {
      calls.push(input);
      return { ok: true, ts: "progress-message" };
    });
    progress({ publisher: createSlackProgressPublisher({ api }) });

    const ctx = new ContextContainer();
    const auth = { current: null, initiator: null };
    ctx.set(AuthKey, null);
    ctx.set(InitiatorAuthKey, null);
    ctx.set(SessionIdKey, "session-107");
    ctx.set(ContinuationTokenKey, "C107:107.001");
    const adapter = eveSlackAdapter({
      channelId: "C107",
      teamId: "T107",
      threadTs: "107.001",
    });
    ctx.set(ChannelKey, adapter);
    ctx.set(
      ChannelInstrumentationKey,
      buildChannelInstrumentationProjection({ adapter, channelName: "slack" }),
    );
    ctx.set(BundleKey, {
      turnAgent: { id: "root-agent" },
    } as never);
    ctx.set(SessionKey, {
      auth,
      sessionId: "session-107",
      turn: { id: "turn-107", sequence: 0 },
    });

    await contextStorage.run(ctx, async () => {
      await binding.events["turn.started"]?.(
        createTurnStartedEvent({ sequence: 0, turnId: "turn-107" }),
        buildResolveContext(ctx, []),
      );

      const registry = registryFor(progressHook);
      await dispatchStreamEventHooks({
        ctx,
        registry,
        event: stampMessageStreamEvent(
          createTurnStartedEvent({ sequence: 0, turnId: "turn-107" }),
        ),
      });

      for (const [stepIndex, status] of (
        ["in_progress", "completed"] as const
      ).entries()) {
        await dispatchStreamEventHooks({
          ctx,
          registry,
          event: stampMessageStreamEvent(
            createActionResultEvent({
              result: {
                callId: `todo-${stepIndex}`,
                kind: "tool-result",
                output: todo(status),
                toolName: "todo",
              },
              sequence: 0,
              stepIndex,
              turnId: "turn-107",
            }),
          ),
        });
      }
    });

    expect(calls.map((call) => call.operation)).toEqual([
      "chat.postMessage",
      "chat.update",
    ]);
    expect(calls[0]?.body).toMatchObject({
      channel: "C107",
      thread_ts: "107.001",
    });
    expect(calls[1]?.body).toMatchObject({
      channel: "C107",
      ts: "progress-message",
    });
  });

  it("reports missing Slack binding metadata and unparseable todo output", async () => {
    const onError = vi.fn();
    const api = vi.fn(async () => ({ ok: true, ts: "unexpected" }));
    progress({
      publisher: createSlackProgressPublisher({ api }),
      onError,
    });

    const ctx = new ContextContainer();
    const auth = { current: null, initiator: null };
    ctx.set(AuthKey, null);
    ctx.set(InitiatorAuthKey, null);
    ctx.set(SessionIdKey, "session-diagnostics");
    ctx.set(ContinuationTokenKey, "missing-routing");
    const adapter = eveSlackAdapter({
      channelId: null,
      teamId: null,
      threadTs: null,
    });
    ctx.set(ChannelKey, adapter);
    ctx.set(
      ChannelInstrumentationKey,
      buildChannelInstrumentationProjection({ adapter, channelName: "slack" }),
    );
    ctx.set(BundleKey, {
      turnAgent: { id: "root-agent" },
    } as never);
    ctx.set(SessionKey, {
      auth,
      sessionId: "session-diagnostics",
      turn: { id: "turn-diagnostics", sequence: 0 },
    });

    await contextStorage.run(ctx, async () => {
      const turnStarted = createTurnStartedEvent({
        sequence: 0,
        turnId: "turn-diagnostics",
      });
      await binding.events["turn.started"]?.(
        turnStarted,
        buildResolveContext(ctx, []),
      );

      const registry = registryFor(progressHook);
      await dispatchStreamEventHooks({
        ctx,
        registry,
        event: stampMessageStreamEvent(turnStarted),
      });
      await dispatchStreamEventHooks({
        ctx,
        registry,
        event: stampMessageStreamEvent(
          createActionResultEvent({
            result: {
              callId: "invalid-todo",
              kind: "tool-result",
              output: { unexpected: true },
              toolName: "todo",
            },
            sequence: 0,
            stepIndex: 0,
            turnId: "turn-diagnostics",
          }),
        ),
      });
    });

    expect(onError.mock.calls.map(([failure]) => failure.phase)).toEqual([
      "bind",
      "parse",
    ]);
    expect(api).not.toHaveBeenCalled();
  });
});
