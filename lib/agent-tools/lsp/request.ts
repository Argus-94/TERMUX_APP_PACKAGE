import { runLspRequest } from "../../lsp";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  return /^textDocument\/(definition|references|hover|completion|rename)$|^workspace\/symbol$/.test(String(args.method || "")) ? null : "LSP_METHOD_NOT_ALLOWED";
}
export function execute(args: ToolArgs, projectPath?: string | null) { return runLspRequest(projectPath || undefined, String(args.method), args.params || {}); }
