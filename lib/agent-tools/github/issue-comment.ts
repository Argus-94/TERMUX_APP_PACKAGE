import { githubCommentIssue } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  const n = Number(args.number);
  if (!Number.isInteger(n) || n < 1 || n > 999999) return "GITHUB_ISSUE_NUMBER_REQUIRED";
  if (!String(args.body||"").trim()) return "GITHUB_COMMENT_BODY_REQUIRED";
  return null;
}
export function execute(args: ToolArgs) {
  return githubCommentIssue(String(args.owner), String(args.repo), Number(args.number), String(args.body));
}
