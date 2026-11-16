import { queryEmbeddedTermuxPackages } from "../../termux-bridge";
import { createPrivatePackageInventoryTool } from "../../private-package-inventory";
import type { ToolArgs, ToolExecutionContext } from "../types";

const tool = createPrivatePackageInventoryTool(queryEmbeddedTermuxPackages);

export function validate(args: ToolArgs): string | null {
  return tool.validate(args);
}

export async function execute(
  args: ToolArgs,
  _projectPath?: string | null,
  context?: ToolExecutionContext,
) {
  return tool.execute(args, context);
}
