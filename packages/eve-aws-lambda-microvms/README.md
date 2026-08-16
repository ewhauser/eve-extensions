# Eve AWS Lambda MicroVM sandboxes

> Extracted from [vercel/eve#208](https://github.com/vercel/eve/pull/208), authored by Andrew Barba, and adapted into a standalone package for Eve 0.38.0. This package is licensed under Apache-2.0; see `LICENSE`. See `NOTICE` for upstream attribution and a summary of the packaging changes.

The `awsLambdaMicrovm()` backend runs each durable eve sandbox in an ARM64 [AWS Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html). It is explicit opt-in: `defaultBackend()` never selects AWS.

eve creates and tags MicroVM images, launches MicroVMs, and stores image artifacts, leases, template descriptors, and full-filesystem checkpoints under one prefix in your S3 bucket. eve does not create the bucket, IAM roles, VPCs, or network connectors.

## Install

This initial package targets Eve 0.38.0 exactly:

```sh
pnpm add eve@0.38.0 eve-aws-lambda-microvms
```

## Configure the backend

Create the bucket and roles first, then author the sandbox:

```ts title="agent/sandbox/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { awsLambdaMicrovm } from "eve-aws-lambda-microvms";

export default defineSandbox({
  backend: awsLambdaMicrovm({
    applicationId: "analytics-agent",
    region: "us-east-1",
    artifactBucket: "company-eve-sandboxes",
    artifactKmsKeyId: process.env.EVE_AWS_ARTIFACT_KMS_KEY_ARN,
    buildRoleArn: process.env.EVE_AWS_BUILD_ROLE_ARN!,
    executionRoleArn: process.env.EVE_AWS_EXECUTION_ROLE_ARN,
  }),
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.run({ command: "dnf install -y git jq" });
  },
});
```

`applicationId` is a stable resource namespace, not a display label. Keep it identical at build and runtime. The package replaces Eve 0.38.0's path-derived key scope with this application scope so templates and sessions remain stable when build and deployment roots differ. The bucket must be in `region`. The default prefix is `eve/lambda-microvms/<application-id-hash>`; set `artifactPrefix` when the bucket policy requires a fixed path.

`artifactKmsKeyId` is optional. When supplied, eve sends explicit `aws:kms` and key-ID headers on JSON, image-artifact, and multipart checkpoint writes. AWS accepts a key ID, key ARN, alias name, or alias ARN; cross-account keys require an ARN. Grant callers `kms:Encrypt`, `kms:Decrypt`, and `kms:GenerateDataKey` as needed for that key. When omitted, eve sends no SSE headers and preserves the bucket's default encryption behavior.

The important defaults are 2 GiB baseline memory, an eight-hour maximum lifetime, suspension after five minutes without endpoint traffic, suspended retention for 30 minutes, automatic resume, no shell access, and no guest execution role. For compatibility, omitted `networkingMode` (or explicit `"legacy"`) retains 0.1.0's managed Internet connector defaults. Production callers should use the explicit fail-closed `"customer-managed"` mode below. Supplying an execution role enables CloudWatch runtime logging by default. Set `runtimeLogging: false` to disable it.

`eve dev` and `eve start` provision authored bootstrap and workspace templates. Eve's Vercel build hook also prewarms them during `eve build`. When Eve supplies no template key, this package lazily provisions an empty application template during the first session create. That caller therefore needs image-build permissions unless the same default template was already provisioned.

## Persistence and lifecycle

Before eve terminates a session, it freezes workload processes and publishes the complete writable overlay to S3. The archive preserves numeric ownership, modes, links, ACLs, xattrs, device entries, and overlay whiteouts. It excludes `/proc`, `/sys`, `/dev`, `/run`, and controller state.

AWS terminates every MicroVM by its configured maximum duration, at the end of suspended retention, or after an operational failure. On the next turn, eve launches the exact image version recorded in the checkpoint and restores all writable paths, including changes under `/etc`, `/usr/local`, `/root`, `/var`, `/tmp`, and `/workspace`. Files survive replacement; processes do not. If AWS has recalled or removed the recorded image version, eve leaves the checkpoint intact and fails instead of restoring only `/workspace` onto a different image.

S3 conditional manifests and per-session leases reject concurrent writers. eve never puts AWS credentials, auth tokens, or presigned URLs in durable session metadata.

## IAM boundaries

Use separate identities for the caller running `eve build`, the deployed runtime caller, the Lambda build role, and the optional guest execution role. Replace the account, Region, bucket, prefix, role, and image values below with your own. Tighten `Resource` entries further where your IAM setup supports it.

Both service roles trust Lambda. Add confused-deputy conditions:

```json title="Build role trust policy"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": ["sts:AssumeRole", "sts:TagSession"],
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "123456789012" },
        "ArnLike": {
          "aws:SourceArn": "arn:aws:lambda:us-east-1:123456789012:microvm-image:*"
        }
      }
    }
  ]
}
```

The build role reads the uploaded image artifact and writes build logs. It does not need permission to manage images:

```json title="Build role permissions"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::company-eve-sandboxes/eve/lambda-microvms/*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:us-east-1:123456789012:*"
    }
  ]
}
```

The build caller manages images, passes the service roles, and reads and writes the artifact prefix:

```json title="Build caller policy"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:CreateMicrovmImage",
        "lambda:GetMicrovmImageVersion",
        "lambda:ListMicrovmImages",
        "lambda:ListMicrovmImageVersions",
        "lambda:ListManagedMicrovmImages",
        "lambda:ListManagedMicrovmImageVersions",
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:SuspendMicrovm",
        "lambda:ResumeMicrovm",
        "lambda:TerminateMicrovm",
        "lambda:CreateMicrovmAuthToken"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::123456789012:role/eve-microvm-build",
        "arn:aws:iam::123456789012:role/eve-microvm-guest"
      ],
      "Condition": {
        "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" }
      }
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetBucketLocation",
      "Resource": "arn:aws:s3:::company-eve-sandboxes"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::company-eve-sandboxes/eve/lambda-microvms/*"
    }
  ]
}
```

The runtime caller needs lifecycle, token, tag, S3 checkpoint, and execution-role pass permissions, but not image creation or build-role pass permissions:

```json title="Runtime caller policy"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:SuspendMicrovm",
        "lambda:ResumeMicrovm",
        "lambda:TerminateMicrovm",
        "lambda:CreateMicrovmAuthToken"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::123456789012:role/eve-microvm-guest",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" }
      }
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetBucketLocation",
      "Resource": "arn:aws:s3:::company-eve-sandboxes"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::company-eve-sandboxes/eve/lambda-microvms/*"
    }
  ]
}
```

The runtime caller needs read access to image and template objects and read/write access to session manifests, leases, temporary multipart objects, and checkpoints. Keep build and runtime prefixes separate with bucket-policy conditions when your organization requires stricter deployment separation.

The optional execution role is guest-visible through IMDS. Its trust policy should use the same service principal and `aws:SourceAccount`, with a MicroVM source ARN:

```json title="Guest execution role trust policy"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": ["sts:AssumeRole", "sts:TagSession"],
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "123456789012" },
        "ArnLike": {
          "aws:SourceArn": "arn:aws:lambda:us-east-1:123456789012:microvm:*"
        }
      }
    }
  ]
}
```

Grant that role only the AWS APIs workload code is intentionally allowed to call, plus CloudWatch Logs permissions when runtime logging is enabled. Never grant it access to the artifact prefix or checkpoint bucket. Omitting `executionRoleArn` is the safest default and prevents guest AWS credentials.

See AWS's [security and permissions](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html) documentation for the current action and ARN reference.

## Networking

eve always attaches AWS's `ALL_INGRESS` connector and creates auth tokens scoped only to controller port 8080. Tokens last at most 60 minutes, are refreshed before expiry, and are never persisted. `shellAccess: true` additionally attaches `SHELL_INGRESS`; shell tokens still come from AWS's separate shell-token API.

For production, select customer-managed networking explicitly and provide the non-secret policy lane bound to each connector:

```ts
awsLambdaMicrovm({
  // required fields omitted
  networkingMode: "customer-managed",
  egressProxyCaBundlePem: process.env.EVE_EGRESS_PROXY_PUBLIC_CA_PEM,
  buildNetworkLaneId: "package-build-v1",
  buildEgressNetworkConnectorArns: [process.env.EVE_AWS_BUILD_CONNECTOR_ARN!],
  runtimeNetworkLaneId: "agent-runtime-v1",
  runtimeEgressNetworkConnectorArns: [process.env.EVE_AWS_RUNTIME_CONNECTOR_ARN!],
});
```

`egressProxyCaBundlePem` accepts only one or more public X.509 `CERTIFICATE` PEM blocks. eve
normalizes the bundle, rejects private-key or other PEM blocks, and bakes the public certificates
into the AL2023 system trust store before the controlled guest root is captured. The private CA key
must remain in the trusted proxy workload and must never be passed to this package, the MicroVM,
the image artifact, checkpoints, or logs. Omitting the bundle preserves the existing trust store;
deployments that intercept TLS must provision the public bundle before enabling that path.

This mode requires exactly one connector for image build/template prewarm and exactly one for live sessions. Both must be customer-managed connector ARNs in the configured Region and the build role's AWS account. Missing, blank, empty, multiple, cross-Region, cross-account, and AWS-managed `INTERNET_EGRESS` values fail before AWS clients are constructed. The connector AWS reports for each launched MicroVM is checked before controller traffic; a mismatch is terminated. Session metadata records the runtime lane ID, connector ARN, and public trust-bundle digest, and stale reattachment is terminated and replaced before exposing the guest. Changing the public bundle creates a new deterministic image/config identity. After the updated template is provisioned, the next replacement launches that image and restores the checksum-verified writable checkpoint onto it instead of silently reusing the old trust root.

Legacy mode continues to default both phases to `INTERNET_EGRESS` and preserves explicit connector arrays (including `[]`) for existing consumers. Do not use legacy mode as a production no-Internet control: explicit empty-array behavior is an AWS API semantic rather than this package's strict invariant. Connectors are fixed at launch, so `sandbox.setNetworkPolicy()` throws for this backend. Configure VPC security groups, network ACLs, routing, and DNS on the connector instead.

The controller uploads and restores checkpoints through short-lived S3 presigned URLs. A restricted VPC path must therefore reach the bucket, normally through an S3 gateway endpoint or controlled NAT. See AWS's [MicroVM networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html) guide.

### Protocol v2 replacement lifecycle

Customer-managed sessions require an injected activation provider. Each launch receives a strict,
secret-free activation envelope smaller than 4 KiB containing an opaque provider credential
placeholder with its exact environment-variable placement and generations, a separate opaque
localhost controller-session token, an activation identifier, and the immutable controller CA
digest. Neither opaque value is a JWT or authorization assertion. JWT-shaped input is rejected;
the guest never receives, requests, renews, validates, or presents an egress JWT, and placeholder
possession establishes no authority.

Session metadata v2 persists the non-secret activation identifier, placeholder placement and
generation, trusted-binding generation, controller CA digest, and public egress-proxy CA digest.
Capture commits the verified
checkpoint manifest, revokes the old trusted proxy binding, and then terminates the MicroVM.
Opening the session again always launches a fresh MicroVM, installs fresh placeholder/binding
generations and fresh local controller authentication, and verifies the exact singleton connector,
image, protocol, controller CA digest, public proxy CA digest, placement, and generations before
restoring the checksum-verified checkpoint. There is no native suspend/resume or stale-placeholder
fallback.

## Operations and retention

Image build logs use `/aws/lambda/microvms/<image-name>` unless you supply another CloudWatch target. Runtime logs use the configured `runtimeLogging` group. eve logs lifecycle phases and failures, but not command text or environment values. Enable CloudTrail management events for Lambda operations and S3 data events on the artifact prefix when you need an audit trail.

eve does not prune images or durable checkpoints. Configure S3 lifecycle rules appropriate to your retention policy for abandoned multipart uploads, temporary objects, noncurrent object versions, old checkpoint generations, and deleted applications. Do not expire the currently referenced checkpoint or template descriptor.

For failures, start with the image version `stateReason`, its CloudWatch build stream, and AWS's [troubleshooting guide](https://docs.aws.amazon.com/lambda/latest/dg/microvms-troubleshooting.html). Also review AWS's [snapshot model](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html) and [best practices](https://docs.aws.amazon.com/lambda/latest/dg/microvms-best-practices.html).

## Atomic AWS end-to-end tests

This repository includes an opt-in live acceptance harness. Each run creates a unique
CloudFormation stack containing a private encrypted S3 bucket and a Lambda MicroVM image-build
role. The application id, image, MicroVMs, S3 prefix, and image tags are unique to that stack.
The runner always attempts the following teardown sequence, whether the tests pass or fail:

1. Find images tagged with the generated stack name.
2. Terminate every MicroVM using those images.
3. Delete the images and wait for them to disappear.
4. Delete the image-build CloudWatch log groups.
5. Delete all S3 objects and abort multipart uploads.
6. Delete the CloudFormation stack and wait for completion.

The live suite validates package-level image provisioning and reuse, command and file APIs, and
full-filesystem restore after checkpoint termination. It
then runs the deterministic Eve fixture in `apps/eve-aws-lambda-microvms-e2e`. That fixture sends
an attachment through Eve's real staging path, loads a packaged skill, reads its sibling reference,
resumes the session, forcibly terminates its MicroVM, and repeats the attachment and skill checks
after replacement. It uses Eve's mock model, so no model-provider key is needed.

Select a disposable AWS account and credentials before opting in. The caller must be able to use
CloudFormation, create and delete the temporary IAM role and S3 bucket, pass the build role to
Lambda, and perform these MicroVM actions:

```text
lambda:CreateMicrovmImage
lambda:CreateMicrovmAuthToken
lambda:DeleteMicrovmImage
lambda:GetMicrovm
lambda:GetMicrovmImageVersion
lambda:ListManagedMicrovmImages
lambda:ListManagedMicrovmImageVersions
lambda:ListMicrovmImages
lambda:ListMicrovmImageVersions
lambda:ListMicrovms
lambda:ListTags
lambda:ResumeMicrovm
lambda:RunMicrovm
lambda:SuspendMicrovm
lambda:TerminateMicrovm
```

The caller also needs `logs:DescribeLogGroups` and `logs:DeleteLogGroup` so the image-build log
group does not outlive its test stack.

Inspect the exact CloudFormation template without making AWS calls:

```sh
pnpm --filter eve-aws-lambda-microvms test:aws:plan
```

Run the suite:

```sh
AWS_PROFILE=eve-microvm-test \
AWS_REGION=us-east-1 \
EVE_AWS_E2E_ACCOUNT_ID=123456789012 \
EVE_RUN_AWS_MICROVM_E2E=1 \
pnpm --filter eve-aws-lambda-microvms test:aws
```

The account id is mandatory and must match `sts:GetCallerIdentity`; a stale or incorrect profile is
rejected before CloudFormation is called.

The generated stack name is printed before provisioning. If the process is killed in a way that
prevents its `finally` cleanup from running, use that name to invoke the idempotent recovery path:

```sh
AWS_PROFILE=eve-microvm-test \
pnpm --filter eve-aws-lambda-microvms test:aws:cleanup -- \
  --stack eve-microvm-e2e-YYYYMMDDHHMMSS-xxxxxxxx \
  --region us-east-1
```

The runner catches `SIGINT` and `SIGTERM` and finishes teardown before exiting. No process can
guarantee teardown after `SIGKILL`, machine loss, or credential revocation; the recovery command,
unique tags, 15-minute MicroVM maximum duration, and CloudFormation ownership are the backstops for
those cases. The first run builds a unique image and can take several minutes.

## License

`eve-aws-lambda-microvms` is licensed under the [Apache License 2.0](./LICENSE). The package includes code derived from `vercel/eve`; attribution and modification details are recorded in [NOTICE](./NOTICE).
