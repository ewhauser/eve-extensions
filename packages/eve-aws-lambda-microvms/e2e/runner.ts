import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
} from "@aws-sdk/client-lambda-microvms";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { randomBytes } from "node:crypto";

import { cleanupE2eRuntime } from "./aws-cleanup.js";
import { createE2eStack, deleteE2eStack, findE2eStack, type E2eStack } from "./aws-stack.js";
import { runEveFixture } from "./eve-fixture.js";
import { applicationIdForStack } from "./naming.js";
import { runPackageScenario } from "./package-scenario.js";
import { serializeE2eStackTemplate } from "./stack-template.js";

const RUN_GUARD = "EVE_RUN_AWS_MICROVM_E2E";

interface CliOptions {
  readonly command: "cleanup" | "plan" | "run";
  readonly region: string;
  readonly stackName?: string;
}

await main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.command === "plan") {
    const stackName = options.stackName ?? "eve-microvm-e2e-plan";
    process.stdout.write(`${JSON.stringify(JSON.parse(serializeE2eStackTemplate(stackName)), null, 2)}\n`);
    return;
  }
  if (options.command === "cleanup") {
    if (!options.stackName) throw new Error("cleanup requires --stack <stack-name>.");
    await cleanupExistingStack(options.region, options.stackName);
    return;
  }
  if (process.env[RUN_GUARD] !== "1") {
    throw new Error(
      `Refusing to create AWS resources. Set ${RUN_GUARD}=1 after selecting a disposable AWS account.`,
    );
  }
  await runAtomic(options.region, options.stackName ?? createStackName());
}

async function runAtomic(region: string, stackName: string): Promise<void> {
  const log = createLogger();
  const cloudFormation = new CloudFormationClient({ region });
  let stack: E2eStack | undefined;
  let testError: Error | undefined;
  let requestedSignal: NodeJS.Signals | undefined;
  const signalHandler = (signal: NodeJS.Signals) => {
    requestedSignal ??= signal;
    log(`${signal} received; cleanup will run before the process exits`);
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  try {
    await preflight(region, log);
    if (requestedSignal) throw new Error(`Interrupted by ${requestedSignal}.`);
    stack = await createE2eStack({ client: cloudFormation, log, name: stackName, region });
    if (requestedSignal) throw new Error(`Interrupted by ${requestedSignal}.`);
    const applicationId = applicationIdForStack(stackName);
    const packageResult = await runPackageScenario({ applicationId, log, stack });
    log(
      `package scenario restored ${packageResult.resumedMicrovmId} as ${packageResult.replacementMicrovmId}`,
    );
    if (requestedSignal) throw new Error(`Interrupted by ${requestedSignal}.`);
    await runEveFixture({ applicationId, log, stack });
    if (requestedSignal) throw new Error(`Interrupted by ${requestedSignal}.`);
    log("all AWS Lambda MicroVM end-to-end scenarios passed");
  } catch (error) {
    testError = asError(error);
  }

  const cleanupErrors: Error[] = [];
  try {
    stack ??= (await findE2eStack({ client: cloudFormation, name: stackName, region })) ?? undefined;
    await cleanupE2eRuntime({
      ...(stack?.artifactBucket ? { artifactBucket: stack.artifactBucket } : {}),
      log,
      region,
      stackName,
    });
  } catch (error) {
    cleanupErrors.push(asError(error));
  }
  try {
    await deleteE2eStack({ client: cloudFormation, log, name: stackName });
  } catch (error) {
    cleanupErrors.push(asError(error));
  } finally {
    cloudFormation.destroy();
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
  }

  if (cleanupErrors.length > 0) {
    const cleanupError = new AggregateError(
      cleanupErrors,
      `Atomic cleanup failed. Recover with: pnpm test:aws:cleanup -- --stack ${stackName} --region ${region}`,
    );
    if (testError) throw new AggregateError([testError, cleanupError], "Tests and cleanup failed.");
    throw cleanupError;
  }
  if (testError) throw testError;
}

async function cleanupExistingStack(region: string, stackName: string): Promise<void> {
  const log = createLogger();
  const cloudFormation = new CloudFormationClient({ region });
  try {
    const stack = await findE2eStack({ client: cloudFormation, name: stackName, region });
    await cleanupE2eRuntime({
      ...(stack?.artifactBucket ? { artifactBucket: stack.artifactBucket } : {}),
      log,
      region,
      stackName,
    });
    await deleteE2eStack({ client: cloudFormation, log, name: stackName });
  } finally {
    cloudFormation.destroy();
  }
}

async function preflight(region: string, log: (message: string) => void): Promise<void> {
  const expectedAccount = process.env.EVE_AWS_E2E_ACCOUNT_ID;
  if (!expectedAccount || !/^\d{12}$/.test(expectedAccount)) {
    throw new Error(
      "EVE_AWS_E2E_ACCOUNT_ID must name the 12-digit disposable AWS account to test.",
    );
  }
  const sts = new STSClient({ region });
  const microvms = new LambdaMicrovmsClient({ region });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account || !identity.Arn) throw new Error("STS GetCallerIdentity omitted identity.");
    if (identity.Account !== expectedAccount) {
      throw new Error(
        `AWS credentials resolved to account ${identity.Account}, expected ${expectedAccount}.`,
      );
    }
    log(`AWS identity ${identity.Arn} in account ${identity.Account}, region ${region}`);
    const managed = await microvms.send(new ListManagedMicrovmImagesCommand({ maxResults: 50 }));
    if (!(managed.items ?? []).some((item) => item.imageArn?.endsWith(":microvm-image:al2023-1"))) {
      throw new Error(`AWS Lambda MicroVM managed image al2023-1 is unavailable in ${region}.`);
    }
  } finally {
    sts.destroy();
    microvms.destroy();
  }
}

export function parseCli(args: readonly string[]): CliOptions {
  let command: CliOptions["command"] = "run";
  let region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  let stackName: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "run" || argument === "plan" || argument === "cleanup") {
      command = argument;
    } else if (argument === "--") {
      continue;
    } else if (argument === "--region") {
      region = expectValue(args, ++index, "--region");
    } else if (argument === "--stack") {
      stackName = expectValue(args, ++index, "--stack");
    } else {
      throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
    }
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    throw new Error(`Invalid AWS region: ${region}.`);
  }
  if (stackName !== undefined && !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)) {
    throw new Error(`Invalid CloudFormation stack name: ${stackName}.`);
  }
  return { command, region, ...(stackName === undefined ? {} : { stackName }) };
}

function createStackName(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  return `eve-microvm-e2e-${timestamp}-${randomBytes(4).toString("hex")}`;
}

function expectValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function createLogger(): (message: string) => void {
  return (message) => console.log(`[aws-e2e ${new Date().toISOString()}] ${message}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map((entry) => formatError(entry))].join("\n");
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
