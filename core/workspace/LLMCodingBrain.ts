/**
 * Phase 31: LLM Coding Brain.
 * Uses the already configured OpenAI-compatible provider, but the model can
 * only propose structured file edits. The existing AICodingAgent remains the
 * enforcement boundary: path, size, iteration and build/test limits are still
 * applied before any edit reaches the workspace.
 */
import { customProviderEngine, type ChatMessage } from "../../lib/custom-provider";
import type { ProotContainerManager } from "../container/ProotContainerManager";
import type { CodingPlan, CodingPlanProvider, CodingPlannerContext } from "./AICodingAgent";

const MAX_CONTEXT_BYTES = 120_000;
const MAX_FILE_BYTES = 12_000;
const MAX_FILES = 24;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 80))}\n...[truncated]`;
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  throw new Error("LLM_CODING_JSON_NOT_FOUND");
}

export function parseCodingPlan(text: string): CodingPlan {
  const raw = JSON.parse(extractJson(text)) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("LLM_CODING_PLAN_INVALID");
  const value = raw as { summary?: unknown; edits?: unknown };
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("LLM_CODING_SUMMARY_INVALID");
  if (!Array.isArray(value.edits)) throw new Error("LLM_CODING_EDITS_INVALID");
  const edits = value.edits.map((item) => {
    if (!item || typeof item !== "object") throw new Error("LLM_CODING_EDIT_INVALID");
    const e = item as { path?: unknown; content?: unknown };
    if (typeof e.path !== "string" || typeof e.content !== "string") throw new Error("LLM_CODING_EDIT_INVALID");
    return { path: e.path, content: e.content };
  });
  return { summary: value.summary, edits };
}

function isSensitivePath(relative: string): boolean {
  const p = relative.replace(/\\/g, "/");
  const lower = p.toLowerCase();
  if (lower.startsWith(".git/") || lower.startsWith(".aib-snapshots/") || lower.startsWith(".aib-memory/")) return true;
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (/(^|\/)(?:local\.properties|.*(?:secret|credential|private).*)$/i.test(lower)) return true;
  if (/\.(pem|key|p12|jks|keystore|der)$/i.test(lower)) return true;
  if (/(google-services\.json|service-account.*\.json|credentials.*\.json)$/i.test(lower)) return true;
  return false;
}

function redactWorkspaceSecrets(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*["']?)[^\s,"'&}]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "sk-[REDACTED]");
}

function buildSystemPrompt(): string {
  return [
    "You are the coding brain inside a mobile AI development environment.",
    "Return ONLY a JSON object with: summary:string, edits:[{path:string,content:string}].",
    "Do not use markdown. Do not include shell commands. Do not request arbitrary file access.",
    "Each edit must contain the COMPLETE desired file content, not a patch.",
    "Use relative paths only. Never use absolute paths or '..'.",
    "Prefer the smallest safe set of edits. Preserve unrelated behavior.",
    "If the build/test result is already successful, return an empty edits array.",
  ].join(" ");
}

export class LLMCodingBrain {
  constructor(private readonly containers: ProotContainerManager) {}

  isReady(): boolean {
    return customProviderEngine.getReady();
  }

  async plan(context: CodingPlannerContext, containerId: string): Promise<CodingPlan> {
    if (!this.isReady()) throw new Error("LLM_CODING_PROVIDER_NOT_READY");
    const workspace = await this.collectWorkspace(containerId);
    const previous = context.previousBuild
      ? JSON.stringify(context.previousBuild).slice(0, 36_000)
      : "No previous build result; implement the requested goal.";
    const userPrompt = [
      `Project: ${context.name}`,
      `Template: ${context.template}`,
      `Goal: ${redactWorkspaceSecrets(context.goal)}`,
      `Iteration: ${context.iteration}`,
      "Previous build/test result:",
      redactWorkspaceSecrets(previous),
      "Persistent project memory:",
      redactWorkspaceSecrets(context.memoryContext || "No project memory recorded yet."),
      "Workspace file snapshot:",
      workspace,
      "Produce the smallest complete-file edits needed for the goal or repair.",
    ].join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: userPrompt },
    ];
    const response = await customProviderEngine.chat(messages, {
      temperature: 0.1,
      maxTokens: 12_000,
      topP: 0.9,
    });
    return parseCodingPlan(response);
  }

  private async collectWorkspace(containerId: string): Promise<string> {
    const listing = await this.containers.exec(containerId, "find", ["/workspace", "-maxdepth", "3", "-type", "f", "-print"], { cwd: "/workspace", timeoutMs: 20_000 });
    if (listing.exitCode !== 0) return `find failed: ${clip(listing.stderr, 2000)}`;
    const files = listing.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/workspace/") && line.length < 260)
      .map((line) => ({ absolute: line, relative: line.slice("/workspace/".length) }))
      .filter((entry) => !isSensitivePath(entry.relative))
      .slice(0, MAX_FILES);
    const chunks: string[] = [];
    let total = 0;
    for (const file of files) {
      if (total >= MAX_CONTEXT_BYTES) break;
      const read = await this.containers.exec(containerId, "cat", [file.absolute], { cwd: "/workspace", timeoutMs: 10_000 });
      if (read.exitCode !== 0) continue;
      const content = redactWorkspaceSecrets(clip(read.stdout, MAX_FILE_BYTES));
      const relative = file.relative;
      const chunk = `FILE: ${relative}\n${content}`;
      if (total + chunk.length > MAX_CONTEXT_BYTES) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    return chunks.length ? chunks.join("\n\n---\n\n") : "(workspace is empty or unreadable)";
  }
}

export function createLLMCodingBrain(containers: ProotContainerManager): LLMCodingBrain {
  return new LLMCodingBrain(containers);
}
