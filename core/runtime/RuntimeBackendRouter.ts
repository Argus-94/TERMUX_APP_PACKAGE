/**
 * RuntimeBackendRouter — health-driven multi-backend execution.
 *
 * Surpasses DSHA's proroot→proot fallback:
 *   - N backends with priority + measured latency
 *   - consecutive failure circuit-breaker (auto demote)
 *   - sticky mode after success (avoid flap)
 *   - full metrics snapshot for UI/agent
 *   - never depends on proprietary binaries
 */
import type {
  BackendExecRequest,
  BackendExecResult,
  BackendId,
  BackendMetrics,
  BackendProbeResult,
  RouterSnapshot,
  RuntimeBackend,
} from "./RuntimeBackend";

type MutableMetrics = {
  id: BackendId;
  execCount: number;
  failCount: number;
  consecutiveFailures: number;
  totalDurationMs: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
};

export type RouterPolicy = "prefer-fastest-healthy" | "prefer-priority" | "sticky";

export class RuntimeBackendRouter {
  private readonly backends: RuntimeBackend[] = [];
  private readonly metrics = new Map<BackendId, MutableMetrics>();
  private readonly lastProbe = new Map<BackendId, BackendProbeResult>();
  private activeId: BackendId | null = null;
  private policy: RouterPolicy = "prefer-priority";
  private failureThreshold: number;
  private priorityOrder: BackendId[] = [];

  constructor(options?: { policy?: RouterPolicy; failureThreshold?: number }) {
    this.policy = options?.policy ?? "prefer-priority";
    this.failureThreshold = 3;
    this.setFailureThreshold(options?.failureThreshold ?? 3);
  }

  register(backend: RuntimeBackend): void {
    this.backends.push(backend);
    this.backends.sort((a, b) => a.priority - b.priority);
    if (!this.metrics.has(backend.id)) {
      this.metrics.set(backend.id, {
        id: backend.id,
        execCount: 0,
        failCount: 0,
        consecutiveFailures: 0,
        totalDurationMs: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
      });
    }
  }

  setPolicy(policy: RouterPolicy): void {
    this.policy = policy;
  }

  setFailureThreshold(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error("ROUTER_FAILURE_THRESHOLD_INVALID");
    this.failureThreshold = value;
  }

  /** Overrides static backend priority for named registered IDs; others retain base order. */
  setPriorityOrder(ids: readonly BackendId[]): void {
    const unique = new Set(ids);
    if (unique.size !== ids.length || ids.some((id) => !this.backends.some((backend) => backend.id === id))) throw new Error("ROUTER_PRIORITY_ORDER_INVALID");
    this.priorityOrder = [...ids];
  }

  list(): RuntimeBackend[] {
    return [...this.backends];
  }

  async probeAll(): Promise<BackendProbeResult[]> {
    const results: BackendProbeResult[] = [];
    for (const b of this.backends) {
      const r = await b.probe();
      this.lastProbe.set(b.id, r);
      results.push(r);
    }
    // Select active
    this.activeId = this.selectBackend(results)?.id ?? null;
    return results;
  }

  private selectBackend(probes: BackendProbeResult[]): RuntimeBackend | null {
    const healthy = probes.filter((p) => p.health === "ready" || p.health === "degraded");
    if (!healthy.length) return null;

    const ready = healthy.filter((p) => p.health === "ready");
    const pool = ready.length ? ready : healthy;

    // Circuit breaker: skip backends over failure threshold unless all are broken
    const notCircuitOpen = pool.filter((p) => {
      const m = this.metrics.get(p.id);
      return !m || m.consecutiveFailures < this.failureThreshold;
    });
    const candidates = notCircuitOpen.length ? notCircuitOpen : pool;

    if (this.policy === "sticky" && this.activeId) {
      const sticky = candidates.find((c) => c.id === this.activeId);
      if (sticky) return this.backends.find((b) => b.id === sticky.id) ?? null;
    }

    if (this.policy === "prefer-fastest-healthy") {
      const sorted = [...candidates].sort((a, b) => a.latencyMs - b.latencyMs);
      const best = sorted[0];
      return this.backends.find((b) => b.id === best.id) ?? null;
    }

    // Explicit mode order takes precedence; unlisted backends retain base priority.
    for (const id of this.priorityOrder) {
      if (candidates.some((candidate) => candidate.id === id)) return this.backends.find((backend) => backend.id === id) ?? null;
    }
    // prefer-priority: backends already sorted by priority
    for (const b of this.backends) {
      if (candidates.some((c) => c.id === b.id)) return b;
    }
    return null;
  }

  getActiveId(): BackendId | null {
    return this.activeId;
  }

  async exec(req: BackendExecRequest): Promise<BackendExecResult> {
    if (!this.lastProbe.size) {
      await this.probeAll();
    }
    const probes = [...this.lastProbe.values()];
    let backend = this.selectBackend(probes);
    if (!backend) {
      // Last resort: try any registered backend
      backend = this.backends[0] ?? null;
    }
    if (!backend) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: "NO_RUNTIME_BACKEND",
        durationMs: 0,
        backendId: "unavailable",
      };
    }

    const m = this.metrics.get(backend.id)!;
    try {
      const result = await backend.exec(req);
      m.execCount++;
      m.totalDurationMs += result.durationMs;
      if (result.exitCode === 0) {
        m.consecutiveFailures = 0;
        m.lastSuccessAt = Date.now();
        this.activeId = backend.id;
      } else {
        m.failCount++;
        m.consecutiveFailures++;
        m.lastFailureAt = Date.now();
        m.lastError = result.stderr.slice(0, 200) || `exit=${result.exitCode}`;
        // Try failover once
        if (m.consecutiveFailures >= this.failureThreshold) {
          const failover = await this.tryFailover(backend.id, req);
          if (failover) return failover;
        }
      }
      return result;
    } catch (e) {
      m.execCount++;
      m.failCount++;
      m.consecutiveFailures++;
      m.lastFailureAt = Date.now();
      m.lastError = e instanceof Error ? e.message : String(e);
      const failover = await this.tryFailover(backend.id, req);
      if (failover) return failover;
      return {
        exitCode: 1,
        stdout: "",
        stderr: m.lastError || "BACKEND_EXEC_FAILED",
        durationMs: 0,
        backendId: backend.id,
      };
    }
  }

  private async tryFailover(failedId: BackendId, req: BackendExecRequest): Promise<BackendExecResult | null> {
    for (const b of this.backends) {
      if (b.id === failedId) continue;
      const probe = this.lastProbe.get(b.id);
      if (probe && probe.health === "unavailable") continue;
      try {
        const result = await b.exec(req);
        const m = this.metrics.get(b.id)!;
        m.execCount++;
        m.totalDurationMs += result.durationMs;
        if (result.exitCode === 0) {
          m.consecutiveFailures = 0;
          m.lastSuccessAt = Date.now();
          this.activeId = b.id;
        }
        return result;
      } catch {
        continue;
      }
    }
    return null;
  }

  snapshot(): RouterSnapshot {
    return {
      activeId: this.activeId,
      backends: [...this.lastProbe.values()],
      metrics: [...this.metrics.values()].map((m) => ({ ...m })),
      policy: this.policy,
      failureThreshold: this.failureThreshold,
      priorityOrder: [...this.priorityOrder],
    };
  }

  /** Reset circuit breakers (e.g. after user repair). */
  resetMetrics(id?: BackendId): void {
    const ids = id ? [id] : [...this.metrics.keys()];
    for (const i of ids) {
      const m = this.metrics.get(i);
      if (m) {
        m.consecutiveFailures = 0;
        m.lastError = null;
      }
    }
  }
}

export function createRuntimeBackendRouter(options?: { policy?: RouterPolicy; failureThreshold?: number }): RuntimeBackendRouter {
  return new RuntimeBackendRouter(options);
}
