import { parseGithubRepoRef } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  return String(args.text||args.url||"").trim() ? null : "GITHUB_PARSE_TEXT_REQUIRED";
}
export function execute(args: ToolArgs) {
  const parsed = parseGithubRepoRef(String(args.text||args.url||""));
  if (!parsed) throw new Error("GITHUB_PARSE_FAILED");
  return parsed;
}
