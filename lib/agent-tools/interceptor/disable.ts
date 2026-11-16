import { runInterceptor } from "./common";
import type { ToolArgs } from "../types";
export function validate(_args: ToolArgs): string | null { return null; }
export async function execute(_args: ToolArgs) {
  return runInterceptor({ action: "disable" });
}
