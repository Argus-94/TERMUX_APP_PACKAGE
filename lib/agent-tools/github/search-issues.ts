import { githubSearchIssues } from "../../github-tools";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null { return typeof args.query==="string"&&args.query.trim()?null:"GITHUB_QUERY_REQUIRED"; }
export function execute(args: ToolArgs) { return githubSearchIssues(String(args.query)); }
