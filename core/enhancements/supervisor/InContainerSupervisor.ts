import type { ProcessRegistry, RegisteredProcess } from "../../process/ProcessRegistry";
import type { RuntimeSupervisor } from "../../runtime/RuntimeSupervisor";
import type { RuntimeJournal } from "../../runtime/RuntimeJournal";
import { applyManifest } from "../manifest/RuntimeManifest";
import { ManifestError } from "../manifest/types";
import type { ManifestProcess, ManifestProcessAdapter, RuntimeManifest } from "../manifest/types";
import type { InContainerSupervisorAdapter } from "./types";

function processSpecs(manifest: RuntimeManifest): ManifestProcess[] {
  const result: ManifestProcess[] = [];
  const healthIntervalMs = manifest.health?.intervalMs ?? 5_000;
  const capabilities = manifest.capabilities ?? [];
  if (manifest.web) result.push({ name: "web", command: manifest.web.command, env: manifest.env ?? {}, capabilities, healthCommand: manifest.web.health ?? manifest.health?.command, healthIntervalMs, restart: true, restartAfterTask: manifest.restartAfterTask ?? false });
  for (const worker of manifest.workers ?? []) result.push({ name: worker.name, command: worker.command, env: manifest.env ?? {}, capabilities, healthCommand: manifest.health?.command, healthIntervalMs, restart: worker.restart ?? true, restartAfterTask: manifest.restartAfterTask ?? false });
  return result;
}
function redactOutput(value: string): string {
  return value.slice(-2048)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization|credential|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gi, "[REDACTED]")
    .replace(/-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/gi, "[REDACTED PRIVATE KEY]");
}

/** Manifest-controlled processes layered over the project's existing RuntimeSupervisor. */
export class InContainerSupervisor {
  private readonly specs = new Map<string, ManifestProcess>();
  private readonly manifests = new Map<string, RuntimeManifest>();
  private ticking = false;
  private readonly removeRecoveryHandler: () => void;

  constructor(private readonly registry: ProcessRegistry, private readonly supervisor: RuntimeSupervisor, private readonly journal: RuntimeJournal, private readonly processAdapter: InContainerSupervisorAdapter, private readonly manifestAdapter: ManifestProcessAdapter) {
    this.removeRecoveryHandler = supervisor.addRecoveryHandler(async (process, error) => {
      if (process.metadata?.manifestManaged !== "true" || process.metadata.restart !== "true") return false;
      const spec = this.specs.get(process.id);
      if (!spec || !this.processAdapter.restart) return false;
      let authorized = false;
      try { authorized = await this.manifestAdapter.authorize(spec.command, process.label ?? spec.name, spec.capabilities ?? []); } catch { authorized = false; }
      if (!authorized) return false;
      const ok = await this.processAdapter.restart(process, spec);
      if (ok) this.registry.patchMetadata(process.id, { health: "healthy", lastRecoveryAt: String(Date.now()) });
      return ok;
    });
  }

  /** Apply an already validated manifest and keep private specs for policy-controlled restarts. */
  async apply(manifest: RuntimeManifest, projectId: string): Promise<readonly string[]> {
    const previous = this.registry.list().filter((process) => process.projectId === projectId && process.metadata?.manifestManaged === "true");
    const ids = await applyManifest(this.registry, this.manifestAdapter, manifest, projectId);
    const specs = processSpecs(manifest);
    ids.forEach((id, index) => { const spec = specs[index]; if (spec) this.specs.set(id, spec); });
    const newIds = new Set(ids);
    const stale = previous.filter((process) => !newIds.has(process.id));
    for (const process of stale) {
      try {
        await this.manifestAdapter.stop(process.id);
        this.registry.unregister(process.id);
        this.specs.delete(process.id);
      } catch {
        this.registry.patchMetadata(process.id, { health: "quarantined", manifestReplacementStopFailedAt: String(Date.now()) });
        for (const id of ids) {
          try { await this.manifestAdapter.stop(id); this.registry.unregister(id); this.specs.delete(id); }
          catch { this.registry.patchMetadata(id, { health: "quarantined", manifestReplacementRollbackStopFailedAt: String(Date.now()) }); }
        }
        throw new ManifestError("APPLY_FAILED", "Replacement manifest started but an old process could not be stopped; active records were retained for repair");
      }
    }
    this.manifests.set(projectId, manifest);
    return ids;
  }

  /** Health probe, redact captured output into RuntimeJournal, then delegate restart budgets to the existing supervisor. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const process of this.registry.list()) {
        if (process.metadata?.manifestManaged !== "true") continue;
        const spec = this.specs.get(process.id);
        let processAuthorized = false;
        try { processAuthorized = Boolean(spec) && await this.manifestAdapter.authorize(spec!.command, process.label ?? spec!.name, spec!.capabilities ?? []); } catch { processAuthorized = false; }
        if (!processAuthorized) {
          await this.stopFailedProcess(process);
          continue;
        }
        const healthCommand = process.metadata.healthCommand;
        const interval = Number(process.metadata.healthIntervalMs);
        const lastHealthAt = Number(process.metadata.lastHealthAt ?? 0);
        const intervalMs = Number.isFinite(interval) && interval >= 1_000 ? interval : 5_000;
        if (healthCommand && Date.now() - (Number.isFinite(lastHealthAt) ? lastHealthAt : 0) >= intervalMs) {
          let healthAuthorized = false;
          try { healthAuthorized = await this.manifestAdapter.authorize(healthCommand, `${process.label ?? "process"}:health`, spec!.capabilities ?? []); } catch { healthAuthorized = false; }
          const lastHealthAtValue = String(Date.now());
          if (!healthAuthorized) {
            // Policy denial is not evidence that the process is unhealthy; never
            // feed it into RuntimeSupervisor's restart path.
            this.registry.patchMetadata(process.id, { health: "policy-blocked", lastHealthAt: lastHealthAtValue, healthPolicyBlockedAt: lastHealthAtValue });
          } else {
            let healthy = false;
            try { healthy = await this.processAdapter.probe(healthCommand, process); } catch { healthy = false; }
            this.registry.patchMetadata(process.id, { health: healthy ? "healthy" : "failed", lastHealthAt: lastHealthAtValue });
          }
        }
        if (this.processAdapter.collectOutput) {
          try {
            const output = await this.processAdapter.collectOutput(process);
            if (output && (output.stdout || output.stderr)) {
              const entry = await this.journal.begin("process.output", { processId: process.id, stdout: redactOutput(output.stdout), stderr: redactOutput(output.stderr) });
              await this.journal.finish(entry, "completed");
            }
          } catch { /* log collection is best effort and cannot fail the supervisor tick */ }
        }
      }
      await this.supervisor.tick();
    } finally { this.ticking = false; }
  }

  /** Restart only processes explicitly marked restartAfterTask. */
  async afterTask(projectId?: string): Promise<number> {
    let restarted = 0;
    for (const process of this.registry.list()) {
      if (process.metadata?.manifestManaged !== "true" || process.metadata.restartAfterTask !== "true") continue;
      if (projectId && process.projectId !== projectId) continue;
      const spec = this.specs.get(process.id);
      if (!spec || !this.processAdapter.restart) {
        await this.stopFailedProcess(process);
        throw new ManifestError("APPLY_FAILED", "Task restart was requested but no restart adapter is available");
      }
      let authorized = false;
      try { authorized = await this.manifestAdapter.authorize(spec.command, process.label ?? spec.name, spec.capabilities ?? []); } catch { authorized = false; }
      if (!authorized) {
        await this.stopFailedProcess(process);
        throw new ManifestError("POLICY_DENIED", `Policy denied task restart: ${spec.name}`);
      }
      let ok = false;
      try { ok = await this.processAdapter.restart(process, spec); } catch { ok = false; }
      if (!ok) {
        await this.stopFailedProcess(process);
        throw new ManifestError("APPLY_FAILED", `Task restart failed: ${spec.name}`);
      }
      this.registry.patchMetadata(process.id, { health: "healthy", lastTaskRestartAt: String(Date.now()) });
      restarted++;
    }
    for (const [manifestProjectId, currentManifest] of this.manifests) {
      if (projectId && manifestProjectId !== projectId) continue;
      const build = currentManifest.build;
      if (build?.afterTask !== true) continue;
      const capabilities = currentManifest.capabilities ?? [];
      if (!this.manifestAdapter.runOnce || !(await this.manifestAdapter.authorize(build.command, `build:${manifestProjectId}`, capabilities))) throw new ManifestError("POLICY_DENIED", "Build command is not authorized");
      await this.manifestAdapter.runOnce(build.command, currentManifest.env ?? {}, capabilities);
    }
    return restarted;
  }

  /** Stop an unhealthy manifest process when restart support is unavailable or fails; never leave an untracked orphan. */
  async stopFailedProcess(process: RegisteredProcess): Promise<boolean> {
    if (process.metadata?.manifestManaged !== "true") return false;
    try {
      await this.manifestAdapter.stop(process.id);
      this.registry.unregister(process.id);
      this.specs.delete(process.id);
      return true;
    } catch {
      this.registry.patchMetadata(process.id, { health: "quarantined", watchdogStopFailedAt: String(Date.now()) });
      return false;
    }
  }

  /** Dispose the recovery hook when the owning runtime is torn down. */
  dispose(): void { this.removeRecoveryHandler(); this.specs.clear(); this.manifests.clear(); }
}
