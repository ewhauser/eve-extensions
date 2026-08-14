import type { ApprovalPolicy } from "eve/tools";
import type {
  ApprovalAction,
  ApprovalsConfig,
  ConnectorToolItem,
} from "./types.js";

/**
 * Derive fail-closed read/destructive flags from MCP annotations.
 *
 * | Condition | Result |
 * |---|---|
 * | `destructiveHint === true` | destructive write |
 * | `readOnlyHint === true` | read-only |
 * | `readOnlyHint === false && destructiveHint === false` | plain write |
 * | anything else (missing/unparseable) | **destructive write** |
 */
export function flagsFromAnnotations(annotations: unknown): {
  readOnly: boolean;
  destructive: boolean;
} {
  if (typeof annotations === "object" && annotations !== null) {
    const a = annotations as Record<string, unknown>;
    if (a.destructiveHint === true) return { readOnly: false, destructive: true };
    if (a.readOnlyHint === true) return { readOnly: true, destructive: false };
    if (a.readOnlyHint === false && a.destructiveHint === false) {
      return { readOnly: false, destructive: false };
    }
  }
  return { readOnly: false, destructive: true };
}

/**
 * The simple (default) policy: read-only auto-allows, every write requires
 * human approval. Eve's approval channel carries no severity flag, so the
 * destructive tier is surfaced through the tool description instead (see
 * `catalog.ts`), not through a different approval status.
 */
export function defaultApprovalFor(item: Pick<ConnectorToolItem, "readOnly">): ApprovalPolicy {
  if (item.readOnly) return () => "not-applicable";
  return () => "user-approval";
}

function approvalForAction(action: ApprovalAction, upstream: string): ApprovalPolicy {
  switch (action) {
    case "allow":
      return () => "not-applicable";
    case "approve":
      return () => "user-approval";
    case "deny":
      return () => ({
        type: "denied",
        reason: `${upstream} is blocked by this agent's connector approval policy.`,
      });
  }
}

/**
 * Compile a glob pattern over upstream dotted names into a RegExp.
 * `*` matches any run of characters (including dots); everything else is
 * literal. Matching is case-insensitive.
 */
export function compileMatchPattern(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

interface CompiledRule {
  patterns: RegExp[];
  action: ApprovalAction;
}

/**
 * Build the `approvalFor` policy from declarative config.
 *
 * - simple mode (default): {@link defaultApprovalFor}.
 * - detailed mode: rules evaluated in order against the upstream dotted name,
 *   first match wins; unmatched tools use `fallback` when given, otherwise
 *   the simple policy.
 */
export function buildApprovalPolicy(
  config: ApprovalsConfig | undefined,
): (item: ConnectorToolItem) => ApprovalPolicy {
  if (!config || (config.mode ?? "simple") === "simple") {
    return defaultApprovalFor;
  }
  const rules: CompiledRule[] = (config.rules ?? []).map((rule) => ({
    patterns: (typeof rule.match === "string" ? [rule.match] : [...rule.match]).map(
      compileMatchPattern,
    ),
    action: rule.action,
  }));
  const fallback = config.fallback;
  return (item) => {
    for (const rule of rules) {
      if (rule.patterns.some((p) => p.test(item.upstream))) {
        return approvalForAction(rule.action, item.upstream);
      }
    }
    if (fallback !== undefined) return approvalForAction(fallback, item.upstream);
    return defaultApprovalFor(item);
  };
}
