import { createHash } from "node:crypto";

/** The Claude Messages API tool-name contract. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const PREFIX_PATTERN = /^[a-zA-Z0-9_-]{0,32}$/;

export function validateToolPrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `eve-openai-connectors: toolPrefix ${JSON.stringify(prefix)} must match ${String(PREFIX_PATTERN)} — it becomes part of every generated tool name.`,
    );
  }
}

export function validateMaxToolNameLength(maxLength: number): void {
  if (!Number.isInteger(maxLength) || maxLength < 8 || maxLength > 64) {
    throw new Error(
      `eve-openai-connectors: maxToolNameLength ${JSON.stringify(maxLength)} must be an integer from 8 through 64.`,
    );
  }
}

export function searchToolName(prefix: string): string {
  return `${prefix}search`;
}

export function statusToolName(prefix: string): string {
  return `${prefix}status`;
}

/**
 * Map an upstream dotted tool name to an API-legal name:
 * dots → underscores, prefix prepended, illegal characters sanitized to `_`,
 * over-long names deterministically truncated to fit `maxLength`, ending in
 * `_` and the first 6 hex chars of the SHA-256 of the FULL upstream name.
 *
 * The result is deterministic across processes — no counters, no state.
 * The reverse mapping is never derived from the result; the upstream string
 * travels alongside every mapped name.
 */
export function mapUpstreamName(upstream: string, prefix: string, maxLength = 64): string {
  validateMaxToolNameLength(maxLength);
  let mapped = prefix + upstream.replace(/\./g, "_");
  mapped = mapped.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (mapped.length > maxLength) {
    const hash = createHash("sha256").update(upstream, "utf8").digest("hex").slice(0, 6);
    mapped = `${mapped.slice(0, maxLength - 7)}_${hash}`;
  }
  return mapped;
}

/**
 * Map an upstream dotted name to a service-qualified tool name. The first
 * dotted segment becomes the stable service namespace, while the remaining
 * operation is sanitized without flattening the namespace boundary.
 *
 * Example: `zoom.search_meetings` becomes `zoom__search_meetings`.
 */
export function mapUpstreamServiceName(upstream: string, maxLength = 64): string {
  validateMaxToolNameLength(maxLength);
  const separator = upstream.indexOf(".");
  const rawService = separator < 0 ? "connector" : upstream.slice(0, separator);
  const rawOperation = separator < 0 ? upstream : upstream.slice(separator + 1);
  const service = rawService.replace(/[^a-zA-Z0-9_-]/g, "_") || "connector";
  const operation = rawOperation.replace(/\./g, "_").replace(/[^a-zA-Z0-9_-]/g, "_");
  let mapped = `${service}__${operation || "tool"}`;
  if (mapped.length > maxLength) {
    const hash = createHash("sha256").update(upstream, "utf8").digest("hex").slice(0, 6);
    mapped = `${mapped.slice(0, maxLength - 7)}_${hash}`;
  }
  return mapped;
}

/**
 * Build the injective upstream → mapped map for a catalog. Collisions are
 * resolved deterministically: upstream names are sorted, the first claimant
 * of a mapped name wins, later ones are dropped with a warning.
 */
export function buildNameMap(
  upstreamNames: readonly string[],
  prefix: string,
  warn?: (message: string) => void,
  maxLength = 64,
  format: "flat" | "service-qualified" = "flat",
): Map<string, string> {
  const sorted = [...upstreamNames].sort();
  const byUpstream = new Map<string, string>();
  const used = new Set<string>();
  for (const upstream of sorted) {
    const mapped =
      format === "service-qualified"
        ? mapUpstreamServiceName(upstream, maxLength)
        : mapUpstreamName(upstream, prefix, maxLength);
    if (used.has(mapped)) {
      warn?.(
        `eve-openai-connectors: tool name collision — dropping ${JSON.stringify(upstream)} because ${JSON.stringify(mapped)} is already taken.`,
      );
      continue;
    }
    used.add(mapped);
    byUpstream.set(upstream, mapped);
  }
  return byUpstream;
}
