/**
 * Global queue for embedded private-runtime command operations.
 *
 * Two lanes:
 *  - high  → interactive console input (user typed in the Termux panel)
 *  - normal → agent / packages / script runner / everything else
 *
 * High-priority jobs always run before pending normal jobs once the
 * currently executing command finishes. Stop cancels the native waiter so the
 * running job returns, then drains pending with ABORTED.
 */

export type TermuxQueuePriority = "high" | "normal";

type Job = {
  priority: TermuxQueuePriority;
  run: () => Promise<void>;
  reject?: (e: unknown) => void;
  cancelled?: boolean;
};

let highQueue: Job[] = [];
let normalQueue: Job[] = [];
let processing = false;
let pendingCount = 0;
let runningPriority: TermuxQueuePriority | null = null;

function recomputePending() {
  pendingCount = highQueue.length + normalQueue.length + (processing ? 1 : 0);
}

async function pump() {
  if (processing) return;
  processing = true;
  try {
    while (highQueue.length > 0 || normalQueue.length > 0) {
      const job = highQueue.shift() || normalQueue.shift();
      if (!job) break;
      if (job.cancelled) {
        try {
          job.reject?.(new Error("ABORTED"));
        } catch {
          /* ignore */
        }
        recomputePending();
        continue;
      }
      runningPriority = job.priority;
      recomputePending();
      try {
        await job.run();
      } catch {
        /* errors are handled by the job's own promise reject */
      }
    }
  } finally {
    runningPriority = null;
    processing = false;
    recomputePending();
  }
}

export function enqueueTermuxCommand<T>(
  job: () => Promise<T>,
  opts?: { priority?: TermuxQueuePriority }
): Promise<T> {
  const priority: TermuxQueuePriority = opts?.priority === "high" ? "high" : "normal";
  return new Promise<T>((resolve, reject) => {
    const wrapped: Job = {
      priority,
      reject,
      run: async () => {
        if (wrapped.cancelled) {
          reject(new Error("ABORTED"));
          return;
        }
        try {
          resolve(await job());
        } catch (e) {
          reject(e);
        }
      },
    };
    if (priority === "high") highQueue.push(wrapped);
    else normalQueue.push(wrapped);
    recomputePending();
    void pump();
  });
}

/** Drop all queued (not running) jobs and reject their promises with ABORTED. */
export function clearPendingTermuxQueue(reason = "ABORTED"): number {
  const all = [...highQueue, ...normalQueue];
  highQueue = [];
  normalQueue = [];
  recomputePending();
  for (const job of all) {
    job.cancelled = true;
    try {
      job.reject?.(new Error(reason));
    } catch {
      /* ignore */
    }
  }
  return all.length;
}

export function getTermuxCommandQueueDepth(): number {
  return pendingCount;
}

export function getTermuxQueueSnapshot(): {
  pending: number;
  high: number;
  normal: number;
  running: TermuxQueuePriority | null;
} {
  return {
    pending: pendingCount,
    high: highQueue.length,
    normal: normalQueue.length,
    running: runningPriority,
  };
}

export function isTermuxCommandQueueIdle(): boolean {
  return pendingCount === 0 && !processing;
}
