import type { RuntimeFacade } from "../core/RuntimeFacade";
import type { ReleaseChannel } from "./release-channel-manager";
import { getFleetSloDashboard, type FleetSloDashboardSnapshot } from "./fleet-slo-dashboard";

export type FleetAlertLevel = "info" | "warning" | "critical";
export type FleetEscalationState = "active" | "acknowledged" | "resolved";

export type FleetEscalationPolicy = {
  schema: 1;
  warningAcknowledgementTimeoutMinutes: number;
  criticalAcknowledgementTimeoutMinutes: number;
  criticalAfterConsecutiveFailures: number;
  maxActiveAlerts: number;
};

export type FleetEscalatedAlert = {
  id: string;
  fingerprint: string;
  channel: ReleaseChannel;
  level: FleetAlertLevel;
  type: string;
  message: string;
  state: FleetEscalationState;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  acknowledgedAt?: string;
  escalatedAt?: string;
  resolvedAt?: string;
};

export type FleetEscalationSnapshot = {
  schema: 1;
  channel: ReleaseChannel;
  generatedAt: string;
  policy: FleetEscalationPolicy;
  alerts: FleetEscalatedAlert[];
  pendingNotifications: number;
  escalatedCount: number;
  acknowledgedCount: number;
  resolvedCount: number;
  source: Pick<FleetSloDashboardSnapshot, "overallStatus" | "metrics" | "recoverySlo">;
};

type EscalationStateFile = {
  schema: 1;
  policy: FleetEscalationPolicy;
  alerts: FleetEscalatedAlert[];
};

type Notification = {
  id: string;
  alertId: string;
  channel: ReleaseChannel;
  level: FleetAlertLevel;
  title: string;
  message: string;
  createdAt: string;
  deliveredAt?: string;
};

const DEFAULT_POLICY: FleetEscalationPolicy = {
  schema: 1,
  warningAcknowledgementTimeoutMinutes: 30,
  criticalAcknowledgementTimeoutMinutes: 15,
  criticalAfterConsecutiveFailures: 2,
  maxActiveAlerts: 100,
};

function validChannel(v: string): v is ReleaseChannel { return ["debug", "internal", "beta", "production"].includes(v); }
function q(v: string): string { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function stableHash(input: string): string {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b1;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619);
    h2 ^= c + i; h2 = Math.imul(h2, 2246822519);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}
function now() { return new Date().toISOString(); }
async function exec(runtime: RuntimeFacade, command: string) { return await runtime.environment.exec(command, {}) as { stdout?: string; exitCode?: number; stderr?: string }; }
async function read(runtime: RuntimeFacade, file: string): Promise<string> { const r = await exec(runtime, `if [ -f ${q(file)} ]; then cat ${q(file)}; fi`); return String(r.stdout || ""); }
async function write(runtime: RuntimeFacade, file: string, text: string): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf("/")); const tmp = `${file}.tmp-${Date.now()}`;
  await exec(runtime, `mkdir -p ${q(dir)}; printf '%s\\n' ${q(text)} > ${q(tmp)}; mv -f ${q(tmp)} ${q(file)}`);
}
async function loadState(runtime: RuntimeFacade, base: string): Promise<EscalationStateFile> {
  const text = await read(runtime, `${base}/fleet-escalation-${"STATE"}.json`);
  if (!text) return { schema: 1, policy: DEFAULT_POLICY, alerts: [] };
  try {
    const parsed = JSON.parse(text) as Partial<EscalationStateFile>;
    return { schema: 1, policy: { ...DEFAULT_POLICY, ...(parsed.policy || {}) }, alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [] };
  } catch { return { schema: 1, policy: DEFAULT_POLICY, alerts: [] }; }
}
async function saveState(runtime: RuntimeFacade, base: string, state: EscalationStateFile) { await write(runtime, `${base}/fleet-escalation-STATE.json`, JSON.stringify(state, null, 2)); }
async function appendJsonl(runtime: RuntimeFacade, file: string, value: unknown) { const old = await read(runtime, file); await write(runtime, file, `${old ? `${old.trim()}\n` : ""}${JSON.stringify(value)}`); }

export function deriveFleetAlerts(snapshot: FleetSloDashboardSnapshot, policy: FleetEscalationPolicy = DEFAULT_POLICY): Array<{ fingerprint: string; level: FleetAlertLevel; type: string; message: string }> {
  const out: Array<{ fingerprint: string; level: FleetAlertLevel; type: string; message: string }> = [];
  const add = (level: FleetAlertLevel, type: string, message: string, key = type) => out.push({ fingerprint: stableHash(`${snapshot.channel}|${key}`), level, type, message });
  if (snapshot.overallStatus === "incident") add("critical", "fleet_incident", "Fleet observability reports an incident.");
  else if (snapshot.overallStatus === "degraded") add("warning", "fleet_degraded", "Fleet observability is degraded.");
  if (snapshot.metrics.failureRate > 0) add(snapshot.metrics.failureRate >= 20 ? "critical" : "warning", "fleet_failure_rate", `Fleet failure rate is ${snapshot.metrics.failureRate.toFixed(1)}%.`);
  if (!snapshot.metrics.backupFresh) add("warning", "backup_stale", "Fleet recovery backup is stale or missing.");
  if (!snapshot.metrics.drillFresh) add("warning", "drill_stale", "Fleet disaster-recovery drill is stale or missing.");
  if (snapshot.metrics.consecutiveRecoveryFailures >= policy.criticalAfterConsecutiveFailures) add("critical", "recovery_failures", `Recovery automation has ${snapshot.metrics.consecutiveRecoveryFailures} consecutive failures.`);
  else if (snapshot.metrics.consecutiveRecoveryFailures > 0) add("warning", "recovery_failures", `Recovery automation has ${snapshot.metrics.consecutiveRecoveryFailures} consecutive failure(s).`);
  if (snapshot.recoverySlo.status === "DUE") add("warning", "recovery_slo_due", "Recovery SLO check is due.");
  return out;
}

export async function getFleetEscalationPolicy(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel }): Promise<FleetEscalationPolicy> {
  if (!validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const state = await loadState(options.runtime, `${options.projectPath}/artifacts/deployments`);
  return state.policy;
}

export async function setFleetEscalationPolicy(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel; policy: Partial<FleetEscalationPolicy> }): Promise<FleetEscalationPolicy> {
  if (!validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const base = `${options.projectPath}/artifacts/deployments`;
  const state = await loadState(options.runtime, base);
  const next: FleetEscalationPolicy = {
    ...state.policy,
    ...options.policy,
    schema: 1,
    warningAcknowledgementTimeoutMinutes: Math.max(5, Math.min(1440, Number(options.policy.warningAcknowledgementTimeoutMinutes ?? state.policy.warningAcknowledgementTimeoutMinutes))),
    criticalAcknowledgementTimeoutMinutes: Math.max(5, Math.min(1440, Number(options.policy.criticalAcknowledgementTimeoutMinutes ?? state.policy.criticalAcknowledgementTimeoutMinutes))),
    criticalAfterConsecutiveFailures: Math.max(1, Math.min(10, Number(options.policy.criticalAfterConsecutiveFailures ?? state.policy.criticalAfterConsecutiveFailures))),
    maxActiveAlerts: Math.max(10, Math.min(500, Number(options.policy.maxActiveAlerts ?? state.policy.maxActiveAlerts))),
  };
  state.policy = next; await saveState(options.runtime, base, state);
  await appendJsonl(options.runtime, `${base}/fleet-escalation-audit.jsonl`, { at: now(), action: "policy_update", channel: options.channel, policy: next });
  return next;
}

export async function escalateFleetAlerts(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel; snapshot?: FleetSloDashboardSnapshot }): Promise<FleetEscalationSnapshot> {
  if (!validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const base = `${options.projectPath}/artifacts/deployments`;
  const state = await loadState(options.runtime, base);
  const snapshot = options.snapshot ?? await getFleetSloDashboard(options);
  const derived = deriveFleetAlerts(snapshot, state.policy);
  const ts = now();
  const byFingerprint = new Map(state.alerts.map(a => [a.fingerprint, a]));
  for (const item of derived) {
    const existing = byFingerprint.get(item.fingerprint);
    if (!existing) {
      const alert: FleetEscalatedAlert = { id: `alert-${Date.now()}-${stableHash(item.fingerprint).slice(0, 8)}`, fingerprint: item.fingerprint, channel: options.channel, level: item.level, type: item.type, message: item.message, state: "active", firstSeenAt: ts, lastSeenAt: ts, occurrenceCount: 1, escalatedAt: item.level === "critical" ? ts : undefined };
      state.alerts.push(alert);
      await appendJsonl(options.runtime, `${base}/fleet-notification-outbox.jsonl`, { id: `notif-${Date.now()}-${alert.id}`, alertId: alert.id, channel: options.channel, level: alert.level, title: `Fleet ${alert.level}`, message: alert.message, createdAt: ts });
      await appendJsonl(options.runtime, `${base}/fleet-escalation-audit.jsonl`, { at: ts, action: "alert_created", channel: options.channel, alertId: alert.id, type: alert.type, level: alert.level });
    } else {
      existing.lastSeenAt = ts; existing.occurrenceCount += 1; existing.message = item.message;
      if (item.level === "critical" && existing.level !== "critical") { existing.level = "critical"; existing.escalatedAt = ts; existing.state = "active"; existing.acknowledgedAt = undefined; await appendJsonl(options.runtime, `${base}/fleet-notification-outbox.jsonl`, { id: `notif-${Date.now()}-${existing.id}`, alertId: existing.id, channel: options.channel, level: "critical", title: "Fleet critical escalation", message: existing.message, createdAt: ts }); }
      else if (existing.state === "acknowledged") {
        const timeout = (existing.level === "critical" ? state.policy.criticalAcknowledgementTimeoutMinutes : state.policy.warningAcknowledgementTimeoutMinutes) * 60000;
        if (existing.acknowledgedAt && Date.now() - Date.parse(existing.acknowledgedAt) >= timeout) {
          existing.state = "active"; existing.escalatedAt = ts; await appendJsonl(options.runtime, `${base}/fleet-notification-outbox.jsonl`, { id: `notif-${Date.now()}-${existing.id}`, alertId: existing.id, channel: options.channel, level: existing.level, title: "Fleet alert re-escalated", message: existing.message, createdAt: ts });
          await appendJsonl(options.runtime, `${base}/fleet-escalation-audit.jsonl`, { at: ts, action: "alert_re_escalated", channel: options.channel, alertId: existing.id });
        }
      }
    }
  }
  const derivedKeys = new Set(derived.map(x => x.fingerprint));
  for (const alert of state.alerts) if (alert.state !== "resolved" && !derivedKeys.has(alert.fingerprint)) { alert.state = "resolved"; alert.resolvedAt = ts; await appendJsonl(options.runtime, `${base}/fleet-escalation-audit.jsonl`, { at: ts, action: "alert_resolved", channel: options.channel, alertId: alert.id }); }
  const active = state.alerts.filter(a => a.state !== "resolved").sort((a,b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, state.policy.maxActiveAlerts);
  state.alerts = [...state.alerts.filter(a => a.state === "resolved").slice(-100), ...active];
  await saveState(options.runtime, base, state);
  return buildSnapshot(options.channel, state, snapshot, await countPending(options.runtime, `${base}/fleet-notification-outbox.jsonl`));
}

async function countPending(runtime: RuntimeFacade, file: string): Promise<number> { const text = await read(runtime, file); return text.split(/\r?\n/).filter(Boolean).length; }
function buildSnapshot(channel: ReleaseChannel, state: EscalationStateFile, source: FleetSloDashboardSnapshot, pendingNotifications: number): FleetEscalationSnapshot {
  return { schema: 1, channel, generatedAt: now(), policy: state.policy, alerts: state.alerts, pendingNotifications, escalatedCount: state.alerts.filter(a => a.state === "active").length, acknowledgedCount: state.alerts.filter(a => a.state === "acknowledged").length, resolvedCount: state.alerts.filter(a => a.state === "resolved").length, source: { overallStatus: source.overallStatus, metrics: source.metrics, recoverySlo: source.recoverySlo } };
}

export async function acknowledgeFleetEscalatedAlert(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel; alertId: string }): Promise<{ acknowledged: boolean; alertId: string }> {
  const base = `${options.projectPath}/artifacts/deployments`; const state = await loadState(options.runtime, base); const alert = state.alerts.find(a => a.id === options.alertId && a.channel === options.channel);
  if (!alert) return { acknowledged: false, alertId: options.alertId };
  alert.state = "acknowledged"; alert.acknowledgedAt = now();
  await saveState(options.runtime, base, state); await appendJsonl(options.runtime, `${base}/fleet-escalation-audit.jsonl`, { at: now(), action: "alert_acknowledged", channel: options.channel, alertId: alert.id });
  return { acknowledged: true, alertId: options.alertId };
}

export async function resolveFleetEscalatedAlert(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel; alertId: string }): Promise<{ resolved: boolean; alertId: string }> {
  const base = `${options.projectPath}/artifacts/deployments`; const state = await loadState(options.runtime, base); const alert = state.alerts.find(a => a.id === options.alertId && a.channel === options.channel);
  if (!alert) return { resolved: false, alertId: options.alertId };
  alert.state = "resolved"; alert.resolvedAt = now(); await saveState(options.runtime, base, state); await appendJsonl(options.runtime, `${base}/fleet-escalation-audit.jsonl`, { at: now(), action: "alert_resolved_manual", channel: options.channel, alertId: alert.id });
  return { resolved: true, alertId: options.alertId };
}

export async function getFleetNotificationOutbox(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel; limit?: number }): Promise<Notification[]> {
  const text = await read(options.runtime, `${options.projectPath}/artifacts/deployments/fleet-notification-outbox.jsonl`);
  return text.split(/\r?\n/).filter(Boolean).slice(-(options.limit ?? 50)).flatMap(line => { try { const x = JSON.parse(line) as Notification; return x.channel === options.channel ? [x] : []; } catch { return []; } });
}
