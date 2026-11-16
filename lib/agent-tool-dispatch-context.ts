import type { ToolExecutionContext } from "./agent-tools/types";
import { AI_BUILDER_WORKSPACE_ROOT, isSafeAIBuilderWorkspaceRelativePath } from "./private-workspace-policy";

export type ExternalMutationAuthorizationRequest = Readonly<{
  tool: string;
  target: string;
  args: Readonly<Record<string, unknown>>;
}>;
export type AgentToolDispatchHost = Readonly<{
  readWorkspaceFile: (relativePath: string) => Promise<{ content: string }>;
  getFacade: () => Promise<{
    home: { projects: string };
    environment: { mkdir(path: string): Promise<void>; write(path: string, content: string): Promise<void> };
    workspaceSnapshots: { createSnapshot(projectRoot: string, label?: string): Promise<{ id: string }> };
  }> | {
    home: { projects: string };
    environment: { mkdir(path: string): Promise<void>; write(path: string, content: string): Promise<void> };
    workspaceSnapshots: { createSnapshot(projectRoot: string, label?: string): Promise<{ id: string }> };
  };
  now?: () => number;
  nonce?: () => string;
}>;
export type AgentToolDispatchContextOptions = Readonly<{
  traceId?: string;
  executionTarget: "selected-backend" | "embedded-private";
  confirmDangerous?: (command: string, reason: string) => Promise<boolean>;
  host?: AgentToolDispatchHost;
}>;

const defaultHost: AgentToolDispatchHost = {
  readWorkspaceFile: async (relativePath) => {
    const { readAIBuilderWorkspaceFile } = await import("./termux-bridge");
    return readAIBuilderWorkspaceFile(relativePath);
  },
  getFacade: async () => {
    // Loaded lazily so the dispatcher does not initialize the runtime until a mutation needs a checkpoint.
    const runtime = await import("./runtime-facade");
    return runtime.getRuntimeFacade();
  },
  now: () => Date.now(),
  nonce: () => Math.random().toString(36).slice(2, 10),
};

/** Construct the exact host-owned context passed by the production AIB_TOOL dispatcher. */
export function createAgentToolExecutionContext(options: AgentToolDispatchContextOptions): ToolExecutionContext {
  const host = options.host ?? defaultHost;
  const context: ToolExecutionContext = {
    traceId: options.traceId,
    executionTarget: options.executionTarget,
  };
  context.beforeFileMutation = async (absolutePath, toolName) => {
    if (toolName !== "workspace.write" || !absolutePath.startsWith(`${AI_BUILDER_WORKSPACE_ROOT}/`)) {
      throw new Error("FILE_WRITE_CHECKPOINT_TARGET_INVALID");
    }
    const relativePath = absolutePath.slice(AI_BUILDER_WORKSPACE_ROOT.length + 1);
    if (!isSafeAIBuilderWorkspaceRelativePath(relativePath) || `${AI_BUILDER_WORKSPACE_ROOT}/${relativePath}` !== absolutePath) {
      throw new Error("FILE_WRITE_CHECKPOINT_TARGET_INVALID");
    }
    // Native procfd/no-follow reader captures the exact pre-write shared-storage version.
    const original = await host.readWorkspaceFile(relativePath);
    if (typeof original?.content !== "string") throw new Error("FILE_WRITE_CHECKPOINT_READ_FAILED");
    const facade = await host.getFacade();
    const timestamp = (host.now ?? Date.now)();
    const nonce = (host.nonce ?? (() => Math.random().toString(36).slice(2, 10)))();
    const projectRoot = `${facade.home.projects}/aib-agent-prewrite-${timestamp}-${nonce}`;
    const savedPath = `${projectRoot}/original/${relativePath}`;
    const parent = savedPath.slice(0, savedPath.lastIndexOf("/"));
    await facade.environment.mkdir(parent);
    await facade.environment.write(savedPath, original.content);
    // Reuse the app's durable, secret-scanned workspace snapshot store. Any scan,
    // storage, or snapshot error propagates and prevents the native write.
    const snapshot = await facade.workspaceSnapshots.createSnapshot(projectRoot, `agent-prewrite-${toolName}`);
    if (!snapshot?.id) throw new Error("FILE_WRITE_CHECKPOINT_FAILED");
  };
  context.authorizeExternalMutation = async (request: ExternalMutationAuthorizationRequest) => {
    if (!options.confirmDangerous) throw new Error("GITHUB_MUTATION_CONFIRMATION_REQUIRED");
    const exact = JSON.stringify(request.args);
    const action = `AIB_TOOL ${request.tool} ${exact}`;
    const reason = `Confirm this GitHub mutation. Target: ${request.target}. Action and arguments: ${exact}`;
    const approved = await options.confirmDangerous(action, reason);
    if (!approved) throw new Error("GITHUB_MUTATION_NOT_AUTHORIZED");
    // This approval is consumed by this single awaited dispatcher call; no token is retained.
  };
  return context;
}
