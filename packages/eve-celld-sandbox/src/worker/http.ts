import { LIMITS, ProtocolError, readBounded, VERSION } from "../protocol.js";
export const reply = (value: unknown) =>
  Response.json({ version: VERSION, ok: true, value });
export function errorResponse(error: unknown): Response {
  const e =
    error instanceof ProtocolError
      ? error
      : new ProtocolError(
          "RUNTIME",
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "Execution failed",
          500,
        );
  return Response.json(
    {
      version: VERSION,
      ok: false,
      error: { code: e.code, message: e.message },
    },
    { status: e.status },
  );
}
export async function jsonBody(request: Request): Promise<unknown> {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readBounded(request.body, LIMITS.requestBytes),
    ),
  );
}
export async function authorize(
  request: Request,
  token: string | undefined,
): Promise<void> {
  if (!token || token.length < 32)
    throw new ProtocolError(
      "CONFIG",
      "SERVICE_TOKEN must contain at least 32 characters",
      503,
    );
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [expected, actual] = await Promise.all([
    digest(`Bearer ${token}`),
    digest(request.headers.get("authorization") ?? ""),
  ]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= expected[i]! ^ actual[i]!;
  if (difference)
    throw new ProtocolError("UNAUTHORIZED", "Invalid service token", 401);
}
