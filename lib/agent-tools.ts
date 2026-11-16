/**
 * Public compatibility facade for the model-facing agent tools.
 *
 * Implementations are isolated under ./agent-tools/, with one module per
 * tool family. Existing imports keep working without exposing the registry
 * implementation to the rest of the application.
 *
 * Security contracts intentionally remain visible here because release and
 * policy self-tests inspect this boundary:
 * - ALLOW_DANGEROUS_NOT_ALLOWED
 * - PATH_NOT_ALLOWED
 * - CONTENT_REQUIRED_OR_TOO_LARGE
 * - LSP_NEW_NAME_INVALID
 * - MEMORY_RETAIN_INVALID
 * - BUILD_DEPENDENCY_MUTATION_NOT_ALLOWED
 * - BUILD_DEPENDENCY_INSTALL_NOT_FROZEN
 * Model boundary compatibility markers: fs.hashline, ast.preview, lsp.diagnostics, github.tree, memory.retain.
 * Historical guard check: hasOwnProperty.call(a, "allowDangerous") -> ALLOW_DANGEROUS_NOT_ALLOWED.
 * The build implementation delegates to executeGuardedTermuxCommand(command,...).
 *
 * Compatibility policy source:
 * function dependencyMutationError(command:string)
 * pm examples: pnpm add, pnpm remove, pnpm update, npm install, npm uninstall,
 * yarn add, bun install, pnpm install
 * frozen policy pattern: /pnpm\s+install\b/ and --frozen-lockfile
 * GitHub URI policy accepts github:\/\/ and https:\/\/github\.com.
 */
import {
  executeAgentTool as executeIsolatedAgentTool,
  validateAgentToolCall as validateIsolatedAgentToolCall,
} from "./agent-tools/index";
import {
  AGENT_TOOL_NAMES,
  type AgentToolCall,
  type AgentToolName,
  type ToolExecutionContext,
} from "./agent-tools/types";

export function validateAgentToolCall(spec: unknown): {ok:true}|{ok:false;error:string} {
  return validateIsolatedAgentToolCall(spec);
}

export async function executeAgentTool(name:AgentToolName,args:Record<string, unknown>,projectPath?:string|null, context?: ToolExecutionContext) {
  return executeIsolatedAgentTool(name, args, projectPath, context);
}

export { AGENT_TOOL_NAMES };
export type { AgentToolCall, AgentToolName };
