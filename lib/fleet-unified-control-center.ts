import type { RuntimeFacade } from "../core/RuntimeFacade";
import type { ReleaseChannel } from "./release-channel-manager";
import { getFleetCommandSnapshot, type FleetCommandSnapshot } from "./fleet-command-center";
import { getFleetSloDashboard, type FleetSloDashboardSnapshot } from "./fleet-slo-dashboard";
import { escalateFleetAlerts, type FleetEscalationSnapshot } from "./fleet-alert-escalation";
import { getFleetPolicy, type FleetPolicy } from "./fleet-policy-manager";

export type FleetControlStatus = "healthy" | "degraded" | "incident" | "unknown";

export type FleetUnifiedControlSnapshot = {
  schema: 1;
  channel: ReleaseChannel;
  generatedAt: string;
  status: FleetControlStatus;
  command: FleetCommandSnapshot;
  slo: FleetSloDashboardSnapshot;
  escalation: FleetEscalationSnapshot;
  policy: FleetPolicy;
  summary: {
    devices: number;
    healthyDevices: number;
    failedDevices: number;
    offlineDevices: number;
    openIncidents: number;
    activeAlerts: number;
    criticalAlerts: number;
    pendingNotifications: number;
  };
};

function validChannel(v: string): v is ReleaseChannel {
  return ["debug", "internal", "beta", "production"].includes(v);
}

export async function getFleetUnifiedControlSnapshot(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
}): Promise<FleetUnifiedControlSnapshot> {
  if (!validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const command = await getFleetCommandSnapshot(options);
  const slo = await getFleetSloDashboard(options);
  const escalation = await escalateFleetAlerts({ ...options, snapshot: slo });
  const policy = await getFleetPolicy({ runtime: options.runtime, projectPath: options.projectPath });

  const healthyDevices = command.devices.filter(x => x.status === "healthy").length;
  const failedDevices = command.devices.filter(x => x.status === "failed" || x.status === "rolled_back").length;
  const offlineDevices = command.devices.filter(x => x.status === "offline" || x.status === "unauthorized").length;
  const active = escalation.alerts.filter(x => x.state === "active");
  const critical = active.filter(x => x.level === "critical").length;

  let status: FleetControlStatus = slo.overallStatus;
  if (critical > 0 || failedDevices > 0) status = "incident";
  else if (active.length > 0 || offlineDevices > 0) status = "degraded";
  else if (status === "unknown" && command.devices.length === 0) status = "unknown";
  else if (status === "unknown") status = "healthy";

  return {
    schema: 1,
    channel: options.channel,
    generatedAt: new Date().toISOString(),
    status,
    command,
    slo,
    escalation,
    policy,
    summary: {
      devices: command.devices.length,
      healthyDevices,
      failedDevices,
      offlineDevices,
      openIncidents: slo.metrics.openIncidentCount,
      activeAlerts: active.length,
      criticalAlerts: critical,
      pendingNotifications: escalation.pendingNotifications,
    },
  };
}
