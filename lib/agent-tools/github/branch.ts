import { githubCreateBranch } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(String(args.branch||"")) || String(args.branch).includes("..")) return "GITHUB_BRANCH_INVALID";
  return null;
}
export function execute(args: ToolArgs) { return githubCreateBranch(String(args.owner), String(args.repo), String(args.branch), String(args.base||"")); }
