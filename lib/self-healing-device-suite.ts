import type { RuntimeFacade } from "../core/RuntimeFacade";
import { DeviceEvidenceStore } from "../core/device/DeviceEvidenceStore";
import { generateDeviceTestSuite, type DeviceTestSuite, type TestPlanModel } from "../core/device/DeviceTestPlanner";
import { runDeviceTestSuite, type DeviceTestSuiteRun } from "../core/device/DeviceTestRunner";
import { runAssembleDebug, type BuildAttemptResult } from "./build-loop";

export type SelfHealingDeviceSuiteOptions = {
  runtime: RuntimeFacade;
  projectPath: string;
  projectId: string;
  packageName?: string;
  goal: string;
  repair: (prompt: string) => Promise<string>;
  model?: TestPlanModel;
  maxBuildAttempts?: number;
  maxActionsPerCase?: number;
  buildTimeoutMs?: number;
  onEvent?: (event: SelfHealingDeviceSuiteEvent) => void;
};

export type SelfHealingDeviceSuiteEvent =
  | { type: "suite_planned"; cases: number }
  | { type: "build_started"; attempt: number; maxAttempts: number }
  | { type: "build_finished"; attempt: number; success: boolean; apkPath?: string }
  | { type: "suite_started"; attempt: number; caseIds?: string[] }
  | { type: "suite_finished"; attempt: number; run: DeviceTestSuiteRun }
  | { type: "repair_started"; attempt: number; failedCases: string[] }
  | { type: "repair_finished"; attempt: number; result: string }
  | { type: "completed"; attempt: number }
  | { type: "failed"; reason: string };

export type SelfHealingDeviceSuiteResult = {
  ok: boolean;
  completed: boolean;
  attempts: number;
  suite: DeviceTestSuite;
  finalRun?: DeviceTestSuiteRun;
  build?: BuildAttemptResult;
  repairedCaseIds: string[];
  history: string[];
};

/**
 * Build -> execute regression suite -> collect deterministic evidence -> repair ->
 * rebuild -> rerun only failed cases. Model output is restricted to planning and
 * source repair; test status always comes from local assertions.
 */
export async function runSelfHealingDeviceSuite(options: SelfHealingDeviceSuiteOptions): Promise<SelfHealingDeviceSuiteResult> {
  const projectPath = String(options.projectPath || "").trim();
  if (!projectPath || projectPath.includes("..") || !/^(\/storage\/|\/sdcard\/|\/data\/data\/com\.termux\/)/.test(projectPath)) {
    options.onEvent?.({ type: "failed", reason: "PROJECT_PATH_REQUIRED" });
    return { ok: false, completed: false, attempts: 0, suite: { cases: [] } as any, repairedCaseIds: [], history: ["PROJECT_PATH_REQUIRED"] };
  }
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(options.maxBuildAttempts ?? 3)));
  const maxActions = Math.min(20, Math.max(1, Math.floor(options.maxActionsPerCase ?? 12)));
  const suite = await generateDeviceTestSuite(options.goal, options.packageName, options.model);
  options.onEvent?.({ type: "suite_planned", cases: suite.cases.length });

  let failedCaseIds: string[] | undefined;
  let finalRun: DeviceTestSuiteRun | undefined;
  let lastBuild: BuildAttemptResult | undefined;
  const history: string[] = [];
  const repairedCaseIds: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.onEvent?.({ type: "build_started", attempt, maxAttempts });
    const build = await runAssembleDebug(projectPath, options.buildTimeoutMs ?? 600_000);
    lastBuild = build;
    options.onEvent?.({ type: "build_finished", attempt, success: build.success, apkPath: build.apkHint });

    if (!build.success || !build.apkHint) {
      if (attempt >= maxAttempts) {
        const reason = "BUILD_FAILED_AFTER_MAX_ATTEMPTS";
        options.onEvent?.({ type: "failed", reason });
        return { ok: false, completed: false, attempts: attempt, suite, finalRun, build, repairedCaseIds, history };
      }
      const prompt = buildRepairPrompt(options, attempt, maxAttempts, build, undefined, history);
      options.onEvent?.({ type: "repair_started", attempt, failedCases: [] });
      const repairResult = await options.repair(prompt);
      history.push(`[build-repair ${attempt}] ${repairResult.slice(-5000)}`);
      options.onEvent?.({ type: "repair_finished", attempt, result: repairResult });
      continue;
    }

    const apkHint = String(build.apkHint || "");
    if (!/\.(apk|aab)$/i.test(apkHint) || !apkHint.startsWith("/")) {
      options.onEvent?.({ type: "failed", reason: "APK_PATH_INVALID" });
      return { ok: false, completed: false, attempts: attempt, suite, finalRun, build, repairedCaseIds, history: [...history, "APK_PATH_INVALID"] };
    }
    const runId = `selfheal-${Date.now()}-${attempt}`;
    const evidence = new DeviceEvidenceStore(projectPath, runId);
    const selected = failedCaseIds?.length ? failedCaseIds : undefined;
    options.onEvent?.({ type: "suite_started", attempt, caseIds: selected });
    finalRun = await runDeviceTestSuite(options.runtime.device, {
      apkPath: build.apkHint,
      packageName: options.packageName,
      suite,
      evidence,
      maxActionsPerCase: maxActions,
      caseIds: selected,
    });
    options.onEvent?.({ type: "suite_finished", attempt, run: finalRun });

    if (finalRun.report.status === "passed") {
      options.onEvent?.({ type: "completed", attempt });
      return { ok: true, completed: true, attempts: attempt, suite, finalRun, build, repairedCaseIds, history };
    }

    failedCaseIds = finalRun.report.cases.filter(c => c.status !== "passed").map(c => c.id).slice(0, 8);
    if (attempt >= maxAttempts) {
      const reason = `TEST_SUITE_FAILED:${failedCaseIds.join(",")}`;
      options.onEvent?.({ type: "failed", reason });
      return { ok: false, completed: false, attempts: attempt, suite, finalRun, build, repairedCaseIds, history };
    }

    for (const id of failedCaseIds) if (!repairedCaseIds.includes(id)) repairedCaseIds.push(id);
    options.onEvent?.({ type: "repair_started", attempt, failedCases: failedCaseIds });
    const repairPrompt = buildRepairPrompt(options, attempt, maxAttempts, build, finalRun, history);
    const repairResult = await options.repair(repairPrompt);
    history.push(`[device-repair ${attempt}] ${repairResult.slice(-5000)}`);
    options.onEvent?.({ type: "repair_finished", attempt, result: repairResult });
  }

  return { ok: false, completed: false, attempts: maxAttempts, suite, finalRun, build: lastBuild, repairedCaseIds, history };
}

function buildRepairPrompt(
  options: SelfHealingDeviceSuiteOptions,
  attempt: number,
  maxAttempts: number,
  build: BuildAttemptResult,
  run: DeviceTestSuiteRun | undefined,
  history: string[],
): string {
  const failed = run?.report.cases.filter(c => c.status !== "passed") || [];
  const cases = failed.map(c => ({
    id: c.id,
    title: c.title,
    status: c.status,
    reason: c.reason,
    evidence: c.steps.flatMap(s => s.evidence.map(e => ({ kind: e.kind, path: e.path, sha256: e.sha256 }))).slice(-12),
  }));
  return [
    `[AI_SELF_HEAL_QA attempt ${attempt}/${maxAttempts}]`,
    `Project: ${options.projectPath}`,
    `Project id: ${options.projectId}`,
    `Package: ${options.packageName || "auto-detect"}`,
    `Goal: ${options.goal}`,
    `Only repair the smallest root cause supported by the evidence.`,
    `Do not alter tests just to make them pass. Do not invent evidence or results.`,
    `Build success: ${build.success}; APK: ${build.apkHint || "none"}`,
    `Build errors: ${(build.errors || []).map(e => e.message).slice(-8).join(" | ")}`,
    run ? `Test report status: ${run.report.status}; failed cases: ${failed.map(c => c.id).join(", ") || "none"}` : "No test report: build failed before device execution.",
    `Failure evidence JSON:\n${JSON.stringify(cases, null, 2)}`,
    history.length ? `Previous repair summaries:\n${history.slice(-3).join("\n")}` : "",
    `After editing, verify the affected source/config and leave the project in a buildable state.`,
  ].filter(Boolean).join("\n\n");
}
