/**
 * BackupManager — create/inspect/restore with maintenance gate + journal.
 * Format 2 manifests + RestoreTransaction for safe restore.
 */
import type { HomeLayout } from "../home/HomeLayout";
import type { RuntimeIdentity } from "../runtime/RuntimeIdentity";
import { RuntimeTaskGate } from "../runtime/RuntimeTaskGate";
import { RuntimeJournal } from "../runtime/RuntimeJournal";
import { RuntimeTransaction } from "../runtime/RuntimeTransaction";
import { BACKUP_FORMAT_CURRENT, type BackupManifestV2 } from "./BackupIntegrity";
import { RestoreTransaction, type RestorePlan, type RestoreResult } from "./RestoreTransaction";
import type { SnapshotRecord, WorkspaceSnapshot } from "../enhancements/snapshot/WorkspaceSnapshot";
import type { TimelineEventType, TimelineLevel } from "../enhancements/timeline/EventStore";

export type BackupScope = "full" | "projects" | "sessions" | "agent" | "toolchains";

/** @deprecated prefer BackupManifestV2 — kept for adapter compatibility */
export type BackupManifest = Readonly<{
  format: 1 | 2;
  createdAt: number;
  identity: RuntimeIdentity;
  scope: BackupScope;
  homeRoot: string;
  paths: string[];
  digest?: string;
  fileCount?: number;
  totalBytes?: number;
  features?: string[];
  appVersion?: string;
}>;

export interface BackupAdapter {
  ensureDir(path: string): Promise<void>;
  snapshot(paths: string[], destination: string): Promise<void>;
  inspect(destination: string): Promise<{ ok: boolean; bytes: number; files: number; digest?: string; error?: string }>;
  /** Remove the selected restore scope before extraction so snapshots replace, not overlay, live state. */
  clear?(paths: string[]): Promise<void>;
  /** Validate that an archive represents the entire selected scope before any live data is cleared. */
  validateRestoreScope?(source: string, paths: string[]): Promise<void>;
  restore(source: string, paths: string[]): Promise<void>;
  writeManifest?(destination: string, manifest: BackupManifest): Promise<void>;
  readManifest?(source: string): Promise<BackupManifest | null>;
}

export type BackupEventSink = (event: Readonly<{ type: TimelineEventType; level: TimelineLevel; payload: Readonly<Record<string, unknown>> }>) => Promise<void> | void;

export class BackupManager {
  readonly restoreTx: RestoreTransaction;
  private readonly tx: RuntimeTransaction;
  private eventSink?: BackupEventSink;

  constructor(
    private readonly home: HomeLayout,
    private readonly identity: RuntimeIdentity,
    private readonly adapter: BackupAdapter,
    private readonly gate: RuntimeTaskGate,
    private readonly journal: RuntimeJournal,
    private readonly workspaceSnapshots?: Pick<WorkspaceSnapshot, "createSnapshot" | "restoreSnapshot" | "listSnapshots">,
  ) {
    this.tx = new RuntimeTransaction(gate, journal);
    this.restoreTx = new RestoreTransaction(this.tx, adapter, identity, (scope) => this.paths(scope));
  }

  /** Attach structured activity logging; telemetry failures never affect backup operations. */
  setEventSink(sink: BackupEventSink): void { this.eventSink = sink; }
  private async emit(event: Parameters<BackupEventSink>[0]): Promise<void> { try { await this.eventSink?.(event); } catch { /* observability is best effort */ } }

  paths(scope: BackupScope): string[] {
    const common = [this.home.metadata];
    if (scope === "full") {
      return [
        this.home.projects,
        this.home.workspace,
        this.home.containers,
        this.home.toolchains,
        this.home.sdk,
        this.home.cache,
        this.home.logs,
        ...common,
      ];
    }
    if (scope === "projects") return [this.home.projects];
    if (scope === "sessions") return [this.home.workspace];
    if (scope === "toolchains") return [this.home.toolchains, this.home.sdk];
    return [this.home.workspace, this.home.metadata];
  }

  async create(scope: BackupScope, destination: string): Promise<BackupManifest> {
    let endFg: (() => void) | null = null;
    try {
      const fg = await import("../../lib/foreground-task");
      const id = fg.startForegroundTask("backup", `Backup ${scope}`);
      endFg = () => fg.endForegroundTask(id);
    } catch {
      /* optional */
    }
    await this.emit({ type: "backup.started", level: "info", payload: { scope } });
    try {
    const result = await this.tx.run(
      "backup:create",
      async (ctx) => {
        const paths = this.paths(scope);
        await ctx.stage("prepare", `scope=${scope}`);
        await this.adapter.ensureDir(destination);
        await ctx.stage("mutate", "snapshot");
        await this.adapter.snapshot(paths, destination);
        await ctx.stage("verify", "inspect");
        const inspected = await this.adapter.inspect(destination);
        if (!inspected.ok) throw new Error(inspected.error || "BACKUP_INTEGRITY_FAILED");
        const manifest: BackupManifest = {
          format: BACKUP_FORMAT_CURRENT,
          createdAt: Date.now(),
          identity: this.identity,
          scope,
          homeRoot: this.home.root,
          paths,
          digest: inspected.digest,
          fileCount: inspected.files,
          totalBytes: inspected.bytes,
          features: ["projects", "sessions", "agent-memory", "toolchains"].filter(() => true),
          appVersion: this.identity.appVersion,
        };
        await this.adapter.writeManifest?.(destination, manifest);
        return manifest;
      },
      { metadata: { scope, destination } },
    );
    if (result.ok === false) throw new Error(result.error);
    await this.emit({ type: "backup.finished", level: "info", payload: { scope, ok: true, fileCount: result.value.fileCount ?? 0, totalBytes: result.value.totalBytes ?? 0 } });
    return result.value;
    } catch (error) {
      await this.emit({ type: "backup.finished", level: "error", payload: { scope, ok: false, error: error instanceof Error ? error.message : "BACKUP_FAILED" } });
      throw error;
    } finally {
      endFg?.();
    }
  }

  async inspect(source: string): Promise<RestorePlan | { ok: false; error: string }> {
    return this.restoreTx.inspect(source);
  }

  /**
   * Scan parent directory for backup folders containing manifest.json.
   * Default parent: home.backups
   */
  async list(parentDir?: string): Promise<
    Array<{
      path: string;
      scope?: string;
      createdAt?: number;
      digest?: string;
      fileCount?: number;
      totalBytes?: number;
      appVersion?: string;
    }>
  > {
    const parent = parentDir || this.home.backups;
    await this.adapter.ensureDir(parent);
    // Adapter may not expose readdir — use inspect via known children through optional hook
    const listFn = (this.adapter as { listChildren?: (dir: string) => Promise<string[]> }).listChildren;
    let children: string[] = [];
    if (listFn) {
      children = await listFn.call(this.adapter, parent);
    } else {
      // Fallback: try reading a simple listing file written by env adapter
      try {
        const anyAdapter = this.adapter as { env?: { exec: (c: string) => Promise<{ stdout?: string; exitCode?: number }> } };
        // TermuxBackupAdapter has env private — use readManifest probes on conventional names
        children = [];
      } catch {
        children = [];
      }
    }
    const out: Array<{
      path: string;
      scope?: string;
      createdAt?: number;
      digest?: string;
      fileCount?: number;
      totalBytes?: number;
      appVersion?: string;
    }> = [];
    for (const name of children) {
      const path = `${parent.replace(/[\\/]+$/, "")}/${name}`;
      const man = await this.adapter.readManifest?.(path);
      if (man) {
        out.push({
          path,
          scope: man.scope,
          createdAt: man.createdAt,
          digest: man.digest,
          fileCount: man.fileCount,
          totalBytes: man.totalBytes,
          appVersion: man.appVersion,
        });
      }
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  async restore(source: string, options?: { preBackupDestination?: string; skipPreBackup?: boolean }): Promise<RestoreResult> {
    await this.emit({ type: "restore.started", level: "info", payload: { source } });
    try {
      const result = await this.restoreTx.restore(source, options);
      await this.emit({ type: "restore.finished", level: result.ok ? "info" : "error", payload: { ok: result.ok, source } });
      return result;
    } catch (error) {
      await this.emit({ type: "restore.finished", level: "error", payload: { ok: false, source, error: error instanceof Error ? error.message : "RESTORE_FAILED" } });
      throw error;
    }
  }

  /** Create a workspace-only archive, separate from full-system backup scopes. */
  async createWorkspaceSnapshot(projectRoot: string, label?: string): Promise<SnapshotRecord> {
    if (!this.workspaceSnapshots) throw new Error("WORKSPACE_SNAPSHOT_UNAVAILABLE");
    const record = await this.workspaceSnapshots.createSnapshot(projectRoot, label);
    await this.emit({ type: "snapshot.created", level: "info", payload: { snapshotId: record.id, projectId: record.projectId, label: record.label ?? "" } });
    return record;
  }

  /** Restore one workspace snapshot using the snapshot manager's gate and pre-restore safety copy. */
  async restoreWorkspaceSnapshot(projectRoot: string, snapshotId: string): Promise<SnapshotRecord> {
    if (!this.workspaceSnapshots) throw new Error("WORKSPACE_SNAPSHOT_UNAVAILABLE");
    const safety = await this.workspaceSnapshots.restoreSnapshot(projectRoot, snapshotId);
    await this.emit({ type: "snapshot.restored", level: "info", payload: { snapshotId, preRestoreSnapshotId: safety.id } });
    return safety;
  }

  /** List workspace snapshots without mixing them with system backup archives. */
  async listWorkspaceSnapshots(projectId: string): Promise<readonly SnapshotRecord[]> {
    if (!this.workspaceSnapshots) throw new Error("WORKSPACE_SNAPSHOT_UNAVAILABLE");
    return this.workspaceSnapshots.listSnapshots(projectId);
  }
}
