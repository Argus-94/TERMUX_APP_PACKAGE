/**
 * Escalation ladder for the autonomous build agent (v379).
 *
 * Principle: the user states a task once; the agent reads the log, fixes and
 * finishes it. A hard stop that tells the user "check it yourself" is not an
 * acceptable end state. When the normal recovery cycles are exhausted (or the
 * handoff itself throws), the pipeline climbs this ladder instead of returning:
 *
 *   rung 1  "new-strategy"     — diagnose from scratch, forbid repeating the
 *                                previous approach.
 *   rung 2  "strict-protocol"  — same goal, minimal one-command-at-a-time
 *                                output format (covers models that broke the
 *                                AIB_TOOL / TERMUX_RUN protocol).
 *   final   honest report      — exact cause, what was tried, and what is
 *                                still missing. Never "check it yourself".
 *
 * This module is pure (no I/O) so it can be self-tested outside the app.
 * It does NOT relax any safety rule: the prompts keep the verified tool-pack
 * only policy, and never allow proot-distro reset/remove.
 */
import { BUILD_RECOVERY_SAFETY_POLICY, extractFirstRootCause } from "./agent-recovery";

export type EscalationRung = "new-strategy" | "strict-protocol";

export const ESCALATION_RUNGS: readonly EscalationRung[] = ["new-strategy", "strict-protocol"];

/** True when the repair agent returned a protocol-abort marker. */
export function isProtocolAbortText(text: string): boolean {
  const s = String(text ?? "");
  return /(^|\n)\s*AGENT_PROTOCOL_ABORT:/.test(s) || /\[REPAIR_AGENT_PROTOCOL_ABORT\]/.test(s);
}

/** An absolute path to an .apk (or .aab) in the agent's final text proves nothing by itself,
 *  but its absence proves the task was not finished. Used only as a cheap "claimed done" check. */
export function extractClaimedArtifactPath(text: string): string | null {
  const m = String(text ?? "").match(/(\/[^\s"'`<>|]+\.(?:apk|aab))\b/i);
  return m ? m[1] : null;
}

/** Cheap check that a handoff result looks like a finished task rather than a refusal/stop message. */
export function looksLikeFinishedBuild(text: string): boolean {
  const s = String(text ?? "");
  if (isProtocolAbortText(s)) return false;
  if (/\[AGENT_HANDOFF_ERROR\]/.test(s)) return false;
  return extractClaimedArtifactPath(s) !== null;
}

export type EscalationTaskInput = Readonly<{
  userTask: string;
  rung: EscalationRung;
  /** Failure kind from classifyTermuxBuildFailure (free text allowed). */
  kind: string;
  /** Tail of the real failure log. */
  failureLog: string;
  /** Short list of strategies that were already tried (most recent last). */
  triedStrategies: readonly string[];
  /** Project path when known. */
  projectPath?: string;
  /** Output of a previous escalation rung, if any. */
  previousRungOutput?: string;
}>;

const SAFETY_RULES = BUILD_RECOVERY_SAFETY_POLICY +
  " Never run proot-distro reset/remove; do not change the project's compilation settings " +
  "(app.config.ts, gradle.properties, package.json, pnpm-lock.yaml, eas.json, plugins/*). " +
  "Never assume `file` is installed: it is optional, and its absence does not mean an archive is corrupt. Check utilities with `command -v` in the selected backend; inspect ZIPs with `unzip -tq` and `unzip -Z1`, or install a genuinely required utility only inside that same backend and verify it. " +
  "For an APK task, NDK/toolchain readiness is only an intermediate prerequisite: continue to assemble, locate, and verify the APK before TERMUX_DONE.";

function triedBlock(tried: readonly string[]): string {
  const items = tried.map((x) => String(x).trim()).filter(Boolean).slice(-8);
  if (!items.length) return "Previously tried: (nothing recorded)";
  return "Previously tried (do NOT repeat these):\n" + items.map((x, i) => `  ${i + 1}. ${x.slice(0, 300)}`).join("\n");
}

/** Build the task text for one rung of the ladder. */
export function buildEscalationTask(input: EscalationTaskInput): string {
  const head =
    `User task (MUST complete end-to-end, do not ask the user to fix anything):\n${input.userTask}\n\n` +
    `[ESCALATION · rung=${input.rung} · failure kind=${input.kind}]\n` +
    (input.projectPath ? `Project path: ${input.projectPath}\n` : "") +
    `${triedBlock(input.triedStrategies)}\n\n` +
      `=== FIRST ROOT CAUSE ===\n${extractFirstRootCause(String(input.failureLog ?? ""))}\n` +
      `=== REAL FAILURE LOG (bounded context) ===\n${String(input.failureLog ?? "").slice(-8000)}\n=== END LOG ===\n\n`;

  const prev = input.previousRungOutput
    ? `Output of the previous escalation rung (it did not finish the task):\n${String(input.previousRungOutput).slice(-1500)}\n\n`
    : "";

  if (input.rung === "new-strategy") {
    return (
      head +
      prev +
      `You are fully autonomous. The normal recovery cycles are exhausted, so the approach used so far is wrong.\n` +
      `1) Re-read the log yourself (tail the on-disk failure log and assemble.log if present) and name the REAL root cause in one line.\n` +
      `2) Choose a DIFFERENT fix layer than the ones listed above (path/import, environment, project files, toolchain verification) and apply the smallest safe fix.\n` +
      `3) Verify the fix with a command, then run the build again. Repeat read-log → fix → retry until a verified .apk exists.\n` +
      `4) If the cause is genuinely outside your control (no network, storage permission denied, rootfs confirmed absent), stop with the EXACT diagnostic and the exact missing component — not a generic message.\n` +
      `${SAFETY_RULES}\n` +
      `Reply ONLY with TERMUX_RUN: / AIB_TOOL: / TERMUX_DONE:. TERMUX_DONE only with the absolute path to the .apk, or an honest exhaustion summary with the exact root cause.`
    );
  }

  return (
    head +
    prev +
    `STRICT PROTOCOL MODE. Earlier replies broke the tool-call format, so no command was executed.\n` +
    `Rules for EVERY reply in this run:\n` +
    `- Your WHOLE reply is exactly ONE line starting with TERMUX_RUN: followed by one shell command, OR one line starting with TERMUX_DONE: followed by the result.\n` +
    `- No markdown, no code fences, no JSON without the AIB_TOOL: prefix, no explanations, no plan text.\n` +
    `- One short command per reply; read the result; then the next command.\n` +
    `Goal: read the real error from the log, apply the smallest safe fix, retry the build until a verified .apk exists.\n` +
    `${SAFETY_RULES}\n` +
    `TERMUX_DONE only with the absolute path to the .apk, or an honest exhaustion summary with the exact root cause.`
  );
}

export type EscalationReportInput = Readonly<{
  kind: string;
  /** Plain-language description of the failure kind (termuxBuildFailureMessage). */
  kindMessage: string;
  failureLog: string;
  rungsTried: readonly EscalationRung[];
  recoveryCycles: number;
  lastAgentOutput?: string;
}>;

/**
 * Final honest report. It states the exact cause and what was attempted.
 * It deliberately never tells the user to fix things by hand as a substitute
 * for the agent's own work.
 */
export function buildEscalationReport(input: EscalationReportInput): string {
  const rungs = input.rungsTried.length ? input.rungsTried.join(" → ") : "none";
  const lines = String(input.failureLog ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const errorLines = lines.filter((l) => /error|fail|missing|denied|not found|NO_|BLOCKED|EXCEPTION/i.test(l)).slice(-6);
  const evidence = (errorLines.length ? errorLines : lines.slice(-4)).map((l) => `  ${l.slice(0, 240)}`).join("\n");
  // The inner agent appends its own "switch model" hint to AGENT_PROTOCOL_ABORT text. Strip it and add
  // exactly one deterministic line below, so the advice appears once and only in the final report.
  const last = String(input.lastAgentOutput ?? "")
    .replace(/\n?→ (?:Настройки|Налаштування|Settings):[^\n]*/g, "")
    .trim();
  const protocolAborted = isProtocolAbortText(input.failureLog) || isProtocolAbortText(input.lastAgentOutput ?? "");
  return (
    `APK не собран. Агент выполнил ${input.recoveryCycles} цикл(ов) восстановления и эскалацию (${rungs}); задача не завершена.\n` +
    `Класс сбоя: ${input.kind}.${input.kindMessage ? ` ${input.kindMessage}` : ""}\n` +
    `Точная причина из лога:\n${evidence || "  (лог пуст)"}\n` +
    (last ? `Последний вывод агента: ${last.slice(-600)}\n` : "") +
    `Полный лог записан в журнал (Termux).` +
    (protocolAborted
      ? `\nМодель несколько раз нарушила формат вызова инструментов, в том числе в строгом режиме. Если нужна другая модель, смените её вручную в настройках.`
      : "")
  );
}
