import { githubReadUri, githubReadFile } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (String(args.uri||"").trim()) {
    return /^(?:github:\/\/|https:\/\/github\.com\/)/i.test(String(args.uri)) ? null : "GITHUB_URI_REQUIRED";
  }
  if (String(args.owner||"").trim() && String(args.repo||"").trim() && String(args.path||"").trim()) return null;
  return "GITHUB_URI_OR_OWNER_REPO_PATH_REQUIRED";
}
export function execute(args: ToolArgs) {
  if (String(args.uri||"").trim()) return githubReadUri(String(args.uri));
  return githubReadFile(String(args.owner), String(args.repo), String(args.path), String(args.ref||"HEAD"));
}
