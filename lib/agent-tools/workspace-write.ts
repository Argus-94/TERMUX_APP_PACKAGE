import { AI_BUILDER_WORKSPACE_MAX_BYTES, isSafeAIBuilderWorkspaceRelativePath } from "../private-workspace-policy";
import { writeAIBuilderWorkspaceFile } from "../termux-bridge";
import type { ToolArgs, ToolExecutionContext } from "./types";
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) { const point = ch.codePointAt(0) ?? 0; bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return bytes;
}
export function validate(args: ToolArgs): string | null {
  if (Object.keys(args).length !== 2 || !Object.prototype.hasOwnProperty.call(args, "relativePath") || !Object.prototype.hasOwnProperty.call(args, "content")) return "AIB_WORKSPACE_WRITE_ARGS_UNSUPPORTED";
  if (!isSafeAIBuilderWorkspaceRelativePath(args.relativePath)) return "AIB_WORKSPACE_RELATIVE_PATH_INVALID";
  if (typeof args.content !== "string") return "AIB_WORKSPACE_CONTENT_INVALID";
  if (utf8ByteLength(args.content) > AI_BUILDER_WORKSPACE_MAX_BYTES) return "AIB_WORKSPACE_CONTENT_TOO_LARGE";
  return null;
}
export async function execute(args: ToolArgs, _projectPath?: string | null, context?: ToolExecutionContext) {
  if (context?.executionTarget !== "embedded-private") throw new Error("AIB_TOOL_WORKSPACE_WRITE_PRIVATE_TARGET_REQUIRED");
  return writeAIBuilderWorkspaceFile(args.relativePath as string, args.content as string);
}
