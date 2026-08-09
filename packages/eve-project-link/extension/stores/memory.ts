import { projectChannelKey } from "../lib/channel.js";
import type {
  ProjectBinding,
  ProjectChannel,
  ProjectLinkStore,
} from "../lib/types.js";

/**
 * Process-local store for tests and local development. Production deployments
 * should implement `ProjectLinkStore` over a durable, shared database or KV.
 */
export function createMemoryProjectLinkStore(
  initial: readonly ProjectBinding[] = [],
): ProjectLinkStore {
  const bindings = new Map(initial.map((binding) => [projectChannelKey(binding.channel), binding]));

  return {
    async get(channel: ProjectChannel) {
      return bindings.get(projectChannelKey(channel)) ?? null;
    },
    async create(binding: ProjectBinding) {
      const key = projectChannelKey(binding.channel);
      if (bindings.has(key)) return false;
      bindings.set(key, binding);
      return true;
    },
    async replace(binding: ProjectBinding, expectedRevision: number) {
      const key = projectChannelKey(binding.channel);
      const current = bindings.get(key);
      if (!current || current.revision !== expectedRevision) return false;
      bindings.set(key, binding);
      return true;
    },
    async delete(channel: ProjectChannel, expectedRevision: number) {
      const key = projectChannelKey(channel);
      const current = bindings.get(key);
      if (!current || current.revision !== expectedRevision) return false;
      return bindings.delete(key);
    },
  };
}

export default createMemoryProjectLinkStore;
