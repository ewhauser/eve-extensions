import { describe, expect, it } from "vitest";

import { createE2eStackTemplate, E2E_STACK_TAG_KEY } from "./stack-template.js";

describe("AWS E2E stack template", () => {
  it("creates only temporary bucket and build-role resources", () => {
    const stackName = "eve-microvm-e2e-test";
    const template = createE2eStackTemplate(stackName);

    expect(Object.keys(template.Resources)).toEqual(["ArtifactBucket", "MicrovmBuildRole"]);
    expect(template.Resources["ArtifactBucket"]).toMatchObject({
      Properties: {
        BucketEncryption: expect.any(Object),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        Tags: [{ Key: E2E_STACK_TAG_KEY, Value: stackName }],
      },
      Type: "AWS::S3::Bucket",
    });
  });

  it("constrains Lambda trust to the stack account and region", () => {
    const template = createE2eStackTemplate("eve-microvm-e2e-test");
    expect(template.Resources["MicrovmBuildRole"]).toMatchObject({
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: ["sts:AssumeRole", "sts:TagSession"],
              Condition: {
                ArnLike: {
                  "aws:SourceArn": {
                    "Fn::Sub": expect.stringContaining(":microvm-image:*"),
                  },
                },
                StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
              },
              Principal: { Service: "lambda.amazonaws.com" },
            },
          ],
        },
      },
    });
  });
});
