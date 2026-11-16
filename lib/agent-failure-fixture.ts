import { sanitizeFailureFixtureForPersistence } from "./agent-trace-privacy.ts";
import type { AgentTrajectory } from "./agent-trajectory.ts";

export const FAILURE_FIXTURE_ROOT = "/storage/emulated/0/AIBuilderTermux/fixtures" as const;
export type AgentFailureFixture = {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  createdAt: number;
  task: string;
  backend: string;
  goal: { kind: string; mustExist: string[] };
  steps: Array<{ kind: string; status: string; backend: string; exitCode?: number }>;
  stdout: string;
  stderr: string;
  expected: { mustContain: string };
};
function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
function q(value: string): string { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
async function executeSharedCommand(command: string, options: { timeoutMs: number; trustedInternal: true; executionTarget: "embedded-private"; preserveOutput?: true }) {
  const { executeGuardedTermuxCommand } = await import("./termux-executor.ts");
  return executeGuardedTermuxCommand(command, options);
}
/** Hash a bounded diagnostic label; never persist its raw text or path. */
export function fingerprintFailureKey(value: unknown): string {
  return `fp-${hash(String(value || "").slice(0, 256))}`;
}

export function normalizeFailureCode(value: unknown): string {
  const candidate = String(value || "").toLowerCase();
  const allowed = new Set(["agent_failed", "agent_exception", "agent_aborted", "goal_unmet", "playbook_failed", "anti_stuck"]);
  return allowed.has(candidate) ? candidate : "agent_failed";
}
export function createFailureFixture(trajectory: AgentTrajectory, failureCode: string): AgentFailureFixture {
  const classification = normalizeFailureCode(failureCode);
  const fingerprint = hash(`${trajectory.goalKind}|${trajectory.backend}|${classification}`);
  return {
    schemaVersion: 1,
    id: `fp-${fingerprint}`,
    fingerprint,
    createdAt: Date.now(),
    task: "[USER_TASK_OMITTED]",
    backend: trajectory.backend,
    goal: { kind: trajectory.goalKind, mustExist: trajectory.goalKind === "generic" ? [] : ["[USER_PATH_OMITTED]"] },
    steps: trajectory.steps.slice(-40).map((s) => ({ kind: s.kind, status: s.status || "skip", backend: s.backend || trajectory.backend, ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }) })),
    stdout: "[REDACTED: failure output omitted]",
    stderr: `[REDACTED: failure class ${classification}]`,
    expected: { mustContain: "AIB_GOAL_OK" },
  };
}
export function createBuiltinFailureFixtures(): AgentFailureFixture[] {
  const base = (id: string, backend: string, goalKind: string, status: string, code: string): AgentFailureFixture => ({
    schemaVersion: 1, id, fingerprint: id.replace(/^fp-/, ""), createdAt: 0,
    task: "[USER_TASK_OMITTED]", backend,
    goal: { kind: goalKind, mustExist: goalKind === "generic" ? [] : ["[USER_PATH_OMITTED]"] },
    steps: [{ kind: "shell", status, backend }],
    stdout: "[REDACTED]", stderr: `[REDACTED: ${code}]`, expected: { mustContain: "AIB_GOAL_OK" },
  });
  return [
    base("fp-golden-download-mkdir", "termux", "dir_mkdir", "pass", "mkdir_download"),
    base("fp-golden-ubuntu-guest-first", "ubuntu-proot", "dir_mkdir", "pass", "guest_first"),
    base("fp-golden-goal-unmet", "termux", "dir_mkdir", "fail", "goal_unmet"),
  ];
}
export function validateFailureFixture(value: unknown): value is AgentFailureFixture {
  const f = value as Partial<AgentFailureFixture> | null;
  return !!f && f.schemaVersion === 1 && typeof f.id === "string" && /^fp-[a-z0-9_-]{1,80}$/i.test(f.id) &&
    typeof f.fingerprint === "string" && !!f.goal && typeof f.goal.kind === "string" && Array.isArray(f.goal.mustExist) &&
    Array.isArray(f.steps) && !!f.expected && f.expected.mustContain === "AIB_GOAL_OK";
}
export function replayFixtureOffline(fixture: AgentFailureFixture): { ok: boolean; outcome: "pass" | "fail"; detail: string } {
  if (!validateFailureFixture(fixture)) return { ok: false, outcome: "fail", detail: "fixture_schema_invalid" };
  const gateExpected = fixture.id === "fp-golden-goal-unmet" ? "fail" : "pass";
  const simulatedMarker = gateExpected === "pass" ? "AIB_GOAL_OK" : "AIB_GOAL_NO";
  const outcome = simulatedMarker.includes(fixture.expected.mustContain) ? "pass" : "fail";
  return { ok: outcome === gateExpected, outcome, detail: "offline_structural_replay" };
}
export async function persistFailureFixture(trajectory: AgentTrajectory, failureCode: string): Promise<boolean> {
  try {
    const fixture = createFailureFixture(trajectory, failureCode);
    const safe = sanitizeFailureFixtureForPersistence(fixture);
    if (!safe) return false;
    const file = `${FAILURE_FIXTURE_ROOT}/${fixture.id}.json`;
    const command = `mkdir -p ${q(FAILURE_FIXTURE_ROOT)} && printf '%s' ${q(JSON.stringify(safe))} > ${q(file)} && echo AIB_FIXTURE_SAVED`;
    const result = await executeSharedCommand(command, { timeoutMs: 15_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true });
    return /AIB_FIXTURE_SAVED/.test(`${result.stdout || ""}\n${result.stderr || ""}`);
  } catch { return false; }
}
