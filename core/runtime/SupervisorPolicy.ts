/**
 * SupervisorPolicy — documented restart / backoff limits (plan.md A3).
 * Pure policy object; RuntimeSupervisor applies it without proprietary code.
 */
export type SupervisorPolicy = Readonly<{
  /** Max consecutive onFailure invocations per process id before quarantine */
  maxRestartsPerProcess: number;
  /** Sliding window for restart counting (ms) */
  restartWindowMs: number;
  /** Base backoff after failure (ms) */
  backoffBaseMs: number;
  /** Max backoff (ms) */
  backoffMaxMs: number;
  /** Tick interval when start() is called without override (ms) */
  defaultTickIntervalMs: number;
  /** Processes with metadata.watchdog === "true" are observed */
  watchdogMetadataKey: "watchdog";
  /** Value that enables watching */
  watchdogEnabledValue: "true";
}>;

/** Production defaults — conservative for Android OEM kill patterns. */
export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  maxRestartsPerProcess: 5,
  restartWindowMs: 10 * 60_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  defaultTickIntervalMs: 5_000,
  watchdogMetadataKey: "watchdog",
  watchdogEnabledValue: "true",
};

/** Exponential backoff with full jitter. */
export function computeBackoffMs(
  attempt: number,
  policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
): number {
  const exp = Math.min(
    policy.backoffMaxMs,
    policy.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1)),
  );
  return Math.floor(Math.random() * (exp + 1));
}

/** Track restarts in a window; returns whether another restart is allowed. */
export class RestartBudget {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY) {}

  /** Record a restart attempt; false = budget exhausted (quarantine). */
  tryConsume(processId: string, now = Date.now()): boolean {
    const windowStart = now - this.policy.restartWindowMs;
    const prev = (this.hits.get(processId) || []).filter((t) => t >= windowStart);
    if (prev.length >= this.policy.maxRestartsPerProcess) {
      this.hits.set(processId, prev);
      return false;
    }
    prev.push(now);
    this.hits.set(processId, prev);
    return true;
  }

  count(processId: string, now = Date.now()): number {
    const windowStart = now - this.policy.restartWindowMs;
    return (this.hits.get(processId) || []).filter((t) => t >= windowStart).length;
  }

  reset(processId?: string): void {
    if (processId) this.hits.delete(processId);
    else this.hits.clear();
  }
}
