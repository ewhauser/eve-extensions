export {
  AWS_LAMBDA_MICROVM_BACKEND_NAME,
  awsLambdaMicrovm,
  createAwsLambdaMicrovmSandbox,
} from "./backend.js";
export {
  AWS_LAMBDA_MICROVM_ACTIVATION_VERSION,
  AWS_LAMBDA_MICROVM_MAX_ACTIVATION_BYTES,
  createAwsLambdaMicrovmActivationEnvelope,
  serializeAwsLambdaMicrovmActivationEnvelope,
  validateAwsLambdaMicrovmActivationEnvelope,
} from "./activation.js";
export type {
  AwsLambdaMicrovmActivationEnvelope,
  AwsLambdaMicrovmActivationIssuer,
  AwsLambdaMicrovmActivationRequest,
} from "./activation.js";
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
  AwsLambdaMicrovmNetworkingMode,
  AwsLambdaMicrovmSandboxOptions,
} from "./types.js";
