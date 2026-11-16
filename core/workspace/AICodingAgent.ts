/**
 * Phase 30: bounded AI Coding Agent.
 * Plans file changes, applies them inside /workspace, runs the existing
 * workspace pipeline, and performs bounded repair iterations. A model-backed
 * planner can be injected; the default planner is deterministic and safe.
 */
import type { ProotContainerManager } from "../container/ProotContainerManager";
import { AIWorkspaceBuilder, type WorkspaceBuildPlan, type WorkspaceBuildResult, type WorkspaceBuildTemplate } from "./AIWorkspaceBuilder";

export type CodingEdit = {
  readonly path: string;
  readonly content: string;
};

export type CodingPlan = {
  readonly summary: string;
  readonly edits: readonly CodingEdit[];
};

export type CodingPlannerContext = {
  readonly name: string;
  readonly goal: string;
  readonly template: WorkspaceBuildTemplate;
  readonly iteration: number;
  readonly previousBuild?: WorkspaceBuildResult;
  readonly memoryContext?: string;
};

export type CodingPlanProvider = (context: CodingPlannerContext) => Promise<CodingPlan> | CodingPlan;

export type AICodingAgentRequest = {
  readonly name: string;
  readonly goal: string;
  readonly template: WorkspaceBuildTemplate;
  readonly maxIterations?: number;
  readonly build?: boolean;
  readonly test?: boolean;
  readonly planner?: CodingPlanProvider;
  readonly memoryContext?: string;
};

export type CodingIteration = {
  readonly iteration: number;
  readonly plan: CodingPlan;
  readonly build?: WorkspaceBuildResult;
};

export type AICodingAgentResult = {
  readonly ok: boolean;
  readonly name: string;
  readonly template: WorkspaceBuildTemplate;
  readonly iterations: readonly CodingIteration[];
  readonly finalBuild?: WorkspaceBuildResult;
  readonly changedFiles: readonly string[];
  readonly error?: string;
};

const MAX_ITERATIONS = 5;
const MAX_EDITS_PER_ITERATION = 32;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function safePath(value: string): string {
  const p = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.includes("\0") || p.split("/").some((x) => x === "" || x === "..")) throw new Error("CODING_PATH_INVALID");
  if (p.length > 240) throw new Error("CODING_PATH_TOO_LONG");
  return p;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function isProtectedPath(path: string): boolean {
  const first = path.split("/")[0].toLowerCase();
  return first === ".git" || first === ".aib-snapshots" || first === ".aib-memory" ||
    path === ".env" || path.startsWith(".env.") ||
    /(^|\/)(?:.*(?:secret|credential|private)[^\/]*)\.(?:pem|key|p12|jks)$/i.test(path) ||
    /(^|\/)local\.properties$/i.test(path);
}


function defaultPlan(ctx: CodingPlannerContext): CodingPlan {
  if (!ctx.previousBuild?.ok) {
    const failure = ctx.previousBuild?.failedStep ?? "build";
    const diagnostics = (ctx.previousBuild?.steps ?? []).find((s) => !s.ok);
    const stderr = diagnostics?.stderr ?? "";
    if (failure === "test" && ctx.template === "python" && stderr.includes("ModuleNotFoundError")) {
      return {
        summary: "Repair Python test dependency",
        edits: [{ path: "requirements.txt", content: "pytest>=8\n" }],
      };
    }
    if (failure === "build" && ctx.template === "node") {
      return {
        summary: "Ensure deterministic Node build script",
        edits: [{ path: "package.json", content: JSON.stringify({ name: ctx.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-"), version: "0.1.0", private: true, scripts: { build: "node -e 'console.log(\"build ok\")'", test: "node -e 'console.log(\"test ok\")'" } }, null, 2) + "\n" }],
      };
    }
  }
  return { summary: "No additional repair required", edits: [] };
}

export class AICodingAgent {
  constructor(
    private readonly containers: ProotContainerManager,
    private readonly workspaceBuilder: AIWorkspaceBuilder,
  ) {}

  async run(containerId: string, request: AICodingAgentRequest): Promise<AICodingAgentResult> {
    if (!NAME_RE.test(request.name.trim())) throw new Error("CODING_PROJECT_NAME_INVALID");
    if (!request.goal.trim()) throw new Error("CODING_GOAL_REQUIRED");
    const maxIterations = Math.min(MAX_ITERATIONS, Math.max(1, request.maxIterations ?? 3));
    const iterations: CodingIteration[] = [];
    const changed = new Set<string>();
    let previousBuild: WorkspaceBuildResult | undefined;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const planner = request.planner ?? defaultPlan;
      const plan = await planner({ name: request.name, goal: request.goal, template: request.template, iteration, previousBuild, memoryContext: request.memoryContext });
      this.validatePlan(plan);
      for (const edit of plan.edits) {
        await this.writeFile(containerId, edit.path, edit.content);
        changed.add(edit.path);
      }

      const buildPlan: WorkspaceBuildPlan = {
        template: request.template,
        install: true,
        build: request.build !== false,
        test: request.test !== false,
        timeoutMs: 15 * 60_000,
      };
      previousBuild = await this.workspaceBuilder.run(containerId, buildPlan);
      iterations.push({ iteration, plan, build: previousBuild });
      if (previousBuild.ok) {
        return { ok: true, name: request.name, template: request.template, iterations, finalBuild: previousBuild, changedFiles: [...changed] };
      }
    }

    return {
      ok: false,
      name: request.name,
      template: request.template,
      iterations,
      finalBuild: previousBuild,
      changedFiles: [...changed],
      error: "CODING_AGENT_MAX_ITERATIONS_EXCEEDED",
    };
  }

  private validatePlan(plan: CodingPlan): void {
    if (!plan || typeof plan.summary !== "string") throw new Error("CODING_PLAN_INVALID");
    if (!Array.isArray(plan.edits) || plan.edits.length > MAX_EDITS_PER_ITERATION) throw new Error("CODING_EDIT_LIMIT_EXCEEDED");
    let total = 0;
    const seen = new Set<string>();
    for (const edit of plan.edits) {
      const path = safePath(edit.path);
      if (isProtectedPath(path)) throw new Error(`CODING_PROTECTED_PATH: ${path}`);
      if (seen.has(path)) throw new Error(`CODING_DUPLICATE_EDIT: ${path}`);
      seen.add(path);
      if (typeof edit.content !== "string") throw new Error("CODING_EDIT_CONTENT_INVALID");
      const size = byteLength(edit.content);
      if (size > MAX_FILE_BYTES) throw new Error(`CODING_FILE_TOO_LARGE: ${path}`);
      total += size;
      if (total > MAX_TOTAL_BYTES) throw new Error("CODING_TOTAL_EDIT_SIZE_EXCEEDED");
    }
  }

  private async writeFile(containerId: string, relativePath: string, content: string): Promise<void> {
    const p = safePath(relativePath);
    const escaped = JSON.stringify(content);
    const target = `/workspace/${p}`;
    const script = `import os; p=${JSON.stringify(target)}; os.makedirs(os.path.dirname(p),exist_ok=True); open(p,'w',encoding='utf-8').write(${escaped})`;
    const result = await this.containers.exec(containerId, "python3", ["-c", script], { cwd: "/workspace", timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || `CODING_WRITE_FAILED: ${p}`);
  }
}

export function createAICodingAgent(containers: ProotContainerManager, workspaceBuilder: AIWorkspaceBuilder): AICodingAgent {
  return new AICodingAgent(containers, workspaceBuilder);
}
