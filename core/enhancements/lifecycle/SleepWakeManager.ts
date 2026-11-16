import type { ContainerLifecycleRecord, AppLifecycleState, LifecyclePolicy, LifecycleStore, SleepWakeAdapter } from "./types";
import { LifecycleError } from "./types";

const DEFAULT_POLICY: LifecyclePolicy = { idleThresholdMs: 12 * 60_000, backgroundIdleThresholdMs: 60_000, healthTimeoutMs: 30_000 };

/** Mobile-aware sleep/wake policy. It stops user processes but never removes rootfs/container data. */
export class SleepWakeManager {
  private readonly records = new Map<string, ContainerLifecycleRecord>();
  private loaded = false;
  private appState: AppLifecycleState = "active";
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: SleepWakeAdapter, private readonly store?: LifecycleStore, private policy: LifecyclePolicy = DEFAULT_POLICY, private readonly now: () => number = Date.now) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string | null | undefined;
    try { raw = await this.store?.read(); }
    catch { throw new LifecycleError("STORE_FAILED", "Lifecycle state could not be loaded"); }
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) for (const value of parsed) {
          if (!value || typeof value !== "object") continue;
          const record = value as Partial<ContainerLifecycleRecord>;
          if (typeof record.containerId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(record.containerId)) continue;
          if (!(record.state === "running" || record.state === "sleeping" || record.state === "quarantined")) continue;
          if (!Number.isFinite(record.lastUsedAt) || !Number.isFinite(record.changedAt)) continue;
          this.records.set(record.containerId, record as ContainerLifecycleRecord);
        }
      } catch { /* invalid state is ignored; runtime state starts safe and awake */ }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.store) return;
    const next = this.queue.catch(() => undefined).then(() => this.store!.write(JSON.stringify([...this.records.values()])));
    this.queue = next.catch(() => undefined);
    try { await next; } catch { throw new LifecycleError("STORE_FAILED", "Lifecycle state could not be saved"); }
  }

  /** Register a known running container without changing its rootfs. */
  async register(containerId: string): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(containerId)) throw new LifecycleError("UNKNOWN_CONTAINER", "Invalid lifecycle id");
    await this.load(); const now = this.now();
    const previous = this.records.get(containerId);
    this.records.set(containerId, { containerId, state: "running", lastUsedAt: now, changedAt: previous?.state === "running" ? previous.changedAt : now });
    await this.persist();
  }

  /** Forget lifecycle metadata after the owning runtime has removed a container. */
  async unregister(containerId: string): Promise<boolean> {
    await this.load();
    const removed = this.records.delete(containerId);
    if (removed) await this.persist();
    return removed;
  }

  /** Mark a container as used by an active task/session. */
  async touch(containerId: string): Promise<void> {
    await this.load(); const previous = this.records.get(containerId);
    if (!previous) throw new LifecycleError("UNKNOWN_CONTAINER", "Unknown container lifecycle id");
    this.records.set(containerId, { ...previous, lastUsedAt: this.now() }); await this.persist();
  }

  /** React Native AppState adapters call this when foreground/background changes. */
  setAppState(state: AppLifecycleState): void { this.appState = state; }

  /** Apply an explicit performance profile; no timer or background poll is started. */
  setPolicy(policy: LifecyclePolicy): void { this.policy = { ...policy }; }

  /** Stop managed processes and preserve rootfs/state for a later wake. */
  async sleep(containerId: string, reason = "idle"): Promise<boolean> {
    await this.load(); const previous = this.records.get(containerId);
    if (!previous) throw new LifecycleError("UNKNOWN_CONTAINER", "Unknown container lifecycle id");
    if (previous.state === "sleeping" || previous.state === "quarantined") return false;
    try { await this.adapter.stopProcesses(containerId); }
    catch { throw new LifecycleError("SLEEP_FAILED", "Container processes could not be stopped"); }
    this.records.set(containerId, { ...previous, state: "sleeping", changedAt: this.now(), reason }); await this.persist(); return true;
  }

  /** Restore processes from the runtime manifest and wait for health before reporting awake. */
  async wake(containerId: string): Promise<boolean> {
    await this.load(); const previous = this.records.get(containerId);
    if (!previous) throw new LifecycleError("UNKNOWN_CONTAINER", "Unknown container lifecycle id");
    if (previous.state === "quarantined") throw new LifecycleError("WAKE_FAILED", "Quarantined container requires explicit repair");
    if (previous.state === "running") { await this.touch(containerId); return false; }
    try { await this.adapter.startFromManifest(containerId); const healthy = await this.adapter.waitForHealth(containerId, this.policy.healthTimeoutMs); if (!healthy) throw new Error("health failed"); }
    catch { try { await this.adapter.stopProcesses(containerId); } catch { /* preserve sleeping marker */ } throw new LifecycleError("WAKE_FAILED", "Container failed to become healthy after wake"); }
    const now = this.now(); this.records.set(containerId, { ...previous, state: "running", lastUsedAt: now, changedAt: now }); await this.persist(); return true;
  }

  /** Sleep idle containers once per maintenance pass; no internal polling loop is created. */
  async reapIdle(): Promise<number> {
    await this.load(); const now = this.now(); const threshold = this.appState === "active" ? this.policy.idleThresholdMs : this.policy.backgroundIdleThresholdMs; let count = 0;
    for (const record of [...this.records.values()]) {
      if (record.state !== "running" || now - record.lastUsedAt < threshold) continue;
      try { if (await this.sleep(record.containerId, this.appState === "active" ? "idle" : "app-background")) count++; }
      catch { /* a busy or unresponsive container must not block independent idle work */ }
    }
    return count;
  }

  /** Used by pressure reaper after it has stopped an idle workload. */
  async list(): Promise<readonly ContainerLifecycleRecord[]> { await this.load(); return [...this.records.values()]; }
  /** Quarantine is a state marker only; it never deletes container files. */
  async quarantine(containerId: string, reason: string): Promise<void> {
    await this.load(); const previous = this.records.get(containerId); if (!previous) throw new LifecycleError("UNKNOWN_CONTAINER", "Unknown container lifecycle id");
    if (previous.state === "running") { try { await this.adapter.stopProcesses(containerId); } catch { throw new LifecycleError("SLEEP_FAILED", "Container processes could not be stopped for quarantine"); } }
    this.records.set(containerId, { ...previous, state: "quarantined", changedAt: this.now(), reason: reason.slice(0, 120) }); await this.persist();
  }
}
