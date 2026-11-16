import type { ToolArgs } from "./types";

// Deliberately explicit: github.release/repo/commit/etc. are read operations here.
export const GITHUB_MUTATION_TOOLS = new Set([
  "github.repoCreate",
  "github.branch",
  "github.apply",
  "github.prCreate",
  "github.prMerge",
  "github.issueCreate",
  "github.issueComment",
  "github.rename",
  "github.write",
  "github.copy",
]);
export function isGithubMutationTool(name: string): boolean {
  return GITHUB_MUTATION_TOOLS.has(name);
}
export function githubMutationTarget(name: string, args: ToolArgs): string {
  const repo = [String(args.owner || "").trim(), String(args.repo || "").trim()].filter(Boolean).join("/");
  switch (name) {
    case "github.repoCreate": return `${String(args.owner || "(authenticated user)")}/${String(args.name || args.repo || "(unnamed)")}`;
    case "github.branch": return `${repo} branch ${String(args.branch || "")}`;
    case "github.apply": return `${repo} branch ${String(args.branch || "")} (${Array.isArray(args.files) ? args.files.length : 0} file changes)`;
    case "github.prCreate": return `${repo} PR ${String(args.head || "")} → ${String(args.base || "default")}`;
    case "github.prMerge": return `${repo} PR #${String(args.number || "")}`;
    case "github.issueCreate": return `${repo} new issue: ${String(args.title || "")}`;
    case "github.issueComment": return `${repo} issue #${String(args.number || "")}`;
    case "github.rename": return `${repo} branch ${String(args.branch || "")}: ${String(args.from || "")} → ${String(args.to || "")}`;
    case "github.write": return `${repo} branch ${String(args.branch || "")}:${String(args.path || "")}`;
    case "github.copy": return `${repo} branch ${String(args.branch || "")}: ${String(args.from || "")} → ${String(args.to || "")}`;
    default: return `${name} ${repo}`;
  }
}
