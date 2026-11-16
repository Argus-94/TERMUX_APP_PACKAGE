/**
 * BackupIntegrity — SHA-256 style digest helpers and manifest validation.
 * Pure logic; no filesystem (adapters do I/O).
 */
import type { RuntimeIdentity } from "../runtime/RuntimeIdentity";
import { requiresMigration } from "../runtime/RuntimeIdentity";

export const BACKUP_FORMAT_CURRENT = 2 as const;

export type BackupManifestV2 = Readonly<{
  format: 2;
  createdAt: number;
  identity: RuntimeIdentity;
  scope: string;
  homeRoot: string;
  paths: readonly string[];
  digest?: string;
  fileCount?: number;
  totalBytes?: number;
  features?: readonly string[];
  appVersion?: string;
}>;

export type IntegrityCheck = Readonly<{
  ok: boolean;
  errors: readonly string[];
  warnings: readonly string[];
  compatible: boolean;
  requiresMigration: boolean;
}>;

/** Accept format 1 (legacy) or 2. */
export function parseManifest(raw: unknown): BackupManifestV2 | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const format = Number(m.format);
  if (format !== 1 && format !== 2) return null;
  if (!m.identity || typeof m.identity !== "object") return null;
  if (!Array.isArray(m.paths)) return null;
  return {
    format: 2,
    createdAt: Number(m.createdAt) || 0,
    identity: m.identity as RuntimeIdentity,
    scope: String(m.scope ?? "full"),
    homeRoot: String(m.homeRoot ?? ""),
    paths: (m.paths as unknown[]).map(String),
    digest: typeof m.digest === "string" ? m.digest : undefined,
    fileCount: typeof m.fileCount === "number" ? m.fileCount : undefined,
    totalBytes: typeof m.totalBytes === "number" ? m.totalBytes : undefined,
    features: Array.isArray(m.features) ? (m.features as string[]) : undefined,
    appVersion: typeof m.appVersion === "string" ? m.appVersion : undefined,
  };
}

export function validateManifest(
  manifest: BackupManifestV2,
  current: RuntimeIdentity,
  inspected?: { ok: boolean; files?: number; bytes?: number; digest?: string },
): IntegrityCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (Number(manifest.format) !== 1 && Number(manifest.format) !== 2) {
    errors.push(`UNSUPPORTED_FORMAT:${manifest.format}`);
  }
  if (!manifest.paths.length) {
    errors.push("EMPTY_PATHS");
  }
  if (inspected && !inspected.ok) {
    errors.push("INSPECT_FAILED");
  }
  if (manifest.digest && inspected?.digest && manifest.digest !== inspected.digest) {
    errors.push(`DIGEST_MISMATCH:expected=${manifest.digest}:actual=${inspected.digest}`);
  }
  if (manifest.fileCount != null && inspected?.files != null && manifest.fileCount !== inspected.files) {
    errors.push(`FILE_COUNT_MISMATCH:manifest=${manifest.fileCount}:actual=${inspected.files}`);
  }
  if (manifest.totalBytes != null && inspected?.bytes != null && manifest.totalBytes !== inspected.bytes) {
    errors.push(`TOTAL_BYTES_MISMATCH:manifest=${manifest.totalBytes}:actual=${inspected.bytes}`);
  }

  const needsMigration = requiresMigration(manifest.identity, current);
  if (needsMigration) {
    warnings.push(
      `MIGRATION_REQUIRED:from=${manifest.identity.schemaVersion}/${manifest.identity.rootfsVersion}:to=${current.schemaVersion}/${current.rootfsVersion}`,
    );
  }

  // Same major app family only
  const major = (v: string) => v.split(".")[0] ?? "0";
  if (major(manifest.identity.appVersion) !== major(current.appVersion)) {
    warnings.push(`APP_MAJOR_DIFF:${manifest.identity.appVersion}->${current.appVersion}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    compatible: errors.length === 0,
    requiresMigration: needsMigration,
  };
}

/** Simple stable string hash for tests (not crypto). Adapters should prefer real SHA-256. */
export function stableDigest(parts: string[]): string {
  let h = 2166136261;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
