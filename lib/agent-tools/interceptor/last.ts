import { runInterceptor } from "./common";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  if (args.limit !== undefined && (!Number.isInteger(Number(args.limit)) || Number(args.limit) < 1 || Number(args.limit) > 100)) {
    return "INTERCEPTOR_LIMIT_INVALID";
  }
  return null;
}
export async function execute(args: ToolArgs) {
  return runInterceptor({ action: "last", limit: args.limit !== undefined ? Number(args.limit) : 10 });
}
