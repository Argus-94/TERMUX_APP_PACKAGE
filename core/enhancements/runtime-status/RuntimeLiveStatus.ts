import { StatusCollector } from "./StatusCollector";
import type { RuntimeLiveSnapshot, RuntimeStatusAppState, RuntimeStatusListener } from "./types";

const MIN_INTERVAL_MS = 1_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 30_000;

/** Subscriber-driven, throttled live status; stops polling without listeners or in background. */
export class RuntimeLiveStatus {
  private readonly listeners = new Set<RuntimeStatusListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private appState: RuntimeStatusAppState = "active";
  private snapshot: RuntimeLiveSnapshot | null = null;
  private pending: Promise<void> | null = null;
  private lastChangeKey = "";
  private lastMaintenanceAt = 0;
  private maintenancePending: Promise<void> | null = null;

  constructor(private readonly collector: StatusCollector, private readonly onImportantChange?: (event: Readonly<{ previous?: RuntimeLiveSnapshot; current: RuntimeLiveSnapshot }>) => void | Promise<void>, private intervalMs = MIN_INTERVAL_MS, private readonly maintenanceTick?: () => Promise<unknown> | unknown, private readonly maintenanceIntervalMs = DEFAULT_MAINTENANCE_INTERVAL_MS) {
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) throw new Error("RUNTIME_STATUS_INTERVAL_TOO_FAST");
    if (!Number.isFinite(maintenanceIntervalMs) || maintenanceIntervalMs < MIN_INTERVAL_MS) throw new Error("RUNTIME_MAINTENANCE_INTERVAL_INVALID");
    this.intervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs));
  }

  /** Return the last cache without causing probes or timers. */
  getSnapshot(): RuntimeLiveSnapshot | null { return this.snapshot; }

  /** Subscribe; first subscriber starts polling, last unsubscribe stops it. */
  subscribe(listener: RuntimeStatusListener): () => void {
    this.listeners.add(listener);
    this.start();
    if (this.snapshot) listener(this.snapshot);
    return () => { this.listeners.delete(listener); if (this.listeners.size === 0) this.stop(); };
  }

  /** Start polling only while subscribed and app is foregrounded. */
  start(): void { this.active = true; this.schedule(0); }
  /** Stop timer and any future polls; an in-flight collection is allowed to finish once. */
  stop(): void { this.active = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  /** Pause in background, resume with a single immediate snapshot in foreground. */
  setAppState(state: RuntimeStatusAppState): void {
    this.appState = state;
    if (state === "background") { if (this.timer) clearTimeout(this.timer); this.timer = null; }
    else if (this.active && this.listeners.size > 0) this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.active || this.appState !== "active" || this.listeners.size === 0 || this.timer || this.pending) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delay);
  }
  private async refresh(): Promise<void> {
    if (!this.active || this.appState !== "active" || this.listeners.size === 0 || this.pending) return;
    this.pending = (async () => {
      try {
        const next = await this.collector.collect();
        if (!this.active || this.appState !== "active" || this.listeners.size === 0) return;
        const previous = this.snapshot;
        this.snapshot = next;
        const changeKey = JSON.stringify({ backends: next.backends.map(({ id, status }) => [id, status]), containers: next.containers.map(({ id, state }) => [id, state]), processes: next.processes, portForwards: next.portForwards, interceptorActive: next.interceptorActive === true, lastError: next.lastError });
        const importantChange = !previous || changeKey !== this.lastChangeKey;
        for (const listener of [...this.listeners]) { try { listener(next); } catch { /* isolate view listeners */ } }
        this.maybeTickMaintenance(next.timestamp);
        if (importantChange) {
          try { await this.onImportantChange?.({ ...(previous ? { previous } : {}), current: next }); } catch { /* telemetry must not affect status */ }
        }
        this.lastChangeKey = changeKey;
      } catch { /* preserve cached snapshot on transient collector errors */ }
    })();
    await this.pending;
    this.pending = null;
    this.schedule(this.intervalMs);
  }

  /** Maintenance runs only while a foreground view subscribes, and is throttled independently of status polling. */
  private maybeTickMaintenance(now: number): void {
    if (!this.maintenanceTick || this.maintenancePending || now - this.lastMaintenanceAt < this.maintenanceIntervalMs) return;
    this.lastMaintenanceAt = now;
    let task: Promise<void>;
    task = Promise.resolve().then(() => this.maintenanceTick?.()).then(() => undefined).catch(() => undefined).finally(() => {
      if (this.maintenancePending === task) this.maintenancePending = null;
    });
    this.maintenancePending = task;
  }
}
