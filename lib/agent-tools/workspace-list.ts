import { listAIBuilderWorkspace } from "../termux-bridge";
import type { ToolArgs, ToolExecutionContext } from "./types";

export function validate(args: ToolArgs): string | null {
  return Object.keys(args).length === 0 ? null : "AIB_WORKSPACE_LIST_ARGS_UNSUPPORTED";
}

/**
 * Lists only direct-child metadata from the explicitly granted AIBuilderTermux
 * SAF tree. It never runs a shell command or accesses arbitrary project paths.
 */
export async function execute(
  _args: ToolArgs,
  _projectPath?: string | null,
  context?: ToolExecutionContext,
) {
  if (context?.executionTarget !== "embedded-private") {
    throw new Error("AIB_TOOL_WORKSPACE_LIST_PRIVATE_TARGET_REQUIRED");
  }
  return listAIBuilderWorkspace();
}
