import { githubPullRequestFiles } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  const owner = String(args.owner||"").trim();
  const repo = String(args.repo||"").trim();
  if(!owner||!repo) return "GITHUB_REPO_REQUIRED";
  if(!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(owner) || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(repo)) return "GITHUB_REPO_INVALID";
  const n = Number(args.number);
  return Number.isInteger(n)&&n>=1&&n<=999999?null:"GITHUB_PR_NUMBER_REQUIRED";
}
export function execute(args: ToolArgs) { return githubPullRequestFiles(String(args.owner),String(args.repo),Number(args.number)); }
