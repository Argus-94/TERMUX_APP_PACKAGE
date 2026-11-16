import { astGrepSearch } from "../../ast-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null { return typeof args.pattern === "string" && args.pattern.trim() ? null : "AST_PATTERN_REQUIRED"; }
export function execute(args: ToolArgs, projectPath?: string | null) { return astGrepSearch(String(args.pattern), projectPath || undefined, typeof args.language === "string" ? args.language : undefined); }
