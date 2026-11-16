/**
 * Agent tool: runtime.killSession
 * Stop an isolated aib-<sessionId> tmux session (or all aib-* sessions).
 */
import {
  killAllRuntimeSessions,
  killRuntimeSession,
  listRuntimeSessions,
} from "../../runtime-session";
import type { ToolArgs } from "../types";

export function validate(args: ToolArgs): string | null {
  if (args.all === true) return null;
  if (typeof args.sessionId === "string" && args.sessionId.trim()) return null;
  return "SESSION_ID_OR_ALL_REQUIRED: pass sessionId or all=true";
}

export async function execute(args: ToolArgs) {
  if (args.all === true) {
    const result = await killAllRuntimeSessions();
    const remaining = await listRuntimeSessions();
    return {
      ok: result.ok,
      action: "kill_all",
      sessionName: result.sessionName,
      remaining,
      error: result.error,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const sessionId = String(args.sessionId).trim();
  const result = await killRuntimeSession(sessionId);
  return {
    ok: result.ok,
    action: "kill_one",
    sessionId,
    sessionName: result.sessionName,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
