import { retainProjectMemory } from "../../session-memory";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  return /^(fact|decision|lesson)$/.test(String(args.kind||""))&&typeof args.text==="string"&&!!args.text.trim()&&args.text.length<=5000?null:"MEMORY_RETAIN_INVALID";
}
export async function execute(args: ToolArgs, projectPath?: string|null) {
  const kind=String(args.kind) as "fact"|"decision"|"lesson";
  if(!["fact","decision","lesson"].includes(kind)) throw new Error("MEMORY_KIND_NOT_ALLOWED");
  await retainProjectMemory(String(projectPath||""),kind,String(args.text||""));
  return {ok:true};
}
