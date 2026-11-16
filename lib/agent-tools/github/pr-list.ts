import { githubListPulls } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  return String(args.owner||"").trim() && String(args.repo||"").trim() ? null : "GITHUB_REPO_REQUIRED";
}
export function execute(args: ToolArgs) {
  return githubListPulls(String(args.owner), String(args.repo), String(args.state||"open"), Number(args.page||1), Number(args.perPage||30));
}
