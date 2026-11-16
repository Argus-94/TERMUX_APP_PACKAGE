import { runInterceptorText } from "./common";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  const t = String(args.text || "").trim();
  if (!t || t.length > 500) return "INTERCEPTOR_COMMAND_INVALID";
  return null;
}
export async function execute(args: ToolArgs) {
  return runInterceptorText(String(args.text));
}
