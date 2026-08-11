import type { DynamicResolveContext } from "eve/tools";

export interface ProjectChannel {
  /** Eve channel kind, for example `slack`. */
  readonly kind: string;
  /** Channel-provider workspace or tenant identifier, for example a Slack team ID. */
  readonly workspaceId: string;
  /** Channel-provider channel identifier. Threads intentionally share this identity. */
  readonly channelId: string;
}

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

/** Compact, system-neutral context injected into every linked-channel turn. */
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

/**
 * Non-authoritative hints that help the model find tools already mounted by
 * the consuming agent. They never register a connection or carry credentials.
 */
export interface ProjectToolHints {
  /** Likely Eve connection names, for example `notion` or `linear`. */
  readonly connectionNames?: readonly string[] | undefined;
  /** Exact custom or already-known qualified tool names, when stable. */
  readonly toolNames?: readonly string[] | undefined;
  /** Semantic queries to use with the agent's tool-discovery mechanism. */
  readonly discoveryQueries?: readonly string[] | undefined;
}

export type ProjectOperation = "locate" | "create" | "retrieve" | "update";

/** Provider-specific guidance. Core lifecycle and safety rules are added later. */
export interface ProjectOperationGuidance {
  readonly locate: readonly string[];
  readonly create?: readonly string[] | undefined;
  readonly retrieve: readonly string[];
  readonly update?: readonly string[] | undefined;
}

export interface ProjectPresetSystem {
  readonly kind: string;
  readonly name: string;
  readonly description: string;
}

/**
 * A configured instance of a reusable project preset. This is plain data: it
 * contains no credentials, provider client, or executable tool callback.
 */
export interface ProjectPreset {
  /** Installation-local id selected by project_link__link. */
  readonly id: string;
  /** Versioned reusable definition, for example `notion/project-hub@1`. */
  readonly presetKey: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly system: ProjectPresetSystem;
  readonly resourceLabel: string;
  readonly toolHints?: ProjectToolHints | undefined;
  readonly operations: ProjectOperationGuidance;
  /** Non-secret, model-visible identifiers or references used by this preset. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/** A resource created or selected through tools already available to the agent. */
export interface ProjectResource {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  /** System-private, JSON-safe data carried with the binding. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export type ProjectBindingStatus = "pending" | "active";

export interface ProjectBinding {
  /** Stable idempotency key to place in the external resource when possible. */
  readonly id: string;
  readonly channel: ProjectChannel;
  /** Configured preset instance used to operate on the external resource. */
  readonly presetId: string;
  readonly title: string;
  readonly channelUrl?: string | undefined;
  readonly status: ProjectBindingStatus;
  readonly resource?: ProjectResource | undefined;
  readonly context?: ProjectContextCard | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Monotonic revision used for compare-and-swap updates. */
  readonly revision: number;
}

/** Model-facing plan for performing external work with already-mounted tools. */
export interface ProjectLinkPlan {
  readonly bindingId: string;
  readonly channel: ProjectChannel;
  readonly channelUrl?: string | undefined;
  readonly title: string;
  readonly presetId: string;
  readonly presetKey: string;
  readonly presetName: string;
  readonly presetDescription?: string | undefined;
  readonly system: string;
  readonly systemName: string;
  readonly systemDescription: string;
  readonly resourceLabel: string;
  readonly toolHints?: ProjectToolHints | undefined;
  readonly provisioningInstructions: string;
  readonly retrievalInstructions: string;
  readonly updateInstructions?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
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

export type ProjectChannelResolver = (
  ctx: DynamicResolveContext,
) => ProjectChannel | null | Promise<ProjectChannel | null>;

export interface ProjectLinkApprovals {
  /** Reserving a new channel link. Defaults to true. */
  readonly link?: boolean | undefined;
  /** Updating the channel's cached context card. Defaults to false. */
  readonly saveContext?: boolean | undefined;
  /** Removing the binding (the external resource is retained). Defaults to true. */
  readonly unlink?: boolean | undefined;
}
