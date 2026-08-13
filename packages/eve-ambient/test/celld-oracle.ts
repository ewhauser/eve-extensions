/**
 * The Phase 2 conformance oracle, ported for the shipped cell.
 *
 * The cell's transition log is treated as an *observation* of which lifecycle
 * events happened and when. Every consequence — which batch a claim selects,
 * its `closedBy`, the resulting instance record — is recomputed by replaying
 * those events through `dispatchLifecycle`, the same function the store tier
 * runs. Where the log also states a consequence, the two are compared.
 *
 * The exclusion list is empty: `expiresAt`, `updatedAt`, and `createdAt` are
 * modelled here exactly as the cell maintains them, so the replayed instance
 * must equal the cell's stored instance field for field.
 */

import { dispatchLifecycle } from "../src/instance-machine.js";
import type { CelldCellConfig } from "../src/mailbox.js";
import type { StoredMonitorInstance } from "../src/storage.js";
import { addMs, durationMs } from "../src/time.js";
import type { ChannelEvent, MonitorDefinition } from "../src/types.js";

/** `LOG_LIMIT` in the worker. A full ring buffer makes a replay unsound. */
const LOG_LIMIT = 60;

export interface PublishedEvent {
  readonly bytes: number;
  readonly acceptedAt: string;
  readonly ingressSequence: string;
}

export interface OracleOptions {
  readonly cellName: string;
  readonly monitorId: string;
  readonly definitionVersion: string;
  readonly config: CelldCellConfig;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly correlationKey: string;
  readonly correlationKeyHash: string;
  readonly published: ReadonlyMap<string, PublishedEvent>;
}

export interface CellLogEntry {
  readonly at: string;
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface OracleVerdict {
  /** What the machine says the instance must be after the observed timeline. */
  readonly instance: StoredMonitorInstance;
  /** Disagreements between the cell's log metadata and the machine. */
  readonly mismatches: readonly string[];
  /** Field-level differences between the cell's record and the machine's. */
  readonly differences: readonly string[];
}

/** Mirrors the worker's `#newInstance`. */
function newInstance(options: OracleOptions, now: string): StoredMonitorInstance {
  return {
    id: options.cellName,
    tenantId: options.tenantId,
    applicationId: options.applicationId,
    monitorId: options.monitorId,
    definitionVersion: options.definitionVersion,
    correlationKey: options.correlationKey,
    correlationKeyHash: options.correlationKeyHash,
    sealedBatches: [],
    evaluationGeneration: 0,
    consecutiveIgnores: 0,
    eventsSinceLastWake: 0,
    expiresAt: addMs(now, durationMs(options.config.retention.decisions)),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Replays a cell's transition log through the lifecycle statechart.
 *
 * Returns the instance the machine says must exist, plus every place the log's
 * own claims about a transition disagreed with what the machine computed.
 */
export function replayCellLog(
  log: readonly CellLogEntry[],
  options: OracleOptions,
): { readonly instance: StoredMonitorInstance; readonly mismatches: readonly string[] } {
  const first = log[0];
  if (first === undefined) throw new Error("cannot replay an empty cell log");
  if (first.kind !== "append") {
    throw new Error(`cell log does not start with an append (starts with ${first.kind})`);
  }
  if (log.length >= LOG_LIMIT) {
    throw new Error(`cell log is at the ring-buffer limit (${log.length}); replay unsound`);
  }
  const definition = options.config as unknown as MonitorDefinition<ChannelEvent>;
  const mismatches: string[] = [];
  let instance = newInstance(options, first.at);

  log.forEach((entry, index) => {
    const where = `${options.cellName}[${index}:${entry.kind}@${entry.at}]`;
    const now = entry.at;
    switch (entry.kind) {
      case "append": {
        const ref = String(entry.ref);
        const published = options.published.get(ref);
        if (published === undefined) {
          mismatches.push(`${where}: appended ${ref} was never published`);
          return;
        }
        const result = dispatchLifecycle(instance, definition, {
          type: "APPEND",
          ref: {
            ref,
            bytes: published.bytes,
            acceptedAt: published.acceptedAt,
            ingressSequence: published.ingressSequence,
          },
          now,
        });
        if (result.flushed !== entry.flushed) {
          mismatches.push(
            `${where}: log says flushed=${String(entry.flushed)}, machine says ${String(result.flushed)}`,
          );
        }
        instance = {
          ...result.instance,
          expiresAt: addMs(now, durationMs(options.config.retention.decisions)),
          updatedAt: now,
        };
        return;
      }
      case "claim":
      case "claim-empty": {
        const runId =
          entry.kind === "claim" ? String(entry.runId) : `probe_${index}`;
        const result = dispatchLifecycle(instance, definition, { type: "CLAIM", runId, now });
        if (entry.kind === "claim-empty") {
          if (result.claimedBatch !== undefined) {
            mismatches.push(`${where}: log says nothing was due, machine claimed a batch`);
          }
        } else if (result.claimedBatch === undefined) {
          mismatches.push(`${where}: log claimed ${runId}, machine found nothing due`);
        } else {
          if (result.claimedBatch.closedBy !== entry.closedBy) {
            mismatches.push(
              `${where}: log closedBy=${String(entry.closedBy)}, machine ${result.claimedBatch.closedBy}`,
            );
          }
          const refs = result.claimedBatch.events.map((event) => event.ref);
          if (JSON.stringify(refs) !== JSON.stringify(entry.refs)) {
            mismatches.push(
              `${where}: log refs ${JSON.stringify(entry.refs)}, machine ${JSON.stringify(refs)}`,
            );
          }
        }
        instance = { ...result.instance, updatedAt: now };
        return;
      }
      case "completed": {
        const decision = entry.decision as
          | { action: "ignore" | "wake"; confidence?: number; reasonClass: string }
          | null;
        const binding = entry.binding as StoredMonitorInstance["binding"] | null;
        const result = dispatchLifecycle(instance, definition, {
          type: "RUN_COMPLETED",
          status: entry.status as "ignored" | "shadowed" | "suppressed" | "delivered" | "unroutable",
          ...(decision === null ? {} : { decision }),
          ...(binding === null || binding === undefined ? {} : { binding }),
          now,
        });
        instance = {
          ...result.instance,
          expiresAt: addMs(now, durationMs(options.config.retention.decisions)),
          updatedAt: now,
        };
        return;
      }
      case "dead-lettered":
      case "run-failed-orphan": {
        const result = dispatchLifecycle(instance, definition, { type: "RUN_FAILED", now });
        instance = { ...result.instance, updatedAt: now };
        return;
      }
      default:
        // `resume` and `rearm` carry no lifecycle transition. `rearm` does
        // rewrite `nextEvaluationAt` and `updatedAt`, so it is not replayable
        // as a no-op; a log containing one is out of scope for the oracle.
        if (entry.kind === "rearm") {
          mismatches.push(`${where}: rearm is outside the oracle's model`);
        }
    }
  });

  return { instance, mismatches };
}

/** Field-level diff with an empty exclusion list. */
export function diffJson(observed: unknown, expected: unknown, path = "$"): string[] {
  if (JSON.stringify(observed) === JSON.stringify(expected)) return [];
  const bothObjects =
    observed !== null &&
    expected !== null &&
    typeof observed === "object" &&
    typeof expected === "object" &&
    Array.isArray(observed) === Array.isArray(expected);
  if (!bothObjects) {
    return [`${path}: cell ${JSON.stringify(observed)} != machine ${JSON.stringify(expected)}`];
  }
  const keys = new Set([
    ...Object.keys(observed as Record<string, unknown>),
    ...Object.keys(expected as Record<string, unknown>),
  ]);
  const differences: string[] = [];
  for (const key of [...keys].sort()) {
    differences.push(
      ...diffJson(
        (observed as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${path}.${key}`,
      ),
    );
  }
  return differences;
}

/**
 * The full verdict for one cell: replay its log, then diff the machine's
 * instance against the one the cell actually stored.
 */
export function compareCellState(
  state: { readonly instance: StoredMonitorInstance | null; readonly log: readonly CellLogEntry[] },
  options: OracleOptions,
): OracleVerdict {
  if (state.instance === null) throw new Error(`cell ${options.cellName} has no instance record`);
  const replay = replayCellLog(state.log, options);
  return {
    instance: replay.instance,
    mismatches: replay.mismatches,
    // JSON round-trip on both sides: the cell persists JSON strings, so an
    // absent key and an explicit `undefined` must compare equal.
    differences: diffJson(
      JSON.parse(JSON.stringify(state.instance)),
      JSON.parse(JSON.stringify(replay.instance)),
    ),
  };
}
