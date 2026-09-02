import type { ApprovalContext } from "eve/tools/approval";
import { describe, expect, test } from "vitest";

import {
  buildApprovalPolicy,
  compileMatchPattern,
  flagsFromAnnotations,
} from "../extension/lib/policy.js";

function approvalContext(
  upstreamToolName: string,
  toolAnnotations?: Readonly<Record<string, unknown>>,
): ApprovalContext {
  return {
    approvedTools: new Set(),
    callId: "call-1",
    session: {} as ApprovalContext["session"],
    toolName: `connectors__${upstreamToolName.replaceAll(".", "__")}`,
    upstreamToolName,
    ...(toolAnnotations === undefined ? {} : { toolAnnotations }),
  } as unknown as ApprovalContext;
}

describe("annotation flags", () => {
  test("recognizes read-only and explicit writes", () => {
    expect(flagsFromAnnotations({ readOnlyHint: true })).toEqual({
      destructive: false,
      readOnly: true,
    });
    expect(flagsFromAnnotations({ destructiveHint: false, readOnlyHint: false })).toEqual({
      destructive: false,
      readOnly: false,
    });
  });

  test.each([undefined, null, {}, { readOnlyHint: false }, { readOnlyHint: "yes" }])(
    "fails closed for missing or invalid annotations: %j",
    (annotations) => {
      expect(flagsFromAnnotations(annotations)).toEqual({ destructive: true, readOnly: false });
    },
  );
});

describe("connection approval policy", () => {
  test("allows only valid read-only annotations without approval", async () => {
    const policy = buildApprovalPolicy(undefined);
    expect(
      await policy(approvalContext("github.search_repositories", { readOnlyHint: true })),
    ).toBe("not-applicable");
    expect(await policy(approvalContext("github.create_issue"))).toBe("user-approval");
  });

  test("matches detailed rules against exact upstream dotted names", async () => {
    const policy = buildApprovalPolicy({
      mode: "detailed",
      rules: [
        { action: "deny", match: "github.delete_*" },
        { action: "allow", match: "github.*" },
      ],
    });
    expect(await policy(approvalContext("github.search_repositories"))).toBe("not-applicable");
    expect(await policy(approvalContext("github.delete_repository"))).toMatchObject({
      type: "denied",
    });
  });

  test("uses explicit detailed fallback before annotation defaults", async () => {
    const policy = buildApprovalPolicy({ mode: "detailed", fallback: "approve" });
    expect(
      await policy(approvalContext("github.search_repositories", { readOnlyHint: true })),
    ).toBe("user-approval");
  });
});

describe("match patterns", () => {
  test("is anchored, case-insensitive, and treats non-star regex syntax literally", () => {
    expect(compileMatchPattern("github.*").test("github.search_issues")).toBe(true);
    expect(compileMatchPattern("github.*").test("google.github_thing")).toBe(false);
    expect(compileMatchPattern("GitHub.Search_Issues").test("github.search_issues")).toBe(true);
    expect(compileMatchPattern("github.x").test("githubax")).toBe(false);
  });
});
