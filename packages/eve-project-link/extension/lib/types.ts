import type { DynamicResolveContext } from "eve/tools";

export interface ProjectChannel {
  /** Eve channel kind, for example `slack`. */
  readonly kind: string;
  /** Provider-owned workspace or tenant identifier, for example a Slack team ID. */
  readonly workspaceId: string;
  /** Provider-owned channel identifier. Threads intentionally share this identity. */
  readonly channelId: string;
}

export type ProjectLinkContext = Pick<DynamicResolveContext, "session">;

export interface ProjectPerson {
  readonly name: string;
  readonly role?: string | undefined;
  readonly url?: string | undefined;
}

export interface ProjectDecision {
  readonly summary: string;
  readonly rationale?: string | undefined;
  readonly decidedAt?: string | undefined;
  readonly sourceUrl?: string | undefined;
}

export interface ProjectMilestone {
  readonly title: string;
  readonly dueAt?: string | undefined;
  readonly status?: string | undefined;
  readonly url?: string | undefined;
}

export interface ProjectMeeting {
  readonly title: string;
  readonly startsAt?: string | undefined;
  readonly attendees?: readonly string[] | undefined;
  readonly url?: string | undefined;
}

export interface ProjectSource {
  readonly title: string;
  readonly url: string;
  readonly description?: string | undefined;
}

/** Compact, provider-neutral context injected into every linked-channel turn. */
export interface ProjectContextCard {
  readonly summary: string;
  readonly status?: string | undefined;
  readonly principals: readonly ProjectPerson[];
  readonly decisions: readonly ProjectDecision[];
  readonly milestones: readonly ProjectMilestone[];
  readonly upcomingMeetings: readonly ProjectMeeting[];
  readonly sources: readonly ProjectSource[];
  readonly openQuestions: readonly string[];
  readonly nextSteps: readonly string[];
  readonly generatedAt: string;
}

export interface ExternalProject {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  /** Provider-private, JSON-safe data carried with the binding. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export type ProjectBindingStatus = "provisioning" | "active" | "error";

export interface ProjectBinding {
  /** Stable idempotency key shared with the external provider. */
  readonly id: string;
  readonly channel: ProjectChannel;
  readonly provider: string;
  readonly title: string;
  readonly status: ProjectBindingStatus;
  readonly externalProject?: ExternalProject | undefined;
  readonly context?: ProjectContextCard | undefined;
  readonly lastError?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Monotonic revision used for compare-and-swap updates. */
  readonly revision: number;
}

/**
 * Durable channel-binding store. `create`, `replace`, and `delete` must be
 * atomic so multiple Eve invocations cannot create competing bindings.
 */
export interface ProjectLinkStore {
  get(channel: ProjectChannel): Promise<ProjectBinding | null>;
  create(binding: ProjectBinding): Promise<boolean>;
  replace(binding: ProjectBinding, expectedRevision: number): Promise<boolean>;
  delete(channel: ProjectChannel, expectedRevision: number): Promise<boolean>;
}

export interface CreateExternalProjectInput {
  readonly bindingId: string;
  readonly channel: ProjectChannel;
  readonly title: string;
  readonly channelUrl?: string | undefined;
}

export interface ProjectProvider {
  readonly kind: string;
  /** Must be idempotent for a stable `bindingId`. */
  createProject(
    input: CreateExternalProjectInput,
    ctx: ProjectLinkContext,
  ): Promise<ExternalProject>;
  readContext(
    project: ExternalProject,
    ctx: ProjectLinkContext,
  ): Promise<ProjectContextCard | null>;
  writeContext(
    project: ExternalProject,
    context: ProjectContextCard,
    ctx: ProjectLinkContext,
  ): Promise<void>;
}

export type ProjectChannelResolver = (
  ctx: DynamicResolveContext,
) => ProjectChannel | null | Promise<ProjectChannel | null>;

export interface ProjectLinkLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface ProjectLinkApprovals {
  /** Creating an external project page. Defaults to true. */
  readonly link?: boolean | undefined;
  /** Writing a curated context card. Defaults to false. */
  readonly saveContext?: boolean | undefined;
  /** Removing the channel binding (the external project is retained). Defaults to true. */
  readonly unlink?: boolean | undefined;
}
