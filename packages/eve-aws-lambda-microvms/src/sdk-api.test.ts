import { describe, expect, it } from "vitest";

import { microvmFromOutput } from "./sdk-api.js";

describe("AWS Lambda MicroVM SDK response mapping", () => {
  it("retains all egress connectors returned by RunMicrovm/GetMicrovm", () => {
    expect(
      microvmFromOutput({
        egressNetworkConnectors: [
          "arn:aws:lambda:us-east-1:123456789012:network-connector:one",
          "arn:aws:lambda:us-east-1:123456789012:network-connector:two",
        ],
        endpoint: "mvm.example.test",
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:test",
        imageVersion: "1",
        microvmId: "mvm-test",
        state: "RUNNING",
      }).egressNetworkConnectorArns,
    ).toEqual([
      "arn:aws:lambda:us-east-1:123456789012:network-connector:one",
      "arn:aws:lambda:us-east-1:123456789012:network-connector:two",
    ]);
  });

  it("maps an omitted legacy connector list to empty for compatibility", () => {
    expect(
      microvmFromOutput({
        endpoint: "mvm.example.test",
        imageArn: "arn:aws:lambda:us-east-1:123456789012:microvm-image:test",
        imageVersion: "1",
        microvmId: "mvm-test",
        state: "RUNNING",
      }).egressNetworkConnectorArns,
    ).toEqual([]);
  });
});
