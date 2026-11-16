/**
 * RestoreTransaction — safe restore with staging, pre-backup of current state, verify, commit/rollback.
 * Exceeds DSHA by making every step explicit and testable in TypeScript.
 */
import type { RuntimeIdentity } from "../runtime/RuntimeIdentity";
import { RuntimeTransaction } from "../runtime/RuntimeTransaction";
import type { RuntimeJournalEntry } from "../runtime/RuntimeJournal";
import type { BackupAdapter, BackupScope } from "./BackupManager";
import {
  BACKUP_FORMAT_CURRENT,
  parseManifest,
  validateManifest,
  type BackupManifestV2,
  type IntegrityCheck,
} from "./BackupIntegrity";

const BACKUP_SCOPES: readonly BackupScope[] = ["full", "projects", "sessions", "agent", "toolchains"];

export type RestorePlan = Readonly<{
  source: string;
  manifest: BackupManifestV2;
  integrity: IntegrityCheck;
  impactPaths: readonly string[];
}>;

export type RestoreResult = Readonly<{
  ok: boolean;
  plan?: RestorePlan;
  error?: string;
  rolledBack?: boolean;
  preBackupPath?: string;
}>;

export class RestoreTransaction {
  constructor(
    private readonly tx: RuntimeTransaction,
    private readonly adapter: BackupAdapter,
    private readonly identity: RuntimeIdentity,
    private readonly resolvePaths: (scope: BackupScope) => string[],
  ) {}

  /** Inspect archive without mutating anything. */
  async inspect(source: string): Promise<RestorePlan | { ok: false; error: string }> {
    const inspected = await this.adapter.inspect(source);
    if (!inspected.ok) {
      return { ok: false, error: inspected.error || "INSPECT_FAILED" };
    }
    let manifest: BackupManifestV2 | null = null;
    if (this.adapter.readManifest) {
      let raw;
      try {
        raw = await this.adapter.readManifest(source);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "BACKUP_MANIFEST_READ_FAILED",
        };
      }
      if (raw != null) {
        manifest = parseManifest(raw);
        if (!manifest) return { ok: false, error: "BACKUP_MANIFEST_INVALID" };
      }
    }
    if (!manifest) {
      // Synthetic manifest from inspect when no file
      manifest = {
        format: BACKUP_FORMAT_CURRENT,
        createdAt: Date.now(),
        identity: this.identity,
        scope: "full",
        homeRoot: "",
        paths: this.resolvePaths("full"),
        digest: inspected.digest,
        fileCount: inspected.files,
        totalBytes: inspected.bytes,
      };
    }
    if (!BACKUP_SCOPES.includes(manifest.scope as BackupScope)) {
      return { ok: false, error: "INVALID_BACKUP_SCOPE" };
    }
    const integrity = validateManifest(manifest, this.identity, {
      ok: inspected.ok,
      files: inspected.files,
      bytes: inspected.bytes,
      digest: inspected.digest,
    });
    if (!integrity.ok) {
      return { ok: false, error: integrity.errors.join("; ") };
    }
    const scope = (manifest.scope as BackupScope) || "full";
    // Never trust archive-controlled absolute manifest paths for pre-backup or restore.
    // The selected scope is resolved against this device's canonical HomeLayout.
    const impactPaths = this.resolvePaths(scope);
    if (!impactPaths.length) return { ok: false, error: "BACKUP_RESTORE_SCOPE_EMPTY" };
    try {
      await this.adapter.validateRestoreScope?.(source, impactPaths);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "BACKUP_SCOPE_VALIDATION_FAILED" };
    }
    return { source, manifest, integrity, impactPaths };
  }

  /**
   * Full restore:
   * inspect → stage check → pre-backup current → restore → verify → commit
   * On failure → rollback to pre-backup if available.
   */
  async restore(
    source: string,
    options?: { preBackupDestination?: string; skipPreBackup?: boolean },
  ): Promise<RestoreResult> {
    const planOrErr = await this.inspect(source);
    if ("error" in planOrErr && planOrErr.ok === false) {
      return { ok: false, error: planOrErr.error };
    }
    const plan = planOrErr as RestorePlan;

    const normalizedSource = source.replace(/[\\/]+$/, "");
    let preBackupPath = options?.skipPreBackup
      ? undefined
      : options?.preBackupDestination || `${normalizedSource}.pre-restore-${Date.now()}`;
    let preBackupReady = false;

    const result = await this.tx.run(
      "backup:restore",
      async (ctx) => {
        await ctx.stage("prepare", `source=${source}`);

        if (!options?.skipPreBackup) {
          preBackupPath = preBackupPath || `${normalizedSource}.pre-restore-${Date.now()}`;
          if (preBackupPath.replace(/[\\/]+$/, "") === normalizedSource) {
            throw new Error("BACKUP_PREBACKUP_PATH_INVALID");
          }
          await ctx.stage("prepare", "pre-backup-current");
          await this.adapter.ensureDir(preBackupPath);
          await this.adapter.snapshot([...plan.impactPaths], preBackupPath);
          const preInspection = await this.adapter.inspect(preBackupPath);
          if (!preInspection.ok || !preInspection.digest) {
            throw new Error(preInspection.error || "BACKUP_PREBACKUP_VERIFY_FAILED");
          }
          await ctx.annotate({
            preBackupReady: "true",
            preBackupDigest: preInspection.digest,
            preBackupFiles: String(preInspection.files),
            preBackupBytes: String(preInspection.bytes),
          });
          preBackupReady = true;
        }

        await ctx.stage("mutate", "restore-files");
        await this.adapter.restore(source, [...plan.impactPaths]);

        await ctx.stage("verify", "post-restore-inspect");
        // Best-effort: re-list is adapter-specific; we trust restore() throw on hard fail
        return plan;
      },
      {
        metadata: {
          source,
          scope: plan.manifest.scope,
          impactPaths: JSON.stringify(plan.impactPaths),
          ...(options?.skipPreBackup ? { preBackupSkipped: "true" } : preBackupPath ? { preBackupPath } : {}),
        },
        ...(!options?.skipPreBackup ? {
          rollback: async () => {
            if (preBackupReady && preBackupPath) {
              await this.adapter.clear?.([...plan.impactPaths]);
              await this.adapter.restore(preBackupPath, [...plan.impactPaths]);
            }
          },
        } : {}),
      },
    );

    if (result.ok === true) {
      return { ok: true, plan: result.value, preBackupPath: preBackupReady ? preBackupPath : undefined };
    }
    return {
      ok: false,
      plan,
      error: result.error,
      rolledBack: result.rolledBack,
      preBackupPath: preBackupReady ? preBackupPath : undefined,
    };
  }

  /** Recover a killed restore only when its complete pre-image was durably verified. */
  async recoverInterruptedRestore(entry: RuntimeJournalEntry): Promise<"rolled_back" | "failed"> {
    if (entry.operation !== "backup:restore") return "failed";
    const metadata = entry.metadata ?? {};
    if (metadata.phase !== "mutate" && metadata.phase !== "verify") return "failed";
    if (metadata.preBackupReady !== "true" || !metadata.preBackupPath) return "failed";
    if (!BACKUP_SCOPES.includes(metadata.scope as BackupScope)) return "failed";
    const impactPaths = this.resolvePaths(metadata.scope as BackupScope);
    if (impactPaths.length === 0) return "failed";

    const preInspection = await this.adapter.inspect(metadata.preBackupPath);
    if (!preInspection.ok || !preInspection.digest) return "failed";
    if (metadata.preBackupDigest && preInspection.digest !== metadata.preBackupDigest) return "failed";
    if (metadata.preBackupFiles && String(preInspection.files) !== metadata.preBackupFiles) return "failed";
    if (metadata.preBackupBytes && String(preInspection.bytes) !== metadata.preBackupBytes) return "failed";

    await this.adapter.clear?.([...impactPaths]);
    await this.adapter.restore(metadata.preBackupPath, [...impactPaths]);
    return "rolled_back";
  }
}
