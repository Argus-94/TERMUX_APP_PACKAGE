import type { RuntimeFacade } from "../core/RuntimeFacade";
import { getReleaseChannelState, type ReleaseChannel, type ReleaseChannelEntry } from "./release-channel-manager";

export type DeploymentHealth = {
  healthy: boolean;
  packageName: string;
  launchExitCode: number;
  uiHierarchyAvailable: boolean;
  uiContainsPackage: boolean;
  pid?: string;
  detail: string;
};

export type DeploymentState = {
  schema: 1;
  channel: ReleaseChannel;
  packageName: string;
  current?: ReleaseChannelEntry;
  previous?: ReleaseChannelEntry;
  deployedAt?: string;
  status: "healthy" | "rolled_back" | "failed";
  lastHealth?: DeploymentHealth;
};

export type ProductionDeploymentOptions = {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
  packageName?: string;
  targetReleaseId?: string;
  healthTimeoutMs?: number;
  autoRollback?: boolean;
};

export type ProductionDeploymentResult = {
  deployed: boolean;
  rolledBack: boolean;
  channel: ReleaseChannel;
  packageName?: string;
  entry?: ReleaseChannelEntry;
  rollbackEntry?: ReleaseChannelEntry;
  health?: DeploymentHealth;
  rollbackHealth?: DeploymentHealth;
  statePath: string;
  message: string;
};

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function validPackage(value: string): boolean {
  return /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value);
}

function parsePackageName(output: string): string | undefined {
  const match = String(output).match(/(?:package:)?name='([^']+)'/);
  if (match?.[1] && validPackage(match[1])) return match[1];
  const direct = String(output).trim().match(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/m);
  return direct?.[0];
}

async function exec(runtime: RuntimeFacade, command: string, cwd?: string) {
  const result = await runtime.environment.exec(command, { cwd });
  const r = result as { exitCode?: number; stdout?: string; stderr?: string };
  return { exitCode: r?.exitCode ?? 0, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
}

async function resolvePackage(runtime: RuntimeFacade, apkPath: string, requested?: string): Promise<string> {
  if (requested) {
    if (!validPackage(requested)) throw new Error("INVALID_PACKAGE_NAME");
    return requested;
  }
  const result = await runtime.device.detectPackageName(apkPath);
  const parsed = parsePackageName(result.stdout);
  if (!parsed) throw new Error("PACKAGE_NAME_DETECTION_FAILED");
  return parsed;
}

async function healthCheck(runtime: RuntimeFacade, packageName: string, timeoutMs: number): Promise<DeploymentHealth> {
  if (!validPackage(packageName)) throw new Error("INVALID_PACKAGE_NAME");
  const launch = await runtime.device.launch(packageName);
  const deadline = Date.now() + Math.max(500, Math.min(timeoutMs, 30_000));
  let lastUi = "";
  let pid = "";
  while (Date.now() < deadline) {
    const pidResult = await runtime.device.shell(`pidof ${shellQuote(packageName)}`);
    pid = pidResult.stdout.trim();
    const ui = await runtime.device.uiHierarchy();
    lastUi = ui.stdout;
    const contains = lastUi.includes(`package=\"${packageName}\"`) || lastUi.includes(`package='${packageName}'`);
    if (launch.exitCode === 0 && (pid.length > 0 || contains)) {
      return {
        healthy: true,
        packageName,
        launchExitCode: launch.exitCode,
        uiHierarchyAvailable: lastUi.length > 0,
        uiContainsPackage: contains,
        pid: pid || undefined,
        detail: "APP_HEALTHY",
      };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return {
    healthy: false,
    packageName,
    launchExitCode: launch.exitCode,
    uiHierarchyAvailable: lastUi.length > 0,
    uiContainsPackage: lastUi.includes(`package=\"${packageName}\"`) || lastUi.includes(`package='${packageName}'`),
    pid: pid || undefined,
    detail: launch.exitCode !== 0 ? `LAUNCH_FAILED:${launch.stderr || launch.stdout}` : "APP_HEALTHCHECK_TIMEOUT",
  };
}

/**
 * Installs a previously Release-Gate-approved channel artifact, runs a bounded
 * health check, and atomically rolls back to the prior channel artifact when
 * the new version fails to launch/appear in the UI.
 */
export async function deployReleaseChannel(options: ProductionDeploymentOptions): Promise<ProductionDeploymentResult> {
  const projectPath = String(options.projectPath || "").trim();
  if (!projectPath || projectPath.includes("..") || !/^(\/storage\/|\/sdcard\/|\/data\/data\/com\.termux\/)/.test(projectPath)) {
    return { deployed: false, rolledBack: false, channel: options.channel, statePath: "", message: "PROJECT_PATH_REQUIRED" };
  }
  const statePath = `${projectPath}/artifacts/deployments/${options.channel}.json`;
  const deployRoot = `${projectPath}/artifacts/deployments/${options.channel}`;
  const stateResult = await exec(options.runtime, `if [ -f ${shellQuote(statePath)} ]; then cat ${shellQuote(statePath)}; fi`);
  let previousState: DeploymentState | undefined;
  try { previousState = stateResult.stdout ? JSON.parse(stateResult.stdout) as DeploymentState : undefined; } catch { previousState = undefined; }

  const channelState = await getReleaseChannelState(options.runtime, projectPath, options.channel);
  const entry = options.targetReleaseId
    ? channelState.history.find(x => x.releaseId === options.targetReleaseId)
    : channelState.current;
  if (!entry) return { deployed: false, rolledBack: false, channel: options.channel, statePath, message: "DEPLOYMENT_TARGET_NOT_FOUND" };

  const packageName = await resolvePackage(options.runtime, entry.apkPath, options.packageName);
  const previousEntry = previousState?.current && previousState.current.releaseId !== entry.releaseId ? previousState.current : undefined;
  const autoRollback = options.autoRollback !== false;

  const apkPath = String(entry.apkPath || "");
  if (!apkPath || !/\.(apk|aab)$/i.test(apkPath) || !/^\/(storage|sdcard|data\/data\/com\.termux)/.test(apkPath)) {
    return { deployed: false, rolledBack: false, channel: options.channel, packageName, entry, statePath, message: "APK_PATH_NOT_ALLOWED" };
  }
  const install = await options.runtime.device.install(apkPath);
  if (install.exitCode !== 0) return { deployed: false, rolledBack: false, channel: options.channel, packageName, entry, statePath, message: install.stderr || install.stdout || "DEVICE_INSTALL_FAILED" };

  const health = await healthCheck(options.runtime, packageName, options.healthTimeoutMs ?? 8000);
  if (health.healthy) {
    const nextState: DeploymentState = { schema: 1, channel: options.channel, packageName, current: entry, previous: previousEntry, deployedAt: new Date().toISOString(), status: "healthy", lastHealth: health };
    const tmp = `${statePath}.tmp-${Date.now()}`;
    const cmd = [
      "set -e",
      `mkdir -p ${shellQuote(deployRoot)}`,
      `printf '%s\\n' ${shellQuote(JSON.stringify(nextState, null, 2))} > ${shellQuote(tmp)}`,
      `mv -f ${shellQuote(tmp)} ${shellQuote(statePath)}`,
    ].join("; ");
    const saved = await exec(options.runtime, cmd);
    if (saved.exitCode !== 0) return { deployed: true, rolledBack: false, channel: options.channel, packageName, entry, health, statePath, message: "DEPLOYED_STATE_SAVE_FAILED" };
    return { deployed: true, rolledBack: false, channel: options.channel, packageName, entry, health, statePath, message: "DEPLOYMENT_HEALTHY" };
  }

  if (!autoRollback || !previousEntry) {
    const failedState: DeploymentState = { schema: 1, channel: options.channel, packageName, current: entry, previous: previousEntry, deployedAt: new Date().toISOString(), status: "failed", lastHealth: health };
    await exec(options.runtime, `mkdir -p ${shellQuote(deployRoot)}; printf '%s\\n' ${shellQuote(JSON.stringify(failedState, null, 2))} > ${shellQuote(statePath)}`);
    return { deployed: false, rolledBack: false, channel: options.channel, packageName, entry, health, statePath, message: "DEPLOYMENT_HEALTHCHECK_FAILED" };
  }

  const rollbackInstall = await options.runtime.device.install(previousEntry.apkPath);
  if (rollbackInstall.exitCode !== 0) return { deployed: false, rolledBack: false, channel: options.channel, packageName, entry, health, statePath, message: rollbackInstall.stderr || rollbackInstall.stdout || "AUTO_ROLLBACK_INSTALL_FAILED" };
  const rollbackHealth = await healthCheck(options.runtime, packageName, options.healthTimeoutMs ?? 8000);
  const rollbackState: DeploymentState = { schema: 1, channel: options.channel, packageName, current: previousEntry, previous: entry, deployedAt: new Date().toISOString(), status: rollbackHealth.healthy ? "rolled_back" : "failed", lastHealth: rollbackHealth };
  const tmp = `${statePath}.tmp-${Date.now()}`;
  const save = await exec(options.runtime, ["set -e", `mkdir -p ${shellQuote(deployRoot)}`, `printf '%s\\n' ${shellQuote(JSON.stringify(rollbackState, null, 2))} > ${shellQuote(tmp)}`, `mv -f ${shellQuote(tmp)} ${shellQuote(statePath)}`].join("; "));
  if (save.exitCode !== 0) return { deployed: false, rolledBack: rollbackHealth.healthy, channel: options.channel, packageName, entry, rollbackEntry: previousEntry, health, rollbackHealth, statePath, message: "ROLLBACK_STATE_SAVE_FAILED" };
  return { deployed: false, rolledBack: rollbackHealth.healthy, channel: options.channel, packageName, entry, rollbackEntry: previousEntry, health, rollbackHealth, statePath, message: rollbackHealth.healthy ? "AUTO_ROLLBACK_COMPLETED" : "AUTO_ROLLBACK_HEALTHCHECK_FAILED" };
}

export async function getDeploymentState(runtime: RuntimeFacade, projectPath: string, channel: ReleaseChannel): Promise<DeploymentState | null> {
  const path = `${projectPath}/artifacts/deployments/${channel}.json`;
  const result = await exec(runtime, `if [ -f ${shellQuote(path)} ]; then cat ${shellQuote(path)}; fi`);
  if (!result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout) as DeploymentState; } catch { return null; }
}
