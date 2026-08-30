import type { HookContext, HookEvent } from "eve/hooks";
import type { DynamicResolveContext } from "eve/tools";

import { getEveProgressConfig } from "../extension.js";
import {
  parseTodoOutput,
  projectLifecycle,
  projectTodoSnapshot,
  toProgressSnapshot,
  type ProgressProjectionResult,
} from "./projection.js";
import {
  progressProjectionState,
  progressPublicationChannelState,
} from "./state.js";
import type {
  AgentProgressSnapshot,
  ProgressLifecycleStatus,
  ProgressPublicationContext,
  ProgressPublishFailure,
} from "./types.js";

export function publicationContext(ctx: HookContext): ProgressPublicationContext {
  const parent = ctx.session.parent;
  const capturedChannel = progressPublicationChannelState.get();
  return {
    sessionId: ctx.session.id,
    rootSessionId: parent?.rootSessionId ?? ctx.session.id,
    agent: {
      name: ctx.agent.name,
      ...(ctx.agent.nodeId === undefined ? {} : { nodeId: ctx.agent.nodeId }),
    },
    ...(parent === undefined
      ? {}
      : {
          parent: {
            callId: parent.callId,
            sessionId: parent.sessionId,
            turnId: parent.turn.id,
            turnSequence: parent.turn.sequence,
          },
        }),
    channel: {
      ...(ctx.channel.kind === undefined && capturedChannel.kind === undefined
        ? {}
        : { kind: ctx.channel.kind ?? capturedChannel.kind }),
      ...(ctx.channel.continuationToken === undefined &&
      capturedChannel.continuationToken === undefined
        ? {}
        : {
            continuationToken:
              ctx.channel.continuationToken ?? capturedChannel.continuationToken,
          }),
      ...(capturedChannel.metadata === undefined
        ? {}
        : { metadata: capturedChannel.metadata }),
    },
  };
}

/** Capture metadata from Eve's resolver context before hook dispatch drops it. */
export function capturePublicationChannel(ctx: DynamicResolveContext): void {
  progressPublicationChannelState.update(() => ({
    ...(ctx.channel.kind === undefined ? {} : { kind: ctx.channel.kind }),
    ...(ctx.channel.continuationToken === undefined
      ? {}
      : { continuationToken: ctx.channel.continuationToken }),
    ...(ctx.channel.metadata === undefined
      ? {}
      : { metadata: ctx.channel.metadata }),
  }));
}

async function reportFailure(failure: ProgressPublishFailure): Promise<void> {
  const callback = getEveProgressConfig().onError;
  if (callback === undefined) return;
  try {
    await callback(failure);
  } catch {
    // Progress is observational. Telemetry failures must not fail the agent.
  }
}

async function bind(context: ProgressPublicationContext): Promise<void> {
  const publisher = getEveProgressConfig().publisher;
  if (publisher.bind === undefined) return;
  try {
    await publisher.bind(context);
  } catch (error) {
    await reportFailure({ error, phase: "bind", context });
  }
}

async function publish(
  snapshot: AgentProgressSnapshot,
  context: ProgressPublicationContext,
): Promise<void> {
  try {
    await getEveProgressConfig().publisher.publish(snapshot, context);
  } catch (error) {
    await reportFailure({ error, phase: "publish", context, snapshot });
  }
}

async function applyAndPublish(
  result: ProgressProjectionResult,
  context: ProgressPublicationContext,
  retryUnchanged = false,
): Promise<void> {
  progressProjectionState.update(() => result.state);
  if (result.changed || (retryUnchanged && result.state.tasks.length > 0)) {
    await publish(toProgressSnapshot(result.state, context), context);
  }
}

export async function handleTurnStarted(ctx: HookContext): Promise<void> {
  const context = publicationContext(ctx);
  await bind(context);
  await applyAndPublish(
    projectLifecycle(progressProjectionState.get(), "running"),
    context,
    true,
  );
}

export async function handleLifecycle(
  lifecycle: ProgressLifecycleStatus,
  ctx: HookContext,
): Promise<void> {
  const context = publicationContext(ctx);
  await bind(context);
  await applyAndPublish(projectLifecycle(progressProjectionState.get(), lifecycle), context);
}

export async function handleActionResult(
  event: HookEvent<"action.result">,
  ctx: HookContext,
): Promise<void> {
  const result = event.data.result;
  if (
    event.data.status !== "completed" ||
    result.kind !== "tool-result" ||
    result.toolName !== "todo"
  ) {
    return;
  }
  const output = parseTodoOutput(result.output);
  const context = publicationContext(ctx);
  if (output === null) {
    await reportFailure({
      error: new Error("Completed todo result did not match Eve's todo output schema."),
      phase: "parse",
      context,
    });
    return;
  }

  await bind(context);
  await applyAndPublish(
    projectTodoSnapshot(progressProjectionState.get(), {
      sessionId: ctx.session.id,
      eventId: event.meta.id,
      sequence: event.data.sequence,
      stepIndex: event.data.stepIndex,
      turnId: event.data.turnId,
      todos: output.todos,
    }),
    context,
    true,
  );
}
