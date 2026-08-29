import { describe, expect, test } from "vitest";
import type { ApprovalContext } from "eve/tools/approval";
import {
  buildApprovalPolicy,
  compileMatchPattern,
  defaultApprovalFor,
  flagsFromAnnotations,
} from "../extension/lib/policy.js";
import type { ConnectorToolItem } from "../extension/lib/types.js";

const approvalCtx = {} as ApprovalContext;

function item(overrides: Partial<ConnectorToolItem>): ConnectorToolItem {
  return {
    name: "apps_github_create_issue",
    upstream: "github.create_issue",
    service: "github",
    description: "",
    inputSchema: { type: "object" },
    readOnly: false,
    destructive: false,
    ...overrides,
  };
}

async function statusOf(policy: ReturnType<typeof buildApprovalPolicy>, it: ConnectorToolItem) {
  return await policy(it)(approvalCtx);
}

describe("annotation flags (fail closed)", () => {
  test("readOnlyHint true → read-only", () => {
    expect(flagsFromAnnotations({ readOnlyHint: true, destructiveHint: false })).toEqual({
      readOnly: true,
      destructive: false,
    });
  });
  test("explicit non-destructive write", () => {
    expect(flagsFromAnnotations({ readOnlyHint: false, destructiveHint: false })).toEqual({
      readOnly: false,
      destructive: false,
    });
  });
  test("destructiveHint true wins even against readOnlyHint true", () => {
    expect(flagsFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toEqual({
      readOnly: false,
      destructive: true,
    });
  });
  test.each([undefined, null, "nope", {}, { readOnlyHint: "yes" }, { readOnlyHint: false }])(
    "missing or unparseable annotations (%j) are a destructive write",
    (annotations) => {
      expect(flagsFromAnnotations(annotations)).toEqual({ readOnly: false, destructive: true });
    },
  );
});

describe("simple mode (default)", () => {
  test("read-only auto-allows", async () => {
    expect(await defaultApprovalFor(item({ readOnly: true }))(approvalCtx)).toBe("not-applicable");
  });
  test("write requires human approval", async () => {
    expect(await defaultApprovalFor(item({ readOnly: false }))(approvalCtx)).toBe("user-approval");
  });
  test("destructive requires human approval", async () => {
    expect(await defaultApprovalFor(item({ destructive: true }))(approvalCtx)).toBe("user-approval");
  });
  test("buildApprovalPolicy with no config is the simple policy", async () => {
    const policy = buildApprovalPolicy(undefined);
    expect(await statusOf(policy, item({ readOnly: true }))).toBe("not-applicable");
    expect(await statusOf(policy, item({ readOnly: false }))).toBe("user-approval");
  });
});

describe("detailed mode", () => {
  const policy = buildApprovalPolicy({
    mode: "detailed",
    rules: [
      { match: "github.delete_*", action: "deny" },
      { match: ["github.*", "notion.create_page"], action: "allow" },
      { match: "*.create_*", action: "approve" },
    ],
  });

  test("first matching rule wins", async () => {
    // github.create_issue matches rule 2 (allow) before rule 3 (approve).
    expect(await statusOf(policy, item({ upstream: "github.create_issue" }))).toBe(
      "not-applicable",
    );
  });
  test("deny returns a denied status with a reason", async () => {
    const status = await statusOf(policy, item({ upstream: "github.delete_branch" }));
    expect(status).toMatchObject({ type: "denied" });
  });
  test("glob crosses namespaces", async () => {
    expect(await statusOf(policy, item({ upstream: "google_drive.create_file" }))).toBe(
      "user-approval",
    );
  });
  test("unmatched tools fall back to the simple annotation policy", async () => {
    expect(await statusOf(policy, item({ upstream: "notion.query_database", readOnly: true }))).toBe(
      "not-applicable",
    );
    expect(await statusOf(policy, item({ upstream: "notion.update_page", readOnly: false }))).toBe(
      "user-approval",
    );
  });
  test("explicit fallback overrides the simple policy", async () => {
    const strict = buildApprovalPolicy({ mode: "detailed", rules: [], fallback: "approve" });
    expect(await statusOf(strict, item({ readOnly: true }))).toBe("user-approval");
  });
});

describe("match patterns", () => {
  test("* matches across dots; matching is case-insensitive and anchored", () => {
    expect(compileMatchPattern("github.*").test("github.search_issues")).toBe(true);
    expect(compileMatchPattern("github.*").test("google.github_thing")).toBe(false);
    expect(compileMatchPattern("*.delete_*").test("github.delete_branch")).toBe(true);
    expect(compileMatchPattern("GitHub.Search_Issues").test("github.search_issues")).toBe(true);
    expect(compileMatchPattern("github.search").test("github.search_issues")).toBe(false);
    // Regex metacharacters in patterns are literal, so "." cannot wildcard.
    expect(compileMatchPattern("github.x").test("githubax")).toBe(false);
  });
});
