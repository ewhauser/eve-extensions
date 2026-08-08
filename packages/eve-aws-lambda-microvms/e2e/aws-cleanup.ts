import {
  DeleteMicrovmImageCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  ListMicrovmsCommand,
  ListTagsCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { setTimeout as sleep } from "node:timers/promises";

import { buildLogGroupPrefixForStack } from "./naming.js";
import { E2E_STACK_TAG_KEY } from "./stack-template.js";

const RESOURCE_TIMEOUT_MS = 30 * 60 * 1000;

export async function cleanupE2eRuntime(input: {
  readonly artifactBucket?: string;
  readonly log: (message: string) => void;
  readonly region: string;
  readonly stackName: string;
}): Promise<void> {
  const microvms = new LambdaMicrovmsClient({ region: input.region });
  const logs = new CloudWatchLogsClient({ region: input.region });
  const s3 = new S3Client({ region: input.region });
  const errors: Error[] = [];
  try {
    await cleanupMicrovmResources({ ...input, client: microvms });
  } catch (error) {
    errors.push(asError(error));
  }
  try {
    await cleanupBuildLogs({ client: logs, log: input.log, stackName: input.stackName });
  } catch (error) {
    errors.push(asError(error));
  }
  if (input.artifactBucket) {
    try {
      await emptyBucket({ bucket: input.artifactBucket, client: s3, log: input.log });
    } catch (error) {
      errors.push(asError(error));
    }
  }
  microvms.destroy();
  logs.destroy();
  s3.destroy();
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to clean all resources for ${input.stackName}.`);
  }
}

async function cleanupBuildLogs(input: {
  readonly client: CloudWatchLogsClient;
  readonly log: (message: string) => void;
  readonly stackName: string;
}): Promise<void> {
  const prefix = buildLogGroupPrefixForStack(input.stackName);
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const output = await input.client.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken }),
    );
    names.push(
      ...(output.logGroups ?? []).flatMap((group) =>
        group.logGroupName?.startsWith(prefix) ? [group.logGroupName] : [],
      ),
    );
    nextToken = output.nextToken;
  } while (nextToken !== undefined);
  for (const name of names) {
    input.log(`deleting CloudWatch log group ${name}`);
    await input.client
      .send(new DeleteLogGroupCommand({ logGroupName: name }))
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
  }
}

async function cleanupMicrovmResources(input: {
  readonly client: LambdaMicrovmsClient;
  readonly log: (message: string) => void;
  readonly stackName: string;
}): Promise<void> {
  const images = await listTaggedImages(input);
  for (const imageArn of images) {
    const microvmIds = await listMicrovmsForImage(input.client, imageArn);
    for (const microvmId of microvmIds) {
      input.log(`terminating MicroVM ${microvmId}`);
      await input.client
        .send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }))
        .catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
    }
    await Promise.all(microvmIds.map((microvmId) => waitForMicrovmTermination(input.client, microvmId)));

    input.log(`deleting MicroVM image ${imageArn}`);
    await retryConflicts(async () => {
      await input.client.send(new DeleteMicrovmImageCommand({ imageIdentifier: imageArn }));
    });
  }

  if (images.length > 0) {
    await waitForImagesToDisappear(input.client, new Set(images));
  }
}

async function listTaggedImages(input: {
  readonly client: LambdaMicrovmsClient;
  readonly stackName: string;
}): Promise<string[]> {
  const result: string[] = [];
  let nextToken: string | undefined;
  do {
    const output = await input.client.send(
      new ListMicrovmImagesCommand({ maxResults: 50, nextToken }),
    );
    for (const item of output.items ?? []) {
      if (!item.imageArn) continue;
      try {
        const tags = await input.client.send(new ListTagsCommand({ Resource: item.imageArn }));
        if (tags.Tags?.[E2E_STACK_TAG_KEY] === input.stackName) result.push(item.imageArn);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    nextToken = output.nextToken;
  } while (nextToken !== undefined);
  return result;
}

async function listMicrovmsForImage(
  client: LambdaMicrovmsClient,
  imageArn: string,
): Promise<string[]> {
  const result: string[] = [];
  let nextToken: string | undefined;
  do {
    const output = await client.send(
      new ListMicrovmsCommand({ imageIdentifier: imageArn, maxResults: 50, nextToken }),
    );
    for (const item of output.items ?? []) {
      if (
        item.microvmId &&
        item.state !== "TERMINATED" &&
        item.state !== "TERMINATING"
      ) {
        result.push(item.microvmId);
      }
    }
    nextToken = output.nextToken;
  } while (nextToken !== undefined);
  return result;
}

async function waitForMicrovmTermination(
  client: LambdaMicrovmsClient,
  microvmId: string,
): Promise<void> {
  const deadline = Date.now() + RESOURCE_TIMEOUT_MS;
  for (;;) {
    try {
      const output = await client.send(
        new GetMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      if (output.state === "TERMINATED") return;
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out terminating MicroVM ${microvmId}.`);
    await sleep(2_000);
  }
}

async function waitForImagesToDisappear(
  client: LambdaMicrovmsClient,
  pending: Set<string>,
): Promise<void> {
  const deadline = Date.now() + RESOURCE_TIMEOUT_MS;
  for (;;) {
    let nextToken: string | undefined;
    const visible = new Set<string>();
    do {
      const output = await client.send(
        new ListMicrovmImagesCommand({ maxResults: 50, nextToken }),
      );
      for (const item of output.items ?? []) {
        if (item.imageArn && pending.has(item.imageArn)) visible.add(item.imageArn);
      }
      nextToken = output.nextToken;
    } while (nextToken !== undefined);
    if (visible.size === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out deleting MicroVM images: ${[...visible].join(", ")}.`);
    }
    await sleep(3_000);
  }
}

async function emptyBucket(input: {
  readonly bucket: string;
  readonly client: S3Client;
  readonly log: (message: string) => void;
}): Promise<void> {
  input.log(`emptying S3 bucket ${input.bucket}`);
  for (;;) {
    const output = await input.client.send(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        MaxKeys: 1_000,
      }),
    );
    const objects = (output.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ Key: object.Key }],
    );
    if (objects.length > 0) {
      const deleted = await input.client.send(
        new DeleteObjectsCommand({
          Bucket: input.bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      if ((deleted.Errors?.length ?? 0) > 0) {
        const reasons = deleted.Errors?.map(
          (error) => `${error.Key ?? "<unknown>"}: ${error.Code ?? "unknown"}`,
        ).join(", ");
        throw new Error(
          `S3 failed to delete objects from ${input.bucket}: ${reasons}`,
        );
      }
    }
    if (objects.length === 0) break;
  }

  for (;;) {
    const output = await input.client.send(
      new ListMultipartUploadsCommand({ Bucket: input.bucket }),
    );
    const uploads = output.Uploads ?? [];
    for (const upload of uploads) {
      if (upload.Key === undefined || upload.UploadId === undefined) continue;
      await input.client.send(
        new AbortMultipartUploadCommand({
          Bucket: input.bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    }
    if (uploads.length === 0) break;
  }
}

async function retryConflicts(operation: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + RESOURCE_TIMEOUT_MS;
  for (;;) {
    try {
      await operation();
      return;
    } catch (error) {
      if (isNotFound(error)) return;
      if (!isConflict(error) || Date.now() >= deadline) throw error;
      await sleep(3_000);
    }
  }
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ["ConflictException", "ResourceConflictException"].includes(
      String((error as { readonly name?: unknown }).name),
    )
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ["NotFoundException", "ResourceNotFoundException"].includes(
      String((error as { readonly name?: unknown }).name),
    )
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
