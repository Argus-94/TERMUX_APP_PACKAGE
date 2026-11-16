import { githubMergePullRequest } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  const n = Number(args.number);
  if (!Number.isInteger(n) || n < 1 || n > 999999) return "GITHUB_PR_NUMBER_REQUIRED";
  return null;
}
export function execute(args: ToolArgs) {
  const method = String(args.mergeMethod||"squash");
  const m = (method === "merge" || method === "rebase" || method === "squash") ? method : "squash";
  return githubMergePullRequest(String(args.owner), String(args.repo), Number(args.number), m, String(args.commitTitle||""));
}
