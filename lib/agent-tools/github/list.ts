import { githubRepoList } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null { return String(args.owner||"").trim()&&String(args.repo||"").trim()?null:"GITHUB_REPO_REQUIRED"; }
export function execute(args: ToolArgs) { return githubRepoList(String(args.owner),String(args.repo),String(args.path||""),String(args.ref||"HEAD")); }
