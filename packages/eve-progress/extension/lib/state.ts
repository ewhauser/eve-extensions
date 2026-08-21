import { defineState } from "eve/context";

import {
  initialProgressProjectionState,
  type ProgressProjectionState,
} from "./projection.js";

/** Durable, extension-scoped projection for exactly one Eve session. */
export const progressProjectionState = defineState<ProgressProjectionState>(
  "projection",
  initialProgressProjectionState,
);
