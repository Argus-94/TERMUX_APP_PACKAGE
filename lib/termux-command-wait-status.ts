export const TERMUX_RESULT_WAIT_WARNING_AFTER_SECONDS = 30;

export type TermuxCommandWaitState = "running" | "waiting-for-result";

/**
 * Heartbeats show only that the app is still waiting on the bridge request.
 * They do not prove that the Termux command is running or producing output.
 */
export function getTermuxCommandWaitState(elapsedSeconds: number): TermuxCommandWaitState {
  return elapsedSeconds >= TERMUX_RESULT_WAIT_WARNING_AFTER_SECONDS
    ? "waiting-for-result"
    : "running";
}
