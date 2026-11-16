import { githubDownloadReleaseAsset } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.owner||"").trim() || !String(args.repo||"").trim()) return "GITHUB_REPO_REQUIRED";
  if (!String(args.assetUrl||"").trim()) return "GITHUB_ASSET_URL_REQUIRED";
  return null;
}
export function execute(args: ToolArgs) {
  return githubDownloadReleaseAsset(String(args.owner), String(args.repo), String(args.assetUrl), String(args.destPath||""), String(args.fileName||""));
}
