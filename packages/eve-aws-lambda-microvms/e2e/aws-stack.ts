import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { setTimeout as sleep } from "node:timers/promises";

import { E2E_STACK_TAG_KEY, serializeE2eStackTemplate } from "./stack-template.js";

const STACK_TIMEOUT_MS = 20 * 60 * 1000;

export interface E2eStack {
  readonly artifactBucket: string;
  readonly buildRoleArn: string;
  readonly name: string;
  readonly region: string;
}

export async function createE2eStack(input: {
  readonly client: CloudFormationClient;
  readonly log: (message: string) => void;
  readonly name: string;
  readonly region: string;
}): Promise<E2eStack> {
  input.log(`creating CloudFormation stack ${input.name}`);
  await input.client.send(
    new CreateStackCommand({
      Capabilities: ["CAPABILITY_IAM"],
      OnFailure: "DO_NOTHING",
      StackName: input.name,
      Tags: [
        { Key: E2E_STACK_TAG_KEY, Value: input.name },
        { Key: "eve:owner", Value: "eve-aws-lambda-microvms-e2e" },
      ],
      TemplateBody: serializeE2eStackTemplate(input.name),
      TimeoutInMinutes: 15,
    }),
  );

  const stack = await waitForStackCreate(input);
  input.log("waiting for IAM build-role propagation");
  await sleep(10_000);
  return stackFromDescription(stack, input.region);
}

export async function findE2eStack(input: {
  readonly client: CloudFormationClient;
  readonly name: string;
  readonly region: string;
}): Promise<E2eStack | null> {
  const stack = await describeStack(input.client, input.name);
  if (stack === null) return null;

  const outputs = outputMap(stack);
  let artifactBucket = outputs.get("ArtifactBucketName");
  if (artifactBucket === undefined) {
    const resources = await input.client.send(
      new DescribeStackResourcesCommand({ StackName: input.name }),
    );
    artifactBucket = resources.StackResources?.find(
      (resource) => resource.LogicalResourceId === "ArtifactBucket",
    )?.PhysicalResourceId;
  }

  return {
    artifactBucket: artifactBucket ?? "",
    buildRoleArn: outputs.get("BuildRoleArn") ?? "",
    name: input.name,
    region: input.region,
  };
}

export async function deleteE2eStack(input: {
  readonly client: CloudFormationClient;
  readonly log: (message: string) => void;
  readonly name: string;
}): Promise<void> {
  if ((await describeStack(input.client, input.name)) === null) {
    input.log(`CloudFormation stack ${input.name} is already absent`);
    return;
  }

  input.log(`deleting CloudFormation stack ${input.name}`);
  await input.client.send(new DeleteStackCommand({ StackName: input.name }));
  const deadline = Date.now() + STACK_TIMEOUT_MS;
  for (;;) {
    const stack = await describeStack(input.client, input.name);
    if (stack === null) {
      input.log(`deleted CloudFormation stack ${input.name}`);
      return;
    }
    if (stack.StackStatus === "DELETE_FAILED") {
      throw new Error(
        `CloudFormation stack ${input.name} failed to delete: ${stack.StackStatusReason ?? "unknown reason"}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out deleting CloudFormation stack ${input.name}.`);
    }
    await sleep(3_000);
  }
}

async function waitForStackCreate(input: {
  readonly client: CloudFormationClient;
  readonly log: (message: string) => void;
  readonly name: string;
}): Promise<Stack> {
  const deadline = Date.now() + STACK_TIMEOUT_MS;
  let lastStatus = "";
  for (;;) {
    const stack = await describeStack(input.client, input.name);
    if (stack === null) throw new Error(`CloudFormation stack ${input.name} disappeared.`);
    if (stack.StackStatus !== lastStatus) {
      lastStatus = stack.StackStatus ?? "UNKNOWN";
      input.log(`stack ${input.name}: ${lastStatus}`);
    }
    if (stack.StackStatus === "CREATE_COMPLETE") return stack;
    if (isCreateFailure(stack.StackStatus)) {
      const events = await input.client.send(
        new DescribeStackEventsCommand({ StackName: input.name }),
      );
      const reason = events.StackEvents?.find((event) => event.ResourceStatusReason)
        ?.ResourceStatusReason;
      throw new Error(
        `CloudFormation stack ${input.name} failed to create (${stack.StackStatus}): ${
          reason ?? stack.StackStatusReason ?? "unknown reason"
        }`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out creating CloudFormation stack ${input.name}.`);
    }
    await sleep(3_000);
  }
}

async function describeStack(
  client: CloudFormationClient,
  name: string,
): Promise<Stack | null> {
  try {
    const output = await client.send(new DescribeStacksCommand({ StackName: name }));
    return output.Stacks?.[0] ?? null;
  } catch (error) {
    if (isMissingStack(error)) return null;
    throw error;
  }
}

function stackFromDescription(stack: Stack, region: string): E2eStack {
  const name = expectString(stack.StackName, "StackName");
  const outputs = outputMap(stack);
  return {
    artifactBucket: expectString(outputs.get("ArtifactBucketName"), "ArtifactBucketName"),
    buildRoleArn: expectString(outputs.get("BuildRoleArn"), "BuildRoleArn"),
    name,
    region,
  };
}

function outputMap(stack: Stack): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
      outputs.set(output.OutputKey, output.OutputValue);
    }
  }
  return outputs;
}

function isCreateFailure(status: string | undefined): boolean {
  return (
    status?.endsWith("_FAILED") === true ||
    status?.startsWith("ROLLBACK_") === true ||
    status === "DELETE_COMPLETE"
  );
}

function isMissingStack(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly name?: unknown }).name === "ValidationError" &&
    String((error as { readonly message?: unknown }).message).includes("does not exist")
  );
}

function expectString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`CloudFormation omitted ${label}.`);
  }
  return value;
}
