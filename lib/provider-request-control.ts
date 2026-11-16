export class ProviderRequestTimeoutError extends Error {
  readonly name = "TimeoutError";
  readonly code = "PROVIDER_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super("PROVIDER_TIMEOUT");
  }
}

export class ProviderRequestAbortedError extends Error {
  readonly name = "AbortError";
  readonly code = "PROVIDER_ABORTED";

  constructor() {
    super("ABORTED");
  }
}

export type ProviderRequestControlOptions = Readonly<{
  timeoutMs: number;
  signal?: AbortSignal;
}>;

/**
 * Bound a provider request, including response-body processing, to an explicit
 * timeout while preserving caller cancellation. Promise.race is intentional:
 * some native fetch implementations do not promptly settle after AbortSignal.
 */
export async function withProviderRequestControl<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  options: ProviderRequestControlOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs;
  const callerSignal = options.signal;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("PROVIDER_TIMEOUT_INVALID");
  }
  if (callerSignal?.aborted) throw new ProviderRequestAbortedError();

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: ((reason: Error) => void) | undefined;
  const onCallerAbort = () => {
    controller.abort();
    rejectCancellation?.(new ProviderRequestAbortedError());
  };
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProviderRequestTimeoutError(timeoutMs));
    }, timeoutMs);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  });
  const request = Promise.resolve().then(() => {
    if (callerSignal?.aborted) throw new ProviderRequestAbortedError();
    if (timedOut) throw new ProviderRequestTimeoutError(timeoutMs);
    return operation(controller.signal);
  });

  try {
    return await Promise.race([request, cancellation]);
  } catch (error: unknown) {
    if (callerSignal?.aborted) throw new ProviderRequestAbortedError();
    if (timedOut) throw new ProviderRequestTimeoutError(timeoutMs);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
