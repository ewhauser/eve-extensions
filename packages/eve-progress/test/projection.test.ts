import { describe, expect, it } from "vitest";

import {
  initialProgressProjectionState,
  parseTodoOutput,
  projectLifecycle,
  projectTodoSnapshot,
} from "../extension/lib/projection.js";

const counts = {
  cancelled: 0,
  completed: 0,
  in_progress: 1,
  pending: 0,
  total: 1,
};

describe("todo projection", () => {
  it("keeps IDs with normalized content and duplicate occurrence", () => {
    const first = projectTodoSnapshot(initialProgressProjectionState(), {
      sessionId: "session-1",
      eventId: "event-1",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
      todos: [
        { content: "Write tests", priority: "high", status: "in_progress" },
        { content: "Write tests", priority: "low", status: "pending" },
        { content: "Build package", priority: "medium", status: "pending" },
      ],
    });
    const [firstTest, secondTest, build] = first.state.tasks;

    const reordered = projectTodoSnapshot(first.state, {
      sessionId: "session-1",
      eventId: "event-2",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-1",
      todos: [
        { content: "Build package", priority: "medium", status: "in_progress" },
        { content: "  WRITE   tests ", priority: "high", status: "completed" },
        { content: "Write tests", priority: "low", status: "pending" },
      ],
    });

    expect(reordered.state.tasks.map((task) => task.id)).toEqual([
      build?.id,
      firstTest?.id,
      secondTest?.id,
    ]);
    expect(reordered.state.tasks[1]?.title).toBe("WRITE tests");
  });

  it("allocates a new ID for a rename and ignores semantic retries", () => {
    const first = projectTodoSnapshot(initialProgressProjectionState(), {
      sessionId: "session-1",
      eventId: "event-1",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
      todos: [{ content: "Old title", priority: "high", status: "in_progress" }],
    });
    const renamed = projectTodoSnapshot(first.state, {
      sessionId: "session-1",
      eventId: "event-2",
      sequence: 0,
      stepIndex: 1,
      turnId: "turn-1",
      todos: [{ content: "New title", priority: "high", status: "in_progress" }],
    });
    const retry = projectTodoSnapshot(renamed.state, {
      sessionId: "session-1",
      eventId: "event-3",
      sequence: 0,
      stepIndex: 2,
      turnId: "turn-1",
      todos: [{ content: "New title", priority: "high", status: "in_progress" }],
    });

    expect(renamed.state.tasks[0]?.id).not.toBe(first.state.tasks[0]?.id);
    expect(retry.changed).toBe(false);
    expect(retry.state.revision).toBe(renamed.state.revision);
    expect(retry.state.lastEventId).toBe("event-3");
  });

  it("projects lifecycle independently from authoritative todo status", () => {
    const initial = initialProgressProjectionState();
    const failed = projectLifecycle(initial, "failed");

    expect(failed.changed).toBe(true);
    expect(failed.state.lifecycle).toBe("failed");
    expect(failed.state.revision).toBe(1);
    expect(projectLifecycle(failed.state, "failed").changed).toBe(false);
  });

  it("validates the exact full todo output shape", () => {
    expect(
      parseTodoOutput({
        counts,
        todos: [{ content: "Test", priority: "high", status: "in_progress" }],
      }),
    ).not.toBeNull();
    expect(parseTodoOutput({ counts, todos: [], extra: true })).toBeNull();
    expect(parseTodoOutput("not json")).toBeNull();
  });
});
