import type { ProcessRegistry, RegisteredProcess } from "../process/ProcessRegistry";
import type { TimelineEventType, TimelineLevel } from "../enhancements/timeline/EventStore";
import {
  DEFAULT_SUPERVISOR_POLICY,
  RestartBudget,
  computeBackoffMs,
  type SupervisorPolicy,
} from "./SupervisorPolicy";

export type SupervisorStatus = "stopped" | "running" | "degraded" | "quarantined";

export type SupervisorSnapshot = Readonly<{
  status: SupervisorStatus;
  watched: number;
  lastTick: number | null;
  failures: number;
  quarantined: number;
  policy: SupervisorPolicy;
}>;

export type SupervisorRecoveryHandler = (process: RegisteredProcess, error: unknown) => Promise<boolean> | boolean;
export type SupervisorEventSink = (event: Readonly<{ type: TimelineEventType; level: TimelineLevel; projectId?: string; payload: Readonly<Record<string, unknown>> }>) => Promise<void> | void;

export class RuntimeSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: SupervisorStatus = "stopped";
  private lastTick: number | null = null;
  private failures = 0;
  private readonly quarantined = new Set<string>();
  private readonly budget: RestartBudget;
  private readonly policy: SupervisorPolicy;
  private readonly recoveryHandlers = new Set<SupervisorRecoveryHandler>();
  private eventSink?: SupervisorEventSink;

  constructor(
    private readonly registry: ProcessRegistry,
    private readonly onFailure?: (
      process: RegisteredProcess,
      error: unknown,
    ) => Promise<void> | void,
    policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY,
  ) {
    this.policy = policy;
    this.budget = new RestartBudget(policy);
  }

  start(intervalMs?: number, runTick: () => Promise<unknown> | unknown = () => this.tick()) {
    if (this.timer) return;
    this.status = "running";
    const ms = Math.max(1000, intervalMs ?? this.policy.defaultTickIntervalMs);
    this.timer = setInterval(() => {
      try { void Promise.resolve(runTick()).catch(() => { this.failures++; this.status = "degraded"; }); }
      catch { this.failures++; this.status = "degraded"; }
    }, ms);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = "stopped";
  }

  /** Register an additive recovery hook; returning true suppresses the legacy failure callback. */
  addRecoveryHandler(handler: SupervisorRecoveryHandler): () => void {
    this.recoveryHandlers.add(handler);
    return () => this.recoveryHandlers.delete(handler);
  }

  /** Attach structured activity logging without coupling the supervisor to storage. */
  setEventSink(sink: SupervisorEventSink): void { this.eventSink = sink; }
  private async emit(event: Parameters<SupervisorEventSink>[0]): Promise<void> { try { await this.eventSink?.(event); } catch { /* telemetry must not change restart decisions */ } }

  async tick() {
    this.lastTick = Date.now();
    try {
      for (const p of this.registry.list()) {
        if (p.metadata?.[this.policy.watchdogMetadataKey] !== this.policy.watchdogEnabledValue) {
          continue;
        }
        if (p.metadata?.health !== "failed") continue;
        if (this.quarantined.has(p.id)) continue;

        if (!this.budget.tryConsume(p.id)) {
          this.quarantined.add(p.id);
          this.status = "quarantined";
          await this.emit({ type: "policy.denied", level: "warn", projectId: p.projectId, payload: { processId: p.id, reason: "restart-budget-exhausted" } });
          continue;
        }

        const attempt = this.budget.count(p.id);
        const delay = computeBackoffMs(attempt, this.policy);
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, Math.min(delay, 5_000)));
        }
        try {
          let recovered = false;
          for (const handler of this.recoveryHandlers) {
            if (await handler(p, new Error("WATCHDOG_HEALTH_FAILED"))) { recovered = true; break; }
          }
          if (!recovered) await this.onFailure?.(p, new Error("WATCHDOG_HEALTH_FAILED"));
          await this.emit({ type: recovered ? "process.restarted" : "runtime.error", level: recovered ? "info" : "error", projectId: p.projectId, payload: { processId: p.id, label: p.label ?? "", recovered, attempt } });
        } catch {
          this.failures++;
          this.status = "degraded";
          await this.emit({ type: "runtime.error", level: "error", projectId: p.projectId, payload: { processId: p.id, reason: "watchdog-recovery-failed" } });
        }
      }
    } catch {
      this.failures++;
      this.status = "degraded";
    }
  }

  clearQuarantine(processId?: string): void {
    if (processId) {
      this.quarantined.delete(processId);
      this.budget.reset(processId);
    } else {
      this.quarantined.clear();
      this.budget.reset();
    }
    if (this.timer && this.status !== "running") this.status = "running";
  }

  snapshot(): SupervisorSnapshot {
    return {
      status: this.status,
      watched: this.registry
        .list()
        .filter(
          (p) =>
            p.metadata?.[this.policy.watchdogMetadataKey] ===
            this.policy.watchdogEnabledValue,
        ).length,
      lastTick: this.lastTick,
      failures: this.failures,
      quarantined: this.quarantined.size,
      policy: this.policy,
    };
  }
}
