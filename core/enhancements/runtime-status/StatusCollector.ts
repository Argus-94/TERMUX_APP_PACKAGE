import { createRuntimeLiveSnapshot } from "./StatusSnapshot";
import type { RuntimeLiveSnapshot, RuntimeStatusSources } from "./types";

/** Gather cached runtime state; host adapters may omit RAM/battery when no supported bridge exists. */
export class StatusCollector {
  constructor(private readonly sources: RuntimeStatusSources, private readonly now: () => number = Date.now) {}

  /** Collect one immutable point-in-time snapshot with graceful per-source degradation. */
  async collect(): Promise<RuntimeLiveSnapshot> {
    const unavailable = new Set<string>();
    const [containers, portForwards, resources, interceptorActive] = await Promise.all([
      Promise.resolve().then(() => this.sources.containers()).catch(() => { unavailable.add("containers"); return []; }),
      Promise.resolve().then(() => this.sources.portForwards()).catch(() => { unavailable.add("portForwards"); return 0; }),
      Promise.resolve().then(() => this.sources.resources()).catch(() => { unavailable.add("resources"); return {}; }),
      Promise.resolve().then(() => this.sources.interceptorActive?.() ?? false).catch(() => { unavailable.add("interceptor"); return false; }),
    ]);
    if (Object.keys(resources).length === 0) unavailable.add("resources");
    let processes: RuntimeLiveSnapshot["processes"] = { total: 0, supervised: 0, quarantined: 0 };
    try { processes = this.sources.processes(); } catch { unavailable.add("processes"); }
    let backends: ReturnType<RuntimeStatusSources["backends"]> = [];
    try { backends = this.sources.backends(); } catch { unavailable.add("backends"); }
    let lastError: string | undefined;
    try { lastError = this.sources.lastError?.(); } catch { /* diagnostic-only */ }
    return createRuntimeLiveSnapshot({ timestamp: this.now(), backends, containers, processes, resources, portForwards, ...(interceptorActive ? { interceptorActive: true } : {}), ...(lastError ? { lastError } : {}), ...(unavailable.size ? { unavailable: [...unavailable] } : {}) });
  }
}
