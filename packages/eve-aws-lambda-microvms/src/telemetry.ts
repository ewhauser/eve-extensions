import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { performance } from "node:perf_hooks";

const INSTRUMENTATION_NAME = "eve-aws-lambda-microvms";

const tracer = trace.getTracer(INSTRUMENTATION_NAME);
const meter = metrics.getMeter(INSTRUMENTATION_NAME);
const operationDuration = meter.createHistogram(
  "eve.aws_lambda_microvm.operation.duration",
  {
    description: "Duration of AWS Lambda MicroVM lifecycle operations.",
    unit: "s",
  },
);
const operationCount = meter.createCounter("eve.aws_lambda_microvm.operation.count", {
  description: "Completed AWS Lambda MicroVM lifecycle operations.",
  unit: "{operation}",
});

export interface AwsLambdaMicrovmTelemetryOperation {
  readonly attributes?: Attributes;
  readonly metricAttributes?: Attributes;
  readonly name: string;
}

/** Records one lifecycle operation as a span plus bounded duration/count metrics. */
export async function instrumentAwsLambdaMicrovmOperation<T>(
  input: AwsLambdaMicrovmTelemetryOperation,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return await tracer.startActiveSpan(input.name, { attributes: input.attributes }, async (span) => {
    const startedAt = performance.now();
    let outcome = "success";
    try {
      const result = await operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      outcome = "error";
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      const attributes: Attributes = {
        ...input.metricAttributes,
        "eve.aws_lambda_microvm.operation": input.name,
        "eve.aws_lambda_microvm.outcome": outcome,
      };
      operationDuration.record((performance.now() - startedAt) / 1000, attributes);
      operationCount.add(1, attributes);
      span.end();
    }
  });
}

/** Adds retry-safe AWS metadata without recording request inputs or credentials. */
export function recordAwsSdkMetadata(span: Span, value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const metadata = (value as { readonly $metadata?: unknown }).$metadata;
  if (typeof metadata !== "object" || metadata === null) return;
  const record = metadata as Record<string, unknown>;
  if (typeof record.requestId === "string") {
    span.setAttribute("aws.request_id", record.requestId);
  }
  if (typeof record.attempts === "number") {
    span.setAttribute("aws.sdk.attempts", record.attempts);
  }
  if (typeof record.totalRetryDelay === "number") {
    span.setAttribute("aws.sdk.total_retry_delay_ms", record.totalRetryDelay);
  }
  if (typeof record.httpStatusCode === "number") {
    span.setAttribute("http.response.status_code", record.httpStatusCode);
  }
}
