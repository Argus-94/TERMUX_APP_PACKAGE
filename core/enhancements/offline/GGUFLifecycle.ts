import type {
  GGUFLoadParams,
  GGUFLifecycleEvent,
  GGUFModelPort,
  OfflinePerformanceMode,
} from "./types";

/** Current lifecycle state as observed from the injected local-model port. */
export type GGUFLifecycleState = "unloaded" | "loading" | "loaded" | "unloading" | "error";

/** Optional, caller-supplied lifecycle policy. No device facts are polled. */
export type GGUFLifecycleOptions = Readonly<{
  params?: GGUFLoadParams;
  keepAliveMs?: number;
  unloadInBackground?: boolean;
  now?: () => number;
  onEvent?: (event: GGUFLifecycleEvent) => void;
}>;

/** Stable, content-free lifecycle failure codes. */
export type GGUFLifecycleErrorCode = "MODEL_FILE_MISSING" | "MODEL_LOAD_FAILED" | "MODEL_UNLOAD_FAILED" | "LIFECYCLE_DISPOSED" | "LIFECYCLE_UNLOAD_PENDING";

/** Typed lifecycle error; native error text and file paths are intentionally omitted. */
export class GGUFLifecycleError extends Error {
  constructor(readonly code: GGUFLifecycleErrorCode) {
    super(code);
    this.name = "GGUFLifecycleError";
  }
}

/**
 * Coordinates an already-present GGUF model through an injected port matching
 * lib/local-model.ts. It never downloads files, observes device state, or polls.
 */
export class GGUFLifecycle {
  private state: GGUFLifecycleState = "unloaded";
  private loadTask: Promise<void> | null = null;
  private unloadTask: Promise<void> | null = null;
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private backgrounded = false;
  private activeUsers = 0;
  private pendingUnload: { reason: GGUFLifecycleEvent["reason"]; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null = null;
  private mode: OfflinePerformanceMode = "Balanced";
  private readonly now: () => number;
  private readonly keepAliveMs: number;
  private readonly params: GGUFLoadParams | undefined;
  private readonly unloadInBackground: boolean;

  constructor(private readonly model: GGUFModelPort, private readonly options: GGUFLifecycleOptions = {}) {
    this.now = options.now ?? Date.now;
    this.keepAliveMs = Math.max(0, Math.min(600_000, options.keepAliveMs ?? 60_000));
    this.params = options.params;
    this.unloadInBackground = options.unloadInBackground ?? false;
    this.state = model.isLoaded() ? "loaded" : "unloaded";
  }

  /** Returns the most recently observed state without probing the platform. */
  getState(): GGUFLifecycleState { return this.state; }

  /** Loads an already-present local GGUF model; never initiates a download. */
  async load(): Promise<void> { return this.ensureLoaded(); }

  /** Ensures an existing model file is loaded. Missing files fail closed; no download is attempted. */
  async ensureLoaded(): Promise<void> {
    this.assertActive();
    this.clearKeepAlive();
    if (this.unloadTask) {
      await this.unloadTask.catch(() => undefined);
      this.assertActive();
      return this.ensureLoaded();
    }
    if (this.loadTask) return this.loadTask;
    if (this.model.isLoaded()) {
      const current = this.model.getAppliedParams();
      const desired = this.params;
      if (!desired || (current && current.nCtx === desired.nCtx && current.nThreads === desired.nThreads && current.nGpuLayers === desired.nGpuLayers)) {
        this.state = "loaded";
        return;
      }
    }
    if (!this.model.isDownloaded()) {
      this.state = "error";
      this.emit("load-failed");
      throw new GGUFLifecycleError("MODEL_FILE_MISSING");
    }
    const task = (async () => {
      this.state = "loading";
      this.emit("load-start");
      try {
        await this.model.load(this.params);
        if (!this.model.isLoaded()) throw new GGUFLifecycleError("MODEL_LOAD_FAILED");
        this.state = "loaded";
        this.emit("loaded");
      } catch {
        this.state = "error";
        this.emit("load-failed");
        throw new GGUFLifecycleError("MODEL_LOAD_FAILED");
      }
    })();
    this.loadTask = task;
    try { await task; } finally { if (this.loadTask === task) this.loadTask = null; }
  }

  /** Unloads model memory on an explicit request; no model files are changed. */
  async unload(reason: GGUFLifecycleEvent["reason"] = "user"): Promise<void> {
    this.clearKeepAlive();
    if (this.unloadTask) return this.unloadTask;
    if (this.activeUsers > 0) {
      if (this.pendingUnload) return this.pendingUnload.promise;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      this.pendingUnload = { reason, promise, resolve, reject };
      return promise;
    }
    const task = (async () => {
      if (this.loadTask) await this.loadTask.catch(() => undefined);
      if (!this.model.isLoaded()) {
        this.state = "unloaded";
        return;
      }
      this.state = "unloading";
      try {
        await this.model.unload();
        this.state = this.model.isLoaded() ? "error" : "unloaded";
        if (this.state === "error") throw new GGUFLifecycleError("MODEL_UNLOAD_FAILED");
        this.emit("unloaded", reason);
      } catch {
        this.state = "error";
        this.emit("unload-failed", reason);
        throw new GGUFLifecycleError("MODEL_UNLOAD_FAILED");
      }
    })();
    this.unloadTask = task;
    try { await task; } finally { if (this.unloadTask === task) this.unloadTask = null; }
  }

  /** Acquire a lease so background/pressure unload cannot race active inference. */
  async acquire(): Promise<() => Promise<void>> {
    this.assertActive();
    if (this.pendingUnload) throw new GGUFLifecycleError("LIFECYCLE_UNLOAD_PENDING");
    this.activeUsers += 1;
    try {
      await this.ensureLoaded();
    } catch (error) {
      await this.releaseUse();
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.releaseUse();
    };
  }

  private async releaseUse(): Promise<void> {
    this.activeUsers = Math.max(0, this.activeUsers - 1);
    if (this.activeUsers > 0) return;
    if (this.pendingUnload) {
      const pending = this.pendingUnload;
      this.pendingUnload = null;
      try { await this.unload(pending.reason); pending.resolve(); }
      catch (error) { pending.reject(error); }
      return;
    }
    if (this.model.isLoaded()) this.keepAlive();
  }

  /** Records completed activity and schedules bounded keepalive expiry, if enabled. */
  keepAlive(): void {
    this.assertActive();
    this.clearKeepAlive();
    if (!this.model.isLoaded() || this.keepAliveMs === 0) return;
    this.emit("keepalive");
    this.keepAliveTimer = setTimeout(() => {
      this.keepAliveTimer = null;
      void this.unload("keepalive-expired").catch(() => undefined);
    }, this.keepAliveMs);
  }

  /** Explicit background/foreground hook; callers decide when app state changes. */
  async onBackground(backgrounded: boolean): Promise<void> {
    this.assertActive();
    this.backgrounded = backgrounded;
    this.emit(backgrounded ? "background" : "foreground", backgrounded ? "background" : undefined);
    if (!backgrounded) return;
    if (this.unloadInBackground || this.mode === "Battery" || this.mode === "Compatibility") {
      await this.unload("background");
    } else {
      this.keepAlive();
    }
  }

  /** Explicit memory-pressure signal unloads immediately and never waits for a polling cycle. */
  async onMemoryPressure(): Promise<void> {
    this.assertActive();
    this.emit("memory-pressure", "memory-pressure");
    await this.unload("memory-pressure");
  }

  /** Applies a caller-provided PerformanceMode change; this module imports no app/runtime code. */
  async onPerformanceModeChange(mode: OfflinePerformanceMode): Promise<void> {
    this.assertActive();
    this.mode = mode;
    this.emit("performance-mode", "performance-mode", mode);
    if (this.backgrounded && (mode === "Battery" || mode === "Compatibility")) {
      await this.unload("performance-mode");
    }
  }

  /** Cancels timers and releases model memory, intended for owner teardown. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.clearKeepAlive();
    try { await this.unload("dispose"); } finally { this.disposed = true; }
  }

  private assertActive(): void {
    if (this.disposed) throw new GGUFLifecycleError("LIFECYCLE_DISPOSED");
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer !== null) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private emit(action: GGUFLifecycleEvent["action"], reason?: GGUFLifecycleEvent["reason"], mode?: OfflinePerformanceMode): void {
    try {
      this.options.onEvent?.({ type: "gguf.lifecycle", action, at: this.now(), state: this.state, ...(reason ? { reason } : {}), ...(mode ? { mode } : {}) });
    } catch { /* observers are best-effort and must not disrupt model ownership */ }
  }
}
