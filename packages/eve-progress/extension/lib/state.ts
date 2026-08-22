import { defineState } from "eve/context";

import {
  initialProgressProjectionState,
  type ProgressProjectionState,
} from "./projection.js";
import type { ProgressRootBinding, ProgressSurface } from "./types.js";

/** Durable, extension-scoped projection for exactly one Eve session. */
export const progressProjectionState = defineState<ProgressProjectionState>(
  "projection",
  initialProgressProjectionState,
);

export interface SlackProgressSessionState {
  readonly binding: ProgressRootBinding | null;
  readonly surface: ProgressSurface | null;
}

function initialSlackProgressSessionState(): SlackProgressSessionState {
  return { binding: null, surface: null };
}

/** Durable Slack routing and message ownership for exactly one Eve session. */
export const slackProgressSessionState = defineState<SlackProgressSessionState>(
  "slack",
  initialSlackProgressSessionState,
);
