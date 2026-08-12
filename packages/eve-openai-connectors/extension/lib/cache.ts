export interface CacheMetrics {
  hits: number;
  misses: number;
  entries: number;
  estimatedBytes: number;
  evictions: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  estimatedBytes: number;
}

interface BoundedTtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxEstimatedBytes: number;
  /** Shared connector caches register themselves for aggregate metrics. */
  registerMetrics?: boolean;
}

interface MetricsSource {
  metrics(): CacheMetrics;
}

const metricsSources = new Set<MetricsSource>();

/**
 * A small LRU/TTL cache with deterministic size accounting. Values larger
 * than the byte budget are returned but never retained.
 */
export class BoundedTtlCache<T> implements MetricsSource {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private estimatedBytes = 0;

  constructor(private readonly options: BoundedTtlCacheOptions) {
    if (
      !Number.isFinite(options.ttlMs) ||
      options.ttlMs <= 0 ||
      !Number.isInteger(options.maxEntries) ||
      options.maxEntries <= 0 ||
      !Number.isFinite(options.maxEstimatedBytes) ||
      options.maxEstimatedBytes <= 0
    ) {
      throw new Error("BoundedTtlCache limits must be positive finite values.");
    }
    if (options.registerMetrics ?? false) metricsSources.add(this);
  }

  getOrCreate(key: string, estimatedBytes: number, create: () => T): T {
    const now = Date.now();
    this.pruneExpired(now);
    const existing = this.entries.get(key);
    if (existing) {
      this.hits++;
      existing.expiresAt = now + this.options.ttlMs;
      // Refresh insertion order so the first entry remains the LRU.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.value;
    }

    this.misses++;
    const value = create();
    const boundedEstimate = Math.max(0, Math.ceil(estimatedBytes));
    if (boundedEstimate > this.options.maxEstimatedBytes) return value;

    this.entries.set(key, {
      value,
      expiresAt: now + this.options.ttlMs,
      estimatedBytes: boundedEstimate,
    });
    this.estimatedBytes += boundedEstimate;
    this.enforceLimits();
    return value;
  }

  metrics(): CacheMetrics {
    this.pruneExpired(Date.now());
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      estimatedBytes: this.estimatedBytes,
      evictions: this.evictions,
    };
  }

  private enforceLimits(): void {
    while (
      this.entries.size > this.options.maxEntries ||
      this.estimatedBytes > this.options.maxEstimatedBytes
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.estimatedBytes -= entry.estimatedBytes;
    this.evictions++;
  }
}

/** Aggregate process-wide metrics only; no principal, token, or schema labels. */
export function getConnectorCacheMetrics(): CacheMetrics {
  const aggregate: CacheMetrics = {
    hits: 0,
    misses: 0,
    entries: 0,
    estimatedBytes: 0,
    evictions: 0,
  };
  for (const source of metricsSources) {
    const metrics = source.metrics();
    aggregate.hits += metrics.hits;
    aggregate.misses += metrics.misses;
    aggregate.entries += metrics.entries;
    aggregate.estimatedBytes += metrics.estimatedBytes;
    aggregate.evictions += metrics.evictions;
  }
  return aggregate;
}
