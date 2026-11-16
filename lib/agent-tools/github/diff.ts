import { githubRepoDiff } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if(!String(args.owner||"").trim()||!String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if(!String(args.base||"").trim()||!String(args.head||"").trim()) return "GITHUB_REFS_REQUIRED";
  return null;
}
export function execute(args: ToolArgs) { return githubRepoDiff(String(args.owner),String(args.repo),String(args.base),String(args.head)); }
