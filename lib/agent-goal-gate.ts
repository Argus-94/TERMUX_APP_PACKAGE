/**
 * Thin wrapper around shouldBlockDoneForGoal for the agent DONE path.
 * Keeps termux-agent free of inline verify orchestration details.
 */
import {
  type AgentGoal,
  shouldBlockDoneForGoal,
  buildGoalVerifyCommand,
} from "./agent-goal";
import { executeGuardedTermuxCommand } from "./termux-executor";

export async function runGoalDoneGate(
  goal: AgentGoal,
  doneMessage: string,
): Promise<{ ok: boolean; detail: string }> {
  return shouldBlockDoneForGoal(goal, doneMessage, async (cmd) => {
    const r = await executeGuardedTermuxCommand(cmd, {
      timeoutMs: 30_000,
      trustedInternal: true,
      executionTarget: "embedded-private", // verify on host for shared storage paths
    });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
    };
  });
}

export function hasGoalVerifyCommand(goal: AgentGoal): boolean {
  return buildGoalVerifyCommand(goal) != null;
}
