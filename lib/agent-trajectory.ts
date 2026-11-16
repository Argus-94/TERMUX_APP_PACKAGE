import { sanitizeAgentTrajectoryForPersistence } from "./agent-trace-privacy.ts";
import { createUsageMeter, finishUsageMeter, recordUsageStep, recordUsageBackend, type AgentUsageMeter } from "./agent-usage-meter.ts";
import { formatUsageSummary } from "./agent-usage-meter.ts";

export type TrajectoryBackend = "termux" | "ubuntu-proot" | "guest" | "host-termux" | "embedded-private" | "unknown";
export type TrajectoryStatus = "pass" | "fail" | "skip";
export type TrajectoryStepKind = "playbook" | "shell" | "tool" | "gate" | "decision" | "done" | "error";
export type TrajectoryOperationClass = "read" | "write-shared" | "write-project" | "shell-destructive" | "network" | "github";
export type TrajectoryResultMarker = "PLAYBOOK_OK" | "PLAYBOOK_FAIL" | "AIB_GOAL_OK" | "GOAL_GATE_BLOCK";
export type AgentTrajectoryStepInput = {
  kind: TrajectoryStepKind;
  action?: string;
  backend?: TrajectoryBackend;
  status?: TrajectoryStatus;
  exitCode?: number;
  durationMs?: number;
  path?: string;
  operationClass?: TrajectoryOperationClass;
  resultMarker?: TrajectoryResultMarker;
  fingerprintKey?: string;
};
export type AgentTrajectoryStep = Omit<AgentTrajectoryStepInput, "path"> & { at: number };
export type AgentTrajectory = {
  schemaVersion: 1;
  id: string;
  sessionId?: string;
  projectKey?: string;
  task: string;
  goalKind: string;
  backend: TrajectoryBackend;
  startedAt: number;
  endedAt?: number;
  outcome: "running" | "pass" | "fail" | "abort";
  steps: AgentTrajectoryStep[];
  usage: AgentUsageMeter;
  blame: Array<{ pathKey: string; step: number; summary: string }>;
};

export const AGENT_SESSION_ROOT = "/storage/emulated/0/AIBuilderTermux/sessions" as const;
const MAX_SESSION_RECORDS = 20;
const MAX_TRAJECTORY_STEPS = 200;

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function safeId(value: string): string { return /^[a-z0-9_-]{1,80}$/i.test(value) ? value : makeId(); }
function shellQuote(value: string): string { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function pathFingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `p-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
async function executeSharedCommand(command: string, options: { timeoutMs: number; trustedInternal: true; executionTarget: "embedded-private"; preserveOutput?: true }) {
  const { executeGuardedTermuxCommand } = await import("./termux-executor.ts");
  return executeGuardedTermuxCommand(command, options);
}

export function createAgentTrajectory(input: {
  task?: string;
  goalKind?: string;
  backend?: string;
  sessionId?: string;
  projectPath?: string | null;
  startedAt?: number;
  tokens?: number | null;
} = {}): AgentTrajectory {
  const startedAt = input.startedAt ?? Date.now();
  const meter = createUsageMeter(startedAt, input.tokens ?? null);
  return {
    schemaVersion: 1,
    id: makeId(),
    ...(input.sessionId ? { sessionId: safeId(input.sessionId) } : {}),
    ...(input.projectPath ? { projectKey: pathFingerprint(input.projectPath) } : {}),
    task: String(input.task || ""),
    goalKind: String(input.goalKind || "generic"),
    backend: normalizeBackend(input.backend),
    startedAt,
    outcome: "running",
    steps: [],
    usage: finishUsageMeter(meter, startedAt),
    blame: [],
  };
}

export function normalizeBackend(value: unknown): TrajectoryBackend {
  if (value === "embedded-private") return value;
  if (value === "termux" || value === "ubuntu-proot" || value === "guest" || value === "host-termux") return value;
  if (value === "Ubuntu proot") return "ubuntu-proot";
  if (value === "Termux") return "termux";
  return "unknown";
}

export function appendAgentTrajectoryStep(trajectory: AgentTrajectory, input: AgentTrajectoryStepInput): AgentTrajectory {
  const kind = input.kind;
  const backend = input.backend ? normalizeBackend(input.backend) : trajectory.backend;
  const status = input.status || "pass";
  const step: AgentTrajectoryStep = {
    kind,
    ...(input.action && /^[a-z0-9_.:-]{1,80}$/i.test(input.action) ? { action: input.action } : {}),
    ...(input.operationClass ? { operationClass: input.operationClass } : {}),
    ...(input.resultMarker ? { resultMarker: input.resultMarker } : {}),
    ...(input.fingerprintKey && /^fp-[a-f0-9]{8}$/i.test(input.fingerprintKey) ? { fingerprintKey: input.fingerprintKey.toLowerCase() } : {}),
    backend,
    status,
    ...(Number.isInteger(input.exitCode) ? { exitCode: input.exitCode } : {}),
    ...(Number.isFinite(input.durationMs) && (input.durationMs as number) >= 0 ? { durationMs: Math.min(86_400_000, input.durationMs as number) } : {}),
    at: Date.now(),
  };
  trajectory.steps.push(step);
  if (trajectory.steps.length > MAX_TRAJECTORY_STEPS) trajectory.steps = trajectory.steps.slice(-MAX_TRAJECTORY_STEPS);
  recordUsageStep(trajectory.usage);
  if (kind === "shell" || kind === "tool" || kind === "playbook") {
    const b = backend === "ubuntu-proot" || backend === "guest" ? "ubuntu-proot" : "termux";
    recordUsageBackend(trajectory.usage, b);
  }
  if (input.path) trajectory.blame.push({ pathKey: pathFingerprint(input.path), step: trajectory.steps.length - 1, summary: `${kind}-${status}` });
  if (trajectory.blame.length > MAX_TRAJECTORY_STEPS) trajectory.blame = trajectory.blame.slice(-MAX_TRAJECTORY_STEPS);
  return trajectory;
}

export function finalizeAgentTrajectory(
  trajectory: AgentTrajectory,
  outcome: AgentTrajectory["outcome"],
  endedAt = Date.now(),
  tokens?: number | null,
): AgentTrajectory {
  trajectory.endedAt = endedAt;
  trajectory.outcome = outcome;
  trajectory.usage = finishUsageMeter(trajectory.usage, endedAt, tokens);
  return trajectory;
}

export function sanitizeAgentTrajectory(trajectory: AgentTrajectory): Record<string, unknown> | null {
  return sanitizeAgentTrajectoryForPersistence(trajectory);
}

export function trajectoryFilePath(id: string): string {
  return `${AGENT_SESSION_ROOT}/run-${safeId(id)}.json`;
}

export function buildTrajectoryWriteCommand(trajectory: AgentTrajectory): string {
  const safe = sanitizeAgentTrajectory(trajectory);
  if (!safe) throw new Error("AGENT_TRAJECTORY_INVALID");
  const json = JSON.stringify(safe);
  const target = trajectoryFilePath(trajectory.id);
  return `mkdir -p ${shellQuote(AGENT_SESSION_ROOT)} && printf '%s' ${shellQuote(json)} > ${shellQuote(target)} && echo AIB_TRAJECTORY_SAVED`;
}

export async function persistAgentTrajectory(trajectory: AgentTrajectory): Promise<boolean> {
  try {
    const write = await executeSharedCommand(buildTrajectoryWriteCommand(trajectory), {
      timeoutMs: 20_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true,
    });
    if (!/AIB_TRAJECTORY_SAVED/.test(`${write.stdout || ""}\n${write.stderr || ""}`)) return false;
    await rotateAgentTrajectories();
    return true;
  } catch {
    return false;
  }
}

export async function rotateAgentTrajectories(): Promise<void> {
  try {
    const listing = await executeSharedCommand(`ls -1t ${shellQuote(AGENT_SESSION_ROOT)}/run-*.json 2>/dev/null`, {
      timeoutMs: 10_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true,
    });
    const oldFiles = String(listing.stdout || "").split(/\r?\n/).map((x) => x.trim())
      .filter((p) => p.startsWith(`${AGENT_SESSION_ROOT}/run-`) && /^run-[a-z0-9_-]+\.json$/i.test(p.slice(AGENT_SESSION_ROOT.length + 1)))
      .slice(MAX_SESSION_RECORDS);
    if (oldFiles.length) {
      await executeSharedCommand(`rm -f -- ${oldFiles.map(shellQuote).join(" ")}`, {
        timeoutMs: 10_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true,
      });
    }
  } catch {
    // Persistence remains usable if a storage implementation cannot rotate.
  }
}

export async function loadRecentAgentTrajectories(limit = 12): Promise<AgentTrajectory[]> {
  try {
    const listing = await executeSharedCommand(`ls -1t ${shellQuote(AGENT_SESSION_ROOT)}/run-*.json 2>/dev/null | head -${Math.max(1, Math.min(20, Math.floor(limit)))}`, {
      timeoutMs: 12_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true,
    });
    const paths = String(listing.stdout || "").split(/\r?\n/).map((x) => x.trim())
      .filter((p) => p.startsWith(`${AGENT_SESSION_ROOT}/run-`) && /^run-[a-z0-9_-]+\.json$/i.test(p.slice(AGENT_SESSION_ROOT.length + 1)));
    const out: AgentTrajectory[] = [];
    for (const path of paths) {
      try {
        const read = await executeSharedCommand(`cat -- ${shellQuote(path)}`, {
          timeoutMs: 8_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true,
        });
        const value = JSON.parse(String(read.stdout || ""));
        const safe = sanitizeAgentTrajectoryForPersistence(value);
        if (safe) out.push(safe as unknown as AgentTrajectory);
      } catch { /* skip malformed or inaccessible records */ }
    }
    return out;
  } catch {
    return [];
  }
}


export function trajectoryUsageSummary(
  trajectory: AgentTrajectory,
  language: "ru" | "uk" | "en" = "en",
): string {
  return formatUsageSummary(trajectory.usage, language);
}
