import { githubMaterializeRepo } from "../../github-tools";
import type { ToolArgs } from "../types";

export function validate(args: ToolArgs): string | null {
  if (!String(args.owner || "").trim() || !String(args.repo || "").trim()) return "GITHUB_REPO_REQUIRED";
  return null;
}

export function execute(args: ToolArgs) {
  return githubMaterializeRepo(
    String(args.owner),
    String(args.repo),
    String(args.ref || ""),
    String(args.destDir || ""),
  );
}
