import type { RuntimeFacade } from "../core/RuntimeFacade";
import { listFleetDevices, deployReleaseFleet, type FleetDevice, type DeviceFleetResult } from "./device-fleet-manager";
import { getFleetObservability, type FleetObservabilitySnapshot, acknowledgeFleetIncident } from "./fleet-observability";
import type { ReleaseChannel } from "./release-channel-manager";

export type FleetCommandDevice = FleetDevice & {
  currentReleaseId?: string;
  currentVersionName?: string;
  currentVersionCode?: number;
  previousReleaseId?: string;
  status: "healthy" | "failed" | "rolled_back" | "offline" | "unauthorized" | "unknown";
  updatedAt?: string;
};

export type FleetCommandSnapshot = {
  channel: ReleaseChannel;
  updatedAt: string;
  devices: FleetCommandDevice[];
  observability: FleetObservabilitySnapshot;
};

function validSerial(v: string): boolean { return /^[A-Za-z0-9._:-]{1,128}$/.test(v); }
function safeChannel(v: string): boolean { return ["debug", "internal", "beta", "production"].includes(v); }
function q(v: string): string { return `'${String(v).replace(/'/g, `'"'"'`)}'`; }

async function readFleetState(runtime: RuntimeFacade, projectPath: string, channel: ReleaseChannel): Promise<any | null> {
  const path = `${projectPath}/artifacts/deployments/fleet-${channel}.json`;
  const r = await runtime.environment.exec(`if [ -f ${q(path)} ]; then cat ${q(path)}; fi`, {});
  if (!r.stdout?.trim()) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export async function getFleetCommandSnapshot(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
}): Promise<FleetCommandSnapshot> {
  if (!safeChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const listed = await listFleetDevices(options.runtime);
  const state = await readFleetState(options.runtime, options.projectPath, options.channel);
  const devices: FleetCommandDevice[] = listed.map(device => {
    const saved = state?.devices?.[device.serial];
    const status = device.state !== "device" ? device.state : (saved?.status === "rolled_back" ? "rolled_back" : saved?.status === "failed" ? "failed" : saved?.status === "healthy" ? "healthy" : "unknown");
    return {
      ...device,
      currentReleaseId: saved?.current?.releaseId,
      currentVersionName: saved?.current?.versionName,
      currentVersionCode: saved?.current?.versionCode,
      previousReleaseId: saved?.previous?.releaseId,
      status: status as FleetCommandDevice["status"],
      updatedAt: saved?.updatedAt,
    };
  });
  const observability = await getFleetObservability(options);
  return { channel: options.channel, updatedAt: new Date().toISOString(), devices, observability };
}

export async function deployFleetDevice(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
  packageName?: string;
  serial: string;
}): Promise<DeviceFleetResult> {
  if (!validSerial(options.serial)) throw new Error("INVALID_DEVICE_SERIAL");
  return deployReleaseFleet({ ...options, serials: [options.serial], concurrency: 1, autoRollback: true, healthTimeoutMs: 8000 });
}

export async function rollbackFleetDevice(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
  serial: string;
  packageName?: string;
}): Promise<{ serial: string; rolledBack: boolean; health: boolean; message: string; releaseId?: string }> {
  if (!validSerial(options.serial)) throw new Error("INVALID_DEVICE_SERIAL");
  const state = await readFleetState(options.runtime, options.projectPath, options.channel);
  const previous = state?.devices?.[options.serial]?.previous;
  if (!previous?.apkPath) return { serial: options.serial, rolledBack: false, health: false, message: "NO_PREVIOUS_RELEASE" };
  let pkg = options.packageName?.trim();
  if (!pkg) {
    const detected = await options.runtime.device.detectPackageName(previous.apkPath);
    pkg = String(detected.stdout || "").trim();
  }
  if (!pkg || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(pkg)) throw new Error("PACKAGE_NAME_DETECTION_FAILED");
  const cmd = `adb -s ${q(options.serial)} install -r ${q(previous.apkPath)}`;
  const install = await options.runtime.environment.exec(cmd, {});
  if ((install.exitCode ?? 0) !== 0) return { serial: options.serial, rolledBack: false, health: false, message: install.stderr || "ROLLBACK_INSTALL_FAILED", releaseId: previous.releaseId };
  const launch = await options.runtime.environment.exec(`adb -s ${q(options.serial)} shell monkey -p ${q(pkg)} -c android.intent.category.LAUNCHER 1`, {});
  const pid = await options.runtime.environment.exec(`adb -s ${q(options.serial)} shell pidof ${q(pkg)}`, {});
  const ui = await options.runtime.environment.exec(`adb -s ${q(options.serial)} shell sh -lc ${q("uiautomator dump /sdcard/aibuilder_command_center.xml >/dev/null 2>&1 && cat /sdcard/aibuilder_command_center.xml")}`, {});
  const health = (launch.exitCode ?? 0) === 0 && Boolean(pid.stdout?.trim() || ui.stdout?.includes(`package="${pkg}"`));
  if (health && state?.devices?.[options.serial]) {
    const current = state.devices[options.serial].current;
    state.devices[options.serial] = { ...state.devices[options.serial], current: previous, previous: current, status: "rolled_back", updatedAt: new Date().toISOString() };
    const statePath = `${options.projectPath}/artifacts/deployments/fleet-${options.channel}.json`;
    const tmp = `${statePath}.tmp-${Date.now()}`;
    await options.runtime.environment.exec(`mkdir -p ${q(options.projectPath + "/artifacts/deployments")}; printf '%s\n' ${q(JSON.stringify(state, null, 2))} > ${q(tmp)}; mv -f ${q(tmp)} ${q(statePath)}`, {});
  }
  return { serial: options.serial, rolledBack: health, health, message: health ? "ROLLBACK_HEALTHY" : "ROLLBACK_HEALTHCHECK_FAILED", releaseId: previous.releaseId };
}

export async function acknowledgeCommandCenterIncident(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
  incidentId: string;
}) { return acknowledgeFleetIncident(options); }
