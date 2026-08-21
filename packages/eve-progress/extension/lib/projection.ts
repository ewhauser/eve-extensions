import { z } from "zod";

import type {
  AgentProgressSnapshot,
  ProgressLifecycleStatus,
  ProgressPublicationContext,
  ProgressSource,
  ProgressTask,
  ProgressTaskPriority,
  ProgressTaskStatus,
} from "./types.js";

const todoItemSchema = z
  .object({
    content: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  })
  .strict();

export const todoOutputSchema = z
  .object({
    counts: z
      .object({
        cancelled: z.number(),
        completed: z.number(),
        in_progress: z.number(),
        pending: z.number(),
        total: z.number(),
      })
      .strict(),
    todos: z.array(todoItemSchema),
  })
  .strict();

export type TodoOutput = z.output<typeof todoOutputSchema>;

export interface ProgressProjectionState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly nextTaskSequence: number;
  readonly lastEventId?: string;
  readonly lifecycle: ProgressLifecycleStatus;
  readonly tasks: readonly ProgressTask[];
  readonly source?: ProgressSource;
}

export interface ProgressProjectionResult {
  readonly changed: boolean;
  readonly state: ProgressProjectionState;
}

export function initialProgressProjectionState(): ProgressProjectionState {
  return {
    schemaVersion: 1,
    revision: 0,
    nextTaskSequence: 1,
    lifecycle: "waiting",
    tasks: [],
  };
}

export function parseTodoOutput(value: unknown): TodoOutput | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = todoOutputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function normalizeTaskTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function hashSessionId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function taskId(sessionId: string, sequence: number): string {
  return `eve-${hashSessionId(sessionId)}-${sequence.toString(36)}`;
}

function sameTask(left: ProgressTask, right: ProgressTask): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.priority === right.priority &&
    left.status === right.status
  );
}

function sameTasks(left: readonly ProgressTask[], right: readonly ProgressTask[]): boolean {
  return left.length === right.length && left.every((task, index) => sameTask(task, right[index]!));
}

/**
 * Projects one full Eve todo snapshot. IDs are owned here, not in Eve's todo
 * schema. Equal normalized titles are matched by duplicate occurrence; a real
 * rename removes the old task and allocates a new ID.
 */
export function projectTodoSnapshot(
  current: ProgressProjectionState,
  input: {
    readonly sessionId: string;
    readonly eventId: string;
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
    readonly todos: readonly {
      readonly content: string;
      readonly priority: ProgressTaskPriority;
      readonly status: ProgressTaskStatus;
    }[];
  },
): ProgressProjectionResult {
  if (current.lastEventId === input.eventId) return { changed: false, state: current };

  const priorByTitle = new Map<string, ProgressTask[]>();
  for (const task of current.tasks) {
    const key = normalizeTaskTitle(task.title);
    const bucket = priorByTitle.get(key);
    if (bucket === undefined) priorByTitle.set(key, [task]);
    else bucket.push(task);
  }

  let nextTaskSequence = current.nextTaskSequence;
  const tasks = input.todos.map((todo): ProgressTask => {
    const key = normalizeTaskTitle(todo.content);
    const prior = priorByTitle.get(key)?.shift();
    const id = prior?.id ?? taskId(input.sessionId, nextTaskSequence++);
    return {
      id,
      title: todo.content.trim().replace(/\s+/g, " "),
      priority: todo.priority,
      status: todo.status,
    };
  });
  const source: ProgressSource = {
    kind: "eve.todo",
    eventId: input.eventId,
    sequence: input.sequence,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  };
  const changed = !sameTasks(current.tasks, tasks);

  return {
    changed,
    state: {
      ...current,
      revision: changed ? current.revision + 1 : current.revision,
      nextTaskSequence,
      lastEventId: input.eventId,
      tasks,
      source,
    },
  };
}

export function projectLifecycle(
  current: ProgressProjectionState,
  lifecycle: ProgressLifecycleStatus,
): ProgressProjectionResult {
  if (current.lifecycle === lifecycle) return { changed: false, state: current };
  return {
    changed: true,
    state: {
      ...current,
      lifecycle,
      revision: current.revision + 1,
    },
  };
}

export function toProgressSnapshot(
  state: ProgressProjectionState,
  context: ProgressPublicationContext,
): AgentProgressSnapshot {
  return {
    schemaVersion: 1,
    revision: state.revision,
    sessionId: context.sessionId,
    rootSessionId: context.rootSessionId,
    agent: context.agent,
    ...(context.parent === undefined ? {} : { parent: context.parent }),
    lifecycle: state.lifecycle,
    tasks: state.tasks,
    ...(state.source === undefined ? {} : { source: state.source }),
  };
}
