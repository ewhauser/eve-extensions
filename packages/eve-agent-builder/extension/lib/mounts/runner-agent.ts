import { defineAgent, defineDynamic, type AgentStaticModelDefinition } from "eve";

import { parseBootstrapMessage, type ExecutionRole } from "../bootstrap.js";
import type { RunnerCapabilityMode } from "../capabilities.js";
import { eventTurnId, getAgentBuilderRuntime, inspectRunnerTurn, resolveDynamicOwner } from "../runtime/service.js";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
        ? (part as Record<string, unknown>).text
        : "",
    )
    .join("");
}

function latestUserMessage(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message?.role === "user") return messageText(message.content);
  }
  return "";
}

export function createAgentBuilderGuardedModel(input: {
  readonly role: ExecutionRole;
  readonly mode: RunnerCapabilityMode;
  readonly model: AgentStaticModelDefinition;
  readonly modelContextWindowTokens: number;
}) {
  const selection = {
    model: input.model,
    modelContextWindowTokens: input.modelContextWindowTokens,
  } as const;
  return defineDynamic({
    events: {
      "step.started": async (event, ctx) => {
        const runtime = getAgentBuilderRuntime();
        const owner = await resolveDynamicOwner(runtime, ctx);
        const lease = await runtime.config.store.getExecutionLease({
          owner,
          childSessionId: ctx.session.id,
        });
        if (lease === null) {
          if (parseBootstrapMessage(latestUserMessage(ctx.messages)) === null) {
            throw new Error("BOOTSTRAP_REQUIRED");
          }
          return selection;
        }
        const turnId = eventTurnId(event);
        if (lease.role !== input.role) throw new Error("BOOTSTRAP_BINDING_MISMATCH");
        if (lease.bootstrapTurnId === turnId && lease.status === "ready") return selection;
        const prepared = await inspectRunnerTurn({ ...input, event, ctx, begin: true });
        if (!prepared.ok) throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
        return selection;
      },
    },
  });
}

export function defineAgentBuilderRoleAgent(input: {
  readonly role: ExecutionRole;
  readonly mode: RunnerCapabilityMode;
  readonly model: AgentStaticModelDefinition;
  readonly modelContextWindowTokens: number;
  readonly description: string;
}) {
  return defineAgent({
    description: input.description,
    model: createAgentBuilderGuardedModel(input),
  });
}
