import { randomUUID } from "node:crypto";

import {
  createProjectContextCard,
  type ProjectContextInput,
} from "./context.js";
import type {
  ProjectBinding,
  ProjectChannel,
  ProjectContextCard,
  ProjectLinkContext,
  ProjectLinkLogger,
  ProjectLinkStore,
  ProjectProvider,
} from "./types.js";

export interface ProjectLinkServiceOptions {
  readonly store: ProjectLinkStore;
  readonly providers: readonly ProjectProvider[];
  readonly defaultProvider: string;
  readonly logger?: ProjectLinkLogger;
  readonly now?: () => Date;
  readonly provisioningTimeoutMs?: number;
}

export interface LinkProjectInput {
  readonly title: string;
  readonly provider?: string;
  readonly channelUrl?: string;
}

export interface LinkProjectResult {
  readonly binding: ProjectBinding;
  readonly created: boolean;
  readonly pending: boolean;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

export class ProjectLinkService {
  readonly #defaultProvider: string;
  readonly #logger: ProjectLinkLogger;
  readonly #now: () => Date;
  readonly #providers: ReadonlyMap<string, ProjectProvider>;
  readonly #provisioningTimeoutMs: number;
  readonly #store: ProjectLinkStore;

  constructor(options: ProjectLinkServiceOptions) {
    this.#store = options.store;
    this.#defaultProvider = options.defaultProvider;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? (() => new Date());
    this.#provisioningTimeoutMs = options.provisioningTimeoutMs ?? 120_000;
    if (this.#provisioningTimeoutMs < 1_000) {
      throw new Error("provisioningTimeoutMs must be at least 1000.");
    }

    const providers = new Map<string, ProjectProvider>();
    for (const provider of options.providers) {
      if (providers.has(provider.kind)) {
        throw new Error(`Duplicate project provider kind: ${provider.kind}`);
      }
      providers.set(provider.kind, provider);
    }
    if (!providers.has(this.#defaultProvider)) {
      throw new Error(
        `defaultProvider ${this.#defaultProvider} is not present in providers.`,
      );
    }
    this.#providers = providers;
  }

  async status(channel: ProjectChannel): Promise<ProjectBinding | null> {
    return this.#store.get(channel);
  }

  async link(
    channel: ProjectChannel,
    input: LinkProjectInput,
    ctx: ProjectLinkContext,
  ): Promise<LinkProjectResult> {
    const requestedProvider = input.provider ?? this.#defaultProvider;
    const provider = this.#provider(requestedProvider);
    let binding = await this.#store.get(channel);
    let created = false;

    if (binding) {
      if (binding.provider !== requestedProvider) {
        throw new Error(
          `This channel is already reserved for provider ${binding.provider}; unlink it before switching to ${requestedProvider}.`,
        );
      }
      if (binding.status === "active") {
        return { binding, created: false, pending: false };
      }
      if (binding.status === "provisioning") {
        const updatedAt = Date.parse(binding.updatedAt);
        const age = this.#now().getTime() - updatedAt;
        if (Number.isFinite(age) && age < this.#provisioningTimeoutMs) {
          return { binding, created: false, pending: true };
        }
      }

      // Claim an error retry or expired provisioning lease with CAS before
      // touching the provider. This keeps recovery from creating two pages.
      const claimed: ProjectBinding = {
        ...binding,
        title: input.title,
        status: "provisioning",
        updatedAt: this.#now().toISOString(),
        revision: binding.revision + 1,
      };
      delete (claimed as { lastError?: string }).lastError;
      if (!(await this.#store.replace(claimed, binding.revision))) {
        const winner = await this.#store.get(channel);
        if (!winner) throw new Error("Project binding recovery raced and disappeared.");
        return {
          binding: winner,
          created: false,
          pending: winner.status === "provisioning",
        };
      }
      binding = claimed;
    } else {
      const now = this.#now().toISOString();
      binding = {
        id: randomUUID(),
        channel,
        provider: requestedProvider,
        title: input.title,
        status: "provisioning",
        createdAt: now,
        updatedAt: now,
        revision: 0,
      };
      created = await this.#store.create(binding);
      if (!created) {
        const winner = await this.#store.get(channel);
        if (!winner) throw new Error("Project binding creation raced and disappeared.");
        return {
          binding: winner,
          created: false,
          pending: winner.status === "provisioning",
        };
      }
    }

    // `error` bindings deliberately retain the stable binding ID. The Notion
    // provider queries that ID before creating, making an explicit retry safe.
    try {
      const externalProject = await provider.createProject(
        {
          bindingId: binding.id,
          channel,
          title: input.title,
          ...(input.channelUrl === undefined ? {} : { channelUrl: input.channelUrl }),
        },
        ctx,
      );
      const active: ProjectBinding = {
        ...binding,
        title: input.title,
        status: "active",
        externalProject,
        updatedAt: this.#now().toISOString(),
        revision: binding.revision + 1,
      };
      delete (active as { lastError?: string }).lastError;
      if (!(await this.#store.replace(active, binding.revision))) {
        const current = await this.#store.get(channel);
        if (current?.status === "active") {
          return { binding: current, created, pending: false };
        }
        throw new Error("Project binding changed while the external project was created.");
      }
      return { binding: active, created, pending: false };
    } catch (error) {
      const failed: ProjectBinding = {
        ...binding,
        status: "error",
        lastError: errorMessage(error),
        updatedAt: this.#now().toISOString(),
        revision: binding.revision + 1,
      };
      if (!(await this.#store.replace(failed, binding.revision))) {
        this.#logger.warn("Could not persist the failed project-link status after a concurrent update.");
      }
      throw error;
    }
  }

  async saveContext(
    channel: ProjectChannel,
    input: ProjectContextInput,
    ctx: ProjectLinkContext,
  ): Promise<ProjectBinding> {
    const context = createProjectContextCard(input, this.#now().toISOString());
    const current = await this.#requireActive(channel);
    await this.#provider(current.provider).writeContext(
      current.externalProject,
      context,
      ctx,
    );
    return this.#storeContext(channel, context);
  }

  async refresh(
    channel: ProjectChannel,
    ctx: ProjectLinkContext,
  ): Promise<ProjectBinding> {
    const current = await this.#requireActive(channel);
    const context = await this.#provider(current.provider).readContext(
      current.externalProject,
      ctx,
    );
    if (!context) {
      throw new Error(
        "The external project does not have a context card yet. Curate the channel and call save_context first.",
      );
    }
    return this.#storeContext(channel, context);
  }

  /** Delete only the channel binding. The provider project is intentionally retained. */
  async unlink(channel: ProjectChannel): Promise<ProjectBinding | null> {
    const binding = await this.#store.get(channel);
    if (!binding) return null;
    if (!(await this.#store.delete(channel, binding.revision))) {
      throw new Error("Project binding changed while it was being unlinked; retry.");
    }
    return binding;
  }

  #provider(kind: string): ProjectProvider {
    const provider = this.#providers.get(kind);
    if (!provider) throw new Error(`Unknown project provider: ${kind}`);
    return provider;
  }

  async #requireActive(channel: ProjectChannel): Promise<
    ProjectBinding & { readonly externalProject: NonNullable<ProjectBinding["externalProject"]> }
  > {
    const binding = await this.#store.get(channel);
    if (!binding) throw new Error("This channel is not linked to a project.");
    if (binding.status !== "active" || !binding.externalProject) {
      throw new Error(`This channel's project binding is ${binding.status}.`);
    }
    return binding as ProjectBinding & {
      readonly externalProject: NonNullable<ProjectBinding["externalProject"]>;
    };
  }

  async #storeContext(
    channel: ProjectChannel,
    context: ProjectContextCard,
  ): Promise<ProjectBinding> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.#requireActive(channel);
      const updated: ProjectBinding = {
        ...current,
        context,
        updatedAt: this.#now().toISOString(),
        revision: current.revision + 1,
      };
      if (await this.#store.replace(updated, current.revision)) return updated;
    }
    throw new Error("Project context changed repeatedly while it was being saved; retry.");
  }
}
