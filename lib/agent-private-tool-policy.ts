export type PrivateToolExecutionTarget = "selected-backend" | "embedded-private";

/**
 * AIB_TOOL capabilities that are app-local and independent of project paths
 * and external shell/network execution. runtime.status adds a bounded private-
 * Bash probe; workspace tools are separately gated as exact-root operations.
 */
const EMBEDDED_PRIVATE_APP_LOCAL_TOOLS = new Set([
  "runtime.status",
  "runtime.packages",
  "diagnostics.log",
  "ctx.expand",
  "ctx.metrics",
  "github.parse",
  "interceptor.status",
  "interceptor.last",
  "interceptor.detail",
]);

/** Workspace tools enforce all-files access and exact-root SAF constraints in their native adapter. */
const EMBEDDED_PRIVATE_WORKSPACE_TOOLS = new Set(["workspace.list", "workspace.read", "workspace.write"]);

/** Only registered GitHub API operations may use the secure native GitHub bridge in private Agent mode. */
const EMBEDDED_PRIVATE_GITHUB_API_TOOLS = new Set([
  "github.read", "github.tree", "github.list", "github.diff", "github.prFiles",
  "github.search", "github.searchIssues", "github.repo", "github.branches", "github.commits",
  "github.commit", "github.tags", "github.releases", "github.release", "github.prList", "github.issue",
  "github.repoCreate", "github.branch", "github.apply", "github.prCreate", "github.prMerge",
  "github.issueCreate", "github.issueComment", "github.rename", "github.write",
]);

/** These tools write/materialize local files or archives and remain outside the private API capability. */
const EMBEDDED_PRIVATE_GITHUB_LOCAL_PATH_TOOLS = new Set([
  "github.materialize", "github.downloadAsset", "github.pack", "github.copy",
]);

/** Return a stable, typed denial reason rather than silently using a legacy executor. */
export function privateAgentToolUnsupportedReason(
  tool: string,
  target: PrivateToolExecutionTarget,
): string | null {
  if (target !== "embedded-private") return "AGENT_SHELL_TARGET_INVALID";
  if (EMBEDDED_PRIVATE_APP_LOCAL_TOOLS.has(tool) || EMBEDDED_PRIVATE_WORKSPACE_TOOLS.has(tool)) return null;
  // build.run is a typed app-owned offline adapter; its own validator requires
  // the exact workspace root, All Files Access, and a cached private Gradle binary.
  if (tool === "build.run") return null;

  if (tool === "pkg.ensure") return "AIB_TOOL_PRIVATE_PACKAGE_INSTALL_UNSUPPORTED";
  if (tool === "toolchain.ensure") return "AIB_TOOL_PRIVATE_TOOLCHAIN_UNSUPPORTED";

  if (tool.startsWith("github.")) {
    if (EMBEDDED_PRIVATE_GITHUB_LOCAL_PATH_TOOLS.has(tool)) return "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED";
    if (EMBEDDED_PRIVATE_GITHUB_API_TOOLS.has(tool)) return null;
    return "AIB_TOOL_PRIVATE_NETWORK_UNSUPPORTED";
  }

  if (tool.startsWith("interceptor.")) {
    return "AIB_TOOL_PRIVATE_HOST_NETWORK_CONTROL_UNSUPPORTED";
  }
  if (tool === "hardware.probe") return "AIB_TOOL_PRIVATE_SHARED_STORAGE_UNSUPPORTED";
  if (tool === "runtime.terminal" || tool === "runtime.proot" || tool === "runtime.killSession") {
    return "AIB_TOOL_PRIVATE_HOST_RUNTIME_UNSUPPORTED";
  }

  if (
    tool.startsWith("fs.") ||
    tool.startsWith("ast.") ||
    tool.startsWith("lsp.") ||
    tool.startsWith("skills.") ||
    tool.startsWith("memory.") ||
    tool === "ctx.compose" ||
    tool === "runtime.session"
  ) {
    return "AIB_TOOL_PRIVATE_PROJECT_PATH_UNSUPPORTED";
  }

  return "AIB_TOOL_PRIVATE_CAPABILITY_UNSUPPORTED";
}
