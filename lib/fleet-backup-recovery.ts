import type { RuntimeFacade } from "../core/RuntimeFacade";
import { createFleetRecoverySnapshot, restoreFleetRecoverySnapshot, validateFleetRecoverySnapshot, type FleetRecoverySnapshot } from "./fleet-audit-recovery";
import type { ReleaseChannel } from "./release-channel-manager";

export type FleetBackupRecord = {
  schema: 1;
  id: string;
  channel?: ReleaseChannel;
  createdAt: string;
  archivePath: string;
  encryptedPath: string;
  signaturePath: string;
  manifestPath: string;
  sha256: string;
  signature: string;
  snapshotId: string;
};

const CHANNELS: readonly ReleaseChannel[] = ["debug", "internal", "beta", "production"];
function q(v: string): string { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function validSecret(v: string): boolean { return typeof v === "string" && v.length >= 12 && v.length <= 4096; }
function validSegment(v: string): boolean { return /^[A-Za-z0-9._:-]{1,160}$/.test(v); }
function validChannel(v: string): v is ReleaseChannel { return CHANNELS.includes(v as ReleaseChannel); }
function validRecord(record: FleetBackupRecord, projectPath: string, backupId: string): boolean {
  const root = `${projectPath}/artifacts/deployments/backups/${backupId}`;
  return record.schema === 1
    && record.id === backupId
    && record.archivePath === `${root}.tar.gz`
    && record.encryptedPath === `${root}.tar.gz.enc`
    && record.signaturePath === `${root}.sig`
    && record.manifestPath === `${root}.json`
    && /^[a-f0-9]{64}$/i.test(record.sha256)
    && /^[a-f0-9]{64}$/i.test(record.signature)
    && /^fleet-snapshot-[0-9]{10,}$/.test(record.snapshotId)
    && (!record.channel || validChannel(record.channel));
}
async function exec(runtime: RuntimeFacade, command: string) {
  return await runtime.environment.exec(command, {});
}
async function read(runtime: RuntimeFacade, file: string): Promise<string> {
  const r = await exec(runtime, `if [ -f ${q(file)} ]; then cat ${q(file)}; fi`);
  if (((r as any).exitCode ?? 0) !== 0) throw new Error(`BACKUP_READ_FAILED:${file}`);
  return String((r as any).stdout || "");
}
async function write(runtime: RuntimeFacade, file: string, text: string): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await exec(runtime, `mkdir -p ${q(dir)} && printf '%s' ${q(text)} > ${q(tmp)} && mv -f ${q(tmp)} ${q(file)}`);
  if (((r as any).exitCode ?? 0) !== 0) {
    await exec(runtime, `rm -f ${q(tmp)}`).catch(() => undefined);
    throw new Error(`BACKUP_WRITE_FAILED:${file}`);
  }
}
async function sha(runtime: RuntimeFacade, file: string): Promise<string> {
  const r = await exec(runtime, `sha256sum ${q(file)} | awk '{print $1}'`);
  const value = String((r as any).stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("SHA256_UNAVAILABLE");
  return value;
}
async function hmac(runtime: RuntimeFacade, file: string, secret: string): Promise<string> {
  const r = await exec(runtime, `openssl dgst -sha256 -hmac ${q(secret)} ${q(file)}`);
  const match = String((r as any).stdout || "").match(/([a-f0-9]{64})\s*$/i);
  if (!match) throw new Error("HMAC_UNAVAILABLE");
  return match[1].toLowerCase();
}

function retentionCount(value?: number): number { return Math.min(Math.max(Math.floor(value ?? 5), 1), 30); }

export async function createFleetEncryptedBackup(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  secret: string;
  channel?: ReleaseChannel;
  retention?: number;
  reason?: string;
}): Promise<{ record: FleetBackupRecord; snapshot: FleetRecoverySnapshot }> {
  if (!validSecret(options.secret)) throw new Error("BACKUP_SECRET_TOO_SHORT");
  if (options.channel && !validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const snapshot = await createFleetRecoverySnapshot({ runtime: options.runtime, projectPath: options.projectPath });
  const id = `fleet-backup-${Date.now()}`;
  const root = `${options.projectPath}/artifacts/deployments/backups/${id}`;
  const archive = `${root}.tar.gz`;
  const encrypted = `${root}.tar.gz.enc`;
  const signaturePath = `${root}.sig`;
  const manifestPath = `${root}.json`;
  await write(options.runtime, `${root}/snapshot.json`, JSON.stringify(snapshot, null, 2));
  await write(options.runtime, `${root}/BACKUP-INFO.txt`, `AI Builder Fleet Backup\\nID=${id}\\nCreated=${new Date().toISOString()}\\nReason=${options.reason || "manual"}\\nEncrypted=true\\nSignature=HMAC-SHA256\\n`);
  const tar = await exec(options.runtime, `tar -czf ${q(archive)} -C ${q(root)} .`);
  if (((tar as any).exitCode ?? 0) !== 0) throw new Error("BACKUP_ARCHIVE_FAILED");
  const enc = await exec(options.runtime, `printf %s ${q(options.secret)} | openssl enc -aes-256-cbc -pbkdf2 -salt -in ${q(archive)} -out ${q(encrypted)} -pass stdin`);
  if (((enc as any).exitCode ?? 0) !== 0) throw new Error("BACKUP_ENCRYPTION_FAILED");
  const signature = await hmac(options.runtime, encrypted, options.secret);
  await write(options.runtime, signaturePath, `${signature}\\n`);
  const digest = await sha(options.runtime, encrypted);
  const record: FleetBackupRecord = { schema: 1, id, channel: options.channel, createdAt: new Date().toISOString(), archivePath: archive, encryptedPath: encrypted, signaturePath, manifestPath, sha256: digest, signature, snapshotId: snapshot.id };
  await write(options.runtime, manifestPath, JSON.stringify(record, null, 2));
  await exec(options.runtime, `rm -rf ${q(root)}`);
  await pruneFleetBackups({ runtime: options.runtime, projectPath: options.projectPath, retention: options.retention });
  return { record, snapshot };
}

export async function verifyFleetEncryptedBackup(options: { runtime: RuntimeFacade; projectPath: string; backupId: string; secret: string }): Promise<{ valid: boolean; record?: FleetBackupRecord; reason?: string }> {
  if (!validSecret(options.secret)) throw new Error("BACKUP_SECRET_TOO_SHORT");
  if (!validSegment(options.backupId) || !options.backupId.startsWith("fleet-backup-")) throw new Error("INVALID_BACKUP_ID");
  const root = `${options.projectPath}/artifacts/deployments/backups/${options.backupId}`;
  const manifestText = await read(options.runtime, `${root}.json`);
  if (!manifestText) return { valid: false, reason: "BACKUP_MANIFEST_NOT_FOUND" };
  let record: FleetBackupRecord;
  try { record = JSON.parse(manifestText) as FleetBackupRecord; } catch { return { valid: false, reason: "BACKUP_MANIFEST_INVALID" }; }
  if (!validRecord(record, options.projectPath, options.backupId)) return { valid: false, record, reason: "BACKUP_MANIFEST_INVALID" };
  const digest = await sha(options.runtime, record.encryptedPath).catch(() => "");
  if (digest !== record.sha256) return { valid: false, record, reason: "BACKUP_SHA256_MISMATCH" };
  const actualSig = await hmac(options.runtime, record.encryptedPath, options.secret).catch(() => "");
  if (actualSig !== record.signature) return { valid: false, record, reason: "BACKUP_SIGNATURE_MISMATCH" };
  return { valid: true, record };
}

export async function restoreFleetEncryptedBackup(options: { runtime: RuntimeFacade; projectPath: string; backupId: string; secret: string }): Promise<{ restored: boolean; backupId: string; snapshotId: string; recoveryIndexUpdated: boolean }> {
  const verification = await verifyFleetEncryptedBackup(options);
  if (!verification.valid || !verification.record) throw new Error(verification.reason || "BACKUP_VERIFICATION_FAILED");
  const record = verification.record;
  const temp = `${options.projectPath}/artifacts/deployments/backups/restore-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mkdir = await exec(options.runtime, `mkdir -p ${q(temp)}`);
  if (((mkdir as any).exitCode ?? 0) !== 0) throw new Error("BACKUP_TEMP_CREATE_FAILED");
  try {
    const dec = await exec(options.runtime, `printf %s ${q(options.secret)} | openssl enc -d -aes-256-cbc -pbkdf2 -in ${q(record.encryptedPath)} -out ${q(temp + "/backup.tar.gz")} -pass stdin`);
    if (((dec as any).exitCode ?? 0) !== 0) throw new Error("BACKUP_DECRYPTION_FAILED");
    const list = await exec(options.runtime, `tar -tzf ${q(temp + "/backup.tar.gz")}`);
    const members = String((list as any).stdout || "").split(/\r?\n/).filter(Boolean);
    const allowed = new Set(["./", ".", "./snapshot.json", "./BACKUP-INFO.txt"]);
    if (((list as any).exitCode ?? 0) !== 0 || new Set(members).size !== members.length || members.some((name) => !allowed.has(name)) || !members.includes("./snapshot.json")) throw new Error("BACKUP_ARCHIVE_UNSAFE");
    const extract = await exec(options.runtime, `tar -xzf ${q(temp + "/backup.tar.gz")} -C ${q(temp)}`);
    if (((extract as any).exitCode ?? 0) !== 0) throw new Error("BACKUP_EXTRACTION_FAILED");
    const snapshotText = await read(options.runtime, `${temp}/snapshot.json`);
    if (!snapshotText) throw new Error("BACKUP_SNAPSHOT_MISSING");
    let snapshot: FleetRecoverySnapshot;
    try { snapshot = JSON.parse(snapshotText) as FleetRecoverySnapshot; } catch { throw new Error("INVALID_BACKUP_SNAPSHOT"); }
    await validateFleetRecoverySnapshot(options.runtime, snapshot);
    const recovery = `${options.projectPath}/artifacts/deployments/recovery`;
    await write(options.runtime, `${recovery}/${snapshot.id}.json`, JSON.stringify(snapshot, null, 2));
    const restored = await restoreFleetRecoverySnapshot({ runtime: options.runtime, projectPath: options.projectPath, snapshotId: snapshot.id });
    if (!restored.restored || restored.files !== snapshot.files.length) throw new Error("BACKUP_RESTORE_INCOMPLETE");
    let recoveryIndexUpdated = true;
    try {
      await write(options.runtime, `${recovery}/LATEST.json`, JSON.stringify({ schema: 1, snapshot: snapshot.id, manifestSha256: snapshot.manifestSha256, createdAt: snapshot.createdAt }, null, 2));
    } catch {
      recoveryIndexUpdated = false;
    }
    return { restored: true, backupId: options.backupId, snapshotId: snapshot.id, recoveryIndexUpdated };
  } finally {
    await exec(options.runtime, `rm -rf ${q(temp)}`).catch(() => undefined);
  }
}

export async function listFleetBackups(options: { runtime: RuntimeFacade; projectPath: string; limit?: number }): Promise<FleetBackupRecord[]> {
  const dir = `${options.projectPath}/artifacts/deployments/backups`;
  const r = await exec(options.runtime, `mkdir -p ${q(dir)}; for f in ${q(dir)}/*.json; do [ -f "$f" ] && cat "$f" && printf '\\n'; done`);
  const out: FleetBackupRecord[] = [];
  for (const line of String((r as any).stdout || "").split(/\n(?=\{)/).filter(Boolean)) { try { const x = JSON.parse(line) as FleetBackupRecord; if (validSegment(x.id) && x.id.startsWith("fleet-backup-") && validRecord(x, options.projectPath, x.id)) out.push(x); } catch {} }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out.slice(0, Math.min(Math.max(options.limit ?? 20, 1), 50));
}

export async function pruneFleetBackups(options: { runtime: RuntimeFacade; projectPath: string; retention?: number }): Promise<{ removed: number }> {
  const keep = retentionCount(options.retention);
  const all = await listFleetBackups({ runtime: options.runtime, projectPath: options.projectPath, limit: 50 });
  let removed = 0;
  for (const record of all.slice(keep)) {
    await exec(options.runtime, `rm -f ${q(record.encryptedPath)} ${q(record.signaturePath)} ${q(record.manifestPath)} ${q(record.archivePath)}`);
    removed += 1;
  }
  return { removed };
}
