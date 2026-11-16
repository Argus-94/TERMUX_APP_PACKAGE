/** Safe policy tuner for an existing RuntimeBackendRouter; it never changes router APIs. */
import type { BackendId, BackendProbeResult } from "../../runtime/RuntimeBackend.ts";
import type { RouterPolicy, RuntimeBackendRouter } from "../../runtime/RuntimeBackendRouter.ts";
/** Optional durable policy state adapter; failures are non-critical. */
export type BackendTunerState = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }>;
/** Optional audit sink for applied or rejected routing policy changes. */
export type BackendTunerTimeline = Readonly<{ record(event: Readonly<{ type: "backend-policy"; policy: RouterPolicy; outcome: "applied" | "rejected"; at: number }>): Promise<void> | void }>;
/** Result of a safe probe-gated policy update. */
export type BackendTuneResult = Readonly<{ applied: boolean; policy: RouterPolicy; probes: readonly BackendProbeResult[]; reason?: "no-healthy-backend" | "probe-failed" | "policy-failed" | "persistence-failed" }>;
export type BackendTuneOptions = Readonly<{ failureThreshold?: number; priorityStrategy?: "base" | "fastest" | "active-first" }>;
/** Minimal read/probe/policy surface consumed from the existing runtime router. */
export type BackendRouterPort = Pick<RuntimeBackendRouter, "probeAll" | "setPolicy" | "setFailureThreshold" | "setPriorityOrder" | "snapshot">;

/** Delegates to setPolicy only after a successful probe finds a usable backend. */
export class BackendTuner {
  /** Creates a tuner over the existing router and optional persistence/telemetry adapters. */
  constructor(private readonly router: BackendRouterPort, private readonly state?: BackendTunerState, private readonly timeline?: BackendTunerTimeline) {}

  /** Applies a profile's policy if probing succeeds; restores the prior policy on set failure. */
  async apply(policy: RouterPolicy, options: BackendTuneOptions = {}): Promise<BackendTuneResult> {
    let previous: ReturnType<BackendRouterPort["snapshot"]>;
    try { previous = this.router.snapshot(); } catch { return { applied: false, policy: "prefer-priority", probes: [], reason: "probe-failed" }; }
    let probes: readonly BackendProbeResult[];
    try { probes = await this.router.probeAll(); }
    catch { return this.result(false, previous.policy, [], "probe-failed"); }
    if (!probes.some((probe) => probe.health === "ready" || probe.health === "degraded")) return this.result(false, previous.policy, probes, "no-healthy-backend");
    const probedSnapshot = this.router.snapshot();
    const failureThreshold = options.failureThreshold ?? previous.failureThreshold ?? 3;
    const priorityStrategy = options.priorityStrategy ?? "base";
    const priorityOrder: BackendId[] = priorityStrategy === "fastest"
      ? probes.filter((probe) => probe.health === "ready" || probe.health === "degraded").sort((a, b) => a.latencyMs - b.latencyMs || a.id.localeCompare(b.id)).map((probe) => probe.id)
      : priorityStrategy === "active-first" && probedSnapshot.activeId ? [probedSnapshot.activeId] : [];
    let persistenceFailed = false;
    try {
      this.router.setPolicy(policy);
      this.router.setFailureThreshold(failureThreshold);
      this.router.setPriorityOrder(priorityOrder);
      const applied = this.router.snapshot();
      if (applied.policy !== policy || applied.failureThreshold !== failureThreshold || JSON.stringify(applied.priorityOrder ?? []) !== JSON.stringify(priorityOrder)) throw new Error("Router tuning was not applied.");
      if (this.state) {
        try { await this.state.write(JSON.stringify({ policy, failureThreshold, priorityOrder, updatedAt: Date.now() })); }
        catch { persistenceFailed = true; throw new Error("BACKEND_POLICY_PERSISTENCE_FAILED"); }
      }
      await this.emit(policy, "applied");
      return { applied: true, policy, probes };
    } catch {
      try {
        this.router.setPolicy(previous.policy);
        this.router.setFailureThreshold(previous.failureThreshold ?? 3);
        this.router.setPriorityOrder(previous.priorityOrder ?? []);
      } catch { /* rollback is best effort; the rejected state is still reported */ }
      await this.emit(previous.policy, "rejected");
      return { applied: false, policy: previous.policy, probes, reason: persistenceFailed ? "persistence-failed" : "policy-failed" };
    }
  }

  private async emit(policy: RouterPolicy, outcome: "applied" | "rejected"): Promise<void> {
    try { await this.timeline?.record({ type: "backend-policy", policy, outcome, at: Date.now() }); } catch { /* optional telemetry */ }
  }
  private result(applied: false, policy: RouterPolicy, probes: readonly BackendProbeResult[], reason: BackendTuneResult["reason"]): BackendTuneResult {
    void this.emit(policy, "rejected");
    return { applied, policy, probes, reason };
  }
}
