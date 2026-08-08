/**
 * Typed errors for the ChatGPT connector protocol layer.
 *
 * - {@link ConnectorProtocolError} — transport or JSON-RPC failures.
 * - {@link ConnectorAuthError} — HTTP 401/403; the bearer token is missing,
 *   invalid, or expired. Distinct so callers can surface "token invalid or
 *   expired" instead of a generic failure.
 * - {@link ConnectorToolError} — the upstream tool ran and returned
 *   `isError: true`; carries the upstream text so the model can adapt.
 */

export class ConnectorProtocolError extends Error {
  /** JSON-RPC error code, when the failure was a JSON-RPC error. */
  readonly code: number | string | undefined;
  /** HTTP status, when the failure was at the HTTP layer. */
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { code?: number | string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConnectorProtocolError";
    this.code = options.code;
    this.status = options.status;
  }
}

export class ConnectorAuthError extends ConnectorProtocolError {
  constructor(message: string, options: { status?: number } = {}) {
    super(message, options);
    this.name = "ConnectorAuthError";
  }
}

export class ConnectorToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorToolError";
  }
}
