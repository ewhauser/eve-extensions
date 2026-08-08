import { describe, expect, it } from "vitest";

import { applicationIdForStack, buildLogGroupPrefixForStack } from "./naming.js";

describe("AWS E2E resource naming", () => {
  it("derives the application and default build-log prefix from the stack", () => {
    const stackName = "eve-microvm-e2e-20260808133700-12345678";

    expect(applicationIdForStack(stackName)).toBe("eve-aws-e2e-20260808133700-12345678");
    expect(buildLogGroupPrefixForStack(stackName)).toBe(
      "/aws/lambda/microvms/eve-06f3d12d7654b9b95138-",
    );
  });
});
