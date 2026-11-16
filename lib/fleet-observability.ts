import type { RuntimeFacade } from "../core/RuntimeFacade";
import type { ReleaseChannel } from "./release-channel-manager";

export type IncidentSeverity = "info" | "warning" | "critical";
export type FleetDeviceIncident = { serial: string; health: boolean; deployed: boolean; rolledBack: boolean; message: string; releaseId?: string; rollbackReleaseId?: string };
export type FleetIncident = {
  id: string;
  severity: IncidentSeverity;
  channel: ReleaseChannel;
  createdAt: string;
  reason: string;
  stage?: number;
  failureRate?: number;
  devices: FleetDeviceIncident[];
  bundlePath?: string;
};
export type FleetObservabilitySnapshot = {
  channel: ReleaseChannel;
  updatedAt: string;
  canary?: { stopped: boolean; stopReason?: string; attempted: number; healthy: number; failed: number; stages: Array<{ stage: number; percentage: number; failureRate: number; passed: boolean; healthy: number; failed: number; rolledBack: number }> };
  fleet?: { total: number; healthy: number; failed: number; rolledBack: number; devices: Record<string, unknown> };
  incidents: FleetIncident[];
  incidentCount: number;
  failureRate: number;
  status: "healthy" | "degraded" | "incident" | "unknown";
};

type AnyRecord = Record<string, any>;
function q(v: string): string { return `'${String(v).replace(/'/g, `\'\\''`)}'`; }
function safeChannel(v: string): boolean { return ["debug", "internal", "beta", "production"].includes(v); }
function safeId(v: string): boolean { return /^[A-Za-z0-9._:-]{1,160}$/.test(v); }
async function exec(runtime: RuntimeFacade, command: string) {
  return await runtime.environment.exec(command, {}) as { exitCode?: number; stdout?: string; stderr?: string };
}
async function readJson(runtime: RuntimeFacade, file: string): Promise<AnyRecord | null> {
  const r = await exec(runtime, `if [ -f ${q(file)} ]; then cat ${q(file)}; fi`);
  if (!r.stdout?.trim()) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
async function writeText(runtime: RuntimeFacade, file: string, text: string): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  const tmp = `${file}.tmp-${Date.now()}`;
  await exec(runtime, `mkdir -p ${q(dir)}; printf '%s\\n' ${q(text)} > ${q(tmp)}; mv -f ${q(tmp)} ${q(file)}`);
}

function deriveSnapshot(channel: ReleaseChannel, canary: AnyRecord | null, fleet: AnyRecord | null, incidents: FleetIncident[]): FleetObservabilitySnapshot {
  const stages = Array.isArray(canary?.stages) ? canary.stages.map((s: AnyRecord) => ({ stage: Number(s.stage) || 0, percentage: Number(s.percentage) || 0, failureRate: Number(s.failureRate) || 0, passed: Boolean(s.passed), healthy: Number(s.healthy) || 0, failed: Number(s.failed) || 0, rolledBack: Number(s.rolledBack) || 0 })) : [];
  const attempted = Number(canary?.attempted) || Number(fleet?.total) || 0;
  const healthy = Number(canary?.healthy) || Number(fleet?.healthy) || 0;
  const failed = Number(canary?.failed) || Number(fleet?.failed) || 0;
  const failureRate = attempted ? (failed / attempted) * 100 : 0;
  const stopped = Boolean(canary?.stopped);
  const status = stopped ? "incident" : attempted === 0 ? "unknown" : failed === 0 ? "healthy" : "degraded";
  return {
    channel,
    updatedAt: new Date().toISOString(),
    canary: canary ? { stopped, stopReason: canary.stopReason, attempted, healthy, failed, stages } : undefined,
    fleet: fleet ? { total: Number(fleet.total) || 0, healthy: Number(fleet.healthy) || 0, failed: Number(fleet.failed) || 0, rolledBack: Number(fleet.rolledBack) || 0, devices: fleet.devices || {} } : undefined,
    incidents,
    incidentCount: incidents.length,
    failureRate,
    status,
  };
}

/** Builds a read-only fleet dashboard snapshot and persists an incident bundle when a canary stops. */
export async function getFleetObservability(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel }): Promise<FleetObservabilitySnapshot> {
  if (!safeChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const base = `${options.projectPath}/artifacts/deployments`;
  const canary = await readJson(options.runtime, `${base}/canary-${options.channel}.json`);
  const fleet = await readJson(options.runtime, `${base}/fleet-${options.channel}.json`);
  const incidentsRaw = await readJson(options.runtime, `${base}/incidents-${options.channel}.json`);
  const incidents: FleetIncident[] = Array.isArray(incidentsRaw?.incidents) ? incidentsRaw.incidents : [];

  if (canary?.stopped) {
    const id = `incident-${options.channel}-${String(canary.updatedAt || Date.now()).replace(/[^0-9A-Za-z]/g, "")}`;
    if (!incidents.some(x => x.id === id)) {
      const failedDevices: FleetDeviceIncident[] = (Array.isArray(canary.stages) ? canary.stages : []).flatMap((s: AnyRecord) => Array.isArray(s.results) ? s.results.filter((x: AnyRecord) => !x.health).map((x: AnyRecord) => ({ serial: String(x.serial), health: Boolean(x.health), deployed: Boolean(x.deployed), rolledBack: Boolean(x.rolledBack), message: String(x.message || "HEALTHCHECK_FAILED"), releaseId: x.releaseId, rollbackReleaseId: x.rollbackReleaseId })) : []);
      const last = Array.isArray(canary.stages) ? canary.stages[canary.stages.length - 1] : undefined;
      const incident: FleetIncident = {
        id, severity: "critical", channel: options.channel, createdAt: new Date().toISOString(), reason: String(canary.stopReason || "CANARY_STOPPED"), stage: last?.stage, failureRate: Number(last?.failureRate) || 0, devices: failedDevices,
      };
      incidents.push(incident);
      const incidentDir = `${base}/incidents/${id}`;
      const bundle = { schema: 1, incident, canary, fleet, generatedAt: new Date().toISOString() };
      await writeText(options.runtime, `${incidentDir}/incident.json`, JSON.stringify(bundle, null, 2));
      await writeText(options.runtime, `${incidentDir}/SUMMARY.txt`, [`Fleet Incident ${id}`, `Channel: ${options.channel}`, `Severity: critical`, `Reason: ${incident.reason}`, `Stage: ${incident.stage ?? "unknown"}`, `Failure rate: ${(incident.failureRate ?? 0).toFixed(1)}%`, `Failed devices: ${incident.devices.length}`, "", ...incident.devices.map(d => `${d.serial}: ${d.message}${d.rolledBack ? " [rolled back]" : ""}`)].join("\\n"));
      incident.bundlePath = incidentDir;
      const cleaned = incidents.slice(-50);
      await writeText(options.runtime, `${base}/incidents-${options.channel}.json`, JSON.stringify({ schema: 1, channel: options.channel, updatedAt: new Date().toISOString(), incidents: cleaned }, null, 2));
    }
  }
  return deriveSnapshot(options.channel, canary, fleet, incidents);
}

export async function listFleetIncidents(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel }): Promise<FleetIncident[]> {
  const snapshot = await getFleetObservability(options);
  return snapshot.incidents;
}

export async function acknowledgeFleetIncident(options: { runtime: RuntimeFacade; projectPath: string; channel: ReleaseChannel; incidentId: string }): Promise<{ acknowledged: boolean; incidentId: string }> {
  if (!safeId(options.incidentId)) throw new Error("INVALID_INCIDENT_ID");
  const file = `${options.projectPath}/artifacts/deployments/incidents-${options.channel}.json`;
  const state = await readJson(options.runtime, file);
  if (!state || !Array.isArray(state.incidents)) return { acknowledged: false, incidentId: options.incidentId };
  let found = false;
  state.incidents = state.incidents.map((x: AnyRecord) => { if (x.id === options.incidentId) { found = true; return { ...x, acknowledgedAt: new Date().toISOString() }; } return x; });
  if (found) await writeText(options.runtime, file, JSON.stringify(state, null, 2));
  return { acknowledged: found, incidentId: options.incidentId };
}
