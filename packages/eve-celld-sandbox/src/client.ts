import {
  Command,
  responses,
  VERSION,
  ProtocolError,
  type Identity,
  type Operation,
} from "./protocol.js";
import { CelldTransport, type CelldOptions } from "./transport.js";
import type { z } from "zod";
export type { CelldOptions } from "./transport.js";
export class CelldClient {
  readonly endpoint: string;
  private readonly transport: CelldTransport;
  constructor(options: CelldOptions) {
    this.transport = new CelldTransport(options);
    this.endpoint = this.transport.endpoint;
  }
  async request<O extends Operation>(
    identity: Identity,
    operation: O,
    signal?: AbortSignal,
  ): Promise<z.infer<(typeof responses)[O["op"]]>> {
    const attempts =
      operation.op === "execute" || operation.op === "cancel" ? 3 : 1;
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await this.transport.request(
          "/v1",
          { version: VERSION, identity, operation },
          signal,
        );
        return responses[operation.op].parse(value) as z.infer<
          (typeof responses)[O["op"]]
        >;
      } catch (error) {
        if (
          error instanceof ProtocolError ||
          signal?.aborted ||
          attempt + 1 >= attempts
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  command(input: Partial<Command> & Pick<Command, "command">): Command {
    return Command.parse({ ...input, id: input.id ?? crypto.randomUUID() });
  }
}
