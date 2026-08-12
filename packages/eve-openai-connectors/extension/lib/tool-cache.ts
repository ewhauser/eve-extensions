import { BoundedTtlCache } from "./cache.js";

const ownerIds = new WeakMap<object, number>();
let nextOwnerId = 1;

// Tool-definition records contain only immutable catalog references and
// connector-scoped execution/policy closures. Keep them process-wide so every
// principal on one connector instance reuses the same definitions, while the
// owner id prevents policies or execution clients from aliasing across
// differently configured connector instances.
const deferredToolCache = new BoundedTtlCache<object>({
  ttlMs: 15 * 60_000,
  maxEntries: 256,
  maxEstimatedBytes: 64 * 1024 * 1024,
  registerMetrics: true,
});

function ownerId(owner: object): number {
  const existing = ownerIds.get(owner);
  if (existing !== undefined) return existing;
  const id = nextOwnerId++;
  ownerIds.set(owner, id);
  return id;
}

export function getOrCreateDeferredToolSet<T extends object>(
  owner: object,
  catalogFingerprint: string,
  toolCount: number,
  create: () => T,
): T {
  // Descriptors and schemas are accounted for by the catalog cache. This is
  // an estimate for the record, branded definitions, and execution closures.
  const estimatedBytes = 256 + toolCount * 384;
  return deferredToolCache.getOrCreate(
    `${ownerId(owner)}:${catalogFingerprint}`,
    estimatedBytes,
    create,
  ) as T;
}
