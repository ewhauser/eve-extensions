import { describe, expect, it } from "vitest";

import { buildAwsLambdaMicrovmImageArtifact } from "./image-artifact.js";

describe("AWS Lambda MicroVM image artifact", () => {
  it("contains only the configured public proxy trust material", async () => {
    const publicCertificate = [
      "-----BEGIN CERTIFICATE-----",
      "public-test-material",
      "-----END CERTIFICATE-----",
      "",
    ].join("\n");
    const artifact = await buildAwsLambdaMicrovmImageArtifact({
      egressProxyCaBundlePem: publicCertificate,
    });
    const archive = artifact.bytes.toString("utf8");

    expect(archive).toContain("egress-proxy-ca.pem");
    expect(archive).toContain(publicCertificate);
    expect(archive).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/);
  });

  it("uses an empty trust-bundle entry when public CA injection is not configured", async () => {
    const artifact = await buildAwsLambdaMicrovmImageArtifact();
    expect(artifact.bytes.toString("utf8")).toContain("egress-proxy-ca.pem");
    expect(artifact.bytes.toString("utf8")).not.toContain("BEGIN CERTIFICATE");
  });
});
