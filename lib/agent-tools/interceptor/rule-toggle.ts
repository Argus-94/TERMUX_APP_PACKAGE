import { runInterceptor } from "./common";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (!String(args.id || "").trim()) return "INTERCEPTOR_ID_REQUIRED";
  if (typeof args.enabled !== "boolean") return "INTERCEPTOR_ENABLED_REQUIRED";
  return null;
}
export async function execute(args: ToolArgs) {
  return runInterceptor({ action: "rule-toggle", id: String(args.id), enabled: args.enabled === true });
}
