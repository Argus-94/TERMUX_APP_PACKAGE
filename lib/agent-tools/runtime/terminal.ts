import type { ToolArgs } from "../types";

export function validate(args: ToolArgs): string | null {
  if (typeof args.projectId !== "string" || !args.projectId.trim()) {
    return "PROJECT_ID_REQUIRED";
  }
  return null;
}

export async function execute(_args: ToolArgs) {
  // The production runtime exposes a general Termux terminal opener, but does
  // not provide the isolated-terminal host hook required for agent isolation.
  // Fail explicitly rather than returning an unrestricted terminal session as
  // a successful isolated-agent capability.
  throw new Error("ISOLATED_TERMINAL_UNAVAILABLE");
}
