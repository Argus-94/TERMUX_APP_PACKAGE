import { verifyProjectSkill } from "../../agent-skills";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null { return String(args.name||args.path||"").trim()?null:"SKILL_NAME_REQUIRED"; }
export async function execute(args: ToolArgs, projectPath?: string|null) {
  const result = await verifyProjectSkill(projectPath || undefined, String(args.name || args.path || ""));
  return result.warning === "SKILL_PIN_MISMATCH" ? { ...result, ok: false, warning: "SKILL_PIN_MISMATCH" } : result;
}
