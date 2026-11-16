import type {
  ProotRuntimeTarget,
  RuntimeEnvironmentReadiness,
} from "./runtime-environment-check.ts";

type RuntimePreparationActionResult<T> =
  | Readonly<{ kind: "already-ready"; readiness: RuntimeEnvironmentReadiness }>
  | Readonly<{ kind: "blocked"; readiness: RuntimeEnvironmentReadiness; reason: string }>
  | Readonly<{ kind: "prepared"; readiness: RuntimeEnvironmentReadiness; result: T }>;

export type RuntimePreparationActionOptions<T> = Readonly<{
  check: () => Promise<RuntimeEnvironmentReadiness>;
  prepare: (freshMissingReadiness: RuntimeEnvironmentReadiness) => Promise<T>;
}>;

function unknownReadiness(target: ProotRuntimeTarget, detail: string): RuntimeEnvironmentReadiness {
  return {
    target,
    status: "error",
    phase: "error",
    detail,
    hostTool: "unknown",
    rootfs: "unknown",
    baseline: "unknown",
    missingItems: [],
  };
}

/**
 * Click-time safety gate for an explicitly requested Ubuntu/Debian preparation.
 * The previously rendered UI state is never authorization: run a fresh
 * read-only production check first, prepare only on confirmed `missing`, and
 * preserve all existing data when the state is ready, unhealthy, or unknown.
 */
export async function runProotRuntimePreparationAction<T>(
  target: ProotRuntimeTarget,
  options: RuntimePreparationActionOptions<T>,
): Promise<RuntimePreparationActionResult<T>> {
  let readiness: RuntimeEnvironmentReadiness;
  try {
    readiness = await options.check();
  } catch {
    readiness = unknownReadiness(
      target,
      "Fresh read-only preflight failed unexpectedly; state remains unknown and no changes were made.",
    );
  }

  if (!readiness || readiness.target !== target) {
    const detail = "Fresh preflight returned a different or missing target; no installation or reset was started.";
    return { kind: "blocked", readiness: unknownReadiness(target, detail), reason: detail };
  }

  if (readiness.status === "ready") {
    return { kind: "already-ready", readiness };
  }

  if (readiness.status !== "missing") {
    const reason = readiness.detail || "Selected environment state is unknown; no installation or reset was started.";
    return { kind: "blocked", readiness, reason };
  }

  const result = await options.prepare(readiness);
  return { kind: "prepared", readiness, result };
}
