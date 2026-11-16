import { executeGuardedTermuxCommand } from "../../termux-executor";
import { quote, safePath } from "../common";
import { guardHashlineCommand, requireProjectRoot } from "./path-guard";
import type { ToolArgs, ToolExecutionContext } from "../types";
export function validate(args: ToolArgs): string | null {
  const path = String(args.path || "");
  if (!path.trim()) return "PATH_REQUIRED";
  if (path.includes("\0") || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..")) return "PATH_NOT_ALLOWED";
  return null;
}
export function execute(args: ToolArgs, projectPath?: string | null, context?: ToolExecutionContext) {
  const path = safePath(String(args.path ?? ""));
  const workdir = requireProjectRoot(projectPath);
  return executeGuardedTermuxCommand(guardHashlineCommand(path, `node scripts/aib-hashline.mjs read ${quote(path)} ${Number(args.start || 1)} ${Number(args.end || 120)}`), {
    workdir,
      traceId: context?.traceId, timeoutMs: 30_000,
  });
}
