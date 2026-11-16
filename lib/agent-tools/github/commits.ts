import { githubListCommits } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  return String(args.owner||"").trim() && String(args.repo||"").trim() ? null : "GITHUB_REPO_REQUIRED";
}
export function execute(args: ToolArgs) {
  return githubListCommits(String(args.owner), String(args.repo), String(args.ref||""), String(args.path||""), Number(args.page||1), Number(args.perPage||30));
}
