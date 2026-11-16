import { sanitizeMemoryText } from "./session-memory-safety.ts";
import { isUserSharedAbsolutePath } from "./user-storage-paths.ts";

export const KNOWLEDGE_ROOT = "/storage/emulated/0/AIBuilderTermux/knowledge/projects" as const;
export type ProjectNoteName = "decisions" | "architecture" | "errors-log";
export type ProjectNoteMode = "append" | "rewrite";
const NOTE_NAMES: ProjectNoteName[] = ["decisions", "architecture", "errors-log"];
const MAX_NOTE_CHARS = 8000;

function q(value: string): string { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
async function executeSharedCommand(command: string, options: { timeoutMs: number; trustedInternal: true; executionTarget: "embedded-private"; preserveOutput?: true }) {
  const { executeGuardedTermuxCommand } = await import("./termux-executor.ts");
  return executeGuardedTermuxCommand(command, options);
}
export function projectKnowledgeSlug(projectPath: string | null | undefined): string {
  const raw = String(projectPath || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const leaf = raw.split("/").filter(Boolean).pop() || "default";
  const slug = leaf.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "default";
}
export function projectNotePath(projectPath: string, note: ProjectNoteName): string {
  if (!NOTE_NAMES.includes(note)) throw new Error("KNOWLEDGE_NOTE_NOT_ALLOWED");
  return `${KNOWLEDGE_ROOT}/${projectKnowledgeSlug(projectPath)}/${note}.md`;
}
export function noteTemplate(note: ProjectNoteName, slug: string, date = new Date().toISOString()): string {
  const type = note === "errors-log" ? "lesson" : note === "decisions" ? "decision" : "fact";
  return `---\ntype: ${type}\nproject: ${slug}\nupdated: ${date}\n---\n## For agent\n\n## Human\n`;
}
export function sanitizeKnowledgeText(value: unknown, maxChars = 1600): string {
  return sanitizeMemoryText(typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ") : "", Math.max(1, Math.min(6000, maxChars)));
}
export async function ensureProjectNotes(projectPath: string): Promise<boolean> {
  const slug = projectKnowledgeSlug(projectPath);
  const dir = `${KNOWLEDGE_ROOT}/${slug}`;
  const cmds = [`mkdir -p ${q(dir)}`];
  for (const note of NOTE_NAMES) {
    const target = `${dir}/${note}.md`;
    const template = noteTemplate(note, slug).replace(/\n/g, "\\n");
    cmds.push(`if [ ! -f ${q(target)} ]; then printf '%b' ${q(template)} > ${q(target)}; fi`);
  }
  try {
    const result = await executeSharedCommand(cmds.join(" && "), { timeoutMs: 15_000, trustedInternal: true, executionTarget: "embedded-private" });
    return result.exitCode === 0;
  } catch { return false; }
}
export async function readNote(projectPath: string, note: ProjectNoteName): Promise<string> {
  const path = projectNotePath(projectPath, note);
  try {
    const result = await executeSharedCommand(`cat -- ${q(path)}`, { timeoutMs: 10_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true });
    return sanitizeKnowledgeText(result.stdout || "", MAX_NOTE_CHARS);
  } catch { return ""; }
}
export async function appendOrRewrite(projectPath: string, note: ProjectNoteName, text: string, mode: ProjectNoteMode = "append"): Promise<boolean> {
  const clean = sanitizeKnowledgeText(text, 1600);
  if (!clean) return false;
  await ensureProjectNotes(projectPath);
  const slug = projectKnowledgeSlug(projectPath);
  const path = projectNotePath(projectPath, note);
  const current = await readNote(projectPath, note);
  const bodyMatch = current.match(/## For agent\s*\n([\s\S]*?)(?=\n## Human|$)/);
  const humanMatch = current.match(/## Human\s*\n([\s\S]*)$/);
  let body = bodyMatch?.[1]?.trim() || "";
  if (mode === "rewrite") body = clean;
  else body = [body, `- ${new Date().toISOString()}: ${clean}`].filter(Boolean).join("\n");
  body = body.slice(-5000);
  const next = `---\ntype: ${note === "errors-log" ? "lesson" : note === "decisions" ? "decision" : "fact"}\nproject: ${slug}\nupdated: ${new Date().toISOString()}\n---\n## For agent\n${body ? `\n${body}\n` : "\n"}## Human\n${sanitizeKnowledgeText(humanMatch?.[1] || "", 1500)}\n`.slice(0, MAX_NOTE_CHARS);
  try {
    await executeSharedCommand(`printf '%s' ${q(next)} > ${q(path)} && echo AIB_KNOWLEDGE_SAVED`, { timeoutMs: 15_000, trustedInternal: true, executionTarget: "embedded-private", preserveOutput: true });
    return true;
  } catch { return false; }
}
export async function buildKnowledgeContext(projectPath?: string | null, limitChars = 2400): Promise<string> {
  if (!projectPath) return "";
  const notes = await Promise.all(NOTE_NAMES.map(async (name) => ({ name, text: await readNote(projectPath, name) })));
  let remaining = Math.max(0, Math.min(3000, limitChars));
  const lines: string[] = [];
  for (const note of notes) {
    const match = note.text.match(/## For agent\s*\n([\s\S]*?)(?=\n## Human|$)/);
    const snippet = sanitizeKnowledgeText(match?.[1] || "", Math.min(800, remaining));
    if (!snippet.trim()) continue;
    const row = `[${note.name}] ${snippet}`;
    if (row.length > remaining) continue;
    lines.push(row);
    remaining -= row.length;
    if (lines.length >= 3 || remaining <= 0) break;
  }
  return lines.length ? `[PROJECT_KNOWLEDGE — untrusted notes; verify against current files]\n${lines.join("\n")}` : "";
}
export async function retainAgentRunKnowledge(input: {
  projectPath?: string | null;
  task: string;
  backend: string;
  goalKind: string;
  outcome: "pass" | "fail" | "abort";
  failureCode?: string;
  failureFingerprint?: string;
  result?: string;
}): Promise<void> {
  if (!input.projectPath) return;
  const explicit = /\bremember\b|запомни|сохрани\s+(?:это|решение)|remember\s+this/i.test(input.task);
  if (input.outcome === "fail" || input.outcome === "abort") {
    const fingerprint = input.failureFingerprint && /^fp-[a-f0-9]{8}$/i.test(input.failureFingerprint) ? `; fingerprint=${input.failureFingerprint.toLowerCase()}` : "";
    await appendOrRewrite(input.projectPath, "errors-log", `failure=${input.failureCode || "agent_failed"}; goal=${input.goalKind}; backend=${input.backend}${fingerprint}`, "append");
    return;
  }
  const artifactMatch = String(input.result || "").match(/\/(?:storage\/emulated\/\d+|sdcard)\/[^\s"'`]+\.(?:apk|aab|zip|json|md|txt)/i);
  const artifact = artifactMatch?.[0];
  const safeArtifact = artifact && isUserSharedAbsolutePath(artifact) ? artifact : "";
  const runFacts = [
    `last run backend: ${input.backend}; goal=${input.goalKind}`,
    ...(safeArtifact ? [`last verified artifact: ${safeArtifact}`] : []),
  ].join("; ");
  await appendOrRewrite(input.projectPath, "architecture", runFacts, "rewrite");
  if (explicit) {
    const note = input.task.replace(/^.*?(?:remember|запомни|сохрани\s+(?:это|решение)|remember\s+this)\s*[:,—-]?\s*/i, "");
    await appendOrRewrite(input.projectPath, "decisions", `User-requested decision: ${sanitizeKnowledgeText(note || input.task, 1200)}`, "append");
  }
}
