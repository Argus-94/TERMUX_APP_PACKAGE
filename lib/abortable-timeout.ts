/**
 * Race an operation against an abortable deadline. The same signal is passed to
 * the operation, so timeout/Stop can terminate providers that honor AbortSignal.
 */
export async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  controller: AbortController = new AbortController(),
  parentSignal?: AbortSignal,
): Promise<T> {
  if (controller.signal.aborted || parentSignal?.aborted) throw new Error("ABORTED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("ABORTED"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the deadline first; abort synchronously notifies provider listeners.
      reject(new Error("MODEL_TIMEOUT"));
      controller.abort();
    }, Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
