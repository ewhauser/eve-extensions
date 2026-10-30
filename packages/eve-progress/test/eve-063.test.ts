import { describe, expect, it, vi } from "vitest";
import type { HookContext } from "eve/hooks";
import { ContextContainer, contextStorage } from "../node_modules/eve/dist/src/context/container.js";

import progress from "../extension/extension.js";
import progressHook from "../extension/hooks/progress.js";
import { capturePublicationChannel } from "../extension/lib/runtime.js";
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

function hookContext(sessionId: string, metadata: Record<string, unknown>, index = 0): HookContext {
  return {
    agent: { name: "root-agent" },
    channel: { kind: "channel:slack", continuationToken: "C107:107.001", metadata },
    position: { line: 1, index },
    session: { id: sessionId, turn: { id: `turn-${sessionId}`, sequence: 0 } },
  } as unknown as HookContext;
}

async function runTodoCall(
  ctx: HookContext,
  callId: string,
  output: unknown,
  name = "todo",
): Promise<void> {
  await progressHook.events["call.requested"]?.({
    type: "call.requested",
    data: { callId, owner: { runId: "model-run" }, capability: { kind: "tool", name } },
  } as never, ctx);
  await progressHook.events["call.settled"]?.({
    type: "call.settled",
    data: { callId, outcome: "completed", output },
    scope: { turnId: ctx.session.turn.id },
  } as never, ctx);
}

describe("Eve 0.90.0 Slack lifecycle", () => {
  it("posts and updates todo progress using channel metadata captured outside hooks", async () => {
    const calls: SlackProgressApiInput[] = [];
    const api = vi.fn(async (input: SlackProgressApiInput) => {
      calls.push(input);
      return { ok: true, ts: "progress-message" };
    });
    progress({ publisher: createSlackProgressPublisher({ api }) });

    await contextStorage.run(new ContextContainer(), async () => {
      const metadata = { channelId: "C107", teamId: "T107", threadTs: "107.001" };
      const ctx = hookContext("session-107", metadata);
      capturePublicationChannel(ctx as never);
      await progressHook.events["turn.started"]?.({ type: "turn.started" } as never, ctx);
      await runTodoCall(ctx, "todo-0", todo("in_progress"));
      await runTodoCall(hookContext("session-107", metadata, 1), "todo-1", todo("completed"));
    });

    expect(calls.map((call) => call.operation)).toEqual(["chat.postMessage", "chat.update"]);
    expect(calls[0]?.body).toMatchObject({ channel: "C107", thread_ts: "107.001" });
    expect(calls[1]?.body).toMatchObject({ channel: "C107", ts: "progress-message" });
  });

  it("reports missing Slack binding metadata and unparseable todo output", async () => {
    const onError = vi.fn();
    const api = vi.fn(async () => ({ ok: true, ts: "unexpected" }));
    progress({ publisher: createSlackProgressPublisher({ api }), onError });

    await contextStorage.run(new ContextContainer(), async () => {
      const ctx = hookContext("session-diagnostics", {});
      capturePublicationChannel(ctx as never);
      await progressHook.events["turn.started"]?.({ type: "turn.started" } as never, ctx);
      await runTodoCall(ctx, "invalid-todo", { unexpected: true });
    });

    expect(onError.mock.calls.map(([failure]) => failure.phase)).toEqual(["bind", "parse"]);
    expect(api).not.toHaveBeenCalled();
  });

  it("ignores a non-todo call even when its output resembles a todo snapshot", async () => {
    const publish = vi.fn();
    progress({ publisher: { publish } });
    await contextStorage.run(new ContextContainer(), async () => {
      const ctx = hookContext("session-other-tool", {});
      await runTodoCall(ctx, "other-call", todo("in_progress"), "other");
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
