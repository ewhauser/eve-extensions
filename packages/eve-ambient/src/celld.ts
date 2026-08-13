/**
 * The celld mailbox adapter surface, kept out of the core entry point so an
 * application that never opts in never imports it.
 *
 * The runtime side of the tier is `MonitorRuntime.handleEvaluation`, which is
 * transport-agnostic on purpose. This module supplies the one transport most
 * hosts want — a `(Request) => Response` handler to mount on whatever server
 * the application already runs — plus the wire types the cell worker shares.
 */

import type { MonitorRuntime } from "./runtime.js";
import {
  EvaluationAuthError,
  EvaluationRequestError,
  secretsMatch,
} from "./mailbox.js";
import type { EvaluationRequest, EvaluationResponse } from "./mailbox.js";

export {
  CELLD_DEFINITION_VERSION_MISMATCH,
  CELLD_MALFORMED_APPEND,
  CELLD_UNPINNED_CELL,
  EvaluationAuthError,
  EvaluationRequestError,
  cellUrl,
  projectInstanceView,
  secretsMatch,
} from "./mailbox.js";
export type {
  CelldAppendOutcome,
  CelldAppendRequest,
  CelldAppendResponse,
  CelldCellConfig,
  CelldErrorResponse,
  CelldMailboxOptions,
  EvaluationRequest,
  EvaluationResponse,
  EvaluationStatus,
  MailboxOptions,
  StoreMailboxOptions,
} from "./mailbox.js";

export interface EvaluationFetchHandlerOptions {
  /**
   * The shared secret cells present as `authorization: Bearer <secret>`. It
   * must match the runtime's `mailbox.secret`; it is checked here as well so a
   * missing or malformed header is rejected before any parsing happens.
   */
  readonly secret: string;
  /** Restricts the handler to one path. Any path is accepted when unset. */
  readonly path?: string | undefined;
}

/**
 * Wraps `runtime.handleEvaluation` as a fetch handler for Node's
 * `Request`/`Response` (or any host with the same globals).
 *
 * Status mapping, and what each means to a cell:
 *
 * | status | cause                                | cell behaviour |
 * |--------|--------------------------------------|----------------|
 * | 200    | terminal outcome                     | dispatches `RUN_COMPLETED` (or `RUN_FAILED` for `dead-lettered`) and clears its alarm |
 * | 401    | bad or missing bearer secret         | throws; celld's alarm ladder retries |
 * | 400    | malformed or misaddressed request    | throws; retries will keep failing — an operator has to intervene |
 * | 409    | the runId belongs to another instance| as above |
 * | 503    | non-terminal (budget backoff, transient failure) | throws; the ladder retries, which is the intent |
 *
 * Everything non-2xx is a retry from the cell's point of view; the codes are
 * for operators reading fleet logs.
 */
export function createEvaluationFetchHandler(
  runtime: MonitorRuntime,
  options: EvaluationFetchHandlerOptions,
): (request: Request) => Promise<Response> {
  if (typeof options.secret !== "string" || options.secret.length === 0) {
    throw new TypeError("evaluation handler secret must not be empty");
  }
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonResponse({ error: "evaluation endpoint accepts POST" }, 405);
    }
    if (options.path !== undefined && new URL(request.url).pathname !== options.path) {
      return jsonResponse({ error: "not found" }, 404);
    }
    const presented = bearerToken(request.headers.get("authorization"));
    if (!secretsMatch(presented, options.secret)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    let body: Omit<EvaluationRequest, "secret">;
    try {
      body = (await request.json()) as Omit<EvaluationRequest, "secret">;
    } catch (error) {
      return jsonResponse({ error: `invalid JSON body: ${message(error)}` }, 400);
    }
    let response: EvaluationResponse;
    try {
      response = await runtime.handleEvaluation({ ...body, secret: presented });
    } catch (error) {
      if (error instanceof EvaluationAuthError) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (error instanceof EvaluationRequestError) {
        return jsonResponse(
          { error: error.message, code: error.code },
          error.code === "run-conflict" ? 409 : 400,
        );
      }
      // Everything else is retryable from the cell's perspective: the run's
      // own checkpoint decides how much of it is repeated.
      return jsonResponse({ error: message(error) }, 503);
    }
    return jsonResponse(response, 200);
  };
}

function bearerToken(header: string | null): string {
  if (header === null) return "";
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1] ?? "";
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
