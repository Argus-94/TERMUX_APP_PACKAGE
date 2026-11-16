/**
 * RuntimeMaintenanceCoordinator — ordered shutdown of work before mutate ops.
 * Mirrors DSHA "stop Web/PTY → barrier → mutate" with AI Builder services.
 */
import type { RuntimeTaskGate } from "./RuntimeTaskGate";
import type { RuntimeJournal } from "./RuntimeJournal";
import type { ProcessRegistry } from "../process/ProcessRegistry";

export type MaintenanceStep = Readonly<{
  id: string;
  label: string;
  status: "pending" | "running" | "ok" | "skipped" | "failed";
  detail?: string;
}>;

export type MaintenanceReport = Readonly<{
  operation: string;
  steps: readonly MaintenanceStep[];
  ok: boolean;
  durationMs: number;
}>;

export type MaintenanceHooks = {
  /** Stop terminal sessions / PTY */
  stopTerminals?: () => Promise<void>;
  /** Pause or cancel agent runs */
  pauseAgent?: () => Promise<void>;
  /** Flush logs / open writers */
  flushWriters?: () => Promise<void>;
  /** Tick the existing runtime supervisor (no timer is started here). */
  tickSupervisor?: () => Promise<void>;
  /** Apply one idle-sleep / memory-pressure pass. */
  reapResources?: () => Promise<void>;
  /** Wake one container from its persisted manifest state. */
  wakeContainer?: (containerId: string) => Promise<void>;
};

export type MaintenanceTickReport = Readonly<{ supervisorOk: boolean; reaperOk: boolean }>;

export class RuntimeMaintenanceCoordinator {
  private tickInProgress: Promise<MaintenanceTickReport> | null = null;
  constructor(
    private readonly gate: RuntimeTaskGate,
    private readonly journal: RuntimeJournal,
    private readonly registry?: ProcessRegistry,
    private readonly hooks: MaintenanceHooks = {},
  ) {}

  /** Run one battery-aware maintenance pass when the app/host signals it is safe. */
  async tick(): Promise<MaintenanceTickReport> {
    if (this.tickInProgress) return this.tickInProgress;
    const current = (async () => {
      let supervisorOk = true;
      let reaperOk = true;
      try { await this.hooks.tickSupervisor?.(); } catch { supervisorOk = false; }
      try { await this.hooks.reapResources?.(); } catch { reaperOk = false; }
      return { supervisorOk, reaperOk };
    })();
    this.tickInProgress = current;
    try { return await current; }
    finally { if (this.tickInProgress === current) this.tickInProgress = null; }
  }

  /** Delegate a task-triggered wake to the configured lifecycle adapter. */
  async wakeContainer(containerId: string): Promise<void> {
    if (this.hooks.wakeContainer) await this.hooks.wakeContainer(containerId);
  }

  /**
   * Run exclusive maintenance after draining cooperative work and stopping side services.
   */
  async runExclusive<T>(
    operation: string,
    body: () => Promise<T>,
    options?: { skipHooks?: boolean },
  ): Promise<{ result: T; report: MaintenanceReport }> {
    const started = Date.now();
    const steps: MaintenanceStep[] = [];

    const mark = (id: string, label: string, status: MaintenanceStep["status"], detail?: string) => {
      steps.push({ id, label, status, detail });
    };

    return this.gate.run("maintenance", operation, async () => {
      const entry = await this.journal.begin(`maintenance:${operation}`);

      try {
        if (!options?.skipHooks && this.hooks.pauseAgent) {
          try {
            await this.hooks.pauseAgent();
            mark("agent", "Pause agent", "ok");
          } catch (e) {
            mark("agent", "Pause agent", "failed", e instanceof Error ? e.message : String(e));
          }
        } else {
          mark("agent", "Pause agent", "skipped");
        }

        if (!options?.skipHooks && this.hooks.stopTerminals) {
          try {
            await this.hooks.stopTerminals();
            mark("terminals", "Stop terminals", "ok");
          } catch (e) {
            mark("terminals", "Stop terminals", "failed", e instanceof Error ? e.message : String(e));
          }
        } else {
          mark("terminals", "Stop terminals", "skipped");
        }

        if (this.registry) {
          const watched = this.registry.list().filter((p) => p.metadata?.watchdog === "true");
          mark("processes", "Process registry", "ok", `watched=${watched.length}`);
        } else {
          mark("processes", "Process registry", "skipped");
        }

        if (!options?.skipHooks && this.hooks.flushWriters) {
          try {
            await this.hooks.flushWriters();
            mark("flush", "Flush writers", "ok");
          } catch (e) {
            mark("flush", "Flush writers", "failed", e instanceof Error ? e.message : String(e));
          }
        } else {
          mark("flush", "Flush writers", "skipped");
        }

        mark("body", "Mutate", "running");
        const result = await body();
        steps[steps.length - 1] = { id: "body", label: "Mutate", status: "ok" };

        await this.journal.finish(entry, "completed");
        return {
          result,
          report: {
            operation,
            steps,
            ok: true,
            durationMs: Date.now() - started,
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        mark("body", "Mutate", "failed", msg);
        await this.journal.finish(entry, "failed", msg);
        throw e;
      }
    });
  }
}
