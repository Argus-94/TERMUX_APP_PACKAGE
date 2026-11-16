import { withAbortableTimeout } from "./abortable-timeout";

export const ONLINE_FEED_CONTROL_TIMEOUT_MS = 20_000;
export const ONLINE_FEED_TRANSFER_IDLE_TIMEOUT_MS = 45_000;
export const ONLINE_FEED_TRANSFER_TOTAL_TIMEOUT_MS = 20 * 60_000;

type FeedDeadlineOptions = { idleTimeoutMs?: number; totalTimeoutMs?: number };

/** Bounds metadata requests even when the fetch implementation ignores AbortSignal. */
export async function withOnlineFeedRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs = ONLINE_FEED_CONTROL_TIMEOUT_MS,
): Promise<T> {
  try {
    return await withAbortableTimeout(operation, timeoutMs, new AbortController(), parentSignal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (parentSignal.aborted || message === "ABORTED") throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
    if (message === "MODEL_TIMEOUT") throw new Error("AIB_ONLINE_PACKAGE_REQUEST_TIMEOUT");
    throw error;
  }
}

/** Gives native downloads both an idle watchdog and a hard per-asset deadline. */
export function withOnlineFeedTransferDeadline<T>(
  start: (onProgress: () => void) => Promise<T>,
  parentSignal: AbortSignal,
  cancel: () => void,
  options: FeedDeadlineOptions = {},
): Promise<T> {
  if (parentSignal.aborted) return Promise.reject(new Error("AIB_ONLINE_PACKAGE_CANCELLED"));
  const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? ONLINE_FEED_TRANSFER_IDLE_TIMEOUT_MS);
  const totalTimeoutMs = Math.max(idleTimeoutMs, options.totalTimeoutMs ?? ONLINE_FEED_TRANSFER_TOTAL_TIMEOUT_MS);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      parentSignal.removeEventListener("abort", onAbort);
    };
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { cancel(); } catch { /* cancellation is best-effort; result remains bounded */ }
      reject(new Error(code));
    };
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => fail("AIB_ONLINE_PACKAGE_CANCELLED");
    const armIdleTimer = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail("AIB_ONLINE_PACKAGE_TRANSFER_IDLE_TIMEOUT"), idleTimeoutMs);
    };

    parentSignal.addEventListener("abort", onAbort, { once: true });
    if (parentSignal.aborted) { onAbort(); return; }
    totalTimer = setTimeout(() => fail("AIB_ONLINE_PACKAGE_TRANSFER_DEADLINE"), totalTimeoutMs);
    armIdleTimer();
    Promise.resolve().then(() => start(() => { if (!settled) armIdleTimer(); })).then(succeed, error => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
  });
}
