import type {
  ProgressRootBinding,
  ProgressSurface,
  ProgressSurfaceStore,
} from "../lib/types.js";

function surfaceKey(rootSessionId: string, sessionId: string): string {
  return `${rootSessionId}\u0000${sessionId}`;
}

/** Process-local store for tests and development. It is not a production store. */
export function createMemoryProgressSurfaceStore(): ProgressSurfaceStore {
  const roots = new Map<string, ProgressRootBinding>();
  const surfaces = new Map<string, ProgressSurface>();
  return {
    async getRoot(rootSessionId) {
      return roots.get(rootSessionId) ?? null;
    },
    async putRoot(binding) {
      roots.set(binding.rootSessionId, Object.freeze({ ...binding }));
    },
    async getSurface(rootSessionId, sessionId) {
      return surfaces.get(surfaceKey(rootSessionId, sessionId)) ?? null;
    },
    async putSurface(surface) {
      surfaces.set(
        surfaceKey(surface.rootSessionId, surface.sessionId),
        Object.freeze({ ...surface }),
      );
    },
  };
}
