import { createHash, randomUUID } from "node:crypto";
import type { JsonValue, StandardSchema } from "./types.js";

/**
 * The duration and timestamp helpers live in `./time.js`, which imports no
 * Node built-ins so that the lifecycle statechart can be bundled for non-Node
 * hosts. They are re-exported here to keep `util.js` the single import site
 * every other module already uses.
 */
export {
  addMs,
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  durationMs,
  iso,
  minTimestamp,
} from "./time.js";

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
