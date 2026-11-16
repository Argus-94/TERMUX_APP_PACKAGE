import type { PressureReport, ReaperAdapter } from "./types";
import { SleepWakeManager } from "./SleepWakeManager";

export type PressurePolicy = Readonly<{ lowMemoryBytes: number; criticalMemoryBytes: number }>;
const DEFAULT_POLICY: PressurePolicy = { lowMemoryBytes: 384 * 1024 * 1024, criticalMemoryBytes: 128 * 1024 * 1024 };

/** One-shot pressure response. Android memory warnings are supplied by a host adapter; no polling is started here. */
export class ResourcePressureReaper {
  private running = false;
  constructor(private readonly lifecycle: SleepWakeManager, private readonly adapter: ReaperAdapter, private readonly policy: PressurePolicy = DEFAULT_POLICY) {}

  async reap(): Promise<PressureReport> {
    if (this.running) return { availableBytes: -1, stage: "none", slept: 0, stoppedWorkers: 0, quarantined: 0 };
    this.running = true;
    try {
      const availableBytes = Math.max(0, await this.adapter.availableMemoryBytes());
      if (availableBytes > this.policy.lowMemoryBytes) return { availableBytes, stage: "none", slept: 0, stoppedWorkers: 0, quarantined: 0 };
      const slept = await this.lifecycle.reapIdle();
      let stage: PressureReport["stage"] = "sleep-idle";
      let stoppedWorkers = 0;
      let quarantined = 0;
      if (availableBytes <= this.policy.lowMemoryBytes) {
        stoppedWorkers = await this.adapter.stopNonCriticalWorkers();
        stage = "stop-workers";
      }
      if (availableBytes <= this.policy.criticalMemoryBytes) {
        quarantined = await this.adapter.quarantineNonCriticalContainers();
        if (quarantined > 0) stage = "quarantine";
      }
      return { availableBytes, stage, slept, stoppedWorkers, quarantined };
    } finally { this.running = false; }
  }
}
