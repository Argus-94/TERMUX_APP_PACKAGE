/**
 * Phase 28: AI Workspace Builder.
 * Orchestrates a bounded project workflow inside a Phase 27 proot container.
 * It never owns or deletes host projects; the workspace is an explicit mount.
 */
import type { ContainerExecResult } from "../container/ProotContainerManager";
import type { ProotContainerManager } from "../container/ProotContainerManager";

export type WorkspaceBuildTemplate = "node" | "expo" | "python";
export type WorkspaceBuildPlan = {
  readonly template: WorkspaceBuildTemplate;
  readonly install?: boolean;
  readonly build?: boolean;
  readonly test?: boolean;
  readonly timeoutMs?: number;
};

export type WorkspaceStep = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly ok: boolean;
};

export type WorkspaceBuildResult = {
  readonly ok: boolean;
  readonly template: WorkspaceBuildTemplate;
  readonly containerId: string;
  readonly workspace: string;
  readonly steps: readonly WorkspaceStep[];
  readonly failedStep?: string;
  readonly startedAt: number;
  readonly finishedAt: number;
};

const MAX_TOTAL_TIMEOUT_MS = 20 * 60_000;
const MAX_STEP_TIMEOUT_MS = 10 * 60_000;

function clampTimeout(value: number | undefined): number {
  return Math.min(MAX_STEP_TIMEOUT_MS, Math.max(5_000, value ?? 120_000));
}

function stepFrom(name: string, command: string, args: readonly string[], result: ContainerExecResult): WorkspaceStep {
  return {
    name, command, args: [...args], exitCode: result.exitCode, stdout: result.stdout.slice(-12_000),
    stderr: result.stderr.slice(-12_000), durationMs: result.durationMs, ok: result.exitCode === 0,
  };
}

function planSteps(plan: WorkspaceBuildPlan): Array<{ name: string; command: string; args: string[] }> {
  const steps: Array<{ name: string; command: string; args: string[] }> = [];
  if (plan.template === "node" || plan.template === "expo") {
    if (plan.install !== false) steps.push({ name: "install", command: "pnpm", args: ["install", "--ignore-scripts"] });
    if (plan.template === "expo" && plan.build) steps.push({ name: "expo-check", command: "npx", args: ["expo", "config", "--json"] });
    if (plan.build) steps.push({ name: "build", command: "pnpm", args: ["run", "build"] });
    if (plan.test) steps.push({ name: "test", command: "pnpm", args: ["test"] });
  } else {
    if (plan.install !== false) steps.push({ name: "install", command: "python3", args: ["-m", "pip", "install", "-r", "requirements.txt", "--disable-pip-version-check"] });
    if (plan.build) steps.push({ name: "compile", command: "python3", args: ["-m", "compileall", "-q", "."] });
    if (plan.test) steps.push({ name: "test", command: "python3", args: ["-m", "pytest", "-q"] });
  }
  return steps;
}

export class AIWorkspaceBuilder {
  constructor(private readonly containers: ProotContainerManager) {}

  async run(containerId: string, plan: WorkspaceBuildPlan): Promise<WorkspaceBuildResult> {
    const startedAt = Date.now();
    const deadline = startedAt + Math.min(MAX_TOTAL_TIMEOUT_MS, Math.max(10_000, plan.timeoutMs ?? 10 * 60_000));
    const steps: WorkspaceStep[] = [];
    const template = plan.template;
    for (const item of planSteps(plan)) {
      const remaining = deadline - Date.now();
      if (remaining < 5_000) {
        return { ok: false, template, containerId, workspace: "/workspace", steps, failedStep: "timeout", startedAt, finishedAt: Date.now() };
      }
      const result = await this.containers.exec(containerId, item.command, item.args, {
        cwd: "/workspace", timeoutMs: Math.min(clampTimeout(plan.timeoutMs), remaining),
      });
      const step = stepFrom(item.name, item.command, item.args, result);
      steps.push(step);
      if (!step.ok) {
        return { ok: false, template, containerId, workspace: "/workspace", steps, failedStep: item.name, startedAt, finishedAt: Date.now() };
      }
    }
    return { ok: true, template, containerId, workspace: "/workspace", steps, startedAt, finishedAt: Date.now() };
  }
}

export function createAIWorkspaceBuilder(containers: ProotContainerManager): AIWorkspaceBuilder {
  return new AIWorkspaceBuilder(containers);
}
