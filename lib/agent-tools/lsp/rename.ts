import { lspRename } from "../../lsp";
import { safePath } from "../common";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  const path=String(args.path||"");
  if(!path.trim()) return "PATH_REQUIRED";
  if(path.includes("\0") || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..")) return "PATH_NOT_ALLOWED";
  if(!Number.isInteger(Number(args.line))||!Number.isInteger(Number(args.character))||Number(args.line)<0||Number(args.character)<0) return "LSP_POSITION_INVALID";
  if(typeof args.newName!=="string"||!/^[A-Za-z_$][\w$]*$/.test(args.newName)) return "LSP_NEW_NAME_INVALID";
  return null;
}
export function execute(args: ToolArgs, projectPath?: string|null) { return lspRename(projectPath||undefined,safePath(String(args.path)),{line:Number(args.line)||0,character:Number(args.character)||0},String(args.newName||"")); }
