import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ListTagsCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { setTimeout as sleep } from "node:timers/promises";

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const ATTACHMENT_SENTINEL = "attachment-payload:lambda-microvm-e2e";
const SKILL_SENTINEL = "skill-reference:lambda-microvm-e2e";

export default defineEval({
  description: "Attachments and packaged skills survive native resume and replacement restore.",
  tags: ["aws", "microvm", "slow"],
  async test(t) {
    const first = await t.sendFile(
      "Load persistence-probe and inspect the attachment and packaged reference.",
      "evals/fixtures/e2e attachment ünicode.txt",
      "text/plain",
    );
    first.expectOk();
    t.check(first.message, includes(ATTACHMENT_SENTINEL));
    t.check(first.message, includes(SKILL_SENTINEL));
    assertAttachmentEvent(first.events);

    const resumed = await t.send("Re-read the original attachment and packaged skill reference.");
    resumed.expectOk();
    t.check(resumed.message, includes(ATTACHMENT_SENTINEL));
    t.check(resumed.message, includes(SKILL_SENTINEL));

    await terminateFixtureMicrovms((message) => t.log(message));

    const restored = await t.send(
      "After replacement, re-read the original attachment and packaged skill reference.",
    );
    restored.expectOk();
    t.check(restored.message, includes(ATTACHMENT_SENTINEL));
    t.check(restored.message, includes(SKILL_SENTINEL));
    t.loadedSkill("persistence-probe", { count: 3 });
    t.calledTool("read_file", { count: 6 });
    t.succeeded();
  },
});

async function terminateFixtureMicrovms(log: (message: string) => void): Promise<void> {
  const region = required("EVE_AWS_E2E_REGION");
  const stackName = required("EVE_AWS_E2E_STACK_NAME");
  const client = new LambdaMicrovmsClient({ region });
  try {
    const microvmIds: string[] = [];
    let nextToken: string | undefined;
    do {
      const output = await client.send(new ListMicrovmsCommand({ maxResults: 50, nextToken }));
      for (const item of output.items ?? []) {
        if (
          !item.microvmId ||
          !item.imageArn ||
          item.state === "TERMINATED" ||
          item.state === "TERMINATING"
        ) {
          continue;
        }
        const resourceArn = microvmArn(item.imageArn, item.microvmId);
        const tags = await client.send(new ListTagsCommand({ Resource: resourceArn }));
        if (tags.Tags?.["eve-e2e-stack"] === stackName) microvmIds.push(item.microvmId);
      }
      nextToken = output.nextToken;
    } while (nextToken !== undefined);

    if (microvmIds.length === 0) throw new Error("No tagged MicroVMs were available to replace.");
    log(`forcing replacement of ${microvmIds.join(", ")}`);
    for (const microvmId of microvmIds) {
      await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    }
    await Promise.all(microvmIds.map((microvmId) => waitForTermination(client, microvmId)));
  } finally {
    client.destroy();
  }
}

async function waitForTermination(
  client: LambdaMicrovmsClient,
  microvmId: string,
): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    try {
      const output = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
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

function microvmArn(imageArn: string, microvmId: string): string {
  const [arn, partition, service, region, account] = imageArn.split(":");
  if (arn !== "arn" || service !== "lambda" || !partition || !region || !account) {
    throw new Error(`Invalid MicroVM image ARN: ${imageArn}.`);
  }
  return `arn:${partition}:lambda:${region}:${account}:microvm:${microvmId}`;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the AWS MicroVM E2E fixture.`);
  return value;
}

function assertAttachmentEvent(events: readonly { readonly data?: unknown; readonly type: string }[]): void {
  const received = events.find((event) => event.type === "message.received");
  if (received === undefined || typeof received.data !== "object" || received.data === null) {
    throw new Error("The attachment turn omitted message.received metadata.");
  }
  const parts = (received.data as { readonly parts?: unknown }).parts;
  if (!Array.isArray(parts)) throw new Error("message.received omitted structured parts.");
  const file = parts.find(
    (part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "file",
  ) as { readonly filename?: unknown; readonly mediaType?: unknown; readonly size?: unknown } | undefined;
  if (
    file === undefined ||
    file.mediaType !== "text/plain" ||
    typeof file.filename !== "string" ||
    !file.filename.endsWith(".txt") ||
    file.filename.includes("/workspace/")
  ) {
    throw new Error(`Unexpected attachment metadata: ${JSON.stringify(file)}.`);
  }
}
