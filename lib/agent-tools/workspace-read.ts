import { isSafeAIBuilderWorkspaceRelativePath } from "../private-workspace-policy";
import { readAIBuilderWorkspaceFile } from "../termux-bridge";
import type { ToolArgs, ToolExecutionContext } from "./types";
const PRIVATE_TARGET_REQUIRED = "AIB_TOOL_WORKSPACE_READ_PRIVATE_TARGET_REQUIRED";
export function validate(args: ToolArgs): string | null {
  if (Object.keys(args).length !== 1 || !Object.prototype.hasOwnProperty.call(args, "relativePath")) return "AIB_WORKSPACE_READ_ARGS_UNSUPPORTED";
  return isSafeAIBuilderWorkspaceRelativePath(args.relativePath) ? null : "AIB_WORKSPACE_RELATIVE_PATH_INVALID";
}
export async function execute(args: ToolArgs, _projectPath?: string | null, context?: ToolExecutionContext) {
  if (context?.executionTarget !== "embedded-private") throw new Error(PRIVATE_TARGET_REQUIRED);
  return readAIBuilderWorkspaceFile(args.relativePath as string);
}
