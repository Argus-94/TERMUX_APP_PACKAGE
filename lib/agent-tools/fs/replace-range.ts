import { executeGuardedTermuxCommand } from "../../termux-executor";
import { quote, safePath } from "../common";
import { guardHashlineCommand, requireProjectRoot } from "./path-guard";
import type { ToolArgs, ToolExecutionContext } from "../types";
export function validate(args: ToolArgs): string | null {
  const path = String(args.path || "");
  if (!path.trim()) return "PATH_REQUIRED";
  if (path.includes("\0") || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..")) return "PATH_NOT_ALLOWED";
  if (!args.hashStart || !args.hashEnd) return "HASH_REQUIRED";
  if (!Number.isInteger(Number(args.start)) || !Number.isInteger(Number(args.end)) || Number(args.start) < 1 || Number(args.end) < Number(args.start) || typeof args.replacement !== "string") return "REPLACE_RANGE_ARGS_INVALID";
  if (Number(args.end) - Number(args.start) > 5000) return "REPLACE_RANGE_TOO_WIDE";
  if (String(args.replacement).length > 100_000) return "REPLACEMENT_TOO_LARGE";
  return null;
}
export function execute(args: ToolArgs, projectPath?: string | null, context?: ToolExecutionContext) {
  const path = safePath(String(args.path ?? ""));
  const workdir = requireProjectRoot(projectPath);
  return executeGuardedTermuxCommand(guardHashlineCommand(path, `node scripts/aib-hashline.mjs replace-range ${quote(path)} ${Number(args.start)} ${Number(args.end)} ${quote(String(args.hashStart))} ${quote(String(args.hashEnd))} ${quote(String(args.replacement ?? ""))}`), {
    workdir,
      traceId: context?.traceId, timeoutMs: 30_000,
  });
}
