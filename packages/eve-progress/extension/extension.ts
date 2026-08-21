import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { ProgressErrorCallback, ProgressPublisher } from "./lib/types.js";

function hasMethod(value: unknown, method: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[method] === "function"
  );
}

const publisherSchema = z.custom<ProgressPublisher>(
  (value) => hasMethod(value, "publish"),
  { message: "publisher must provide publish(snapshot, context)." },
);

const onErrorSchema = z.custom<ProgressErrorCallback>(
  (value) => typeof value === "function",
  { message: "onError must be a function." },
);

const config = z
  .object({
    publisher: publisherSchema,
    onError: onErrorSchema.optional(),
  })
  .strict();

export type EveProgressConfig = z.output<typeof config>;

// Distribution entry points can be evaluated in separate authored-module
// graphs. Pin the namespace so every handle resolves the same configuration.
const extension = defineExtension({ config }, "eve-progress");

export function getEveProgressConfig(): EveProgressConfig {
  return extension.config;
}

export default extension;
export { createSlackProgressPublisher, renderSlackProgress } from "./slack.js";
export { createMemoryProgressSurfaceStore } from "./stores/memory.js";
export {
  initialProgressProjectionState,
  normalizeTaskTitle,
  parseTodoOutput,
  projectLifecycle,
  projectTodoSnapshot,
  toProgressSnapshot,
} from "./lib/projection.js";
export type {
  AgentProgressSnapshot,
  ProgressAgentIdentity,
  ProgressErrorCallback,
  ProgressFailurePhase,
  ProgressLifecycleStatus,
  ProgressParentIdentity,
  ProgressPublicationContext,
  ProgressPublisher,
  ProgressPublishFailure,
  ProgressRootBinding,
  ProgressSurface,
  ProgressSurfaceStore,
  ProgressTask,
  ProgressTaskPriority,
  ProgressTaskStatus,
  SlackProgressApi,
  SlackProgressApiInput,
  SlackProgressApiResponse,
  SlackProgressPublisherOptions,
  SlackProgressTokenResolver,
} from "./lib/types.js";
