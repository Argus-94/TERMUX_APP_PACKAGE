export interface AgentToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

export const AGENT_TOOL_NAMES = [
  "build.run",
  "toolchain.ensure",
  "fs.read",
  "fs.hashline",
  "fs.create",
  "fs.delete",
  "fs.replace",
  "fs.replaceRange",
  "ast.search",
  "ast.preview",
  "ast.edit",
  "lsp.diagnostics",
  "lsp.request",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
  "lsp.completion",
  "lsp.rename",
  "github.read",
  "github.tree",
  "github.list",
  "github.diff",
  "github.prFiles",
  "github.search",
  "github.searchIssues",
  "github.repo",
  "github.repoCreate",
  "github.branch",
  "github.apply",
  "github.prCreate",
  "github.materialize",
  "github.pack",
  "github.branches",
  "github.commits",
  "github.commit",
  "github.tags",
  "github.releases",
  "github.release",
  "github.prList",
  "github.prMerge",
  "github.issue",
  "github.issueCreate",
  "github.issueComment",
  "github.rename",
  "github.downloadAsset",
  "github.parse",
  "interceptor.rulesDisable",
  "interceptor.ruleToggle",
  "interceptor.command",
  "interceptor.detail",
  "interceptor.last",
  "interceptor.disable",
  "interceptor.enable",
  "interceptor.status",
  "github.copy",
  "github.write",
  "skills.list",
  "skills.read",
  "skills.verify",
  "skills.pin",
  "memory.recall",
  "memory.retain",
  "memory.reflect",
  "runtime.status",
  "runtime.packages",
  "workspace.list",
  "workspace.read",
  "workspace.write",
  "runtime.session",
  "runtime.terminal",
  "runtime.proot",
  "runtime.killSession",
  "pkg.ensure",
  "hardware.probe",
  "diagnostics.log",
  "ctx.compose",
  "ctx.expand",
  "ctx.metrics",
] as const;

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];
export type ToolArgs = Record<string, unknown>;
export type ToolResult = unknown;
export type ToolValidator = (args: ToolArgs) => string | null;
export type ToolExecutionContext = {
  traceId?: string;
  /** Selected by the chat agent; private-aware tools must not delegate elsewhere. */
  executionTarget?: "selected-backend" | "embedded-private";
  /** Host-owned durable checkpoint; mutation tools fail closed when absent. */
  beforeFileMutation?: (absolutePath: string, toolName: string) => Promise<void>;
  /** Explicit, host-mediated, per-call authorization for external GitHub mutations. */
  authorizeExternalMutation?: (request: {
    tool: string;
    target: string;
    args: Readonly<Record<string, unknown>>;
  }) => Promise<void>;
};
export type ToolExecutor = (
  args: ToolArgs,
  projectPath?: string | null,
  context?: ToolExecutionContext,
) => Promise<ToolResult>;
export type ToolDefinition = {
  validate: ToolValidator;
  execute: ToolExecutor;
};
