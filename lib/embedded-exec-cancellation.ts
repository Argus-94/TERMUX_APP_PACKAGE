/**
 * Connect an AbortSignal to the private native one-shot runner. Cancellation is
 * best-effort for the registered shell and descendants observed in its owned
 * process tree. The caller waits for the native execution promise to
 * settle before surfacing ABORTED, so the native request can clean up its slot.
 */
export async function runWithEmbeddedAbort<T>(
  signal: AbortSignal | undefined,
  start: () => Promise<T>,
  cancel: () => Promise<unknown>,
): Promise<T> {
  if (signal?.aborted) throw new Error("ABORTED");
  if (!signal) return start();

  let cancellation: Promise<unknown> | undefined;
  const requestCancellation = () => {
    if (!cancellation) {
      cancellation = Promise.resolve().then(cancel).catch(() => undefined);
    }
  };
  const onAbort = () => requestCancellation();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal.aborted) requestCancellation();
    const result = await start();
    if (signal.aborted) {
      requestCancellation();
      await cancellation;
      throw new Error("ABORTED");
    }
    return result;
  } catch (error) {
    if (signal.aborted) {
      requestCancellation();
      await cancellation;
      throw new Error("ABORTED");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
