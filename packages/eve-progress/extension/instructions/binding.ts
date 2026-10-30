import { defineDynamic } from "eve/tools";

import { capturePublicationChannel } from "../lib/runtime.js";

export default defineDynamic((ctx) => {
  capturePublicationChannel(ctx);
  return null;
});
