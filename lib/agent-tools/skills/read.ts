import { readProjectSkill } from "../../agent-skills";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null { return String(args.name||args.path||"").trim()?null:"SKILL_NAME_REQUIRED"; }
export function execute(args: ToolArgs, projectPath?: string|null) { return readProjectSkill(projectPath||undefined,String(args.name||args.path||"")); }
