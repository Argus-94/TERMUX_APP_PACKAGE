import { githubCreateIssue } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!String(args.title||"").trim()) return "GITHUB_ISSUE_TITLE_REQUIRED";
  return null;
}
export function execute(args: ToolArgs) {
  const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
  return githubCreateIssue(String(args.owner), String(args.repo), String(args.title), String(args.body||""), labels);
}
