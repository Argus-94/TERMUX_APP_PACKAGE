import { githubGetRelease } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!String(args.tag||args.id||"").trim()) return "GITHUB_RELEASE_REF_REQUIRED";
  return null;
}
export function execute(args: ToolArgs) {
  return githubGetRelease(String(args.owner), String(args.repo), String(args.tag||args.id));
}
