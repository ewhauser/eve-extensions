import type { SlackBotToken } from "eve/channels/slack";

export type ProgressTaskPriority = "high" | "medium" | "low";
export type ProgressTaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type ProgressLifecycleStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProgressTask {
  readonly id: string;
  readonly title: string;
  readonly priority: ProgressTaskPriority;
  readonly status: ProgressTaskStatus;
}

export interface ProgressSource {
  readonly kind: "eve.todo";
  readonly eventId: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface ProgressAgentIdentity {
  readonly name: string;
  readonly nodeId?: string;
}

export interface ProgressParentIdentity {
  readonly callId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnSequence: number;
}

export interface ProgressPublicationContext {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly agent: ProgressAgentIdentity;
  readonly parent?: ProgressParentIdentity;
  readonly channel: {
    readonly kind?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

export interface AgentProgressSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly agent: ProgressAgentIdentity;
  readonly parent?: ProgressParentIdentity;
  readonly lifecycle: ProgressLifecycleStatus;
  readonly tasks: readonly ProgressTask[];
  readonly source?: ProgressSource;
}

export interface ProgressPublisher {
  /** Capture any transport binding visible on a lifecycle event. */
  bind?(context: ProgressPublicationContext): void | Promise<void>;
  /** Materialize one complete, transport-neutral agent progress snapshot. */
  publish(
    snapshot: AgentProgressSnapshot,
    context: ProgressPublicationContext,
  ): void | Promise<void>;
}

export type ProgressFailurePhase = "bind" | "publish";

export interface ProgressPublishFailure {
  readonly error: unknown;
  readonly phase: ProgressFailurePhase;
  readonly context: ProgressPublicationContext;
  readonly snapshot?: AgentProgressSnapshot;
}

export type ProgressErrorCallback = (
  failure: ProgressPublishFailure,
) => void | Promise<void>;

export interface ProgressRootBinding {
  readonly rootSessionId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly teamId?: string;
}

export interface ProgressSurface {
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly revision: number;
  readonly fingerprint: string;
}

/**
 * Durable application-owned state for Slack routing and message ownership.
 * Production implementations should make writes linearizable per key.
 */
export interface ProgressSurfaceStore {
  getRoot(rootSessionId: string): Promise<ProgressRootBinding | null>;
  putRoot(binding: ProgressRootBinding): Promise<void>;
  getSurface(rootSessionId: string, sessionId: string): Promise<ProgressSurface | null>;
  putSurface(surface: ProgressSurface): Promise<void>;
}

export interface SlackProgressApiInput {
  readonly botToken: SlackBotToken | undefined;
  readonly operation: "chat.postMessage" | "chat.update";
  readonly body: Readonly<Record<string, unknown>>;
}

export interface SlackProgressApiResponse extends Readonly<Record<string, unknown>> {
  readonly ok?: boolean;
  readonly error?: string;
  readonly ts?: string;
}

export type SlackProgressApi = (
  input: SlackProgressApiInput,
) => Promise<SlackProgressApiResponse>;

export type SlackProgressTokenResolver = (
  binding: ProgressRootBinding,
) => SlackBotToken | Promise<SlackBotToken>;

export interface SlackProgressPublisherOptions {
  readonly store: ProgressSurfaceStore;
  readonly botToken?: SlackBotToken;
  readonly resolveBotToken?: SlackProgressTokenResolver;
  readonly api?: SlackProgressApi;
  readonly maxTasks?: number;
  readonly title?:
    | string
    | ((snapshot: AgentProgressSnapshot, context: ProgressPublicationContext) => string);
}
