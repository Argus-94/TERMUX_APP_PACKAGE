/**
 * Cooperative gate: normal work may coexist; maintenance is exclusive and drains normal work first.
 * Enhanced with drain timeout and maintenance snapshot for diagnostics.
 */
export type RuntimeTaskMode = "normal" | "maintenance";
export type RuntimeTask = Readonly<{
  id: string;
  mode: RuntimeTaskMode;
  owner: string;
  startedAt: number;
}>;

export class RuntimeTaskGate {
  private readonly normal = new Map<string, RuntimeTask>();
  private maintenance: RuntimeTask | null = null;
  private maintenanceRequests = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly drainTimeoutMs: number;

  constructor(options?: { drainTimeoutMs?: number }) {
    this.drainTimeoutMs = options?.drainTimeoutMs ?? 15_000;
  }

  snapshot() {
    return {
      normal: [...this.normal.values()],
      maintenance: this.maintenance,
      maintenanceRequested: this.maintenanceRequests > 0,
    };
  }

  async run<T>(mode: RuntimeTaskMode, owner: string, fn: () => Promise<T> | T): Promise<T> {
    if (mode === "normal") return this.runNormal(owner, fn);
    return this.runMaintenance(owner, fn);
  }

  private async runNormal<T>(owner: string, fn: () => Promise<T> | T): Promise<T> {
    while (this.maintenance || this.maintenanceRequests > 0) {
      await this.queue;
    }
    const task: RuntimeTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mode: "normal",
      owner,
      startedAt: Date.now(),
    };
    this.normal.set(task.id, task);
    try {
      return await fn();
    } finally {
      this.normal.delete(task.id);
    }
  }

  private async runMaintenance<T>(owner: string, fn: () => Promise<T> | T): Promise<T> {
    this.maintenanceRequests += 1;
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = false;
    try {
      await previous;
      const deadline = Date.now() + this.drainTimeoutMs;
      while (this.normal.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      if (this.normal.size > 0) throw new Error("MAINTENANCE_DRAIN_TIMEOUT");

      const task: RuntimeTask = {
        id: `maintenance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: "maintenance",
        owner,
        startedAt: Date.now(),
      };
      this.maintenance = task;
      acquired = true;
      return await fn();
    } finally {
      if (acquired) this.maintenance = null;
      this.maintenanceRequests = Math.max(0, this.maintenanceRequests - 1);
      release();
    }
  }
}
