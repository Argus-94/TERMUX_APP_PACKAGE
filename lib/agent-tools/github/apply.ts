import { githubApplyFiles, type GithubFileChange } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!String(args.branch||"").trim()) return "GITHUB_BRANCH_REQUIRED";
  if (!String(args.message||"").trim()) return "GITHUB_COMMIT_MESSAGE_REQUIRED";
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 100) return "GITHUB_FILES_INVALID";
  return null;
}
export function execute(args: ToolArgs) {
  return githubApplyFiles(
    String(args.owner), String(args.repo), String(args.branch), String(args.message),
    args.files as GithubFileChange[], String(args.base||"")
  );
}
