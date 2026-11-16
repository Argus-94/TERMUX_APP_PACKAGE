/** Explicit performance profiles aligned with RuntimeBackendRouter's public RouterPolicy. */
import type { RouterPolicy } from "../../runtime/RuntimeBackendRouter.ts";
import type { BackendTuneOptions, BackendTuner, BackendTuneResult } from "./BackendTuner.ts";

/** User-selectable operating mode names. */
export type PerformanceModeName = "Performance" | "Balanced" | "Battery" | "Compatibility";
/** Snapshot facts supplied by the caller; this module performs no polling. */
export type DeviceFacts = Readonly<{ pluggedIn?: boolean; batteryPercent?: number; lowPowerMode?: boolean; availableMemoryBytes?: number; totalMemoryBytes?: number; architectureSupported?: boolean }>;
/** Resolved RouterPolicy and coarse rate/battery hints for one mode. */
export type PerformanceProfile = Readonly<{ mode: PerformanceModeName; routerPolicy: RouterPolicy; failureThreshold: number; priorityStrategy: NonNullable<BackendTuneOptions["priorityStrategy"]>; requestRateHint: "high" | "normal" | "low"; batteryImpact: "high" | "moderate" | "low"; conservativeFeatures: boolean }>;
/** Durable store for the user's explicitly selected profile. */
export type PerformanceModeStore = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }>;
/** Optional best-effort timeline sink for profile changes. */
export type PerformanceModeTimeline = Readonly<{ record(event: Readonly<{ type: "performance.mode"; mode: PerformanceModeName; policy: RouterPolicy; at: number }>): Promise<void> | void }>;
/** Result of an explicit profile application; a failed backend tune never changes the selected profile. */
export type PerformanceModeApplyResult = Readonly<{ applied: boolean; mode: PerformanceModeName; tune: BackendTuneResult; persisted: boolean | null; rollbackApplied?: boolean }>;

const profiles: Readonly<Record<PerformanceModeName, PerformanceProfile>> = {
  Performance: { mode: "Performance", routerPolicy: "prefer-fastest-healthy", failureThreshold: 2, priorityStrategy: "fastest", requestRateHint: "high", batteryImpact: "high", conservativeFeatures: false },
  Balanced: { mode: "Balanced", routerPolicy: "prefer-priority", failureThreshold: 3, priorityStrategy: "base", requestRateHint: "normal", batteryImpact: "moderate", conservativeFeatures: false },
  Battery: { mode: "Battery", routerPolicy: "sticky", failureThreshold: 4, priorityStrategy: "active-first", requestRateHint: "low", batteryImpact: "low", conservativeFeatures: true },
  Compatibility: { mode: "Compatibility", routerPolicy: "prefer-priority", failureThreshold: 1, priorityStrategy: "base", requestRateHint: "low", batteryImpact: "low", conservativeFeatures: true },
};

/** Chooses a profile from explicitly supplied facts; no background observation or polling occurs. */
export function choosePerformanceMode(mode?: PerformanceModeName, facts?: DeviceFacts): PerformanceProfile {
  if (mode) return profiles[mode];
  const device = facts ?? {};
  if (device.architectureSupported === false || device.availableMemoryBytes !== undefined && device.availableMemoryBytes < 1_500_000_000 || device.totalMemoryBytes !== undefined && device.totalMemoryBytes < 2_500_000_000) return profiles.Compatibility;
  if (device.lowPowerMode || !device.pluggedIn && device.batteryPercent !== undefined && device.batteryPercent <= 20 || device.totalMemoryBytes !== undefined && device.totalMemoryBytes < 5_000_000_000) return profiles.Battery;
  if (device.pluggedIn && device.batteryPercent !== undefined && device.batteryPercent >= 70 && (device.totalMemoryBytes === undefined || device.totalMemoryBytes >= 8_000_000_000)) return profiles.Performance;
  return profiles.Balanced;
}

/** Validates a persisted mode without trusting its serialized value. */
export function isPerformanceModeName(value: unknown): value is PerformanceModeName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(profiles, value);
}

/**
 * Persistent controller for an explicit user choice. It starts in Balanced mode,
 * restores only previously saved choices, and never polls battery or device facts.
 */
export class PerformanceModeController {
  private current: PerformanceModeName = "Balanced";

  /** Binds a probe-gated backend tuner and optional persistence/audit adapters. */
  constructor(private readonly tuner: BackendTuner, private readonly store?: PerformanceModeStore, private readonly timeline?: PerformanceModeTimeline) {}

  /** Returns the current in-memory choice. */
  getMode(): PerformanceModeName { return this.current; }

  /** Restores an explicit saved choice; an absent/invalid value leaves Balanced unchanged. */
  async restore(): Promise<PerformanceModeName> {
    let raw: string | null;
    try { raw = await this.store?.read() ?? null; } catch { return this.current; }
    if (!raw) return this.current;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !isPerformanceModeName((parsed as { mode?: unknown }).mode)) return this.current;
      const mode = (parsed as { mode: PerformanceModeName }).mode;
      const result = await this.apply(mode);
      return result.applied ? mode : this.current;
    } catch { return this.current; }
  }

  /** Applies a mode only when at least one backend is healthy; failed tuning preserves the old mode. */
  async apply(mode: PerformanceModeName): Promise<PerformanceModeApplyResult> {
    const profile = choosePerformanceMode(mode);
    const tune = await this.tuner.apply(profile.routerPolicy, { failureThreshold: profile.failureThreshold, priorityStrategy: profile.priorityStrategy });
    if (!tune.applied) return { applied: false, mode: this.current, tune, persisted: null };
    if (this.store) {
      try {
        await this.store.write(JSON.stringify({ mode, updatedAt: Date.now() }));
      } catch {
        const previous = this.current;
        const previousProfile = choosePerformanceMode(previous);
        const rollback = await this.tuner.apply(previousProfile.routerPolicy, { failureThreshold: previousProfile.failureThreshold, priorityStrategy: previousProfile.priorityStrategy });
        return {
          applied: false,
          mode: previous,
          tune: { ...tune, applied: false, policy: rollback.applied ? rollback.policy : tune.policy, reason: "persistence-failed" },
          persisted: false,
          rollbackApplied: rollback.applied,
        };
      }
    }
    this.current = mode;
    try { await this.timeline?.record({ type: "performance.mode", mode, policy: profile.routerPolicy, at: Date.now() }); } catch { /* telemetry is non-critical */ }
    return { applied: true, mode, tune, persisted: this.store ? true : null };
  }
}
