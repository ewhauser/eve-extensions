export const E2E_STACK_TAG_KEY = "eve-e2e-stack";

export interface E2eStackTemplate {
  readonly AWSTemplateFormatVersion: "2010-09-09";
  readonly Description: string;
  readonly Outputs: Record<string, unknown>;
  readonly Resources: Record<string, unknown>;
}

/**
 * The test runner deliberately creates only infrastructure that CloudFormation
 * can own. MicroVM images and instances are tagged and removed by the runner
 * before this stack is deleted.
 */
export function createE2eStackTemplate(stackName: string): E2eStackTemplate {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Temporary infrastructure for eve AWS Lambda MicroVM end-to-end tests",
    Resources: {
      ArtifactBucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
            ],
          },
          LifecycleConfiguration: {
            Rules: [
              {
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
                Id: "abort-incomplete-uploads",
                Status: "Enabled",
              },
            ],
          },
          OwnershipControls: {
            Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
          },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          Tags: [{ Key: E2E_STACK_TAG_KEY, Value: stackName }],
        },
      },
      MicrovmBuildRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Action: ["sts:AssumeRole", "sts:TagSession"],
                Condition: {
                  ArnLike: {
                    "aws:SourceArn": {
                      "Fn::Sub":
                        "arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:microvm-image:*",
                    },
                  },
                  StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
                },
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
              },
            ],
          },
          Policies: [
            {
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Action: "s3:GetObject",
                    Effect: "Allow",
                    Resource: { "Fn::Sub": "${ArtifactBucket.Arn}/*" },
                  },
                  {
                    Action: [
                      "logs:CreateLogGroup",
                      "logs:CreateLogStream",
                      "logs:PutLogEvents",
                    ],
                    Effect: "Allow",
                    Resource: {
                      "Fn::Sub":
                        "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:*",
                    },
                  },
                ],
              },
              PolicyName: "microvm-image-build",
            },
          ],
          Tags: [{ Key: E2E_STACK_TAG_KEY, Value: stackName }],
        },
      },
    },
    Outputs: {
      ArtifactBucketName: { Value: { Ref: "ArtifactBucket" } },
      BuildRoleArn: { Value: { "Fn::GetAtt": ["MicrovmBuildRole", "Arn"] } },
    },
  };
}

export function serializeE2eStackTemplate(stackName: string): string {
  return JSON.stringify(createE2eStackTemplate(stackName));
}
