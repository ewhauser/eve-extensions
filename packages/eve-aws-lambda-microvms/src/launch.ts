import type { AwsLambdaMicrovmLifecycleEvent } from "./types.js";

/** Timely rejection does not depend on a provider honoring AbortSignal. */
export function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onLate?: (value: T) => Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const cancel = () => {
      aborted = true;
      reject(signal.reason);
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        if (aborted) void Promise.resolve().then(() => onLate?.(value)).catch(() => undefined);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

export function emitLifecycle(
  log: ((event: AwsLambdaMicrovmLifecycleEvent) => void) | undefined,
  event: AwsLambdaMicrovmLifecycleEvent,
): void {
  // Diagnostics must never affect authority or leak provider error bodies.
  try { log?.(event); } catch { /* Ignore observer failures. */ }
}

export async function timedPhase<T>(
  log: ((event: AwsLambdaMicrovmLifecycleEvent) => void) | undefined,
  phase: AwsLambdaMicrovmLifecycleEvent["phase"],
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  emitLifecycle(log, { phase, status: "started", durationMs: 0 });
  try {
    signal.throwIfAborted();
    const result = await bounded(operation(), signal);
    emitLifecycle(log, { phase, status: "completed", durationMs: Date.now() - started });
    return result;
  } catch (error) {
    emitLifecycle(log, { phase, status: "failed", durationMs: Date.now() - started });
    throw error;
  }
}
