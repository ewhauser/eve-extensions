import { describe, expect, it } from "vitest";

import { parseAwsLambdaMicrovmSessionMetadata } from "./metadata.js";

const VALID = {
  activationId: "activation_opaque_1",
  configHash: "config-1",
  controllerCaSha256: "c".repeat(64),
  controllerProtocolVersion: 2,
  egressProxyCaSha256: "e".repeat(64),
  egressNetworkConnectorArn:
    "arn:aws:lambda:us-east-1:123456789012:network-connector:runtime",
  imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:test",
  imageVersion: "1",
  manifestEtag: "etag-1",
  microvmId: "mvm-1",
  networkLaneId: "lane-1",
  placeholderGeneration: 4,
  placeholderPlacement: { environmentVariable: "OPENAI_API_KEY" },
  region: "us-east-1",
  templateHash: "a".repeat(64),
  trustedBindingGeneration: 9,
  version: 2,
} as const;

describe("AWS Lambda MicroVM metadata v2", () => {
  it("parses placeholder and trusted-binding generations without authorization material", () => {
    expect(parseAwsLambdaMicrovmSessionMetadata(VALID)).toMatchObject({
      activationId: "activation_opaque_1",
      egressProxyCaSha256: "e".repeat(64),
      placeholderGeneration: 4,
      placeholderPlacement: { environmentVariable: "OPENAI_API_KEY" },
      trustedBindingGeneration: 9,
    });
  });

  it.each(["capability", "capabilitySha256", "egressJwt"])(
    "rejects stale authorization field %s",
    (field) => {
      expect(() =>
        parseAwsLambdaMicrovmSessionMetadata({ ...VALID, [field]: "forbidden" }),
      ).toThrow(new RegExp(field));
    },
  );

  it("rejects invalid placeholder placement and generations", () => {
    expect(() =>
      parseAwsLambdaMicrovmSessionMetadata({
        ...VALID,
        placeholderPlacement: { environmentVariable: "bad-name" },
      }),
    ).toThrow(/placeholderPlacement/);
    expect(() =>
      parseAwsLambdaMicrovmSessionMetadata({ ...VALID, placeholderGeneration: 0 }),
    ).toThrow(/placeholderGeneration/);
  });
});
