import type { RuntimeFacade } from "../core/RuntimeFacade";
import type { ReleaseChannel } from "./release-channel-manager";
import { getFleetObservability, type FleetIncident, type FleetObservabilitySnapshot, acknowledgeFleetIncident } from "./fleet-observability";
import { evaluateFleetRecoverySlo, getFleetRecoverySchedule, type FleetRecoverySchedule, type FleetSloStatus } from "./fleet-recovery-scheduler";

export type FleetAlert = {
  id: string;
  createdAt: string;
  severity: "info" | "warning" | "critical";
  channel: ReleaseChannel;
  type: string;
  message: string;
  acknowledgedAt?: string;
};

export type FleetSloDashboardSnapshot = {
  schema: 1;
  channel: ReleaseChannel;
  generatedAt: string;
  overallStatus: "healthy" | "degraded" | "incident" | "unknown";
  observability: FleetObservabilitySnapshot;
  recoverySlo: FleetSloStatus;
  schedule: FleetRecoverySchedule;
  alerts: FleetAlert[];
  timeline: Array<{ at: string; type: string; severity: string; message: string; incidentId?: string }>;
  metrics: {
    failureRate: number;
    incidentCount: number;
    openIncidentCount: number;
    consecutiveRecoveryFailures: number;
    backupFresh: boolean;
    drillFresh: boolean;
  };
};

function validChannel(v: string): v is ReleaseChannel { return ["debug", "internal", "beta", "production"].includes(v); }
function q(v: string): string { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
async function exec(runtime: RuntimeFacade, command: string) {
  return await runtime.environment.exec(command, {}) as { stdout?: string; exitCode?: number; stderr?: string };
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

export async function getFleetSloDashboard(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel }): Promise<FleetSloDashboardSnapshot> {
  if (!validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const observability = await getFleetObservability(options);
  const schedule = await getFleetRecoverySchedule(options);
  const recoverySlo = await evaluateFleetRecoverySlo({ runtime: options.runtime, projectPath: options.projectPath, schedule });
  const base = `${options.projectPath}/artifacts/deployments`;
  const alertText = await read(options.runtime, `${base}/recovery-alerts-${options.channel}.jsonl`);
  const alerts: FleetAlert[] = alertText.split(/\r?\n/).filter(Boolean).slice(-50).flatMap(line => { try { return [JSON.parse(line) as FleetAlert]; } catch { return []; } });
  const openIncidents = observability.incidents.filter(x => !(x as FleetIncident & { acknowledgedAt?: string }).acknowledgedAt);
  const timeline = [
    ...observability.incidents.map(x => ({ at: x.createdAt, type: "INCIDENT", severity: x.severity, message: x.reason, incidentId: x.id })),
    ...alerts.map(x => ({ at: x.createdAt, type: x.type, severity: x.severity, message: x.message || x.type })),
    ...(recoverySlo.lastDrillStatus ? [{ at: recoverySlo.checkedAt, type: "RECOVERY_DRILL", severity: recoverySlo.lastDrillStatus === "PASS" ? "info" : "critical", message: `Recovery drill ${recoverySlo.lastDrillStatus}` }] : []),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100);
  let overallStatus: FleetSloDashboardSnapshot["overallStatus"] = observability.status;
  if (recoverySlo.status === "FAIL") overallStatus = "incident";
  else if (overallStatus === "healthy" && recoverySlo.status === "DUE") overallStatus = "degraded";
  else if (overallStatus === "unknown" && recoverySlo.status === "PASS") overallStatus = "healthy";
  return {
    schema: 1, channel: options.channel, generatedAt: new Date().toISOString(), overallStatus,
    observability, recoverySlo, schedule, alerts, timeline,
    metrics: {
      failureRate: observability.failureRate,
      incidentCount: observability.incidentCount,
      openIncidentCount: openIncidents.length,
      consecutiveRecoveryFailures: recoverySlo.consecutiveFailures,
      backupFresh: recoverySlo.backupFresh,
      drillFresh: recoverySlo.drillFresh,
    },
  };
}

export async function acknowledgeFleetDashboardAlert(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel; alertId: string }): Promise<{ acknowledged: boolean; alertId: string }> {
  const file = `${options.projectPath}/artifacts/deployments/recovery-alerts-${options.channel}.jsonl`;
  const text = await read(options.runtime, file);
  const lines = text.split(/\r?\n/).filter(Boolean);
  let found = false;
  const next = lines.map(line => { try { const x = JSON.parse(line) as FleetAlert; if (x.id === options.alertId) { found = true; return JSON.stringify({ ...x, acknowledgedAt: new Date().toISOString() }); } } catch {} return line; });
  if (found) await write(options.runtime, file, next.join("\n"));
  return { acknowledged: found, alertId: options.alertId };
}

export async function acknowledgeFleetDashboardIncident(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel; incidentId: string }) {
  return acknowledgeFleetIncident(options);
}
