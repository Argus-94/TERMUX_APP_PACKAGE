/**
 * Runtime session isolation helpers (antigravity-inspired per-chat sessions).
 *
 * Naming convention for tmux / process groups:
 *   aib-<sessionId>
 *
 * Provides stop/kill helpers. UI wiring (buttons in runtime / chat-history)
 * is intentionally left for a follow-up session so this module stays pure.
 */

import { executeGuardedTermuxCommand } from "./termux-executor";

const SESSION_PREFIX = "aib-";

export function runtimeSessionName(sessionId: string): string {
  const safe = String(sessionId || "default")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48) || "default";
  return `${SESSION_PREFIX}${safe}`;
}

export function isRuntimeSessionName(name: string): boolean {
  return String(name || "").startsWith(SESSION_PREFIX);
}

export type SessionActionResult = {
  ok: boolean;
  sessionName: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
};

/**
 * Best-effort: create a detached tmux session for the given id if tmux exists.
 * No-op (ok=true) when tmux is unavailable so callers can still proceed.
 */
export async function ensureRuntimeSession(sessionId: string): Promise<SessionActionResult> {
  const name = runtimeSessionName(sessionId);
  const cmd = `command -v tmux >/dev/null 2>&1 && tmux has-session -t ${name} 2>/dev/null || tmux new-session -d -s ${name} 2>/dev/null || true`;
  try {
    const result = await executeGuardedTermuxCommand(cmd, { timeoutMs: 8000, executionTarget: "embedded-private", trustedInternal: true });
    return {
      ok: true,
      sessionName: name,
      stdout: result?.stdout,
      stderr: result?.stderr,
      exitCode: result?.exitCode,
    };
  } catch (e: any) {
    return { ok: false, sessionName: name, error: String(e?.message || e) };
  }
}

/** Stop (kill) a single runtime session by app session id. */
export async function killRuntimeSession(sessionId: string): Promise<SessionActionResult> {
  const name = runtimeSessionName(sessionId);
  const cmd = `command -v tmux >/dev/null 2>&1 && tmux kill-session -t ${name} 2>/dev/null; true`;
  try {
    const result = await executeGuardedTermuxCommand(cmd, { timeoutMs: 8000, executionTarget: "embedded-private", trustedInternal: true });
    return {
      ok: true,
      sessionName: name,
      stdout: result?.stdout,
      stderr: result?.stderr,
      exitCode: result?.exitCode,
    };
  } catch (e: any) {
    return { ok: false, sessionName: name, error: String(e?.message || e) };
  }
}

/** Kill all aib-* tmux sessions (cleanup on demand). */
export async function killAllRuntimeSessions(): Promise<SessionActionResult> {
  const cmd = `command -v tmux >/dev/null 2>&1 && tmux list-sessions -F '#{session_name}' 2>/dev/null | while read -r s; do case "$s" in ${SESSION_PREFIX}*) tmux kill-session -t "$s" 2>/dev/null ;; esac; done; true`;
  try {
    const result = await executeGuardedTermuxCommand(cmd, { timeoutMs: 15000, executionTarget: "embedded-private", trustedInternal: true });
    return {
      ok: true,
      sessionName: `${SESSION_PREFIX}*`,
      stdout: result?.stdout,
      stderr: result?.stderr,
      exitCode: result?.exitCode,
    };
  } catch (e: any) {
    return { ok: false, sessionName: `${SESSION_PREFIX}*`, error: String(e?.message || e) };
  }
}

/** List aib-* session names (best-effort). */
export async function listRuntimeSessions(): Promise<string[]> {
  const cmd = `command -v tmux >/dev/null 2>&1 && tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^${SESSION_PREFIX}' || true`;
  try {
    const result = await executeGuardedTermuxCommand(cmd, { timeoutMs: 8000, executionTarget: "embedded-private", trustedInternal: true });
    const out = String(result?.stdout || "");
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => isRuntimeSessionName(l));
  } catch {
    return [];
  }
}
