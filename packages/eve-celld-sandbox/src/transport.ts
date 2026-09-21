import {
  Identity,
  LIMITS,
  ProtocolError,
  readBounded,
  ResponseEnvelope,
} from "./protocol.js";
export interface CelldOptions {
  endpoint: string;
  token: string;
  namespace: string;
  fetch?: typeof globalThis.fetch;
}
export class CelldTransport {
  readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: CelldOptions) {
    const url = new URL(options.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error(
        "endpoint must be an HTTP(S) origin without credentials, query, or fragment",
      );
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("Use HTTPS for non-loopback endpoints");
    if (options.token.length < 32)
      throw new Error("A service token of at least 32 characters is required");
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    Identity.parse({
      namespace: options.namespace,
      kind: "session",
      key: "validate",
      template: null,
    });
  }
  async request(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs = 350_000,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > LIMITS.requestBytes)
      throw new ProtocolError("LIMIT", "Request exceeds byte limit", 413);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetcher(`${this.endpoint}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
      },
      body: text,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    const envelope = ResponseEnvelope.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBounded(response.body, LIMITS.requestBytes),
        ),
      ),
    );
    if (!envelope.ok)
      throw new ProtocolError(
        envelope.error.code,
        envelope.error.message,
        response.status,
      );
    if (!response.ok)
      throw new ProtocolError(
        "HTTP",
        `Unexpected HTTP status ${response.status}`,
        response.status,
      );
    return envelope.value;
  }
}
