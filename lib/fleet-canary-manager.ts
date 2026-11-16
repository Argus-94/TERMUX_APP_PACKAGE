import type { RuntimeFacade } from "../core/RuntimeFacade";
import { deployReleaseFleet, listFleetDevices, type FleetDeviceResult } from "./device-fleet-manager";
import type { ReleaseChannel } from "./release-channel-manager";

export type CanaryStage = { percentage: number; maxFailureRate: number };
export type CanaryStageResult = {
  stage: number;
  percentage: number;
  serials: string[];
  healthy: number;
  failed: number;
  rolledBack: number;
  failureRate: number;
  passed: boolean;
  results: FleetDeviceResult[];
};
export type FleetCanaryResult = {
  channel: ReleaseChannel;
  totalDevices: number;
  attempted: number;
  healthy: number;
  failed: number;
  stopped: boolean;
  stopReason?: string;
  stages: CanaryStageResult[];
  statePath: string;
};

type CanaryState = { schema: 1; channel: ReleaseChannel; updatedAt: string; stages: CanaryStageResult[]; stopped: boolean; stopReason?: string };

function q(v: string): string { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function safeSerial(v: string): boolean { return /^[A-Za-z0-9._:-]{1,128}$/.test(v); }
function clampPct(v: number): number { return Math.max(1, Math.min(100, Math.round(v))); }

async function exec(runtime: RuntimeFacade, command: string) {
  const r = await runtime.environment.exec(command, {});
  return r as { exitCode?: number; stdout?: string; stderr?: string };
}
async function saveState(runtime: RuntimeFacade, path: string, state: CanaryState) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const tmp = `${path}.tmp-${Date.now()}`;
  await exec(runtime, `mkdir -p ${q(dir)}; printf '%s\\n' ${q(JSON.stringify(state, null, 2))} > ${q(tmp)}; mv -f ${q(tmp)} ${q(path)}`);
}

function makeStages(input?: CanaryStage[]): CanaryStage[] {
  const raw = input?.length ? input : [
    { percentage: 10, maxFailureRate: 0 },
    { percentage: 25, maxFailureRate: 20 },
    { percentage: 100, maxFailureRate: 20 },
  ];
  const sorted = raw.map(x => ({ percentage: clampPct(x.percentage), maxFailureRate: Math.max(0, Math.min(100, x.maxFailureRate)) })).sort((a,b) => a.percentage-b.percentage);
  if (sorted[sorted.length-1].percentage !== 100) sorted.push({ percentage: 100, maxFailureRate: sorted[sorted.length-1].maxFailureRate });
  return sorted;
}

/** Progressive rollout. A stage only advances when its observed failure rate is within the configured threshold. */
export async function runFleetCanary(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
  packageName?: string;
  concurrency?: number;
  healthTimeoutMs?: number;
  autoRollback?: boolean;
  stages?: CanaryStage[];
}): Promise<FleetCanaryResult> {
  const projectPath = String(options.projectPath || "").trim();
  if (!projectPath || projectPath.includes("..") || !/^(\/storage\/|\/sdcard\/|\/data\/data\/com\.termux\/)/.test(projectPath)) {
    throw new Error("PROJECT_PATH_REQUIRED");
  }
  const all = (await listFleetDevices(options.runtime)).filter(x => x.state === "device" && safeSerial(x.serial));
  if (!all.length) throw new Error("NO_READY_FLEET_DEVICES");
  const stages = makeStages(options.stages);
  const selected = new Set<string>();
  const results: CanaryStageResult[] = [];
  const statePath = `${options.projectPath}/artifacts/deployments/canary-${options.channel}.json`;
  let stopped = false;
  let stopReason: string | undefined;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const targetCount = Math.max(1, Math.ceil(all.length * stage.percentage / 100));
    const batch = all.map(x => x.serial).filter(x => !selected.has(x)).slice(0, Math.max(0, targetCount - selected.size));
    if (!batch.length) continue;
    const fleet = await deployReleaseFleet({ runtime: options.runtime, projectPath: options.projectPath, channel: options.channel, packageName: options.packageName, serials: batch, concurrency: options.concurrency ?? 2, autoRollback: options.autoRollback !== false, healthTimeoutMs: options.healthTimeoutMs ?? 8000 });
    batch.forEach(x => selected.add(x));
    const failed = fleet.results.filter(x => !x.health).length;
    const failureRate = fleet.results.length ? (failed / fleet.results.length) * 100 : 100;
    const passed = failureRate <= stage.maxFailureRate;
    results.push({ stage: i + 1, percentage: stage.percentage, serials: batch, healthy: fleet.healthy, failed, rolledBack: fleet.rolledBack, failureRate, passed, results: fleet.results });
    if (!passed) { stopped = true; stopReason = `STAGE_${i + 1}_FAILURE_RATE_${failureRate.toFixed(1)}_PCT_EXCEEDS_${stage.maxFailureRate}_PCT`; break; }
  }
  const state: CanaryState = { schema: 1, channel: options.channel, updatedAt: new Date().toISOString(), stages: results, stopped, stopReason };
  await saveState(options.runtime, statePath, state);
  const allResults = results.flatMap(x => x.results);
  return { channel: options.channel, totalDevices: all.length, attempted: allResults.length, healthy: allResults.filter(x => x.health).length, failed: allResults.filter(x => !x.health).length, stopped, stopReason, stages: results, statePath };
}
