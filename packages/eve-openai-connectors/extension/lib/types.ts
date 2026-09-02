import type { DynamicConnectionResolveContext } from "eve/connections";

/** Safe subset shared with application-owned credential callbacks. */
export interface ConnectorContext {
  readonly session: DynamicConnectionResolveContext["session"];
}

export type ApprovalAction = "allow" | "approve" | "deny";

export interface ApprovalRule {
  /** Glob matched against the exact upstream dotted name. */
  readonly match: string | readonly string[];
  readonly action: ApprovalAction;
}

export interface ApprovalsConfig {
  readonly mode?: "simple" | "detailed";
  readonly rules?: readonly ApprovalRule[];
  readonly fallback?: ApprovalAction;
}
