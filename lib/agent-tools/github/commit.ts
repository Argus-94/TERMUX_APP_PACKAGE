import { githubGetCommit } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!/^[0-9a-fA-F]{7,40}$/.test(String(args.sha||"").trim())) return "GITHUB_COMMIT_SHA_INVALID";
  return null;
}
export function execute(args: ToolArgs) {
  return githubGetCommit(String(args.owner), String(args.repo), String(args.sha));
}
