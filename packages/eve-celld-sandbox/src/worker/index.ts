import justBash from "./just-bash.js";
import { containerStub, type ContainerEnv } from "./container.js";
import { ContainerEnvelope } from "../container-protocol.js";
import { authorize, errorResponse, jsonBody } from "./http.js";
export { SandboxCell } from "./just-bash.js";
export { ContainerCell } from "./container.js";

export default {
  async fetch(
    request: Request,
    env: ContainerEnv & { CELLS: DurableObjectNamespace },
  ): Promise<Response> {
    if (new URL(request.url).pathname !== "/container/v1")
      return justBash.fetch(request, env);
    try {
      if (request.method !== "POST")
        return new Response("Use POST", { status: 405 });
      await authorize(request, env.SERVICE_TOKEN);
      const body = ContainerEnvelope.parse(await jsonBody(request));
      const sandbox = await containerStub(env, body.identity);
      return await sandbox.fetch(
        new Request("http://cell/__eve", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    } catch (error) {
      return errorResponse(error);
    }
  },
};
