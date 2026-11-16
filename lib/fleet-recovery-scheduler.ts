import type { RuntimeFacade } from "../core/RuntimeFacade";
import { createFleetEncryptedBackup, listFleetBackups, type FleetBackupRecord } from "./fleet-backup-recovery";
import { runFleetRecoveryDrill, type FleetRecoveryDrillResult } from "./fleet-disaster-recovery-drill";
import type { ReleaseChannel } from "./release-channel-manager";

export type FleetRecoverySchedule = {
  schema: 1;
  enabled: boolean;
  channel: ReleaseChannel;
  intervalMinutes: number;
  maxBackupAgeHours: number;
  maxDrillAgeHours: number;
  maxConsecutiveFailures: number;
  alertOnFailure: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  lastBackupId?: string;
  lastDrillId?: string;
};

export type FleetSloStatus = {
  schema: 1;
  checkedAt: string;
  channel: ReleaseChannel;
  status: "PASS" | "FAIL" | "DUE";
  backupFresh: boolean;
  drillFresh: boolean;
  lastDrillStatus?: "PASS" | "FAIL";
  consecutiveFailures: number;
  alerts: string[];
  schedule: FleetRecoverySchedule;
};

export type FleetScheduledRecoveryResult = {
  schedule: FleetRecoverySchedule;
  backup: FleetBackupRecord;
  drill: FleetRecoveryDrillResult;
  slo: FleetSloStatus;
};

function q(v: string): string { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function validChannel(v: string): v is ReleaseChannel { return ["debug", "internal", "beta", "production"].includes(v); }
function clampInt(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), min), max) : fallback;
}
function nowMs(): number { return Date.now(); }
function ageHours(iso?: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (nowMs() - t) / 3600000) : Number.POSITIVE_INFINITY;
}
async function exec(runtime: RuntimeFacade, command: string) {
  return await runtime.environment.exec(command, {}) as { exitCode?: number; stdout?: string; stderr?: string };
}
async function read(runtime: RuntimeFacade, file: string): Promise<string> {
  const r = await exec(runtime, `if [ -f ${q(file)} ]; then cat ${q(file)}; fi`);
  return String(r.stdout || "");
}
async function write(runtime: RuntimeFacade, file: string, text: string): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const tmp = `${file}.tmp-${Date.now()}`;
  await exec(runtime, `mkdir -p ${q(dir)}; printf '%s\\n' ${q(text)} > ${q(tmp)}; mv -f ${q(tmp)} ${q(file)}`);
}

export function defaultFleetRecoverySchedule(channel: ReleaseChannel = "production"): FleetRecoverySchedule {
  return { schema: 1, enabled: true, channel, intervalMinutes: 360, maxBackupAgeHours: 24, maxDrillAgeHours: 48, maxConsecutiveFailures: 2, alertOnFailure: true };
}

export async function getFleetRecoverySchedule(options: { runtime: RuntimeFacade; projectPath: string; channel?: ReleaseChannel }): Promise<FleetRecoverySchedule> {
  const channel = options.channel || "production";
  if (!validChannel(channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const path = `${options.projectPath}/artifacts/deployments/recovery-schedule-${channel}.json`;
  const text = await read(options.runtime, path);
  if (!text) return defaultFleetRecoverySchedule(channel);
  try {
    const raw = JSON.parse(text) as Partial<FleetRecoverySchedule>;
    return {
      ...defaultFleetRecoverySchedule(channel), ...raw,
      schema: 1, channel,
      enabled: raw.enabled !== false,
      intervalMinutes: clampInt(Number(raw.intervalMinutes), 5, 10080, 360),
      maxBackupAgeHours: clampInt(Number(raw.maxBackupAgeHours), 1, 720, 24),
      maxDrillAgeHours: clampInt(Number(raw.maxDrillAgeHours), 1, 720, 48),
      maxConsecutiveFailures: clampInt(Number(raw.maxConsecutiveFailures), 0, 20, 2),
      alertOnFailure: raw.alertOnFailure !== false,
    };
  } catch { return defaultFleetRecoverySchedule(channel); }
}

export async function setFleetRecoverySchedule(options: { runtime: RuntimeFacade; projectPath: string; schedule: Partial<FleetRecoverySchedule> & { channel: ReleaseChannel } }): Promise<FleetRecoverySchedule> {
  const base = defaultFleetRecoverySchedule(options.schedule.channel);
  if (!validChannel(options.schedule.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const schedule: FleetRecoverySchedule = {
    ...base, ...options.schedule, schema: 1,
    enabled: options.schedule.enabled !== false,
    intervalMinutes: clampInt(Number(options.schedule.intervalMinutes), 5, 10080, base.intervalMinutes),
    maxBackupAgeHours: clampInt(Number(options.schedule.maxBackupAgeHours), 1, 720, base.maxBackupAgeHours),
    maxDrillAgeHours: clampInt(Number(options.schedule.maxDrillAgeHours), 1, 720, base.maxDrillAgeHours),
    maxConsecutiveFailures: clampInt(Number(options.schedule.maxConsecutiveFailures), 0, 20, base.maxConsecutiveFailures),
    alertOnFailure: options.schedule.alertOnFailure !== false,
  };
  const path = `${options.projectPath}/artifacts/deployments/recovery-schedule-${schedule.channel}.json`;
  await write(options.runtime, path, JSON.stringify(schedule, null, 2));
  return schedule;
}

async function readDrillHistory(runtime: RuntimeFacade, projectPath: string, channel: ReleaseChannel): Promise<Array<{ id: string; status: "PASS" | "FAIL"; finishedAt: string }>> {
  const path = `${projectPath}/artifacts/deployments/recovery-drills-history-${channel}.json`;
  const text = await read(runtime, path);
  if (!text) return [];
  try { const x = JSON.parse(text); return Array.isArray(x?.runs) ? x.runs.slice(0, 100) : []; } catch { return []; }
}
async function writeDrillHistory(runtime: RuntimeFacade, projectPath: string, channel: ReleaseChannel, drill: FleetRecoveryDrillResult): Promise<void> {
  const path = `${projectPath}/artifacts/deployments/recovery-drills-history-${channel}.json`;
  const history = await readDrillHistory(runtime, projectPath, channel);
  const next = [{ id: drill.id, status: drill.status, finishedAt: drill.finishedAt }, ...history.filter(x => x.id !== drill.id)].slice(0, 100);
  await write(runtime, path, JSON.stringify({ schema: 1, channel, updatedAt: new Date().toISOString(), runs: next }, null, 2));
}

export async function evaluateFleetRecoverySlo(options: { runtime: RuntimeFacade; projectPath: string; schedule?: FleetRecoverySchedule }): Promise<FleetSloStatus> {
  const schedule = options.schedule || await getFleetRecoverySchedule({ runtime: options.runtime, projectPath: options.projectPath });
  const backups = await listFleetBackups({ runtime: options.runtime, projectPath: options.projectPath, limit: 50 });
  const latestBackup = backups[0];
  const history = await readDrillHistory(options.runtime, options.projectPath, schedule.channel);
  const latestDrill = history[0];
  const consecutiveFailures = history.reduce((n, x) => x.status === "FAIL" ? n + 1 : n ? n : 0, 0);
  const backupFresh = Boolean(latestBackup && ageHours(latestBackup.createdAt) <= schedule.maxBackupAgeHours);
  const drillFresh = Boolean(latestDrill && latestDrill.status === "PASS" && ageHours(latestDrill.finishedAt) <= schedule.maxDrillAgeHours);
  const alerts: string[] = [];
  if (!backupFresh) alerts.push("BACKUP_STALE_OR_MISSING");
  if (!drillFresh) alerts.push("RECOVERY_DRILL_STALE_OR_FAILED");
  if (consecutiveFailures > schedule.maxConsecutiveFailures) alerts.push("CONSECUTIVE_DRILL_FAILURE_LIMIT_EXCEEDED");
  const due = schedule.enabled && (!schedule.nextRunAt || Date.parse(schedule.nextRunAt) <= nowMs());
  const status: FleetSloStatus["status"] = alerts.length ? "FAIL" : due ? "DUE" : "PASS";
  return { schema: 1, checkedAt: new Date().toISOString(), channel: schedule.channel, status, backupFresh, drillFresh, lastDrillStatus: latestDrill?.status, consecutiveFailures, alerts, schedule };
}

export async function runFleetScheduledRecoveryCheck(options: { runtime: RuntimeFacade; projectPath: string; secret: string; channel?: ReleaseChannel; force?: boolean; reason?: string }): Promise<FleetScheduledRecoveryResult> {
  const channel = options.channel || "production";
  let schedule = await getFleetRecoverySchedule({ runtime: options.runtime, projectPath: options.projectPath, channel });
  if (!schedule.enabled && !options.force) throw new Error("RECOVERY_SCHEDULER_DISABLED");
  const due = !schedule.nextRunAt || Date.parse(schedule.nextRunAt) <= nowMs();
  if (!due && !options.force) throw new Error("RECOVERY_CHECK_NOT_DUE");
  if (typeof options.secret !== "string" || options.secret.length < 12) throw new Error("BACKUP_SECRET_TOO_SHORT");

  const backupResult = await createFleetEncryptedBackup({ runtime: options.runtime, projectPath: options.projectPath, secret: options.secret, channel, retention: 5, reason: options.reason || "scheduled-recovery-point" });
  const drill = await runFleetRecoveryDrill({ runtime: options.runtime, projectPath: options.projectPath, secret: options.secret, backupId: backupResult.record.id });
  await writeDrillHistory(options.runtime, options.projectPath, channel, drill);

  schedule = { ...schedule, lastRunAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + schedule.intervalMinutes * 60000).toISOString(), lastBackupId: backupResult.record.id, lastDrillId: drill.id };
  await setFleetRecoverySchedule({ runtime: options.runtime, projectPath: options.projectPath, schedule });
  const slo = await evaluateFleetRecoverySlo({ runtime: options.runtime, projectPath: options.projectPath, schedule });
  const alertPath = `${options.projectPath}/artifacts/deployments/recovery-alerts-${channel}.jsonl`;
  if (slo.status === "FAIL" || drill.status === "FAIL") {
    const alert = { schema: 1, id: `recovery-alert-${Date.now()}`, createdAt: new Date().toISOString(), severity: "critical", channel, type: drill.status === "FAIL" ? "RECOVERY_DRILL_FAILED" : "RECOVERY_SLO_FAILED", alerts: slo.alerts, drillId: drill.id, backupId: backupResult.record.id };
    await exec(options.runtime, `mkdir -p ${q(options.projectPath + "/artifacts/deployments")}; printf '%s\\n' ${q(JSON.stringify(alert))} >> ${q(alertPath)}`);
  }
  return { schedule, backup: backupResult.record, drill, slo };
}
