import { getRuntimeFacade } from "../../runtime-facade";
import type { ToolArgs } from "../types";

export function validate(args: ToolArgs): string | null {
  if (typeof args.projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.projectId.trim()) || args.projectId.trim() === "." || args.projectId.trim() === "..") {
    return "PROJECT_ID_REQUIRED";
  }
  const profile = args.profile;
  if (profile !== undefined && profile !== "ubuntu") {
    return "PROFILE_INVALID";
  }
  return null;
}

export async function execute(args: ToolArgs) {
  const projectId = String(args.projectId);
  const profile = "ubuntu" as const;
  const instanceId =
    typeof args.instanceId === "string" && args.instanceId
      ? String(args.instanceId)
      : `auto-${projectId}`;
  const facade = getRuntimeFacade();
  const { plan, result } = await facade.runProotAuto(profile, instanceId, projectId);
  return {
    plan: {
      command: plan.command,
      profile: plan.profile,
      instanceId: plan.instanceId,
      projectRoot: plan.projectRoot,
    },
    result,
  };
}
