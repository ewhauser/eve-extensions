import { describe, expect, it, vi } from "vitest";

import { createSlackProgressPublisher, renderSlackProgress } from "../extension/slack.js";
import { createMemoryProgressSurfaceStore } from "../extension/stores/memory.js";
import type {
  AgentProgressSnapshot,
  ProgressPublicationContext,
  SlackProgressApiInput,
} from "../extension/lib/types.js";

function context(sessionId = "root", rootSessionId = "root"): ProgressPublicationContext {
  return {
    sessionId,
    rootSessionId,
    agent: { name: sessionId === rootSessionId ? "root-agent" : "researcher" },
    ...(sessionId === rootSessionId
      ? {}
      : {
          parent: {
            callId: "call-1",
            sessionId: rootSessionId,
            turnId: "root-turn",
            turnSequence: 0,
          },
        }),
    channel:
      sessionId === rootSessionId
        ? {
            kind: "slack",
            metadata: { channelId: "C123", teamId: "T123", threadTs: "100.200" },
          }
        : { kind: "subagent" },
  };
}

function snapshot(
  sessionId = "root",
  rootSessionId = "root",
  revision = 1,
  status: "pending" | "in_progress" | "completed" | "cancelled" = "in_progress",
  lifecycle: AgentProgressSnapshot["lifecycle"] = "running",
): AgentProgressSnapshot {
  const ctx = context(sessionId, rootSessionId);
  return {
    schemaVersion: 1,
    revision,
    sessionId,
    rootSessionId,
    agent: ctx.agent,
    ...(ctx.parent === undefined ? {} : { parent: ctx.parent }),
    lifecycle,
    tasks: [{ id: `${sessionId}-task-1`, title: "Implement progress", priority: "high", status }],
  };
}

describe("Slack rendering", () => {
  it("maps Eve completion, cancellation, and turn failure to task cards", () => {
    const completed = renderSlackProgress(snapshot("root", "root", 1, "completed"), {
      title: "Plan",
    });
    const cancelled = renderSlackProgress(snapshot("root", "root", 2, "cancelled"), {
      title: "Plan",
    });
    const failed = renderSlackProgress(
      snapshot("root", "root", 3, "in_progress", "failed"),
      { title: "Plan" },
    );

    expect(completed.blocks[0]).toMatchObject({
      type: "plan",
      tasks: [{ status: "complete" }],
    });
    expect(cancelled.blocks[0]).toMatchObject({
      tasks: [{ status: "error" }],
    });
    expect(failed.blocks[0]).toMatchObject({
      tasks: [{ status: "error" }],
    });
  });

  it("rotates block IDs by revision and bounds plans to Slack's 50-task limit", () => {
    const base = snapshot();
    const rendered = renderSlackProgress(
      {
        ...base,
        revision: 7,
        tasks: Array.from({ length: 60 }, (_, index) => ({
          id: `task-${index}`,
          title: `Task ${index}`,
          priority: "medium" as const,
          status: "pending" as const,
        })),
      },
      { title: "Plan", maxTasks: 100 },
    );

    expect(rendered.blocks[0]).toMatchObject({ block_id: expect.stringContaining("-r7") });
    expect((rendered.blocks[0] as { tasks: unknown[] }).tasks).toHaveLength(50);
  });
});

describe("Slack publisher", () => {
  it("posts one message per agent, updates it in place, and skips replays", async () => {
    const store = createMemoryProgressSurfaceStore();
    const calls: SlackProgressApiInput[] = [];
    const api = vi.fn(async (input: SlackProgressApiInput) => {
      calls.push(input);
      return { ok: true, ts: `message-${calls.length}` };
    });
    const publisher = createSlackProgressPublisher({ store, botToken: "xoxb-test", api });
    const rootContext = context();

    await publisher.bind(rootContext);
    await publisher.publish(snapshot(), rootContext);
    await publisher.publish(snapshot("root", "root", 2, "completed"), rootContext);
    await publisher.publish(snapshot("root", "root", 2, "completed"), rootContext);
    await publisher.publish(
      { ...snapshot("root", "root", 3, "completed"), tasks: [] },
      rootContext,
    );

    const childContext = context("child", "root");
    await publisher.publish(snapshot("child", "root"), childContext);

    expect(calls.map((call) => call.operation)).toEqual([
      "chat.postMessage",
      "chat.update",
      "chat.update",
      "chat.postMessage",
    ]);
    expect(calls[0]?.body).toMatchObject({ channel: "C123", thread_ts: "100.200" });
    expect(calls[1]?.body).toMatchObject({ channel: "C123", ts: "message-1" });
    expect(calls[2]?.body).toMatchObject({ channel: "C123", ts: "message-1" });
    expect(calls[3]?.body).toMatchObject({ channel: "C123", thread_ts: "100.200" });
    expect(
      await store.getSurface("root", "child"),
    ).toMatchObject({ messageTs: "message-4", sessionId: "child" });
  });

  it("does not create an empty initial surface or publish without a root binding", async () => {
    const store = createMemoryProgressSurfaceStore();
    const api = vi.fn(async () => ({ ok: true, ts: "message-1" }));
    const publisher = createSlackProgressPublisher({ store, api });
    const noTasks = { ...snapshot(), tasks: [] };

    await publisher.publish(noTasks, context());
    await publisher.publish(snapshot("child", "missing"), context("child", "missing"));

    expect(api).not.toHaveBeenCalled();
  });
});
