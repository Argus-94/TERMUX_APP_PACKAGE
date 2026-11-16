import { discoverProjectSkills } from "../../agent-skills";
import type { ToolArgs } from "../types";
export function validate(_args: ToolArgs): string | null { return null; }
export function execute(_args: ToolArgs, projectPath?: string|null) { return discoverProjectSkills(projectPath||undefined); }
