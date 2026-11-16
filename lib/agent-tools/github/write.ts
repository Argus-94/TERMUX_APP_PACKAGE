import { githubWriteFile } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!String(args.branch||"").trim()) return "GITHUB_BRANCH_REQUIRED";
  if (!String(args.path||"").trim()) return "GITHUB_FILE_PATH_INVALID";
  if (typeof args.content !== "string") return "GITHUB_FILE_CONTENT_REQUIRED";
  return null;
}
export function execute(args: ToolArgs) {
  return githubWriteFile(String(args.owner), String(args.repo), String(args.branch), String(args.path), String(args.content), String(args.message||""), String(args.base||""));
}
