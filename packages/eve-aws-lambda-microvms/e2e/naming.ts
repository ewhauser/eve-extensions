import { createHash } from "node:crypto";

export function applicationIdForStack(stackName: string): string {
  const suffix = stackName.replace(/^eve-microvm-e2e-/, "");
  return `eve-aws-e2e-${suffix}`;
}

export function buildLogGroupPrefixForStack(stackName: string): string {
  const applicationHash = createHash("sha256")
    .update(applicationIdForStack(stackName))
    .digest("hex")
    .slice(0, 20);
  return `/aws/lambda/microvms/eve-${applicationHash}-`;
}
