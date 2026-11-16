import { githubCreatePullRequest } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!String(args.title||"").trim() || !String(args.head||"").trim()) return "GITHUB_PR_FIELDS_REQUIRED";
  return null;
}
export function execute(args: ToolArgs) {
  return githubCreatePullRequest(String(args.owner), String(args.repo), String(args.title), String(args.head), String(args.base||""), String(args.body||""));
}
