import { describe, expect, it } from "vitest";

import type { AwsLambdaMicrovmImageVersionRecord } from "./api.js";
import { isUnavailableImageVersion } from "./provision.js";

const IMAGE = {
  imageArn: "arn:aws:lambda:us-east-2:123456789012:microvm-image:eve-test",
  imageVersion: "1.0",
} as const;

describe("AWS Lambda MicroVM image provisioning", () => {
  it("waits while a pending image is inactive", () => {
    expect(
      isUnavailableImageVersion({ ...IMAGE, state: "PENDING", status: "INACTIVE" }),
    ).toBe(false);
  });

  it.each([
    { state: "FAILED", status: "INACTIVE" },
    { state: "DELETING", status: "INACTIVE" },
    { state: "DELETED", status: "INACTIVE" },
    { state: "DELETE_FAILED", status: "INACTIVE" },
    { state: "SUCCESSFUL", status: "INACTIVE" },
  ] satisfies Pick<AwsLambdaMicrovmImageVersionRecord, "state" | "status">[])(
    "rejects an unavailable $state/$status image",
    (image) => {
      expect(isUnavailableImageVersion({ ...IMAGE, ...image })).toBe(true);
    },
  );
});
