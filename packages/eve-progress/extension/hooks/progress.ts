import { defineHook } from "eve/hooks";

import {
  handleActionResult,
  handleLifecycle,
  handleTurnStarted,
} from "../lib/runtime.js";

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => handleTurnStarted(ctx),
    "action.result": handleActionResult,
    "turn.completed": async (_event, ctx) => handleLifecycle("waiting", ctx),
    "turn.failed": async (_event, ctx) => handleLifecycle("failed", ctx),
    "turn.cancelled": async (_event, ctx) => handleLifecycle("cancelled", ctx),
    "session.completed": async (_event, ctx) => handleLifecycle("completed", ctx),
    "session.failed": async (_event, ctx) => handleLifecycle("failed", ctx),
  },
});
