/**
 * ctx.compose — task-oriented context preload (LeanCTX-inspired).
 * Returns keywords + ranked project-relative paths to read first.
 */
import { executeGuardedTermuxCommand } from "../../termux-executor";
import { composeContext } from "../../context-engine";
import type { ToolArgs, ToolExecutionContext } from "../types";

export function validate(args: ToolArgs): string | null {
  if (typeof args.task !== "string" || !String(args.task).trim()) return "CTX_COMPOSE_TASK_REQUIRED";
  return null;
}

export async function execute(args: ToolArgs, projectPath?: string | null, context?: ToolExecutionContext) {
  const task = String(args.task || "").slice(0, 800);
  let fileList: string[] = [];
  try {
    const listing = await executeGuardedTermuxCommand(
      `find . -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.kt' -o -name '*.java' -o -name '*.py' -o -name '*.gradle' -o -name '*.json' -o -name '*.xml' -o -name '*.md' \\) ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/build/*' 2>/dev/null | head -200`,
      { workdir: projectPath || undefined,
      traceId: context?.traceId, timeoutMs: 20_000 },
    );
    const text =
      typeof listing === "string"
        ? listing
        : typeof (listing as { stdout?: string })?.stdout === "string"
          ? (listing as { stdout: string }).stdout
          : "";
    fileList = text
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter(Boolean)
      .slice(0, 200);
  } catch {
    fileList = [];
  }

  const result = composeContext(task, fileList);
  return {
    ok: true,
    task: result.task,
    keywords: result.keywords,
    suggestedPaths: result.suggestedPaths,
    notes: result.notes,
    hint: "Next: fs.read path=<suggested> mode=signatures|map, then full only for files you edit.",
  };
}
