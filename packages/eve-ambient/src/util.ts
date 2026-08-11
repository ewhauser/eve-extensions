import { createHash, randomUUID } from "node:crypto";
import type { Duration, JsonValue, StandardSchema } from "./types.js";

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

export function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

export function assertBoundedText(value: string, name: string, maxBytes: number): void {
  assertNonEmpty(value, name);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`${name} must be at most ${maxBytes} UTF-8 bytes`);
  }
}

export function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new TypeError(
      `${name} must start with a lowercase letter and contain lowercase letters, digits, dots, underscores, or hyphens`,
    );
  }
}

export function jsonBytes(value: unknown, name = "value"): number {
  return Buffer.byteLength(canonicalJson(value, name), "utf8");
}

export function assertJsonValue(value: unknown, name = "value"): asserts value is JsonValue {
  canonicalJson(value, name);
}

export function canonicalJson(value: unknown, name = "value"): string {
  const seen = new Set<object>();
  const normalize = (current: unknown, path: string): JsonValue => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${path} must contain finite numbers`);
      return current;
    }
    if (typeof current !== "object") {
      throw new TypeError(`${path} must be JSON-safe; received ${typeof current}`);
    }
    if (seen.has(current)) throw new TypeError(`${path} must not contain circular references`);
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item, index) => normalize(item, `${path}[${index}]`));
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path} must contain only plain JSON objects`);
      }
      const output: Record<string, JsonValue> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        output[key] = normalize(
          (current as Record<string, unknown>)[key],
          `${path}.${key}`,
        );
      }
      return output;
    } finally {
      seen.delete(current);
    }
  };
  return JSON.stringify(normalize(value, name));
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
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

export async function parseSchema<T>(
  schema: StandardSchema<T>,
  value: unknown,
  name: string,
): Promise<T> {
  const result = await schema["~standard"].validate(value);
  if ("issues" in result && result.issues !== undefined) {
    throw new TypeError(`${name} failed schema validation: ${formatIssues(result.issues)}`);
  }
  if (!("value" in result)) throw new TypeError(`${name} schema returned no value`);
  return result.value;
}

function formatIssues(issues: readonly unknown[]): string {
  const serialized = JSON.stringify(issues);
  return serialized.length <= 1_000 ? serialized : `${serialized.slice(0, 997)}...`;
}

export function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function estimateJsonTokens(value: JsonValue): number {
  return Math.max(1, Math.ceil(jsonBytes(value) / 4));
}
