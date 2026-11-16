import { githubCopyFile } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!String(args.branch||"").trim()) return "GITHUB_BRANCH_REQUIRED";
  if (!String(args.from||"").trim() || !String(args.to||"").trim()) return "GITHUB_COPY_PATHS_INVALID";
  return null;
}
export function execute(args: ToolArgs) {
  return githubCopyFile(
    String(args.owner), String(args.repo), String(args.branch),
    String(args.from), String(args.to), String(args.message||""),
    args.deleteSource === true, String(args.base||""),
  );
}
