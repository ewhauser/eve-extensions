import { describe, expect, it } from "vitest";

import { isRetryableImageDeletion } from "./aws-cleanup.js";

describe("AWS E2E image cleanup", () => {
  it.each(["ConflictException", "ResourceConflictException"])(
    "retries %s",
    (name) => {
      expect(isRetryableImageDeletion(Object.assign(new Error("busy"), { name }))).toBe(true);
    },
  );

  it("retries the validation error returned while an image build is pending", () => {
    expect(
      isRetryableImageDeletion(
        Object.assign(new Error("Cannot delete MicroVM image in its current state: arn"), {
          name: "ValidationException",
        }),
      ),
    ).toBe(true);
  });

  it("does not retry unrelated validation errors", () => {
    expect(
      isRetryableImageDeletion(
        Object.assign(new Error("invalid image identifier"), { name: "ValidationException" }),
      ),
    ).toBe(false);
  });
});
