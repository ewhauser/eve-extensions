import { defineHook } from "eve/hooks";

import {
  handleActionResult,
  handleCallRequested,
  handleLifecycle,
  handleTurnStarted,
} from "../lib/runtime.js";

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => handleTurnStarted(ctx),
    "call.requested": handleCallRequested,
    "call.settled": handleActionResult,
    "turn.settled": async (event, ctx) => handleLifecycle(
      event.data.outcome === "completed" ? "waiting" : event.data.outcome,
      ctx,
    ),
    "session.ended": async (event, ctx) => handleLifecycle(
      event.data.outcome === "completed" ? "completed" : "failed",
      ctx,
    ),
  },
});
