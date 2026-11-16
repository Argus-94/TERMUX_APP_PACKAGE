import { githubPackLocalDir } from "../../github-tools";
import type { ToolArgs } from "../types";

export function validate(args: ToolArgs): string | null {
  if (!String(args.sourceDir || "").trim()) return "GITHUB_PACK_SOURCE_REQUIRED";
  return null;
}

export function execute(args: ToolArgs) {
  return githubPackLocalDir(String(args.sourceDir), String(args.archivePath || ""));
}
