import { defineHook, type HookContext } from "eve/hooks";

import { ownerChannelFromContext, ownerInputFromSession } from "../runtime/owner.js";
import { getAgentBuilderRuntime, runtimeTimestamp } from "../runtime/service.js";

async function close(
  status: "failed" | "cancelled",
  terminalCode: string,
  ctx: HookContext,
): Promise<void> {
  const runtime = getAgentBuilderRuntime();
  const owner = await runtime.service.resolveOwner(
    ownerInputFromSession(ctx, ownerChannelFromContext(ctx.channel)),
  );
  if (!owner.ok) return;
  const result = await runtime.bootstrap.closeParentTurn({
    owner: owner.owner,
    parentSessionId: ctx.session.id,
    parentTurnId: ctx.session.turn.id,
    status,
    occurredAt: runtimeTimestamp(runtime),
    terminalCode,
  });
  if (!result.ok) throw new Error(result.error.code);
}

export default defineHook({
  events: {
    "turn.completed": async (_event, ctx) =>
      close("cancelled", "PARENT_TURN_COMPLETED_WITHOUT_EXECUTION", ctx),
    "turn.failed": async (_event, ctx) => close("failed", "PARENT_TURN_FAILED", ctx),
    "turn.cancelled": async (_event, ctx) => close("cancelled", "PARENT_TURN_CANCELLED", ctx),
  },
});
