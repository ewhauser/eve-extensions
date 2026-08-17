import type { AwsLambdaMicrovmVerifiedImage, AwsLambdaMicrovmSandboxOptions } from "./types.js";
import { resolveAwsLambdaMicrovmOptions } from "./options.js";
import { ensureAwsLambdaMicrovmImage } from "./provision.js";
import { SdkAwsLambdaMicrovmApi } from "./sdk-api.js";
import { SdkAwsLambdaMicrovmStorage } from "./storage.js";

/**
 * Explicitly reconciles one environment-specific image and returns its
 * immutable, credential-free deployment identity.
 *
 * This operation may upload the deterministic controller artifact and call
 * CreateMicrovmImage. It belongs in a dedicated bake workflow, never in an
 * application deployment or runtime process.
 */
export async function reconcileAwsLambdaMicrovmImage(
  options: AwsLambdaMicrovmSandboxOptions,
  input: { readonly log?: (message: string) => void } = {},
): Promise<AwsLambdaMicrovmVerifiedImage> {
  if (options.verifiedImage !== undefined) {
    throw new Error("AWS Lambda MicroVM reconciliation does not accept verifiedImage.");
  }
  const resolved = resolveAwsLambdaMicrovmOptions(options);
  const api = new SdkAwsLambdaMicrovmApi(resolved.region);
  const storage = new SdkAwsLambdaMicrovmStorage({
    bucket: resolved.artifactBucket,
    kmsKeyId: resolved.artifactKmsKeyId,
    region: resolved.region,
  });
  try {
    await storage.assertBucketRegion();
    return (
      await ensureAwsLambdaMicrovmImage({
        api,
        log: input.log,
        options: resolved,
        storage,
      })
    ).verifiedImage;
  } finally {
    storage.destroy();
    api.destroy();
  }
}
