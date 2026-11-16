import { executeGuardedTermuxCommand } from "../../termux-executor";
import { utf8ToBase64 } from "../../base64";
import { quote, safePath } from "../common";
import { guardHashlineCommand, requireProjectRoot } from "./path-guard";
import type { ToolArgs, ToolExecutionContext } from "../types";
export function validate(args: ToolArgs): string | null {
  const path = String(args.path || "");
  if (!path.trim()) return "PATH_REQUIRED";
  if (path.includes("\0") || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..")) return "PATH_NOT_ALLOWED";
  if (typeof args.content !== "string" || args.content.length > 500_000) return "CONTENT_REQUIRED_OR_TOO_LARGE";
  return null;
}
export function execute(args: ToolArgs, projectPath?: string | null, context?: ToolExecutionContext) {
  const path = safePath(String(args.path ?? ""));
  const workdir = requireProjectRoot(projectPath);
  const encoded = utf8ToBase64(String(args.content ?? ""));
  return executeGuardedTermuxCommand(guardHashlineCommand(path, `node scripts/aib-hashline.mjs create ${quote(path)} ${quote(encoded)}`), {
    workdir,
      traceId: context?.traceId, timeoutMs: 30_000,
  });
}
