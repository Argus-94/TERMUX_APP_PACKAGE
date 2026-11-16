import { runInterceptor } from "./common";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  return String(args.id || "").trim() ? null : "INTERCEPTOR_ID_REQUIRED";
}
export async function execute(args: ToolArgs) {
  return runInterceptor({ action: "detail", id: String(args.id) });
}
