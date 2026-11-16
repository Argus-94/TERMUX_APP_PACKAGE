import type { RuntimeFacade } from "../core/RuntimeFacade";
import type { ReleaseChannel } from "./release-channel-manager";
import type { FleetAuditEntry, FleetRole, FleetAction } from "./fleet-policy-manager";

export type SecureAuditEntry = FleetAuditEntry & { prevHash: string; hash: string };
export type AuditFilter = { serial?: string; role?: FleetRole; channel?: ReleaseChannel; action?: FleetAction; result?: FleetAuditEntry["result"] };
export type AuditVerification = { valid: boolean; entries: number; firstError?: string; lastHash?: string };
export type FleetRecoveryFile = { path: string; sha256: string; content: string };
export type FleetRecoverySnapshot = {
  schema: 1;
  id: string;
  createdAt: string;
  projectRoot: string;
  files: FleetRecoveryFile[];
  manifestSha256: string;
};

const CHANNELS: readonly ReleaseChannel[] = ["debug", "internal", "beta", "production"];
const ROLES: readonly FleetRole[] = ["viewer", "operator", "release-manager", "admin"];
const ACTIONS: readonly FleetAction[] = ["view", "deploy", "rollback", "canary", "acknowledge_incident", "set_policy"];
const RESULTS: readonly FleetAuditEntry["result"][] = ["allowed", "denied", "executed"];

function q(v: string): string { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function validSegment(v: string): boolean { return /^[A-Za-z0-9._:-]{1,160}$/.test(v); }
function validChannel(v: string): v is ReleaseChannel { return CHANNELS.includes(v as ReleaseChannel); }
function validRole(v: string): v is FleetRole { return ROLES.includes(v as FleetRole); }
function validAction(v: string): v is FleetAction { return ACTIONS.includes(v as FleetAction); }
function validResult(v: string): v is FleetAuditEntry["result"] { return RESULTS.includes(v as FleetAuditEntry["result"]); }

async function exec(runtime: RuntimeFacade, command: string) {
  const r = await runtime.environment.exec(command, {});
  return r as { exitCode?: number; stdout?: string; stderr?: string };
}
async function readFile(runtime: RuntimeFacade, file: string): Promise<string> {
  const r = await exec(runtime, `if [ -f ${q(file)} ]; then cat ${q(file)}; fi`);
  if ((r.exitCode ?? 0) !== 0) throw new Error(`RECOVERY_READ_FAILED:${file}`);
  return String(r.stdout || "");
}
async function sha256Text(runtime: RuntimeFacade, text: string): Promise<string> {
  const r = await exec(runtime, `printf '%s' ${q(text)} | sha256sum | awk '{print $1}'`);
  const hash = String(r.stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("SHA256_UNAVAILABLE");
  return hash;
}
async function writeText(runtime: RuntimeFacade, file: string, text: string): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await exec(runtime, `mkdir -p ${q(dir)} && printf '%s' ${q(text)} > ${q(tmp)} && mv -f ${q(tmp)} ${q(file)}`);
  if ((r.exitCode ?? 0) !== 0) {
    await exec(runtime, `rm -f ${q(tmp)}`).catch(() => undefined);
    throw new Error(`RECOVERY_WRITE_FAILED:${file}`);
  }
}

async function fileExists(runtime: RuntimeFacade, file: string): Promise<boolean> {
  const r = await exec(runtime, `if [ -f ${q(file)} ]; then printf '1'; else printf '0'; fi`);
  if ((r.exitCode ?? 0) !== 0) throw new Error(`RECOVERY_STAT_FAILED:${file}`);
  return String(r.stdout || "").trim() === "1";
}

async function removeFile(runtime: RuntimeFacade, file: string): Promise<void> {
  const r = await exec(runtime, `rm -f ${q(file)}`);
  if ((r.exitCode ?? 0) !== 0) throw new Error(`RECOVERY_REMOVE_FAILED:${file}`);
}

function canonicalAudit(entry: FleetAuditEntry): string {
  return JSON.stringify({
    id: entry.id, at: entry.at, role: entry.role, action: entry.action,
    channel: entry.channel, serial: entry.serial, result: entry.result, reason: entry.reason,
  });
}

export async function verifyFleetAuditChain(options: { runtime: RuntimeFacade; projectPath: string }): Promise<AuditVerification> {
  const file = `${options.projectPath}/artifacts/deployments/fleet-audit-chain.jsonl`;
  const raw = await readFile(options.runtime, file);
  if (!raw.trim()) return { valid: true, entries: 0 };
  let prev = "GENESIS";
  let count = 0;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    let item: SecureAuditEntry;
    try { item = JSON.parse(line) as SecureAuditEntry; } catch { return { valid: false, entries: count, firstError: "INVALID_JSON" }; }
    if (!item.hash || !/^[a-f0-9]{64}$/i.test(item.hash) || item.prevHash !== prev) return { valid: false, entries: count, firstError: `CHAIN_LINK_INVALID:${item.id}` , lastHash: prev };
    const expected = await sha256Text(options.runtime, `${prev}\n${canonicalAudit(item)}`);
    if (expected !== item.hash.toLowerCase()) return { valid: false, entries: count, firstError: `HASH_MISMATCH:${item.id}`, lastHash: prev };
    prev = item.hash.toLowerCase();
    count += 1;
  }
  return { valid: true, entries: count, lastHash: count ? prev : undefined };
}

export async function listSecureFleetAudit(options: { runtime: RuntimeFacade; projectPath: string; limit?: number; filter?: AuditFilter }): Promise<SecureAuditEntry[]> {
  const file = `${options.projectPath}/artifacts/deployments/fleet-audit-chain.jsonl`;
  const raw = await readFile(options.runtime, file);
  const f = options.filter || {};
  if (f.serial && !validSegment(f.serial)) throw new Error("INVALID_DEVICE_SERIAL");
  if (f.channel && !validChannel(f.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  if (f.role && !validRole(f.role)) throw new Error("INVALID_FLEET_ROLE");
  if (f.action && !validAction(f.action)) throw new Error("INVALID_FLEET_ACTION");
  if (f.result && !validResult(f.result)) throw new Error("INVALID_AUDIT_RESULT");
  const out: SecureAuditEntry[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line) as SecureAuditEntry;
      if (f.serial && item.serial !== f.serial) continue;
      if (f.channel && item.channel !== f.channel) continue;
      if (f.role && item.role !== f.role) continue;
      if (f.action && item.action !== f.action) continue;
      if (f.result && item.result !== f.result) continue;
      out.push(item);
    } catch { /* verifier reports malformed records separately */ }
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  return out.slice(-limit);
}

function snapshotPaths(): string[] {
  const result = [
    "artifacts/deployments/fleet-policy.json",
    "artifacts/deployments/fleet-audit.jsonl",
    "artifacts/deployments/fleet-audit-chain.jsonl",
  ];
  for (const channel of CHANNELS) {
    result.push(`artifacts/channels/${channel}/channel.json`);
    result.push(`artifacts/deployments/fleet-${channel}.json`);
    result.push(`artifacts/deployments/canary-${channel}.json`);
    result.push(`artifacts/deployments/incidents-${channel}.json`);
  }
  return result;
}

export async function createFleetRecoverySnapshot(options: { runtime: RuntimeFacade; projectPath: string }): Promise<FleetRecoverySnapshot> {
  const files: FleetRecoveryFile[] = [];
  for (const relative of snapshotPaths()) {
    const path = `${options.projectPath}/${relative}`;
    if (!(await fileExists(options.runtime, path))) continue;
    const content = await readFile(options.runtime, path);
    files.push({ path: relative, sha256: await sha256Text(options.runtime, content), content });
  }
  const base = { schema: 1 as const, id: `fleet-snapshot-${Date.now()}`, createdAt: new Date().toISOString(), projectRoot: "PROJECT_ROOT", files };
  const manifestSha256 = await sha256Text(options.runtime, JSON.stringify(base));
  const snapshot: FleetRecoverySnapshot = { ...base, manifestSha256 };
  const path = `${options.projectPath}/artifacts/deployments/recovery/${snapshot.id}.json`;
  await writeText(options.runtime, path, JSON.stringify(snapshot, null, 2));
  await writeText(options.runtime, `${options.projectPath}/artifacts/deployments/recovery/LATEST.json`, JSON.stringify({ schema: 1, snapshot: snapshot.id, manifestSha256, createdAt: snapshot.createdAt }, null, 2));
  return snapshot;
}

export async function validateFleetRecoverySnapshot(runtime: RuntimeFacade, snapshot: FleetRecoverySnapshot): Promise<void> {
  if (snapshot.schema !== 1 || !/^fleet-snapshot-[0-9]{10,}$/.test(snapshot.id) || snapshot.projectRoot !== "PROJECT_ROOT" || !Array.isArray(snapshot.files)) throw new Error("INVALID_RECOVERY_SNAPSHOT");
  const base = { schema: 1 as const, id: snapshot.id, createdAt: snapshot.createdAt, projectRoot: "PROJECT_ROOT", files: snapshot.files };
  const expectedManifest = await sha256Text(runtime, JSON.stringify(base));
  if (expectedManifest !== snapshot.manifestSha256) throw new Error("RECOVERY_SNAPSHOT_TAMPERED");
  const allowed = new Set(snapshotPaths());
  const seen = new Set<string>();
  for (const file of snapshot.files) {
    if (!allowed.has(file.path) || seen.has(file.path) || typeof file.content !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error("INVALID_SNAPSHOT_PATH");
    seen.add(file.path);
    if (await sha256Text(runtime, file.content) !== file.sha256.toLowerCase()) throw new Error(`SNAPSHOT_FILE_HASH_MISMATCH:${file.path}`);
  }
}

export async function restoreFleetRecoverySnapshot(options: { runtime: RuntimeFacade; projectPath: string; snapshotId?: string }): Promise<{ restored: boolean; snapshotId: string; files: number }> {
  const recoveryRoot = `${options.projectPath}/artifacts/deployments/recovery`;
  const latest = await readFile(options.runtime, `${recoveryRoot}/LATEST.json`);
  let id = options.snapshotId;
  if (!id) {
    try { id = JSON.parse(latest).snapshot; } catch { /* no latest */ }
  }
  if (!id || !/^fleet-snapshot-[0-9]{10,}$/.test(id)) throw new Error("RECOVERY_SNAPSHOT_NOT_FOUND");
  const snapshotText = await readFile(options.runtime, `${recoveryRoot}/${id}.json`);
  if (!snapshotText) throw new Error("RECOVERY_SNAPSHOT_NOT_FOUND");
  let snapshot: FleetRecoverySnapshot;
  try { snapshot = JSON.parse(snapshotText) as FleetRecoverySnapshot; } catch { throw new Error("INVALID_RECOVERY_SNAPSHOT"); }
  await validateFleetRecoverySnapshot(options.runtime, snapshot);
  const savedByPath = new Map<string, FleetRecoveryFile>(snapshot.files.map((file) => [file.path, file] as const));
  const originals: Array<{ relative: string; path: string; exists: boolean; content: string }> = [];
  for (const relative of snapshotPaths()) {
    const path = `${options.projectPath}/${relative}`;
    const exists = await fileExists(options.runtime, path);
    originals.push({ relative, path, exists, content: exists ? await readFile(options.runtime, path) : "" });
  }
  const touched = new Set<string>();
  try {
    for (const original of originals) {
      const file = savedByPath.get(original.relative);
      touched.add(original.path);
      if (file) {
        await writeText(options.runtime, original.path, file.content);
        if (await readFile(options.runtime, original.path) !== file.content) throw new Error(`RECOVERY_VERIFY_FAILED:${file.path}`);
      } else {
        await removeFile(options.runtime, original.path);
        if (await fileExists(options.runtime, original.path)) throw new Error(`RECOVERY_REMOVE_VERIFY_FAILED:${original.relative}`);
      }
    }
  } catch (restoreError) {
    const rollbackErrors: string[] = [];
    for (const original of originals.filter((entry) => touched.has(entry.path)).reverse()) {
      try {
        if (original.exists) await writeText(options.runtime, original.path, original.content);
        else {
          await removeFile(options.runtime, original.path);
          if (await fileExists(options.runtime, original.path)) throw new Error("ROLLBACK_REMOVE_VERIFY_FAILED");
        }
        if (original.exists && await readFile(options.runtime, original.path) !== original.content) throw new Error("ROLLBACK_VERIFY_FAILED");
      } catch {
        rollbackErrors.push(original.path);
      }
    }
    const cause = restoreError instanceof Error ? restoreError.message : String(restoreError);
    if (rollbackErrors.length) throw new Error(`RECOVERY_RESTORE_FAILED:${cause};ROLLBACK_INCOMPLETE:${rollbackErrors.join(",")}`);
    throw new Error(`RECOVERY_RESTORE_FAILED:${cause};ROLLED_BACK`);
  }
  return { restored: true, snapshotId: id, files: snapshot.files.length };
}

export async function exportFleetAuditBundle(options: { runtime: RuntimeFacade; projectPath: string; channel?: ReleaseChannel; incidentId?: string }): Promise<{ path: string; verification: AuditVerification }> {
  if (options.channel && !validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const verification = await verifyFleetAuditChain(options);
  const audit = await listSecureFleetAudit({ runtime: options.runtime, projectPath: options.projectPath, limit: 1000, filter: options.channel ? { channel: options.channel } : undefined });
  const snapshot = options.incidentId ? undefined : await createFleetRecoverySnapshot(options);
  const id = `fleet-audit-bundle-${Date.now()}`;
  const root = `${options.projectPath}/artifacts/deployments/recovery/${id}`;
  await writeText(options.runtime, `${root}/audit.json`, JSON.stringify({ schema: 1, verification, entries: audit }, null, 2));
  if (snapshot) await writeText(options.runtime, `${root}/snapshot.json`, JSON.stringify(snapshot, null, 2));
  if (options.incidentId) {
    if (!validSegment(options.incidentId)) throw new Error("INVALID_INCIDENT_ID");
    const incident = options.channel ? await readFile(options.runtime, `${options.projectPath}/artifacts/deployments/incidents-${options.channel}.json`) : "";
    await writeText(options.runtime, `${root}/incident-${options.incidentId}.json`, incident || JSON.stringify({ incidentId: options.incidentId, missing: true }, null, 2));
  }
  await writeText(options.runtime, `${root}/SUMMARY.txt`, `Fleet audit bundle ${id}\nchainValid=${verification.valid}\nentries=${verification.entries}\ncreatedAt=${new Date().toISOString()}\n`);
  const archive = `${options.projectPath}/artifacts/deployments/recovery/${id}.tar.gz`;
  const r = await exec(options.runtime, `tar -czf ${q(archive)} -C ${q(root)} .`);
  if ((r.exitCode ?? 0) !== 0) return { path: root, verification };
  return { path: archive, verification };
}
