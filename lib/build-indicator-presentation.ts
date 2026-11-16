export type BuildIndicatorStage = Readonly<{
  id: string;
  label: string;
  status: "pending" | "active" | "done" | "error" | "skipped";
  detail?: string;
}>;

export type BuildIndicatorInput = Readonly<{
  stages: readonly BuildIndicatorStage[];
  command?: string;
  detail?: string;
  buildStatus?: "running" | "recovering" | "verified";
  taskStatus?: "running" | "completed" | "failed" | "cancelled";
  /** Explicit percentage from backend (0–100). Preferred when present. */
  progressPercent?: number;
  /** Optional step counters for playbook / multi-step tasks. */
  step?: number;
  maxSteps?: number;
}>;

export type BuildIndicatorModel = Readonly<{
  status: "running" | "recovering" | "attention" | "verified" | "completed" | "cancelled";
  completed: number;
  total: number;
  current?: BuildIndicatorStage;
  currentIndex: number;
  /**
   * 0–100 progress for the UI bar.
   * Prefer authoritative backend percent; otherwise derive from stages or step/maxSteps
   * so the user always sees real task progress (playbooks, builds, recovery).
   */
  percent: number;
  /** True when percent came from backend, not synthesis. */
  percentAuthoritative: boolean;
}>;

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

/** Derive progress from observed stage statuses (active stage counts as partial). */
function percentFromStages(visible: readonly BuildIndicatorStage[]): number | undefined {
  if (visible.length === 0) return undefined;
  const total = visible.length;
  let weight = 0;
  for (const stage of visible) {
    if (stage.status === "done") weight += 1;
    else if (stage.status === "active") weight += 0.45;
    else if (stage.status === "error") weight += 0.45;
  }
  return clampPercent((weight / total) * 100);
}

/** Derive progress from step counters (1-based step preferred). */
function percentFromSteps(step?: number, maxSteps?: number): number | undefined {
  if (typeof maxSteps !== "number" || !Number.isFinite(maxSteps) || maxSteps <= 0) return undefined;
  if (typeof step !== "number" || !Number.isFinite(step) || step < 0) return undefined;
  // step is often 1-based "current step"; treat completed fraction as (step-1)/max while running
  const done = Math.max(0, Math.min(maxSteps, step > 0 ? step - 1 : 0));
  const partial = step > 0 && step <= maxSteps ? 0.35 : 0;
  return clampPercent(((done + partial) / maxSteps) * 100);
}

/**
 * Build the indicator model.
 * - Never invent success: status still follows observed task/build flags.
 * - Always expose a percent for the progress bar (0 when nothing known yet).
 */
export function buildIndicatorModel(input: BuildIndicatorInput): BuildIndicatorModel {
  const visible = input.stages.filter((stage) => stage.status !== "skipped");
  const total = visible.length;
  const completed = visible.filter((stage) => stage.status === "done").length;
  const current =
    visible.find((stage) => stage.status === "active") ||
    visible.find((stage) => stage.status === "error");
  const currentIndex = current ? visible.findIndex((stage) => stage.id === current.id) + 1 : 0;
  const hasError = visible.some((stage) => stage.status === "error");
  const verifyStage = input.stages.find((stage) => /^(verify|verified|check|validate)$/i.test(stage.id));
  const verified = input.buildStatus === "verified" && !!verifyStage && verifyStage.status === "done";

  let status: BuildIndicatorModel["status"];
  if (verified) status = "verified";
  else if (input.taskStatus === "cancelled") status = "cancelled";
  else if (input.taskStatus === "failed" || hasError) status = "attention";
  else if (input.taskStatus === "completed") status = "completed";
  else if (input.buildStatus === "recovering") status = "recovering";
  else status = "running";

  const reported = input.progressPercent;
  const hasReportedPercent =
    typeof reported === "number" && Number.isFinite(reported) && reported >= 0 && reported <= 100;

  let percent: number;
  let percentAuthoritative = false;

  if (verified || input.taskStatus === "completed") {
    percent = 100;
    percentAuthoritative = hasReportedPercent ? true : false;
  } else if (input.taskStatus === "cancelled") {
    percent = hasReportedPercent ? clampPercent(reported!) : percentFromStages(visible) ?? percentFromSteps(input.step, input.maxSteps) ?? 0;
  } else if (hasReportedPercent) {
    percent = clampPercent(reported!);
    percentAuthoritative = true;
  } else {
    percent =
      percentFromStages(visible) ??
      percentFromSteps(input.step, input.maxSteps) ??
      0;
  }

  return {
    status,
    completed,
    total,
    ...(current ? { current } : {}),
    currentIndex,
    percent,
    percentAuthoritative,
  };
}
