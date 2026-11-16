import type { PackageCheckOutcome } from "./package-check-outcome";

export interface PackageScanHooks<TId extends string = string> {
  onStart?: (id: TId) => void;
  onResult?: (id: TId, result: PackageCheckOutcome) => void;
  /** Stop before starting another independent probe (e.g. menu closed). */
  shouldContinue?: () => boolean;
  /** A small courtesy gap for the embedded private command bridge; defaults to none. */
  delayMs?: number;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scan one catalog entry at a time. A slow/failed check affects only its own
 * outcome; later cards still receive their own fresh check. Callbacks let the UI
 * show only the package whose probe is currently in flight.
 */
export async function scanPackageCatalog<T extends { id: string }>(
  definitions: readonly T[],
  check: (definition: T) => Promise<PackageCheckOutcome>,
  hooks: PackageScanHooks<T["id"]> = {},
): Promise<Record<string, PackageCheckOutcome>> {
  const results: Record<string, PackageCheckOutcome> = {};
  for (const definition of definitions) {
    try {
      if (hooks.shouldContinue && !hooks.shouldContinue()) break;
    } catch {
      // An unavailable UI/session owner must fail closed: do not start another probe.
      break;
    }
    try {
      hooks.onStart?.(definition.id);
    } catch {
      // A view callback must not prevent a package check from running.
    }

    let result: PackageCheckOutcome;
    try {
      result = await check(definition);
      if (!result || !["installed", "missing", "error"].includes(result.status)) {
        result = { status: "error", detail: "PACKAGE_CHECK_INVALID_RESULT" };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      result = { status: "error", detail: (message || "PACKAGE_CHECK_FAILED").slice(0, 500) };
    }

    results[definition.id] = result;
    try {
      hooks.onResult?.(definition.id, result);
    } catch {
      // A view callback must not stop the remaining independent checks.
    }
    if (Number.isFinite(hooks.delayMs) && (hooks.delayMs || 0) > 0) {
      await pause(hooks.delayMs || 0);
    }
  }
  return results;
}

/**
 * Persist only authoritative live outcomes. Errors/timeouts preserve the old
 * hint for diagnostics but never turn the returned live result into installed
 * or missing.
 */
export function mergeSuccessfulPackageChecksIntoCache<TId extends string>(
  cached: Record<string, boolean>,
  outcomes: Record<TId, PackageCheckOutcome>,
): Record<string, boolean> {
  const next = { ...cached };
  for (const [id, outcome] of Object.entries(outcomes) as [TId, PackageCheckOutcome][]) {
    if (outcome.status === "installed") next[id] = true;
    else if (outcome.status === "missing") next[id] = false;
  }
  return next;
}

/**
 * The embedded private command bridge is globally one-at-a-time. Mirror that policy
 * at the catalog UI layer and coalesce duplicate requests for the same target
 * and section, rather than filling the native queue with duplicate full scans.
 */
export class PackageScanCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private runningCount = 0;

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const pending = this.tail.then(async () => {
      this.runningCount += 1;
      try {
        return await task();
      } finally {
        this.runningCount -= 1;
      }
    });
    this.inFlight.set(key, pending);
    this.tail = pending.then(() => undefined, () => undefined);

    const cleanup = () => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  isRunning(key: string): boolean {
    return this.inFlight.has(key);
  }

  get activeCount(): number {
    return this.runningCount;
  }
}

export const packageScanCoordinator = new PackageScanCoordinator();
