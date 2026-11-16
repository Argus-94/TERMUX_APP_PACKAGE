/**
 * Helpers to retry a task from a failure fixture / trajectory fingerprint.
 */
import type { AgentFailureFixture } from "./agent-failure-fixture";

export type FixtureRetryPlan = {
  task: string;
  backendHint: string;
  goalKind: string;
  mustExist: string[];
  note: string;
};

export function buildRetryPlanFromFixture(fixture: AgentFailureFixture): FixtureRetryPlan {
  return {
    task: fixture.task,
    backendHint: fixture.backend,
    goalKind: fixture.goal?.kind || "unknown",
    mustExist: Array.isArray(fixture.goal?.mustExist) ? [...fixture.goal.mustExist] : [],
    note: `Retry from fixture ${fixture.id} fp=${fixture.fingerprint}. Avoid repeating failed step kinds: ${
      (fixture.steps || [])
        .filter((s) => s.status === "fail" || s.status === "failed")
        .map((s) => s.kind)
        .slice(0, 8)
        .join(",") || "none"
    }`,
  };
}

export function formatRetryPlanBlock(plan: FixtureRetryPlan): string {
  return [
    "[FIXTURE_RETRY]",
    `task=${plan.task.slice(0, 500)}`,
    `backend_hint=${plan.backendHint}`,
    `goal=${plan.goalKind}`,
    `must_exist=${plan.mustExist.join(",") || "none"}`,
    `note=${plan.note}`,
  ].join("\n");
}
