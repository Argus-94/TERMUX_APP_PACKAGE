import type { RuntimeFacade } from "../core/RuntimeFacade";
import { listFleetBackups, verifyFleetEncryptedBackup, type FleetBackupRecord } from "./fleet-backup-recovery";

export type FleetRecoveryDrillResult = {
  schema: 1;
  id: string;
  startedAt: string;
  finishedAt: string;
  status: "PASS" | "FAIL";
  backupId?: string;
  snapshotId?: string;
  files: number;
  stagingPath: string;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  failureReason?: string;
};

function q(v: string): string { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function validSegment(v: string): boolean { return /^[A-Za-z0-9._:-]{1,160}$/.test(v); }
async function exec(runtime: RuntimeFacade, command: string) {
  return await runtime.environment.exec(command, {});
}
async function read(runtime: RuntimeFacade, file: string): Promise<string> {
  const r = await exec(runtime, `if [ -f ${q(file)} ]; then cat ${q(file)}; fi`);
  return String((r as any).stdout || "");
}
async function write(runtime: RuntimeFacade, file: string, value: string): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  await exec(runtime, `mkdir -p ${q(dir)}; printf '%s\\n' ${q(value)} > ${q(file)}`);
}

/**
 * Verifies the newest encrypted backup by decrypting/extracting it into an
 * isolated staging directory and validating its snapshot/file hashes. No
 * production state is written or replaced.
 */
export async function runFleetRecoveryDrill(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  secret: string;
  backupId?: string;
}): Promise<FleetRecoveryDrillResult> {
  const startedAt = new Date().toISOString();
  const id = `recovery-drill-${Date.now()}`;
  const staging = `${options.projectPath}/artifacts/deployments/recovery-drills/${id}`;
  const checks: FleetRecoveryDrillResult["checks"] = [];
  const finish = (status: "PASS" | "FAIL", extra: Partial<FleetRecoveryDrillResult> = {}): FleetRecoveryDrillResult => ({
    schema: 1, id, startedAt, finishedAt: new Date().toISOString(), status,
    files: 0, stagingPath: staging, checks, ...extra,
  });
  if (typeof options.secret !== "string" || options.secret.length < 12 || options.secret.length > 4096) {
    checks.push({ name: "secret_policy", passed: false, detail: "BACKUP_SECRET_TOO_SHORT" });
    return finish("FAIL", { failureReason: "BACKUP_SECRET_TOO_SHORT" });
  }
  await exec(options.runtime, `mkdir -p ${q(staging)}`);
  try {
    const backups = await listFleetBackups({ runtime: options.runtime, projectPath: options.projectPath, limit: 50 });
    const record: FleetBackupRecord | undefined = options.backupId
      ? backups.find((x) => x.id === options.backupId)
      : backups[0];
    checks.push({ name: "backup_discovery", passed: Boolean(record), detail: record?.id || "NO_BACKUP" });
    if (!record) return finish("FAIL", { failureReason: "NO_BACKUP_AVAILABLE" });
    if (!validSegment(record.id) || !record.id.startsWith("fleet-backup-")) return finish("FAIL", { backupId: record.id, failureReason: "INVALID_BACKUP_ID" });
    const verification = await verifyFleetEncryptedBackup({ runtime: options.runtime, projectPath: options.projectPath, backupId: record.id, secret: options.secret });
    checks.push({ name: "backup_integrity", passed: verification.valid, detail: verification.reason || "sha256+hmac_ok" });
    if (!verification.valid) return finish("FAIL", { backupId: record.id, failureReason: verification.reason || "BACKUP_VERIFICATION_FAILED" });

    const decrypted = `${staging}/backup.tar.gz`;
    const dec = await exec(options.runtime, `printf %s ${q(options.secret)} | openssl enc -d -aes-256-cbc -pbkdf2 -in ${q(record.encryptedPath)} -out ${q(decrypted)} -pass stdin`);
    checks.push({ name: "decrypt", passed: (dec as any).exitCode === 0, detail: String((dec as any).stderr || "").trim() || "ok" });
    if (((dec as any).exitCode ?? 1) !== 0) return finish("FAIL", { backupId: record.id, failureReason: "BACKUP_DECRYPTION_FAILED" });

    const list = await exec(options.runtime, `tar -tzf ${q(decrypted)}`);
    const listing = String((list as any).stdout || "");
    const unsafe = /(^|\n)(\/|\.\.\/|.*\/\.\.\/)/.test(listing);
    checks.push({ name: "archive_safety", passed: (list as any).exitCode === 0 && !unsafe, detail: unsafe ? "PATH_TRAVERSAL" : "ok" });
    if (((list as any).exitCode ?? 1) !== 0 || unsafe) return finish("FAIL", { backupId: record.id, failureReason: "BACKUP_ARCHIVE_UNSAFE" });

    const extract = await exec(options.runtime, `mkdir -p ${q(staging + "/extracted")}; tar -xzf ${q(decrypted)} -C ${q(staging + "/extracted")}`);
    checks.push({ name: "extract", passed: (extract as any).exitCode === 0 });
    if (((extract as any).exitCode ?? 1) !== 0) return finish("FAIL", { backupId: record.id, failureReason: "BACKUP_EXTRACT_FAILED" });

    const snapshotText = await read(options.runtime, `${staging}/extracted/snapshot.json`);
    let snapshot: any;
    try { snapshot = JSON.parse(snapshotText); } catch { snapshot = null; }
    const snapshotOk = Boolean(snapshot && snapshot.schema === 1 && snapshot.id && Array.isArray(snapshot.files) && snapshot.manifestSha256);
    checks.push({ name: "snapshot_schema", passed: snapshotOk, detail: snapshot?.id || "INVALID" });
    if (!snapshotOk) return finish("FAIL", { backupId: record.id, failureReason: "INVALID_BACKUP_SNAPSHOT" });

    const manifest = { schema: 1, id: snapshot.id, createdAt: snapshot.createdAt, projectRoot: "PROJECT_ROOT", files: snapshot.files };
    const manifestCheck = await exec(options.runtime, `printf '%s' ${q(JSON.stringify(manifest))} | sha256sum | awk '{print $1}'`);
    const manifestHash = String((manifestCheck as any).stdout || "").trim().toLowerCase();
    checks.push({ name: "snapshot_manifest", passed: manifestHash === String(snapshot.manifestSha256).toLowerCase() });
    if (manifestHash !== String(snapshot.manifestSha256).toLowerCase()) return finish("FAIL", { backupId: record.id, snapshotId: snapshot.id, failureReason: "BACKUP_SNAPSHOT_TAMPERED" });

    let fileCount = 0;
    for (const file of snapshot.files) {
      if (!file || typeof file.path !== "string" || file.path.startsWith("/") || file.path.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(file.path)) return finish("FAIL", { backupId: record.id, snapshotId: snapshot.id, failureReason: `INVALID_SNAPSHOT_PATH:${String(file?.path || "")}` });
      const r = await exec(options.runtime, `printf '%s' ${q(String(file.content || ""))} | sha256sum | awk '{print $1}'`);
      if (String((r as any).stdout || "").trim().toLowerCase() !== String(file.sha256 || "").toLowerCase()) return finish("FAIL", { backupId: record.id, snapshotId: snapshot.id, failureReason: `SNAPSHOT_FILE_HASH_MISMATCH:${file.path}` });
      fileCount += 1;
    }
    checks.push({ name: "snapshot_files", passed: true, detail: `${fileCount} files verified` });
    await write(options.runtime, `${staging}/DRILL-RESULT.json`, JSON.stringify({ id, status: "PASS", backupId: record.id, snapshotId: snapshot.id, files: fileCount, checks }, null, 2));
    return finish("PASS", { backupId: record.id, snapshotId: snapshot.id, files: fileCount });
  } catch (error) {
    return finish("FAIL", { failureReason: error instanceof Error ? error.message : String(error) });
  } finally {
    // Keep only the small result directory; remove decrypted material.
    await exec(options.runtime, `rm -f ${q(staging + "/backup.tar.gz")}; rm -rf ${q(staging + "/extracted")}`);
  }
}
