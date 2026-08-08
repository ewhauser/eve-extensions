import { describe, expect, it } from "vitest";

import type { AwsLambdaMicrovmController } from "./controller-client.js";
import { createAwsLambdaMicrovmSession } from "./session.js";

describe("AWS Lambda MicroVM session paths", () => {
  const session = createAwsLambdaMicrovmSession({
    controller: {} as AwsLambdaMicrovmController,
    id: "path-test",
  });

  it("resolves Eve model-home paths to the sandbox home", () => {
    expect(session.resolvePath("$HOME")).toBe("/root");
    expect(session.resolvePath("$HOME/.agents/skills/example/SKILL.md")).toBe(
      "/root/.agents/skills/example/SKILL.md",
    );
  });

  it("continues to resolve ordinary relative paths under the workspace", () => {
    expect(session.resolvePath("src/index.ts")).toBe("/workspace/src/index.ts");
    expect(session.resolvePath("$HOME-not-a-token/file.txt")).toBe(
      "/workspace/$HOME-not-a-token/file.txt",
    );
  });
});
