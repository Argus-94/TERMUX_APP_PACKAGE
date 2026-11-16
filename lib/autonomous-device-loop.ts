import type { RuntimeFacade } from "../core/RuntimeFacade";
import { runAssembleDebug, buildFixPrompt, type BuildAttemptResult } from "./build-loop";
import type { DeviceAutomationResult, VisionAnalyzer } from "../core/device/DeviceAutomationAgent";

export type AutonomousDeviceLoopOptions = {
  runtime: RuntimeFacade;
  projectPath: string;
  projectId: string;
  packageName?: string;
  goal: string;
  vision: VisionAnalyzer;
  repair: (prompt: string) => Promise<string>;
  maxBuildAttempts?: number;
  maxDeviceSteps?: number;
  buildTimeoutMs?: number;
  onEvent?: (event: AutonomousDeviceLoopEvent) => void;
};

export type AutonomousDeviceLoopEvent =
  | { type: "build_started"; attempt: number; maxAttempts: number }
  | { type: "build_failed"; attempt: number; build: BuildAttemptResult }
  | { type: "repair_started"; attempt: number }
  | { type: "repair_finished"; attempt: number; result: string }
  | { type: "device_started"; attempt: number; apkPath: string }
  | { type: "device_finished"; attempt: number; result: DeviceAutomationResult }
  | { type: "completed"; attempt: number }
  | { type: "failed"; reason: string };

export type AutonomousDeviceLoopResult = {
  ok: boolean;
  completed: boolean;
  buildAttempts: number;
  device?: DeviceAutomationResult;
  build?: BuildAttemptResult;
  history: string[];
};

/**
 * Full AI development/test loop. Build and repair remain deterministic tool
 * operations; the model is only used to diagnose/repair and to interpret
 * screenshots through the supplied VisionAnalyzer.
 */
export async function runAutonomousDeviceDevelopmentLoop(
  options: AutonomousDeviceLoopOptions,
): Promise<AutonomousDeviceLoopResult> {
  const maxAttempts = Math.max(1, Math.min(6, Math.floor(options.maxBuildAttempts ?? 3)));
  const history: string[] = [];
  let lastBuild: BuildAttemptResult | undefined;
  let lastDevice: DeviceAutomationResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.onEvent?.({ type: "build_started", attempt, maxAttempts });
    const build = await runAssembleDebug(options.projectPath, options.buildTimeoutMs ?? 600_000);
    lastBuild = build;

    if (!build.success || !build.apkHint) {
      options.onEvent?.({ type: "build_failed", attempt, build });
      if (attempt >= maxAttempts) {
        const reason = "BUILD_FAILED_AFTER_MAX_ATTEMPTS";
        options.onEvent?.({ type: "failed", reason });
        return { ok: false, completed: false, buildAttempts: attempt, build, history };
      }
      options.onEvent?.({ type: "repair_started", attempt });
      const repairResult = await options.repair(buildFixPrompt(options.projectPath, attempt, maxAttempts, build, history));
      history.push(`[build-repair ${attempt}] ${repairResult.slice(-4000)}`);
      options.onEvent?.({ type: "repair_finished", attempt, result: repairResult });
      continue;
    }

    options.onEvent?.({ type: "device_started", attempt, apkPath: build.apkHint });
    lastDevice = await options.runtime.runDeviceAutomationAsAgent(options.projectId, {
      apkPath: build.apkHint,
      packageName: options.packageName,
      goal: options.goal,
      maxSteps: options.maxDeviceSteps ?? 8,
      vision: options.vision,
    });
    options.onEvent?.({ type: "device_finished", attempt, result: lastDevice });

    if (lastDevice.completed) {
      options.onEvent?.({ type: "completed", attempt });
      return { ok: true, completed: true, buildAttempts: attempt, build, device: lastDevice, history };
    }

    if (attempt >= maxAttempts) {
      const reason = `DEVICE_TEST_FAILED:${lastDevice.reason}`;
      options.onEvent?.({ type: "failed", reason });
      return { ok: false, completed: false, buildAttempts: attempt, build, device: lastDevice, history };
    }

    const evidence = lastDevice.steps
      .slice(-3)
      .map((step) => `STEP ${step.step}\nOBSERVATION:\n${step.observation.slice(-2500)}\nLOGCAT:\n${(step.logcat || "").slice(-2500)}`)
      .join("\n\n");
    const repairPrompt =
      `[DEVICE_UI_RECOVERY attempt ${attempt}/${maxAttempts}]\n` +
      `Project: ${options.projectPath}\nPackage: ${options.packageName}\nGoal: ${options.goal}\n` +
      `The built APK installed/launched but the device test did not reach the goal.\n` +
      `Reason: ${lastDevice.reason}\n\n${evidence}\n\n` +
      `Inspect the real project and repair the smallest root cause. Do not invent test results. ` +
      `After editing, verify the relevant code/config and finish with a concise summary.`;
    options.onEvent?.({ type: "repair_started", attempt });
    const repairResult = await options.repair(repairPrompt);
    history.push(`[device-repair ${attempt}] ${repairResult.slice(-4000)}`);
    options.onEvent?.({ type: "repair_finished", attempt, result: repairResult });
  }

  return { ok: false, completed: false, buildAttempts: maxAttempts, build: lastBuild, device: lastDevice, history };
}
