import { astGrepEdit } from "../../ast-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (typeof args.pattern !== "string" || !args.pattern.trim()) return "AST_PATTERN_REQUIRED";
  if (typeof args.rewrite !== "string" || !args.rewrite.trim()) return "AST_REWRITE_REQUIRED";
  if (args.updateAll !== undefined && typeof args.updateAll !== "boolean") return "AST_UPDATE_ALL_INVALID";
  return null;
}
export function execute(args: ToolArgs, projectPath?: string | null) { return astGrepEdit(String(args.pattern), String(args.rewrite), projectPath || undefined, typeof args.language === "string" ? args.language : undefined, args.updateAll !== false); }
