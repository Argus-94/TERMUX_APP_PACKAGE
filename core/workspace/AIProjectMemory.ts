/** Phase 35: durable project memory for the AI coding/build loop. */
import type { HomeLayout } from "../home/HomeLayout";
import type { ExecutionEnvironment } from "../environment/ExecutionEnvironment";
import { validateProjectName } from "../project-manager";

export type ProjectMemoryEntry = {
  readonly at: string;
  readonly summary: string;
  readonly detail?: string;
};

export type AIProjectMemory = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly architecture: string;
  readonly dependencies: readonly string[];
  readonly conventions: readonly string[];
  readonly buildHistory: readonly ProjectMemoryEntry[];
  readonly knownErrors: readonly ProjectMemoryEntry[];
  readonly successfulFixes: readonly ProjectMemoryEntry[];
  readonly testHistory: readonly ProjectMemoryEntry[];
};

const MAX_ITEMS = 50;
const MAX_TEXT = 1200;
const SECRET_RE = /(api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi;

function clean(value: string, max = MAX_TEXT): string {
  return value.replace(SECRET_RE, "$1=[redacted]").trim().slice(0, max);
}
function projectPath(home: HomeLayout, id: string): string { return `${home.projects.replace(/[\\/]+$/, "")}/${validateProjectName(id)}`; }
function memoryPath(home: HomeLayout, id: string): string { return `${projectPath(home, id)}/.aib-memory/project-memory.json`; }
function unique(values: readonly string[]): string[] { return [...new Set(values.map((v) => clean(v, 500)).filter(Boolean))].slice(-MAX_ITEMS); }

export class AIProjectMemoryStore {
  constructor(private readonly environment: ExecutionEnvironment, private readonly home: HomeLayout) {}

  private async ensure(projectId: string): Promise<void> {
    const id = validateProjectName(projectId);
    const path = projectPath(this.home, id);
    await this.environment.mkdir(path);
    await this.environment.mkdir(`${path}/.aib-memory`);
  }

  async get(projectId: string): Promise<AIProjectMemory> {
    const id = validateProjectName(projectId);
    await this.ensure(id);
    const path = memoryPath(this.home, id);
    if (await this.environment.exists(path)) {
      let parsed: Partial<AIProjectMemory>;
      try {
        parsed = JSON.parse(await this.environment.read(path)) as Partial<AIProjectMemory>;
      } catch {
        throw new Error("PROJECT_MEMORY_INVALID_JSON");
      }
      if (parsed.schemaVersion !== 1) {
        throw new Error(`PROJECT_MEMORY_UNSUPPORTED_SCHEMA:${String(parsed.schemaVersion ?? "missing")}`);
      }
      if (parsed.projectId !== id) throw new Error("PROJECT_MEMORY_PROJECT_MISMATCH");
      const normalized = this.normalize(parsed, id);
      if (JSON.stringify(normalized) !== JSON.stringify(parsed)) await this.save(normalized);
      return normalized;
    }
    const memory = this.empty(id);
    await this.save(memory);
    return memory;
  }

  async save(memory: AIProjectMemory): Promise<void> {
    await this.ensure(memory.projectId);
    await this.environment.write(memoryPath(this.home, memory.projectId), JSON.stringify(memory, null, 2));
  }

  async setArchitecture(projectId: string, architecture: string): Promise<AIProjectMemory> {
    const m = await this.get(projectId); const next = { ...m, architecture: clean(architecture, 4000), updatedAt: new Date().toISOString() }; await this.save(next); return next;
  }

  async setDependencies(projectId: string, dependencies: readonly string[]): Promise<AIProjectMemory> {
    const m = await this.get(projectId); const next = { ...m, dependencies: unique(dependencies), updatedAt: new Date().toISOString() }; await this.save(next); return next;
  }

  async setConventions(projectId: string, conventions: readonly string[]): Promise<AIProjectMemory> {
    const m = await this.get(projectId); const next = { ...m, conventions: unique(conventions), updatedAt: new Date().toISOString() }; await this.save(next); return next;
  }

  async recordBuild(projectId: string, summary: string, detail = ""): Promise<AIProjectMemory> { return this.append(projectId, "buildHistory", summary, detail); }
  async recordError(projectId: string, summary: string, detail = ""): Promise<AIProjectMemory> { return this.append(projectId, "knownErrors", summary, detail); }
  async recordFix(projectId: string, summary: string, detail = ""): Promise<AIProjectMemory> { return this.append(projectId, "successfulFixes", summary, detail); }
  async recordTest(projectId: string, summary: string, detail = ""): Promise<AIProjectMemory> { return this.append(projectId, "testHistory", summary, detail); }

  async context(projectId: string): Promise<string> {
    const m = await this.get(projectId);
    return JSON.stringify({ architecture: m.architecture, dependencies: m.dependencies, conventions: m.conventions, recentBuilds: m.buildHistory.slice(-8), knownErrors: m.knownErrors.slice(-8), successfulFixes: m.successfulFixes.slice(-8), recentTests: m.testHistory.slice(-8) });
  }

  async reset(projectId: string): Promise<AIProjectMemory> { const memory = this.empty(validateProjectName(projectId)); await this.save(memory); return memory; }

  private async append(projectId: string, key: "buildHistory" | "knownErrors" | "successfulFixes" | "testHistory", summary: string, detail: string): Promise<AIProjectMemory> {
    const m = await this.get(projectId); const entry = { at: new Date().toISOString(), summary: clean(summary), detail: clean(detail) || undefined };
    const next = { ...m, [key]: [...m[key], entry].slice(-MAX_ITEMS), updatedAt: entry.at } as AIProjectMemory; await this.save(next); return next;
  }

  private empty(projectId: string): AIProjectMemory { return { schemaVersion: 1, projectId, updatedAt: new Date().toISOString(), architecture: "", dependencies: [], conventions: [], buildHistory: [], knownErrors: [], successfulFixes: [], testHistory: [] }; }
  private normalize(input: Partial<AIProjectMemory>, id: string): AIProjectMemory {
    const e = (v: unknown): ProjectMemoryEntry[] => Array.isArray(v)
      ? v.filter((x): x is ProjectMemoryEntry => !!x && typeof x === "object" && typeof (x as ProjectMemoryEntry).summary === "string")
        .slice(-MAX_ITEMS)
        .map((x) => ({ at: typeof x.at === "string" ? x.at.slice(0, 80) : new Date().toISOString(), summary: clean(x.summary), detail: typeof x.detail === "string" ? clean(x.detail) || undefined : undefined }))
      : [];
    return {
      schemaVersion: 1,
      projectId: id,
      updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
      architecture: typeof input.architecture === "string" ? clean(input.architecture, 4000) : "",
      dependencies: unique(Array.isArray(input.dependencies) ? input.dependencies.map(String) : []),
      conventions: unique(Array.isArray(input.conventions) ? input.conventions.map(String) : []),
      buildHistory: e(input.buildHistory), knownErrors: e(input.knownErrors), successfulFixes: e(input.successfulFixes), testHistory: e(input.testHistory),
    };
  }
}

export function createAIProjectMemory(environment: ExecutionEnvironment, home: HomeLayout): AIProjectMemoryStore { return new AIProjectMemoryStore(environment, home); }
