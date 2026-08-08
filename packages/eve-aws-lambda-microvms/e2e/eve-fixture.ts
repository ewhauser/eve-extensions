import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { E2eStack } from "./aws-stack.js";

const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/eve-aws-lambda-microvms-e2e",
);

export async function runEveFixture(input: {
  readonly applicationId: string;
  readonly log: (message: string) => void;
  readonly stack: E2eStack;
}): Promise<void> {
  // This dedicated fixture consumes the package through its built `dist`
  // export. Eve intentionally ignores dependency build output in its dev
  // watcher, so discard generated fixture state to prevent a previous run's
  // authored-module bundle or prewarm signature from masking current changes.
  await rm(resolve(FIXTURE_ROOT, ".eve"), { force: true, recursive: true });
  input.log("running deterministic Eve attachment and packaged-skill eval");
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "eve",
        "eval",
        "aws-microvm",
        "--strict",
        "--skip-report",
        "--verbose",
        "--max-concurrency",
        "1",
        "--timeout",
        "1800000",
      ],
      {
        cwd: FIXTURE_ROOT,
        env: {
          ...process.env,
          EVE_AWS_E2E_APPLICATION_ID: input.applicationId,
          EVE_AWS_E2E_ARTIFACT_BUCKET: input.stack.artifactBucket,
          EVE_AWS_E2E_BUILD_ROLE_ARN: input.stack.buildRoleArn,
          EVE_AWS_E2E_REGION: input.stack.region,
          EVE_AWS_E2E_STACK_NAME: input.stack.name,
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Eve eval exited from signal ${signal}.`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`Eve attachment and skill eval exited with ${exitCode}.`);
}
