export {
  AWS_LAMBDA_MICROVM_BACKEND_NAME,
  awsLambdaMicrovm,
  createAwsLambdaMicrovmSandbox,
} from "./backend.js";
export type {
  AwsLambdaMicrovmBackendServices,
  AwsLambdaMicrovmSandboxBackend,
  CreateAwsLambdaMicrovmSandboxInput,
} from "./backend.js";
export type {
  AwsLambdaMicrovmBaseImage,
  AwsLambdaMicrovmCloudWatchLogging,
  AwsLambdaMicrovmIdlePolicy,
  AwsLambdaMicrovmMemoryMiB,
  AwsLambdaMicrovmSandboxOptions,
} from "./types.js";
