import { defineHook, type HookContext } from "eve/hooks";

import { ownerChannelFromContext, ownerInputFromSession } from "../runtime/owner.js";
import { getAgentBuilderRuntime, runtimeTimestamp } from "../runtime/service.js";
import { forgetUserInput, rememberUserInput } from "../runtime/user-input.js";

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
    "delivery.consumed": async (event, ctx) => {
      const message = event.data.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n");
      rememberUserInput(ctx.session.id, event.data.turnId, message);
    },
    "turn.settled": async (event, ctx) => {
      forgetUserInput(ctx.session.id, event.data.turnId);
      const outcome = event.data.outcome;
      await close(
        outcome === "failed" ? "failed" : "cancelled",
        outcome === "failed" ? "PARENT_TURN_FAILED" : outcome === "cancelled" ? "PARENT_TURN_CANCELLED" : "PARENT_TURN_COMPLETED_WITHOUT_EXECUTION",
        ctx,
      );
    },
  },
});
