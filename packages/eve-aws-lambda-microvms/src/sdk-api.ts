// Derived from vercel/eve PR #208 (Apache-2.0); adapted to load the AWS SDK directly.
import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmImageCommand,
  GetMicrovmCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
  ListManagedMicrovmImageVersionsCommand,
  ListMicrovmImageVersionsCommand,
  ListMicrovmImagesCommand,
  type Logging,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";

import type {
  AwsLambdaMicrovmApi,
  AwsLambdaMicrovmCreateImageInput,
  AwsLambdaMicrovmImageRecord,
  AwsLambdaMicrovmImageVersionRecord,
  AwsLambdaMicrovmLogging,
  AwsLambdaMicrovmRecord,
  AwsLambdaMicrovmRunInput,
  AwsLambdaMicrovmState,
} from "./api.js";

const LIST_PAGE_SIZE = 50;

export class SdkAwsLambdaMicrovmApi implements AwsLambdaMicrovmApi {
  readonly #client: LambdaMicrovmsClient;

  constructor(region: string) {
    this.#client = new LambdaMicrovmsClient({ region });
  }

  async createAuthToken(microvmId: string): Promise<string> {
    const output = await this.#client.send(
      new CreateMicrovmAuthTokenCommand({
        allowedPorts: [{ port: 8080 }],
        expirationInMinutes: 60,
        microvmIdentifier: microvmId,
      }),
    );
    const authToken = expectRecord(output.authToken, "authToken");
    return expectString(authToken["X-aws-proxy-auth"], 'authToken["X-aws-proxy-auth"]');
  }

  async createImage(
    input: AwsLambdaMicrovmCreateImageInput,
  ): Promise<AwsLambdaMicrovmImageVersionRecord> {
    const output = await this.#client.send(
      new CreateMicrovmImageCommand({
        additionalOsCapabilities: ["ALL"],
        baseImageArn: input.baseImageArn,
        baseImageVersion: input.baseImageVersion,
        buildRoleArn: input.buildRoleArn,
        clientToken: input.clientToken,
        codeArtifact: { uri: input.codeArtifactUri },
        cpuConfigurations: [{ architecture: "ARM_64" }],
        description: input.description,
        egressNetworkConnectors: [...input.egressNetworkConnectorArns],
        environmentVariables: { ...input.environmentVariables },
        hooks: {
          microvmHooks: {
            resume: "ENABLED",
            resumeTimeoutInSeconds: 30,
            run: "ENABLED",
            runTimeoutInSeconds: 30,
            suspend: "ENABLED",
            suspendTimeoutInSeconds: 30,
            terminate: "ENABLED",
            terminateTimeoutInSeconds: 30,
          },
          microvmImageHooks: {
            ready: "ENABLED",
            readyTimeoutInSeconds: 900,
            validate: "ENABLED",
            validateTimeoutInSeconds: 900,
          },
          port: 9000,
        },
        logging: toSdkLogging(input.logging),
        name: input.name,
        resources: [{ minimumMemoryInMiB: input.memoryMiB }],
        tags: { ...input.tags },
      }),
    );
    return {
      imageArn: expectString(output.imageArn, "imageArn"),
      imageVersion: expectString(output.imageVersion, "imageVersion"),
      state: "PENDING",
    };
  }

  destroy(): void {
    this.#client.destroy();
  }

  async getImageVersion(
    imageArn: string,
    imageVersion: string,
  ): Promise<AwsLambdaMicrovmImageVersionRecord> {
    return imageVersionFromOutput(
      await this.#client.send(
        new GetMicrovmImageVersionCommand({
          imageIdentifier: imageArn,
          imageVersion,
        }),
      ),
    );
  }

  async getMicrovm(microvmId: string): Promise<AwsLambdaMicrovmRecord | null> {
    try {
      return microvmFromOutput(
        await this.#client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId })),
      );
    } catch (error) {
      if (isAwsNotFound(error)) return null;
      throw error;
    }
  }

  async listImages(name: string): Promise<readonly AwsLambdaMicrovmImageRecord[]> {
    const items: AwsLambdaMicrovmImageRecord[] = [];
    let nextToken: string | undefined;
    do {
      const output = await this.#client.send(
        new ListMicrovmImagesCommand({
          maxResults: LIST_PAGE_SIZE,
          nameFilter: name,
          nextToken,
        }),
      );
      for (const item of expectArray(output.items, "items")) {
        const record = expectRecord(item, "image item");
        items.push({
          imageArn: expectString(record.imageArn, "imageArn"),
          latestActiveImageVersion: optionalString(record.latestActiveImageVersion),
          name: expectString(record.name, "name"),
        });
      }
      nextToken = optionalString(output.nextToken);
    } while (nextToken !== undefined);
    return items;
  }

  async listImageVersions(
    imageArn: string,
  ): Promise<readonly AwsLambdaMicrovmImageVersionRecord[]> {
    const items: AwsLambdaMicrovmImageVersionRecord[] = [];
    let nextToken: string | undefined;
    do {
      const output = await this.#client.send(
        new ListMicrovmImageVersionsCommand({
          imageIdentifier: imageArn,
          maxResults: LIST_PAGE_SIZE,
          nextToken,
        }),
      );
      for (const item of expectArray(output.items, "items")) {
        items.push(imageVersionFromOutput(expectRecord(item, "image version item")));
      }
      nextToken = optionalString(output.nextToken);
    } while (nextToken !== undefined);
    return items;
  }

  async listManagedImages(): Promise<readonly { readonly imageArn: string }[]> {
    const items: { imageArn: string }[] = [];
    let nextToken: string | undefined;
    do {
      const output = await this.#client.send(
        new ListManagedMicrovmImagesCommand({ maxResults: LIST_PAGE_SIZE, nextToken }),
      );
      for (const item of expectArray(output.items, "items")) {
        items.push({
          imageArn: expectString(expectRecord(item, "image item").imageArn, "imageArn"),
        });
      }
      nextToken = optionalString(output.nextToken);
    } while (nextToken !== undefined);
    return items;
  }

  async listManagedImageVersions(
    imageArn: string,
  ): Promise<readonly { readonly imageArn: string; readonly imageVersion: string }[]> {
    const items: { imageArn: string; imageVersion: string }[] = [];
    let nextToken: string | undefined;
    do {
      const output = await this.#client.send(
        new ListManagedMicrovmImageVersionsCommand({
          imageIdentifier: imageArn,
          maxResults: LIST_PAGE_SIZE,
          nextToken,
        }),
      );
      for (const item of expectArray(output.items, "items")) {
        const record = expectRecord(item, "image version item");
        items.push({
          imageArn: expectString(record.imageArn, "imageArn"),
          imageVersion: expectString(record.imageVersion, "imageVersion"),
        });
      }
      nextToken = optionalString(output.nextToken);
    } while (nextToken !== undefined);
    return items;
  }

  async runMicrovm(input: AwsLambdaMicrovmRunInput): Promise<AwsLambdaMicrovmRecord> {
    return microvmFromOutput(
      await this.#client.send(
        new RunMicrovmCommand({
          clientToken: input.clientToken,
          egressNetworkConnectors: [...input.egressNetworkConnectorArns],
          executionRoleArn: input.executionRoleArn,
          idlePolicy: input.idlePolicy,
          imageIdentifier: input.imageArn,
          imageVersion: input.imageVersion,
          ingressNetworkConnectors: [...input.ingressNetworkConnectorArns],
          logging: toSdkLogging(input.logging),
          maximumDurationInSeconds: input.maximumDurationSeconds,
          runHookPayload: input.runHookPayload,
        }),
      ),
    );
  }

  async terminateMicrovm(microvmId: string): Promise<void> {
    await this.#client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
  }
}

function toSdkLogging(logging: AwsLambdaMicrovmLogging): Logging {
  return "disabled" in logging ? { disabled: {} } : { cloudWatch: logging.cloudWatch };
}

function imageVersionFromOutput(
  value: unknown,
): AwsLambdaMicrovmImageVersionRecord {
  const output = expectRecord(value, "image version");
  return {
    imageArn: expectString(output.imageArn, "imageArn"),
    imageVersion: expectString(output.imageVersion, "imageVersion"),
    state: expectImageVersionState(output.state),
    stateReason: optionalString(output.stateReason),
    status: expectImageVersionStatus(output.status),
  };
}

export function microvmFromOutput(value: unknown): AwsLambdaMicrovmRecord {
  const output = expectRecord(value, "MicroVM");
  const rawEndpoint = expectString(output.endpoint, "endpoint");
  const egressNetworkConnectors =
    output.egressNetworkConnectors === undefined
      ? []
      : expectArray(output.egressNetworkConnectors, "egressNetworkConnectors");
  return {
    egressNetworkConnectorArns: egressNetworkConnectors.map((connector, index) =>
      expectString(connector, `egressNetworkConnectors[${index}]`),
    ),
    endpoint: rawEndpoint.startsWith("http") ? rawEndpoint : `https://${rawEndpoint}`,
    imageArn: expectString(output.imageArn, "imageArn"),
    imageVersion: expectString(output.imageVersion, "imageVersion"),
    microvmId: expectString(output.microvmId, "microvmId"),
    state: expectMicrovmState(output.state),
    stateReason: optionalString(output.stateReason),
  };
}

function expectMicrovmState(value: unknown): AwsLambdaMicrovmState {
  if (
    value === "PENDING" ||
    value === "RUNNING" ||
    value === "SUSPENDED" ||
    value === "SUSPENDING" ||
    value === "TERMINATED" ||
    value === "TERMINATING"
  ) {
    return value;
  }
  throw new Error(`AWS Lambda MicroVM returned invalid state ${String(value)}.`);
}

function expectImageVersionState(value: unknown): AwsLambdaMicrovmImageVersionRecord["state"] {
  if (
    value === "PENDING" ||
    value === "IN_PROGRESS" ||
    value === "SUCCESSFUL" ||
    value === "FAILED" ||
    value === "DELETING" ||
    value === "DELETE_FAILED" ||
    value === "DELETED"
  ) {
    return value;
  }
  throw new Error(`AWS Lambda MicroVM returned invalid image state ${String(value)}.`);
}

function expectImageVersionStatus(value: unknown): AwsLambdaMicrovmImageVersionRecord["status"] {
  if (value === undefined || value === "ACTIVE" || value === "INACTIVE") return value;
  throw new Error(`AWS Lambda MicroVM returned invalid image status ${String(value)}.`);
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`AWS Lambda MicroVM response field ${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new Error(`AWS Lambda MicroVM response field ${name} is invalid.`);
  return value;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`AWS Lambda MicroVM response field ${name} is invalid.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAwsNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { readonly name?: unknown }).name === "ResourceNotFoundException" ||
      (error as { readonly $metadata?: { readonly httpStatusCode?: unknown } }).$metadata
        ?.httpStatusCode === 404)
  );
}
