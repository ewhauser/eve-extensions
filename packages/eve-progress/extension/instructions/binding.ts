import { defineDynamic } from "eve/tools";

import { capturePublicationChannel } from "../lib/runtime.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      capturePublicationChannel(ctx);
      return null;
    },
    "turn.started": (_event, ctx) => {
      capturePublicationChannel(ctx);
      return null;
    },
  },
});
