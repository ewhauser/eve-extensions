import type { Duration } from "./types.js";

/**
 * Runtime-agnostic duration and timestamp helpers.
 *
 * This module deliberately imports nothing outside the ECMAScript standard
 * library — no `node:crypto`, no `Buffer` — so the lifecycle statechart in
 * `instance-machine.ts` can be bundled for non-Node hosts (Workers, Durable
 * Objects, edge runtimes). `util.ts` re-exports everything here, so existing
 * imports keep working unchanged.
 */

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const DURATION_FACTORS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function durationMs(value: Duration, name = "duration"): number {
  if (typeof value === "number") {
    assertPositiveSafeInteger(value, name);
    return value;
  }
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new TypeError(`${name} must be a positive duration such as "2s" or "24h"`);
  }
  const amount = Number(match[1]);
  const factor = DURATION_FACTORS[match[2]!]!;
  const result = amount * factor;
  assertPositiveSafeInteger(result, name);
  return result;
}

export function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

export function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export function iso(date: Date | number): string {
  return new Date(date).toISOString();
}

export function addMs(timestamp: string, milliseconds: number): string {
  return iso(Date.parse(timestamp) + milliseconds);
}

export function minTimestamp(...timestamps: readonly (string | undefined)[]): string | undefined {
  let result: string | undefined;
  for (const timestamp of timestamps) {
    if (timestamp !== undefined && (result === undefined || timestamp < result)) result = timestamp;
  }
  return result;
}
