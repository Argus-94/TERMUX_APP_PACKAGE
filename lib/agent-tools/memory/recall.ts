import { recallProjectMemory } from "../../session-memory";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null { return args.query===undefined||typeof args.query==="string"?null:"MEMORY_QUERY_INVALID"; }
export function execute(args: ToolArgs, projectPath?: string|null) { return recallProjectMemory(String(projectPath||""),typeof args.query==="string"?args.query:undefined); }
