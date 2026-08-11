import type {
  MonitorStore,
  MonitorStoreTransaction,
  StoredDeadLetter,
  StoredDefinitionPin,
  StoredDeployment,
  StoredEvent,
  StoredMonitorInstance,
  StoredMonitorRun,
  StoredSubscription,
  SubscriptionStatus,
  UsageReservation,
} from "./storage.js";
import { scopedKey } from "./storage.js";
import { addMs, cloneJson, iso } from "./util.js";

/** Durable-semantics in-memory store for local development and deterministic tests. */
export class MemoryMonitorStore implements MonitorStore {
  readonly #events = new Map<string, StoredEvent>();
  readonly #eventDedupe = new Map<string, string>();
  readonly #subscriptions = new Map<string, StoredSubscription>();
  readonly #instances = new Map<string, StoredMonitorInstance>();
  readonly #runs = new Map<string, StoredMonitorRun>();
  readonly #deadLetters = new Map<string, StoredDeadLetter>();
  readonly #deployments = new Map<string, StoredDeployment>();
  readonly #usage = new Map<string, UsageReservation>();
  readonly #sequences = new Map<string, bigint>();
  readonly #locks = new Map<string, Promise<void>>();

  async transaction<T>(
    _lockKey: string,
    callback: (tx: MonitorStoreTransaction) => Promise<T>,
  ): Promise<T> {
    // A global mutex makes rollback atomic across the map-backed tables. The
    // production PostgreSQL store retains per-key parallelism.
    const lockKey = "__transaction__";
    const previous = this.#locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(lockKey, queued);
    await previous;

    const snapshot = this.#snapshot();
    try {
      return await callback(this.#transactionView());
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    } finally {
      release();
      if (this.#locks.get(lockKey) === queued) this.#locks.delete(lockKey);
    }
  }

  async listSubscriptions(input: {
    readonly applicationId: string;
    readonly statuses: readonly SubscriptionStatus[];
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredSubscription[]> {
    const statuses = new Set(input.statuses);
    const due = [...this.#subscriptions.values()].filter(
      (value) =>
        value.applicationId === input.applicationId &&
        statuses.has(value.status) &&
        value.availableAt <= input.availableBefore &&
        (value.status !== "processing" ||
          value.leaseExpiresAt === undefined ||
          value.leaseExpiresAt <= input.availableBefore),
    );
    return fairByTenant(
      due,
      input.limit,
      (left, right) =>
        left.availableAt.localeCompare(right.availableAt) ||
        compareSequence(left.ingressSequence, right.ingressSequence),
    ).map(clone);
  }

  async listSubscriptionsForMonitor(input: {
    readonly applicationId: string;
    readonly monitorId: string;
  }): Promise<readonly StoredSubscription[]> {
    return [...this.#subscriptions.values()]
      .filter(
        (value) =>
          value.applicationId === input.applicationId && value.monitorId === input.monitorId,
      )
      .map(clone);
  }

  async listDueInstances(input: {
    readonly applicationId: string;
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredMonitorInstance[]> {
    const due = [...this.#instances.values()].filter(
      (value) =>
        value.applicationId === input.applicationId &&
        value.activeRunId === undefined &&
        value.nextEvaluationAt !== undefined &&
        value.nextEvaluationAt <= input.availableBefore,
    );
    return fairByTenant(
      due,
      input.limit,
      (left, right) => left.nextEvaluationAt!.localeCompare(right.nextEvaluationAt!),
    ).map(clone);
  }

  async listDueRuns(input: {
    readonly applicationId: string;
    readonly availableBefore: string;
    readonly limit: number;
  }): Promise<readonly StoredMonitorRun[]> {
    const due = [...this.#runs.values()].filter(
      (value) =>
        value.applicationId === input.applicationId &&
        (value.status === "pending" || value.status === "retry" || value.status === "processing") &&
        value.availableAt <= input.availableBefore &&
        (value.status !== "processing" ||
          value.leaseExpiresAt === undefined ||
          value.leaseExpiresAt <= input.availableBefore),
    );
    return fairByTenant(
      due,
      input.limit,
      (left, right) => left.availableAt.localeCompare(right.availableAt),
    ).map(clone);
  }

  async listInstances(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
  }): Promise<readonly StoredMonitorInstance[]> {
    return [...this.#instances.values()]
      .filter(
        (value) =>
          value.applicationId === input.applicationId &&
          (input.monitorId === undefined || value.monitorId === input.monitorId),
      )
      .map(clone);
  }

  async listRuns(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly StoredMonitorRun[]> {
    return [...this.#runs.values()]
      .filter(
        (value) =>
          value.applicationId === input.applicationId &&
          (input.monitorId === undefined || value.monitorId === input.monitorId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit ?? 100)
      .map(clone);
  }

  async listDeadLetters(input: {
    readonly applicationId: string;
    readonly monitorId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly StoredDeadLetter[]> {
    return [...this.#deadLetters.values()]
      .filter(
        (value) =>
          value.applicationId === input.applicationId &&
          (input.monitorId === undefined || value.monitorId === input.monitorId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit ?? 100)
      .map(clone);
  }

  async listDefinitionPins(applicationId: string): Promise<readonly StoredDefinitionPin[]> {
    return [
      ...[...this.#subscriptions.values()]
        .filter(
          (value) =>
            value.applicationId === applicationId &&
            ["pending", "processing", "ready"].includes(value.status),
        )
        .map((value) => ({
          kind: "subscription" as const,
          id: value.id,
          monitorId: value.monitorId,
          definitionVersion: value.definitionVersion,
        })),
      ...[...this.#instances.values()]
        .filter((value) => value.applicationId === applicationId)
        .map((value) => ({
          kind: "instance" as const,
          id: value.id,
          monitorId: value.monitorId,
          definitionVersion: value.definitionVersion,
        })),
      ...[...this.#runs.values()]
        .filter(
          (value) =>
            value.applicationId === applicationId &&
            ["pending", "processing", "retry"].includes(value.status),
        )
        .map((value) => ({
          kind: "run" as const,
          id: value.id,
          monitorId: value.monitorId,
          definitionVersion: value.definitionVersion,
        })),
    ];
  }

  async getRun(id: string): Promise<StoredMonitorRun | null> {
    const value = this.#runs.get(id);
    return value === undefined ? null : clone(value);
  }

  async getEvent(ref: string): Promise<StoredEvent | null> {
    const value = this.#events.get(ref);
    return value === undefined ? null : clone(value);
  }

  async getInstance(id: string): Promise<StoredMonitorInstance | null> {
    const value = this.#instances.get(id);
    return value === undefined ? null : clone(value);
  }

  async purgeExpired(now: string): Promise<{
    readonly events: number;
    readonly runs: number;
    readonly instances: number;
    readonly usage: number;
  }> {
    let events = 0;
    let runs = 0;
    let instances = 0;
    let usage = 0;
    for (const [ref, event] of this.#events) {
      if (event.dedupeExpiresAt <= now) {
        if (
          event.directDispatch !== undefined &&
          ["pending", "processing"].includes(event.directDispatch.status)
        ) {
          this.#deadLetters.set(`purge:direct:${event.ref}`, {
            id: `purge:direct:${event.ref}`,
            tenantId: event.tenantId,
            applicationId: event.applicationId,
            eventRef: event.ref,
            stage: "direct-dispatch",
            reason: "source dedupe retention expired before direct dispatch completed",
            createdAt: now,
          });
        }
        this.#events.delete(ref);
        this.#eventDedupe.delete(event.dedupeKey);
        for (const [subscriptionId, subscription] of this.#subscriptions) {
          if (subscription.eventRef !== ref) continue;
          if (["pending", "processing", "ready"].includes(subscription.status)) {
            this.#deadLetters.set(`purge:${subscription.id}`, {
              id: `purge:${subscription.id}`,
              tenantId: subscription.tenantId,
              applicationId: subscription.applicationId,
              monitorId: subscription.monitorId,
              definitionVersion: subscription.definitionVersion,
              eventRef: subscription.eventRef,
              subscriptionId: subscription.id,
              stage: "retention",
              reason: "source dedupe retention expired before subscription completed",
              createdAt: now,
            });
          }
          this.#subscriptions.delete(subscriptionId);
        }
        events += 1;
      } else if (event.payloadExpiresAt <= now && event.event !== undefined) {
        this.#events.set(ref, { ...event, event: undefined });
        events += 1;
      }
    }
    for (const [id, run] of this.#runs) {
      if (run.expiresAt <= now && isTerminalRun(run.status)) {
        this.#runs.delete(id);
        runs += 1;
      }
    }
    for (const [id, instance] of this.#instances) {
      if (
        instance.expiresAt <= now &&
        instance.activeRunId === undefined &&
        instance.openBatch === undefined &&
        instance.sealedBatches.length === 0
      ) {
        this.#instances.delete(id);
        instances += 1;
      }
    }
    for (const [id, reservation] of this.#usage) {
      if (reservation.expiresAt <= now) {
        this.#usage.delete(id);
        usage += 1;
      }
    }
    return { events, runs, instances, usage };
  }

  #transactionView(): MonitorStoreTransaction {
    return {
      getEventByDedupeKey: async (key) => {
        const ref = this.#eventDedupe.get(key);
        const value = ref === undefined ? undefined : this.#events.get(ref);
        return value === undefined ? null : clone(value);
      },
      getEvent: async (ref) => {
        const value = this.#events.get(ref);
        return value === undefined ? null : clone(value);
      },
      releaseEventDedupe: async (ref) => {
        const event = this.#events.get(ref);
        if (event === undefined) return;
        this.#eventDedupe.delete(event.dedupeKey);
        const dedupeKey = scopedKey("expired", event.ref, event.dedupeKey);
        this.#events.set(ref, clone({ ...event, dedupeKey }));
        this.#eventDedupe.set(dedupeKey, ref);
      },
      putEvent: async (event) => {
        const previousRef = this.#eventDedupe.get(event.dedupeKey);
        if (previousRef !== undefined && previousRef !== event.ref) this.#events.delete(previousRef);
        this.#events.set(event.ref, clone(event));
        this.#eventDedupe.set(event.dedupeKey, event.ref);
      },
      getSubscription: async (id) => {
        const value = this.#subscriptions.get(id);
        return value === undefined ? null : clone(value);
      },
      putSubscription: async (subscription) => {
        this.#subscriptions.set(subscription.id, clone(subscription));
      },
      deleteSubscription: async (id) => {
        this.#subscriptions.delete(id);
      },
      getInstance: async (id) => {
        const value = this.#instances.get(id);
        return value === undefined ? null : clone(value);
      },
      countInstances: async (input) =>
        [...this.#instances.values()].filter(
          (instance) =>
            instance.tenantId === input.tenantId &&
            instance.applicationId === input.applicationId,
        ).length,
      putInstance: async (instance) => {
        this.#instances.set(instance.id, clone(instance));
      },
      deleteInstance: async (id) => {
        this.#instances.delete(id);
      },
      getRun: async (id) => {
        const value = this.#runs.get(id);
        return value === undefined ? null : clone(value);
      },
      putRun: async (run) => {
        this.#runs.set(run.id, clone(run));
      },
      putDeadLetter: async (deadLetter) => {
        this.#deadLetters.set(deadLetter.id, clone(deadLetter));
      },
      getDeployment: async (applicationId) => {
        const value = this.#deployments.get(applicationId);
        return value === undefined ? null : clone(value);
      },
      putDeployment: async (deployment) => {
        this.#deployments.set(deployment.applicationId, clone(deployment));
      },
      nextIngressSequence: async (scope) => {
        const next = (this.#sequences.get(scope) ?? 0n) + 1n;
        this.#sequences.set(scope, next);
        return next.toString();
      },
      hasEarlierOpenSubscription: async (input) =>
        [...this.#subscriptions.values()].some(
          (subscription) =>
            subscription.tenantId === input.tenantId &&
            subscription.applicationId === input.applicationId &&
            subscription.monitorId === input.monitorId &&
            subscription.definitionVersion === input.definitionVersion &&
            ["pending", "processing", "ready"].includes(subscription.status) &&
            (subscription.correlationKeyHash === undefined ||
              subscription.correlationKeyHash === input.correlationKeyHash) &&
            compareSequence(subscription.ingressSequence, input.ingressSequence) < 0,
        ),
      reserveUsage: async (input) => {
        if (this.#usage.has(input.id)) return { allowed: true } as const;
        const windowStart = iso(Date.parse(input.now) - input.windowMs);
        const reservations = [...this.#usage.values()].filter(
          (value) =>
            value.scope === input.scope &&
            value.metric === input.metric &&
            value.occurredAt > windowStart &&
            value.expiresAt > input.now,
        );
        const used = reservations.reduce((sum, value) => sum + value.amount, 0);
        if (used + input.amount > input.limit) {
          const oldest = reservations.sort((left, right) =>
            left.occurredAt.localeCompare(right.occurredAt),
          )[0];
          return {
            allowed: false,
            retryAt: oldest === undefined ? addMs(input.now, input.windowMs) : addMs(oldest.occurredAt, input.windowMs),
          } as const;
        }
        this.#usage.set(input.id, {
          id: input.id,
          scope: input.scope,
          metric: input.metric,
          amount: input.amount,
          occurredAt: input.now,
          expiresAt: addMs(input.now, input.windowMs),
        });
        return { allowed: true } as const;
      },
    };
  }

  #snapshot(): MemorySnapshot {
    return {
      events: new Map(this.#events),
      eventDedupe: new Map(this.#eventDedupe),
      subscriptions: new Map(this.#subscriptions),
      instances: new Map(this.#instances),
      runs: new Map(this.#runs),
      deadLetters: new Map(this.#deadLetters),
      deployments: new Map(this.#deployments),
      usage: new Map(this.#usage),
      sequences: new Map(this.#sequences),
    };
  }

  #restore(snapshot: MemorySnapshot): void {
    replaceMap(this.#events, snapshot.events);
    replaceMap(this.#eventDedupe, snapshot.eventDedupe);
    replaceMap(this.#subscriptions, snapshot.subscriptions);
    replaceMap(this.#instances, snapshot.instances);
    replaceMap(this.#runs, snapshot.runs);
    replaceMap(this.#deadLetters, snapshot.deadLetters);
    replaceMap(this.#deployments, snapshot.deployments);
    replaceMap(this.#usage, snapshot.usage);
    replaceMap(this.#sequences, snapshot.sequences);
  }
}

interface MemorySnapshot {
  readonly events: Map<string, StoredEvent>;
  readonly eventDedupe: Map<string, string>;
  readonly subscriptions: Map<string, StoredSubscription>;
  readonly instances: Map<string, StoredMonitorInstance>;
  readonly runs: Map<string, StoredMonitorRun>;
  readonly deadLetters: Map<string, StoredDeadLetter>;
  readonly deployments: Map<string, StoredDeployment>;
  readonly usage: Map<string, UsageReservation>;
  readonly sequences: Map<string, bigint>;
}

function replaceMap<TKey, TValue>(target: Map<TKey, TValue>, source: Map<TKey, TValue>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fairByTenant<T extends { readonly tenantId: string; readonly id: string }>(
  values: readonly T[],
  limit: number,
  compare: (left: T, right: T) => number,
): T[] {
  const queues = new Map<string, T[]>();
  for (const value of values) {
    const queue = queues.get(value.tenantId) ?? [];
    queue.push(value);
    queues.set(value.tenantId, queue);
  }
  for (const queue of queues.values()) {
    queue.sort((left, right) => compare(left, right) || left.id.localeCompare(right.id));
  }
  const tenants = [...queues.keys()].sort();
  const result: T[] = [];
  while (result.length < limit) {
    let progressed = false;
    for (const tenant of tenants) {
      const next = queues.get(tenant)?.shift();
      if (next !== undefined) {
        result.push(next);
        progressed = true;
        if (result.length === limit) break;
      }
    }
    if (!progressed) break;
  }
  return result;
}

function isTerminalRun(status: StoredMonitorRun["status"]): boolean {
  return ["ignored", "shadowed", "suppressed", "delivered", "unroutable", "dead-lettered"].includes(status);
}

function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
