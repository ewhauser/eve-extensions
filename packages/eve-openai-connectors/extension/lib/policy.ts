import type { ApprovalPolicy, ApprovalStatus } from "eve/tools/approval";

import type { ApprovalAction, ApprovalsConfig } from "./types.js";

export function flagsFromAnnotations(annotations: unknown): {
  readonly destructive: boolean;
  readonly readOnly: boolean;
} {
  if (typeof annotations === "object" && annotations !== null) {
    const value = annotations as Record<string, unknown>;
    if (value.destructiveHint === true) return { destructive: true, readOnly: false };
    if (value.readOnlyHint === true) return { destructive: false, readOnly: true };
    if (value.readOnlyHint === false && value.destructiveHint === false) {
      return { destructive: false, readOnly: false };
    }
  }
  return { destructive: true, readOnly: false };
}

export function compileMatchPattern(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

function statusForAction(action: ApprovalAction, upstream: string): ApprovalStatus {
  if (action === "allow") return "not-applicable";
  if (action === "approve") return "user-approval";
  return {
    type: "denied",
    reason: `${upstream} is blocked by this agent's connector approval policy.`,
  };
}

export function buildApprovalPolicy(config: ApprovalsConfig | undefined): ApprovalPolicy {
  const rules = (config?.mode === "detailed" ? (config.rules ?? []) : []).map((rule) => ({
    action: rule.action,
    patterns: (typeof rule.match === "string" ? [rule.match] : rule.match).map(compileMatchPattern),
  }));

  return (ctx) => {
    const upstream = ctx.upstreamToolName ?? ctx.toolName;
    for (const rule of rules) {
      if (rule.patterns.some((pattern) => pattern.test(upstream))) {
        return statusForAction(rule.action, upstream);
      }
    }
    if (config?.mode === "detailed" && config.fallback !== undefined) {
      return statusForAction(config.fallback, upstream);
    }
    return flagsFromAnnotations(ctx.toolAnnotations).readOnly ? "not-applicable" : "user-approval";
  };
}
