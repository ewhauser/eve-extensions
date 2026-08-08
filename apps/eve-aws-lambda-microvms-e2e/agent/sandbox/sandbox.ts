import { awsLambdaMicrovm } from "eve-aws-lambda-microvms";
import { defineSandbox } from "eve/sandbox";

const stackName = required("EVE_AWS_E2E_STACK_NAME");

export default defineSandbox({
  backend: awsLambdaMicrovm({
    applicationId: required("EVE_AWS_E2E_APPLICATION_ID"),
    artifactBucket: required("EVE_AWS_E2E_ARTIFACT_BUCKET"),
    artifactPrefix: `runs/${stackName}/eve-fixture`,
    buildRoleArn: required("EVE_AWS_E2E_BUILD_ROLE_ARN"),
    idlePolicy: {
      autoResumeEnabled: true,
      maxIdleDurationSeconds: 60,
      suspendedDurationSeconds: 300,
    },
    maximumDurationSeconds: 900,
    memoryMiB: 512,
    region: required("EVE_AWS_E2E_REGION"),
    runtimeLogging: false,
    tags: { "eve-e2e-stack": stackName },
  }),
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the AWS MicroVM E2E fixture.`);
  return value;
}
