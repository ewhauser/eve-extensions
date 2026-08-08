# Eve AWS Lambda MicroVM sandboxes

> Extracted from [vercel/eve#208](https://github.com/vercel/eve/pull/208), authored by Andrew Barba, and adapted into a standalone package for Eve 0.31.3. This package is licensed under Apache-2.0; see `LICENSE`. See `NOTICE` for upstream attribution and a summary of the packaging changes.

The `awsLambdaMicrovm()` backend runs each durable eve sandbox in an ARM64 [AWS Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html). It is explicit opt-in: `defaultBackend()` never selects AWS.

eve creates and tags MicroVM images, launches MicroVMs, and stores image artifacts, leases, template descriptors, and full-filesystem checkpoints under one prefix in your S3 bucket. eve does not create the bucket, IAM roles, VPCs, or network connectors.

## Install

This initial package targets Eve 0.31.3 exactly:

```sh
pnpm add eve@0.31.3 eve-aws-lambda-microvms
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
    buildRoleArn: process.env.EVE_AWS_BUILD_ROLE_ARN!,
    executionRoleArn: process.env.EVE_AWS_EXECUTION_ROLE_ARN,
  }),
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.run({ command: "dnf install -y git jq" });
  },
});
```

`applicationId` is a stable resource namespace, not a display label. Keep it identical at build and runtime. The package replaces Eve 0.31.3's path-derived key scope with this application scope so templates and sessions remain stable when build and deployment roots differ. The bucket must be in `region`. The default prefix is `eve/lambda-microvms/<application-id-hash>`; set `artifactPrefix` when the bucket policy requires a fixed path.

The important defaults are 2 GiB baseline memory, an eight-hour maximum lifetime, suspension after five minutes without endpoint traffic, suspended retention for 30 minutes, automatic resume, managed internet egress, no shell access, and no guest execution role. Supplying an execution role enables CloudWatch runtime logging by default. Set `runtimeLogging: false` to disable it.

`eve dev` and `eve start` provision authored bootstrap and workspace templates. Eve's Vercel build hook also prewarms them during `eve build`. When Eve supplies no template key, this package lazily provisions an empty application template during the first session create. That caller therefore needs image-build permissions unless the same default template was already provisioned.

## Persistence and lifecycle

Native AWS suspension retains memory, files, and running processes. Before eve explicitly suspends a session, it freezes workload processes and publishes the complete writable overlay to S3. The archive preserves numeric ownership, modes, links, ACLs, xattrs, device entries, and overlay whiteouts. It excludes `/proc`, `/sys`, `/dev`, `/run`, and controller state.

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

The build caller manages images, tags resources, passes the service roles, and reads and writes the artifact prefix:

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
        "lambda:CreateMicrovmAuthToken",
        "lambda:TagResource"
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
        "lambda:CreateMicrovmAuthToken",
        "lambda:TagResource"
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

Build and runtime egress use `INTERNET_EGRESS` by default. Pass custom connector ARNs through `buildEgressNetworkConnectorArns` and `runtimeEgressNetworkConnectorArns`. An explicit empty array means no egress. Connectors are fixed at launch, so `sandbox.setNetworkPolicy()` throws for this backend. Configure VPC security groups, network ACLs, routing, and DNS on the connector instead.

The controller uploads and restores checkpoints through short-lived S3 presigned URLs. A restricted VPC path must therefore reach the bucket, normally through an S3 gateway endpoint or controlled NAT. See AWS's [MicroVM networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html) guide.

## Operations and retention

Image build logs use `/aws/lambda/microvms/<image-name>` unless you supply another CloudWatch target. Runtime logs use the configured `runtimeLogging` group. eve logs lifecycle phases and failures, but not command text or environment values. Enable CloudTrail management events for Lambda operations and S3 data events on the artifact prefix when you need an audit trail.

eve does not prune images or durable checkpoints. Configure S3 lifecycle rules appropriate to your retention policy for abandoned multipart uploads, temporary objects, noncurrent object versions, old checkpoint generations, and deleted applications. Do not expire the currently referenced checkpoint or template descriptor.

For failures, start with the image version `stateReason`, its CloudWatch build stream, and AWS's [troubleshooting guide](https://docs.aws.amazon.com/lambda/latest/dg/microvms-troubleshooting.html). Also review AWS's [snapshot model](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html) and [best practices](https://docs.aws.amazon.com/lambda/latest/dg/microvms-best-practices.html).

## License

`eve-aws-lambda-microvms` is licensed under the [Apache License 2.0](./LICENSE). The package includes code derived from `vercel/eve`; attribution and modification details are recorded in [NOTICE](./NOTICE).
