import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { awsLambdaMicrovm } from "../src/index.js";
import type { E2eStack } from "./aws-stack.js";
import { E2E_STACK_TAG_KEY } from "./stack-template.js";

export interface PackageScenarioResult {
  readonly replacementMicrovmId: string;
  readonly resumedMicrovmId: string;
}

export async function runPackageScenario(input: {
  readonly applicationId: string;
  readonly log: (message: string) => void;
  readonly stack: E2eStack;
}): Promise<PackageScenarioResult> {
  const api = new LambdaMicrovmsClient({ region: input.stack.region });
  const backend = awsLambdaMicrovm({
    applicationId: input.applicationId,
    artifactBucket: input.stack.artifactBucket,
    artifactPrefix: `runs/${input.stack.name}/package`,
    buildRoleArn: input.stack.buildRoleArn,
    idlePolicy: {
      autoResumeEnabled: true,
      maxIdleDurationSeconds: 60,
      suspendedDurationSeconds: 300,
    },
    maximumDurationSeconds: 900,
    memoryMiB: 512,
    region: input.stack.region,
    runtimeLogging: false,
    tags: { [E2E_STACK_TAG_KEY]: input.stack.name },
  });

  const templateKey = `e2e-template-${input.stack.name}`;
  const sessionKey = `e2e-session-${input.stack.name}`;
  input.log("prewarming the package-level template");
  const firstPrewarm = await backend.prewarm({
    async bootstrap({ use }) {
      const session = await use();
      await session.writeTextFile({
        content: `template:${input.stack.name}\n`,
        path: "/etc/eve-e2e-template",
      });
    },
    log: input.log,
    runtimeContext: { appRoot: "/e2e/package" },
    seedFiles: [
      { content: `workspace:${input.stack.name}\n`, path: "/workspace/e2e-seed.txt" },
    ],
    templateKey,
  });
  assert.equal(firstPrewarm.reused, false);
  const secondPrewarm = await backend.prewarm({
    runtimeContext: { appRoot: "/e2e/package" },
    seedFiles: [
      { content: `workspace:${input.stack.name}\n`, path: "/workspace/e2e-seed.txt" },
    ],
    templateKey,
  });
  assert.equal(secondPrewarm.reused, true);

  input.log("creating the package-level durable session");
  const first = await backend.create({
    runtimeContext: { appRoot: "/e2e/package" },
    sessionKey,
    templateKey,
  });
  assert.equal(
    await first.session.readTextFile({ path: "/etc/eve-e2e-template" }),
    `template:${input.stack.name}\n`,
  );
  assert.equal(
    await first.session.readTextFile({ path: "/workspace/e2e-seed.txt" }),
    `workspace:${input.stack.name}\n`,
  );

  const command = await first.session.run({ command: "printf 'stdout-ok'; printf 'stderr-ok' >&2" });
  assert.deepEqual(command, { exitCode: 0, stderr: "stderr-ok", stdout: "stdout-ok" });
  await first.session.writeTextFile({
    content: `attachment:${input.stack.name}\n`,
    path: "/workspace/attachments/manual/e2e attachment.txt",
  });
  await first.session.spawn({
    command: "while :; do date +%s >> /workspace/e2e-process.log; sleep 1; done",
  });
  await sleep(2_500);
  assert.ok(
    lineCount(await first.session.readTextFile({ path: "/workspace/e2e-process.log" })) >= 2,
    "background process did not start",
  );
  const firstState = await first.captureState();
  const firstMicrovmId = microvmIdFromState(firstState.metadata);
  await first.shutdown();

  input.log(`reattaching suspended MicroVM ${firstMicrovmId}`);
  const resumed = await backend.create({
    existingMetadata: firstState.metadata,
    runtimeContext: { appRoot: "/e2e/package" },
    sessionKey,
    templateKey,
  });
  assert.equal(
    await resumed.session.readTextFile({ path: "/workspace/attachments/manual/e2e attachment.txt" }),
    `attachment:${input.stack.name}\n`,
  );
  const resumedLinesBefore = lineCount(
    await resumed.session.readTextFile({ path: "/workspace/e2e-process.log" }),
  );
  await sleep(2_500);
  const resumedLinesAfter = lineCount(
    await resumed.session.readTextFile({ path: "/workspace/e2e-process.log" }),
  );
  assert.ok(
    resumedLinesAfter > resumedLinesBefore,
    "background process did not survive native resume",
  );
  const resumedState = await resumed.captureState();
  const resumedMicrovmId = microvmIdFromState(resumedState.metadata);
  assert.equal(resumedMicrovmId, firstMicrovmId);
  await resumed.shutdown();

  input.log(`forcing replacement of MicroVM ${resumedMicrovmId}`);
  await api.send(new TerminateMicrovmCommand({ microvmIdentifier: resumedMicrovmId }));
  await waitForTermination(api, resumedMicrovmId);

  const replacement = await backend.create({
    existingMetadata: resumedState.metadata,
    runtimeContext: { appRoot: "/e2e/package" },
    sessionKey,
    templateKey,
  });
  assert.equal(
    await replacement.session.readTextFile({ path: "/etc/eve-e2e-template" }),
    `template:${input.stack.name}\n`,
  );
  assert.equal(
    await replacement.session.readTextFile({
      path: "/workspace/attachments/manual/e2e attachment.txt",
    }),
    `attachment:${input.stack.name}\n`,
  );
  const replacementLinesBefore = lineCount(
    await replacement.session.readTextFile({ path: "/workspace/e2e-process.log" }),
  );
  await sleep(2_500);
  const replacementLinesAfter = lineCount(
    await replacement.session.readTextFile({ path: "/workspace/e2e-process.log" }),
  );
  assert.equal(
    replacementLinesAfter,
    replacementLinesBefore,
    "background process unexpectedly survived replacement",
  );
  const replacementState = await replacement.captureState();
  const replacementMicrovmId = microvmIdFromState(replacementState.metadata);
  assert.notEqual(replacementMicrovmId, resumedMicrovmId);
  await replacement.shutdown();
  await api.send(new TerminateMicrovmCommand({ microvmIdentifier: replacementMicrovmId }));
  await waitForTermination(api, replacementMicrovmId);
  api.destroy();

  return { replacementMicrovmId, resumedMicrovmId };
}

async function waitForTermination(
  client: LambdaMicrovmsClient,
  microvmId: string,
): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    try {
      const output = await client.send(
        new GetMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      if (output.state === "TERMINATED") return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        ["NotFoundException", "ResourceNotFoundException"].includes(
          String((error as { readonly name?: unknown }).name),
        )
      ) {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out terminating MicroVM ${microvmId}.`);
    await sleep(2_000);
  }
}

function microvmIdFromState(metadata: unknown): string {
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("AWS Lambda MicroVM state metadata was not an object.");
  }
  const microvmId = (metadata as { readonly microvmId?: unknown }).microvmId;
  if (typeof microvmId !== "string" || microvmId.length === 0) {
    throw new Error("AWS Lambda MicroVM state metadata omitted microvmId.");
  }
  return microvmId;
}

function lineCount(value: string | null): number {
  if (value === null || value.length === 0) return 0;
  return value.trimEnd().split("\n").length;
}
