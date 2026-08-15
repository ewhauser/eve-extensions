import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classifierErrorCode,
  classifyParticipation,
} from "../../extension/lib/classifier.js";
import { buildClassifierContext } from "../../extension/lib/context.js";
import type {
  ClassifierResult,
  ClassifierSlackParticipationConfig,
  SlackParticipationDecisionValue,
} from "../../extension/lib/types.js";
import {
  engineeringConversationEvalCases,
  gradeEngineeringConversation,
  materializeEngineeringConversation,
} from "./engineering-conversations.js";

const configuredModels =
  process.env.EVE_SLACK_PARTICIPATION_EVAL_MODELS?.trim() ||
  process.env.EVE_SLACK_PARTICIPATION_EVAL_MODEL?.trim();
if (!configuredModels) {
  throw new Error(
    "Set EVE_SLACK_PARTICIPATION_EVAL_MODELS to comma-separated AI SDK gateway model ids before running pnpm eval.",
  );
}

const modelIds = [...new Set(
  configuredModels
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
)];

const requestedIds = new Set(
  (process.env.EVE_SLACK_PARTICIPATION_EVAL_CASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedCases = requestedIds.size === 0
  ? engineeringConversationEvalCases
  : engineeringConversationEvalCases.filter((testCase) => requestedIds.has(testCase.id));

if (selectedCases.length === 0 || selectedCases.length !== (requestedIds.size || selectedCases.length)) {
  throw new Error(
    `No exact eval-case match for: ${[...requestedIds].join(", ")}. ` +
      `Available ids: ${engineeringConversationEvalCases.map((testCase) => testCase.id).join(", ")}`,
  );
}

interface GatewayPricing {
  readonly input: number;
  readonly output: number;
  readonly inputCacheRead?: number;
  readonly inputCacheWrite?: number;
}

interface EvalObservation {
  readonly modelId: string;
  readonly caseId: string;
  readonly expectedDecision: SlackParticipationDecisionValue;
  readonly actual?: ClassifierResult;
  readonly mismatches: readonly string[];
  readonly errorCode?: string;
}

const observations: EvalObservation[] = [];
const pricingByModel = new Map<string, GatewayPricing>();

beforeAll(async () => {
  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return;
    const catalog = await response.json() as {
      readonly data?: readonly {
        readonly id?: string;
        readonly pricing?: {
          readonly input?: string;
          readonly output?: string;
          readonly input_cache_read?: string;
          readonly input_cache_write?: string;
        };
      }[];
    };
    for (const entry of catalog.data ?? []) {
      if (!entry.id || !modelIds.includes(entry.id)) continue;
      const input = Number(entry.pricing?.input);
      const output = Number(entry.pricing?.output);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      const inputCacheRead = Number(entry.pricing?.input_cache_read);
      const inputCacheWrite = Number(entry.pricing?.input_cache_write);
      pricingByModel.set(entry.id, {
        input,
        output,
        ...(Number.isFinite(inputCacheRead) ? { inputCacheRead } : {}),
        ...(Number.isFinite(inputCacheWrite) ? { inputCacheWrite } : {}),
      });
    }
  } catch {
    // Accuracy and latency remain useful when the public pricing catalog is unavailable.
  }
});

for (const modelId of modelIds) {
  describe.sequential(`engineering Slack participation eval (${modelId})`, () => {
    for (const testCase of selectedCases) {
      it(
        testCase.id,
        async () => {
          const materialized = materializeEngineeringConversation(testCase);
          const context = buildClassifierContext({
            ...materialized,
            maxMessages: 12,
            maxCharacters: 12_000,
            groupRequests: testCase.groupRequests,
          });
          const config: ClassifierSlackParticipationConfig = {
            strategy: "classifier",
            model: modelId,
            mode: "enforce",
            recentMessages: 12,
            maxContextCharacters: 12_000,
            timeoutMs: 10_000,
            groupRequests: testCase.groupRequests,
          };
          try {
            const actual = await classifyParticipation({ config, context });
            const grade = gradeEngineeringConversation(testCase, actual);
            observations.push({
              modelId,
              caseId: testCase.id,
              expectedDecision: testCase.expected.decision,
              actual,
              mismatches: grade.mismatches,
            });

            expect(
              grade.mismatches,
              `${testCase.description}\nActual: ${JSON.stringify({
                decision: actual.decision,
                addressee: actual.addressee,
                reason: actual.reason,
              })}`,
            ).toEqual([]);
          } catch (error) {
            if (!observations.some(
              (observation) => observation.modelId === modelId && observation.caseId === testCase.id,
            )) {
              const errorCode = classifierErrorCode(error);
              observations.push({
                modelId,
                caseId: testCase.id,
                expectedDecision: testCase.expected.decision,
                mismatches: [errorCode],
                errorCode,
              });
              throw new Error(`${modelId}/${testCase.id}: ${errorCode}`);
            }
            throw error;
          }
        },
        15_000,
      );
    }
  });
}

function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0
    ? present.reduce((total, value) => total + value, 0)
    : undefined;
}

function estimatedCost(
  rows: readonly EvalObservation[],
  pricing: GatewayPricing | undefined,
): number | undefined {
  if (!pricing) return undefined;
  let cost = 0;
  let pricedRows = 0;
  for (const row of rows) {
    const actual = row.actual;
    if (!actual || actual.outputTokens === undefined) continue;
    const cacheRead = actual.cacheReadInputTokens ?? 0;
    const cacheWrite = actual.cacheWriteInputTokens ?? 0;
    const uncached = actual.uncachedInputTokens ?? (
      actual.inputTokens === undefined
        ? undefined
        : Math.max(0, actual.inputTokens - cacheRead - cacheWrite)
    );
    if (uncached === undefined) continue;
    cost += uncached * pricing.input;
    cost += cacheRead * (pricing.inputCacheRead ?? pricing.input);
    cost += cacheWrite * (pricing.inputCacheWrite ?? pricing.input);
    cost += actual.outputTokens * pricing.output;
    pricedRows += 1;
  }
  return pricedRows > 0 ? cost : undefined;
}

afterAll(() => {
  const summaries = modelIds.map((modelId) => {
    const rows = observations.filter((observation) => observation.modelId === modelId);
    const exact = rows.filter((row) => row.mismatches.length === 0).length;
    const decisionCorrect = rows.filter(
      (row) => (row.actual?.decision ?? "SILENT") === row.expectedDecision,
    ).length;
    const falseWakes = rows.filter(
      (row) => row.expectedDecision === "SILENT" &&
        (row.actual?.decision ?? "SILENT") === "RESPOND",
    ).length;
    const missedWakes = rows.filter(
      (row) => row.expectedDecision === "RESPOND" &&
        (row.actual?.decision ?? "SILENT") === "SILENT",
    ).length;
    const latency = rows.map((row) => row.actual?.latencyMs).filter(
      (value): value is number => value !== undefined,
    );
    const cost = estimatedCost(rows, pricingByModel.get(modelId));
    return {
      model: modelId,
      exact: `${exact}/${selectedCases.length}`,
      decision: `${decisionCorrect}/${selectedCases.length}`,
      falseWakes,
      missedWakes,
      errors: rows.filter((row) => row.errorCode !== undefined).length,
      p50Ms: percentile(latency, 0.5),
      p95Ms: percentile(latency, 0.95),
      inputTokens: sum(rows.map((row) => row.actual?.inputTokens)),
      outputTokens: sum(rows.map((row) => row.actual?.outputTokens)),
      estimatedCostUsd: cost === undefined ? undefined : Number(cost.toFixed(6)),
      costPer1kUsd: cost === undefined || rows.length === 0
        ? undefined
        : Number(((cost / rows.length) * 1_000).toFixed(4)),
    };
  });

  console.table(summaries);
  console.log(`EVE_SLACK_PARTICIPATION_EVAL_SUMMARY=${JSON.stringify(summaries)}`);
});
