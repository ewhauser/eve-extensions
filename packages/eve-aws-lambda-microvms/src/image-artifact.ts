import { createHash } from "node:crypto";

import { CONTROLLER_ASSETS } from "./controller-assets.generated.js";
import { createDeterministicZip } from "./deterministic-zip.js";

export const AWS_LAMBDA_MICROVM_CONTROLLER_PROTOCOL_VERSION = 1;

/** Builds the deterministic Docker context uploaded for a Lambda MicroVM image. */
export async function buildAwsLambdaMicrovmImageArtifact(): Promise<{
  readonly bytes: Buffer;
  readonly sha256: string;
}> {
  const [dockerfile, controller, launcher, start] = await Promise.all([
    readControllerAsset("Dockerfile"),
    readControllerAsset("controller.py"),
    readControllerAsset("launcher.py"),
    readControllerAsset("start.sh"),
  ]);
  const bytes = createDeterministicZip([
    { content: controller, mode: 0o100755, path: "controller.py" },
    { content: dockerfile, path: "Dockerfile" },
    { content: launcher, mode: 0o100755, path: "launcher.py" },
    { content: start, mode: 0o100755, path: "start.sh" },
  ]);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function readControllerAsset(name: string): Promise<Buffer> {
  const encoded = CONTROLLER_ASSETS[name as keyof typeof CONTROLLER_ASSETS];
  if (encoded === undefined) {
    throw new Error(`Unknown AWS Lambda MicroVM controller asset: ${name}`);
  }
  return Buffer.from(encoded, "base64");
}
