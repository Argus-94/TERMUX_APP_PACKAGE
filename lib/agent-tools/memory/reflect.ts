import { reflectProjectMemory } from "../../session-memory";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null { return typeof args.query==="string"?null:"MEMORY_QUERY_REQUIRED"; }
export function execute(args: ToolArgs, projectPath?: string|null) { return reflectProjectMemory(String(projectPath||""),String(args.query||"")); }
