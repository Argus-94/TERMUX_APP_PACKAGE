import { executeGuardedTermuxCommand } from "./termux-executor";
import type { AgentTranscriptTurn } from "./termux-agent";

export interface ReviewFinding { severity: "P0"|"P1"|"P2"|"P3"; confidence: number; message: string; }

export async function collectProjectReview(projectPath?: string | null) {
  const cwd = projectPath || undefined;
  const r = await executeGuardedTermuxCommand(
    "command -v git >/dev/null 2>&1 || { echo GIT_UNAVAILABLE; exit 0; }; git diff --check; printf '\\n---DIFF---\\n'; git diff --stat; printf '\\n---PATCH---\\n'; git diff --unified=3 | head -n 16000; printf '\\n---STATUS---\\n'; git status --short",
    { workdir: cwd, timeoutMs: 60000, trustedInternal: true }
  );
  const findings: ReviewFinding[] = [];
  const raw = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
  if (/GIT_UNAVAILABLE/i.test(raw)) {
    findings.push({ severity: "P3", confidence: 0.99, message: "git not installed — diff/status skipped (optional: pkg install git)." });
    return { verdict: "SHIP" as const, findings, raw };
  }
  if (r.exitCode !== 0) findings.push({ severity:"P1", confidence:0.99, message:(r.stderr||r.stdout||"git review failed").slice(0,500) });
  if (/whitespace errors/i.test(r.stdout||"")) findings.push({severity:"P2",confidence:0.99,message:"Git diff contains whitespace errors."});
  return { verdict: findings.some(f=>f.severity==="P0"||f.severity==="P1") ? "CHANGES_REQUIRED" : "SHIP", findings, raw } as const;
}

export interface AIReviewer { askModel(history: AgentTranscriptTurn[]): Promise<string>; }

export async function aiReviewProject(input: {
  task: string;
  result: string;
  projectPath?: string | null;
  staticReview: Awaited<ReturnType<typeof collectProjectReview>>;
  diagnostics?: { available: boolean; exitCode: number; output: string } | null;
}, model: AIReviewer): Promise<string> {
  const prompt = `You are an independent final code reviewer. Do not modify files. Review the completed agent task and evidence. Return ONLY concise findings in this format:\nVERDICT: SHIP|CHANGES_REQUIRED|BLOCKED\nP0: ...\nP1: ...\nP2: ...\nP3: ...\nIf a severity has no finding, omit that line. Never invent evidence. When a durable project-specific fact/decision/lesson is supported by the evidence, you may add one line formatted [MEMORY fact] ..., [MEMORY decision] ..., or [MEMORY lesson] ....\nTASK: ${input.task}\nAGENT RESULT: ${input.result}\nSTATIC REVIEW: ${JSON.stringify(input.staticReview)}\nDIFF EVIDENCE IS IN STATIC REVIEW.raw; use it and do not invent changes.\nTSC/LSP: ${JSON.stringify(input.diagnostics || null)}`;
  return (await model.askModel([{role:"user", content:prompt}])).trim();
}
