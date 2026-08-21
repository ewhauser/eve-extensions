import { defineHook, type HookContext } from "eve/hooks";

import type { ExecutionRole } from "../bootstrap.js";
import { clearPreparedRunnerTurn, getAgentBuilderRuntime, runtimeTimestamp } from "../runtime/service.js";
import { ownerChannelFromContext, ownerInputFromSession } from "../runtime/owner.js";

export function createAgentBuilderLeaseHooks(role: ExecutionRole) {
  async function close(
    status: "succeeded" | "failed" | "cancelled",
    terminalCode: string,
    ctx: HookContext,
  ): Promise<void> {
    const runtime = getAgentBuilderRuntime();
    const owner = await runtime.service.resolveOwner(
      ownerInputFromSession(ctx, ownerChannelFromContext(ctx.channel)),
    );
    if (!owner.ok) return;
    clearPreparedRunnerTurn(runtime, owner.owner, ctx.session.id, ctx.session.turn.id);
    const lease = await runtime.config.store.getExecutionLease({
      owner: owner.owner,
      childSessionId: ctx.session.id,
    });
    const terminalTurnMatches =
      lease?.status === "running"
        ? lease.executionTurnId === ctx.session.turn.id
        : lease?.status === "ready" &&
          (lease.bootstrapTurnId !== ctx.session.turn.id || status !== "succeeded");
    if (lease === null || lease.role !== role || !terminalTurnMatches) {
      return;
    }
    const result = await runtime.bootstrap.closeExecution({
      owner: owner.owner,
      childSessionId: ctx.session.id,
      executionTurnId: ctx.session.turn.id,
      status,
      occurredAt: runtimeTimestamp(runtime),
      terminalCode,
    });
    if (!result.ok) throw new Error(result.error.code);
  }
  return defineHook({
    events: {
      "turn.completed": async (_event, ctx) => close("succeeded", "TURN_COMPLETED", ctx),
      "turn.failed": async (_event, ctx) => close("failed", "TURN_FAILED", ctx),
      "turn.cancelled": async (_event, ctx) => close("cancelled", "TURN_CANCELLED", ctx),
    },
  });
}

export const pmLeaseHooks = createAgentBuilderLeaseHooks("pm");
export const implementorLeaseHooks = createAgentBuilderLeaseHooks("implementor");
export const qaLeaseHooks = createAgentBuilderLeaseHooks("qa");
export const testRunnerLeaseHooks = createAgentBuilderLeaseHooks("test_runner");
export const activeRunnerLeaseHooks = createAgentBuilderLeaseHooks("active_runner");
