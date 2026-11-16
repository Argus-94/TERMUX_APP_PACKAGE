import type { RuntimeFacade } from "../core/RuntimeFacade";
import { getReleaseChannelState, type ReleaseChannel, type ReleaseChannelEntry } from "./release-channel-manager";

export type FleetDevice = { serial: string; state: "device" | "offline" | "unauthorized" | "unknown" };
export type FleetDeviceResult = {
  serial: string;
  state: FleetDevice["state"];
  deployed: boolean;
  rolledBack: boolean;
  health: boolean;
  message: string;
  releaseId?: string;
  rollbackReleaseId?: string;
};
export type DeviceFleetResult = {
  channel: ReleaseChannel;
  packageName: string;
  total: number;
  healthy: number;
  failed: number;
  rolledBack: number;
  results: FleetDeviceResult[];
  statePath: string;
};

type FleetState = { schema: 1; channel: ReleaseChannel; packageName: string; devices: Record<string, { current?: ReleaseChannelEntry; previous?: ReleaseChannelEntry; status: string; updatedAt: string }> };

function quote(v: string): string { return `'${String(v).replace(/'/g, `'"'"'`)}'`; }
function validSerial(v: string): boolean { return /^[A-Za-z0-9._:-]{1,128}$/.test(v); }
function validPackage(v: string): boolean { return /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(v); }
function parsePackageName(output: string): string | undefined {
  const m = String(output).match(/(?:package:)?name='([^']+)'/);
  if (m?.[1] && validPackage(m[1])) return m[1];
  const d = String(output).trim().match(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/m);
  return d?.[0];
}
async function host(runtime: RuntimeFacade, command: string, cwd?: string) {
  const r = await runtime.environment.exec(command, { cwd }) as { exitCode?: number; stdout?: string; stderr?: string };
  return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
export async function listFleetDevices(runtime: RuntimeFacade): Promise<FleetDevice[]> {
  const r = await host(runtime, "adb devices");
  if (r.exitCode !== 0) throw new Error(r.stderr || "ADB_DEVICES_FAILED");
  return r.stdout.split(/\r?\n/).slice(1).map(x => x.trim()).filter(Boolean).map(line => {
    const [serial, state] = line.split(/\s+/); return { serial, state: (state === "device" || state === "offline" || state === "unauthorized" ? state : "unknown") as FleetDevice["state"] };
  }).filter(x => validSerial(x.serial));
}
async function target(runtime: RuntimeFacade, serial: string, cmd: string, timeout = 30_000) {
  if (!validSerial(serial)) throw new Error("INVALID_DEVICE_SERIAL");
  return host(runtime, `adb -s ${quote(serial)} ${cmd}`, undefined);
}
async function health(runtime: RuntimeFacade, serial: string, pkg: string, timeoutMs: number): Promise<boolean> {
  const launch = await target(runtime, serial, `shell monkey -p ${quote(pkg)} -c android.intent.category.LAUNCHER 1`);
  const deadline = Date.now() + Math.max(500, Math.min(timeoutMs, 30_000));
  while (Date.now() < deadline) {
    const pid = await target(runtime, serial, `shell pidof ${quote(pkg)}`);
    const ui = await target(runtime, serial, `shell sh -lc ${quote("uiautomator dump /sdcard/aibuilder_fleet.xml >/dev/null 2>&1 && cat /sdcard/aibuilder_fleet.xml")}`);
    if (launch.exitCode === 0 && (pid.stdout.trim() || ui.stdout.includes(`package=\"${pkg}\"`))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
async function readState(runtime: RuntimeFacade, path: string): Promise<FleetState | null> {
  const r = await host(runtime, `if [ -f ${quote(path)} ]; then cat ${quote(path)}; fi`);
  if (!r.stdout.trim()) return null; try { return JSON.parse(r.stdout) as FleetState; } catch { return null; }
}
async function saveState(runtime: RuntimeFacade, path: string, state: FleetState) {
  const tmp = `${path}.tmp-${Date.now()}`;
  await host(runtime, `mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")))}; printf '%s\\n' ${quote(JSON.stringify(state, null, 2))} > ${quote(tmp)}; mv -f ${quote(tmp)} ${quote(path)}`);
}

/**
 * Bounded multi-device rollout. Each device is evaluated independently; a bad
 * device is rolled back to its own last healthy artifact without affecting
 * healthy devices. Model output never supplies adb commands or serials.
 */
export async function deployReleaseFleet(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
  packageName?: string;
  serials?: string[];
  concurrency?: number;
  healthTimeoutMs?: number;
  autoRollback?: boolean;
}): Promise<DeviceFleetResult> {
  const channel = await getReleaseChannelState(options.runtime, options.projectPath, options.channel);
  if (!channel.current) throw new Error("RELEASE_CHANNEL_HAS_NO_CURRENT_ARTIFACT");
  const pkgResult = options.packageName ? { stdout: options.packageName } : await options.runtime.device.detectPackageName(channel.current.apkPath);
  const packageName = options.packageName?.trim() || parsePackageName(pkgResult.stdout);
  if (!packageName || !validPackage(packageName)) throw new Error("PACKAGE_NAME_DETECTION_FAILED");
  const listed = await listFleetDevices(options.runtime);
  const wanted = options.serials?.length ? new Set(options.serials.filter(validSerial)) : undefined;
  const selected = listed.filter(d => !wanted || wanted.has(d.serial));
  const statePath = `${options.projectPath}/artifacts/deployments/fleet-${options.channel}.json`;
  const state: FleetState = (await readState(options.runtime, statePath)) ?? { schema: 1, channel: options.channel, packageName, devices: {} };
  const results: FleetDeviceResult[] = [];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));
  let cursor = 0;
  const worker = async () => {
    while (cursor < selected.length) {
      const d = selected[cursor++];
      if (d.state !== "device") { results.push({ serial: d.serial, state: d.state, deployed: false, rolledBack: false, health: false, message: `DEVICE_${d.state.toUpperCase()}` }); continue; }
      const previous = state.devices[d.serial]?.current;
      const apkPath = String(channel.current!.apkPath || "");
      if (!apkPath || !/\.(apk|aab)$/i.test(apkPath) || !/^\/(storage|sdcard|data\/data\/com\.termux)/.test(apkPath)) {
        results.push({ serial: d.serial, state: d.state, deployed: false, rolledBack: false, health: false, message: "APK_PATH_NOT_ALLOWED", releaseId: channel.current!.releaseId });
        continue;
      }
      const install = await target(options.runtime, d.serial, `install -r ${quote(apkPath)}`, 600_000);
      if (install.exitCode !== 0) { results.push({ serial: d.serial, state: d.state, deployed: false, rolledBack: false, health: false, message: install.stderr || "DEVICE_INSTALL_FAILED", releaseId: channel.current!.releaseId }); continue; }
      const ok = await health(options.runtime, d.serial, packageName, options.healthTimeoutMs ?? 8000);
      if (ok) {
        state.devices[d.serial] = { current: channel.current, previous, status: "healthy", updatedAt: new Date().toISOString() };
        results.push({ serial: d.serial, state: d.state, deployed: true, rolledBack: false, health: true, message: "HEALTHY", releaseId: channel.current!.releaseId });
        continue;
      }
      if (options.autoRollback !== false && previous?.apkPath) {
        const rb = await target(options.runtime, d.serial, `install -r ${quote(previous.apkPath)}`, 600_000);
        const rbOk = rb.exitCode === 0 && await health(options.runtime, d.serial, packageName, options.healthTimeoutMs ?? 8000);
        state.devices[d.serial] = { current: previous, previous: channel.current, status: rbOk ? "rolled_back" : "failed", updatedAt: new Date().toISOString() };
        results.push({ serial: d.serial, state: d.state, deployed: false, rolledBack: rbOk, health: false, message: rbOk ? "AUTO_ROLLBACK_COMPLETED" : "AUTO_ROLLBACK_FAILED", releaseId: channel.current!.releaseId, rollbackReleaseId: previous.releaseId });
      } else {
        state.devices[d.serial] = { current: channel.current, previous, status: "failed", updatedAt: new Date().toISOString() };
        results.push({ serial: d.serial, state: d.state, deployed: false, rolledBack: false, health: false, message: "HEALTHCHECK_FAILED", releaseId: channel.current!.releaseId });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(selected.length, 1)) }, () => worker()));
  await saveState(options.runtime, statePath, state);
  return { channel: options.channel, packageName, total: results.length, healthy: results.filter(x => x.health).length, failed: results.filter(x => !x.health).length, rolledBack: results.filter(x => x.rolledBack).length, results, statePath };
}
