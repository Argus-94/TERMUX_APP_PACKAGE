import { pinLocalSkill, validSkillName } from "../../agent-skill-registry";
import type { ToolArgs } from "../types";
export function validate(args: ToolArgs): string | null {
  const name = String(args.name || "").trim();
  if (!validSkillName(name)) return "SKILL_NAME_INVALID";
  if (args.unpin !== undefined && typeof args.unpin !== "boolean") return "SKILL_UNPIN_INVALID";
  return null;
}
export function execute(args: ToolArgs) {
  return pinLocalSkill(String(args.name), args.unpin === true);
}
