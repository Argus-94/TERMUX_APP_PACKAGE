/**
 * Anti-stuck policy for the chat agent repair loop.
 * Goal: never spin on the same failure; always propose a concrete next step
 * or stop with an honest status — no silent hang / model stupor.
 */
import type { AutonomyBackend } from "./agent-autonomy-policy";
import { installCommandForTool } from "./agent-autonomy-policy";
import { APK_BUILD_SAFETY_POLICY } from "./apk-build-safety-policy";

export type StuckErrorKind =
  | "missing-tool"
  | "permission"
  | "network"
  | "disk"
  | "timeout"
  | "build"
  | "path"
  | "unknown";

export type StuckDiagnosis = Readonly<{
  kind: StuckErrorKind;
  /** Stable fingerprint for streak tracking (no raw paths of user secrets). */
  fingerprint: string;
  /** Tool id when kind=missing-tool */
  missingToolId?: string;
  /** One concrete shell command to try next (may be null if user action required). */
  suggestedCommand: string | null;
  /** Short RU/EN-neutral instruction for the model. */
  instruction: string;
  /** If true, model must TERMUX_DONE instead of another blind retry. */
  forceDone: boolean;
}>;

const MISSING_PATTERNS: ReadonlyArray<{ re: RegExp; toolId: string }> = [
  { re: /\b(?:python3?|pip3?):(?:\s+command)?\s+not found\b/i, toolId: "python" },
  { re: /\b(?:node|npm|npx):(?:\s+command)?\s+not found\b/i, toolId: "nodejs" },
  { re: /\bgit:(?:\s+command)?\s+not found\b/i, toolId: "git" },
  { re: /\bcurl:(?:\s+command)?\s+not found\b/i, toolId: "curl" },
  { re: /\bwget:(?:\s+command)?\s+not found\b/i, toolId: "wget" },
  { re: /\bunzip:(?:\s+command)?\s+not found\b/i, toolId: "unzip" },
  { re: /\b(?:java|javac):(?:\s+command)?\s+not found\b|JAVA_NOT_FOUND|java=MISSING/i, toolId: "openjdk-17" },
  { re: /\b(?:clang|gcc|g\+\+):(?:\s+command)?\s+not found\b/i, toolId: "clang" },
  { re: /command not found|No such file or directory.*bin\//i, toolId: "" },
];

/** Max times the same error fingerprint may be seen before forceDone. */
export const MAX_SAME_ERROR_STREAK = 3;
/** Max times the exact same command may repeat. */
export const MAX_SAME_CMD_STREAK = 2;

export function fingerprintCommand(command: string): string {
  return String(command || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
    .toLowerCase();
}

export function fingerprintError(stdout: string, stderr: string, exitCode: number, timedOut: boolean): string {
  const blob = `${stdout || ""}\n${stderr || ""}`.slice(0, 4000);
  if (timedOut) return "timeout";
  if (/RUN_COMMAND_PERMISSION|permission denied|EACCES|EPERM/i.test(blob)) return "permission";
  if (/No space left|ENOSPC|disk full/i.test(blob)) return "disk";
  if (/Unknown host|Could not resolve|Connection refused|Network is unreachable|SSLHandshake|HTTP\s*50[234]|timed?\s*out/i.test(blob)) {
    return "network";
  }
  for (const { re, toolId } of MISSING_PATTERNS) {
    if (re.test(blob) && toolId) return `missing:${toolId}`;
  }
  if (/command not found|not found/i.test(blob)) return "missing:unknown";
  if (/BUILD FAILED|AAPT2|Gradle|compile|error:/i.test(blob)) {
    const line = blob.split("\n").find((l) => /error:|FAILED|What went wrong/i.test(l)) || "build";
    return `build:${line.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase()}`;
  }
  if (/No such file or directory|cannot access|AIB_CWD_/i.test(blob)) return "path";
  return `exit:${exitCode}:${blob.replace(/\s+/g, " ").trim().slice(0, 60).toLowerCase()}`;
}

export function diagnoseStuckFailure(options: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  backend: AutonomyBackend;
  sameErrorStreak: number;
  sameCmdStreak: number;
  command: string;
}): StuckDiagnosis {
  const { stdout, stderr, exitCode, timedOut, backend, sameErrorStreak, sameCmdStreak } = options;
  const blob = `${stdout || ""}\n${stderr || ""}`;
  const fp = fingerprintError(stdout, stderr, exitCode, timedOut);
  const forceDone =
    sameErrorStreak >= MAX_SAME_ERROR_STREAK || sameCmdStreak >= MAX_SAME_CMD_STREAK + 1;

  if (timedOut) {
    return {
      kind: "timeout",
      fingerprint: fp,
      suggestedCommand: null,
      instruction:
        "Timeout. Split the work into a shorter command, or write a script file and run it. Do not re-run the same long command unchanged.",
      forceDone: sameErrorStreak >= 2,
    };
  }

  if (/RUN_COMMAND_PERMISSION|permission denied|EACCES/i.test(blob)) {
    return {
      kind: "permission",
      fingerprint: fp,
      suggestedCommand: null,
      instruction:
        "Embedded private-runtime permission or workspace access was denied. Do not invoke external Termux, RUN_COMMAND, or termux-setup-storage. Verify embedded bridge readiness and the exact AIBuilderTermux workspace grant; report the specific denied capability and stop rather than retrying unchanged.",
      forceDone: true,
    };
  }

  if (/No space left|ENOSPC/i.test(blob)) {
    return {
      kind: "disk",
      fingerprint: fp,
      suggestedCommand: "df -h; du -sh $PREFIX/tmp $HOME/.gradle 2>/dev/null | head",
      instruction: "Disk full. Report free space; only clean safe caches if appropriate, then TERMUX_DONE if still full.",
      forceDone: sameErrorStreak >= 2,
    };
  }

  if (/Unknown host|Could not resolve|Connection refused|Network is unreachable/i.test(blob)) {
    return {
      kind: "network",
      fingerprint: fp,
      suggestedCommand: backend === "termux" ? "ping -c 1 8.8.8.8; pkg update -y 2>&1 | tail -5" : "ping -c 1 8.8.8.8; apt-get update -y 2>&1 | tail -5",
      instruction: "Network error. Check connectivity once; if still down, TERMUX_DONE and tell the user.",
      forceDone: sameErrorStreak >= 2,
    };
  }

  for (const { re, toolId } of MISSING_PATTERNS) {
    if (!re.test(blob)) continue;
    if (!toolId) continue;
    const isJdk = toolId === "openjdk-17";
    const install = isJdk ? "java-install" : installCommandForTool(toolId, backend);
    return {
      kind: "missing-tool",
      fingerprint: fp,
      missingToolId: toolId,
      suggestedCommand: install,
      instruction: isJdk
        ? `Missing JDK. Run the java-install recipe or install openjdk-17 with the backend package manager (pkg install openjdk-17 / apt-get install openjdk-17-jdk-headless), export JAVA_HOME, then re-probe. APK policy: ${APK_BUILD_SAFETY_POLICY}`
        : install
        ? `Missing tool "${toolId}". Next reply MUST install it, then re-check (command -v). Install: ${install}`
        : `Missing tool "${toolId}". Install via the active package manager, re-check, then retry the task.`,
      forceDone,
    };
  }

  if (
    /(?:sdkmanager|android[- ]sdk|cmdline-tools|build-tools|\bndk\b|SDK_MISSING)/i.test(blob) &&
    /(?:not found|missing|no such file|cannot locate)/i.test(blob)
  ) {
    return {
      kind: "missing-tool",
      fingerprint: fp,
      missingToolId: "verified-android-toolchain-component",
      suggestedCommand: null,
      instruction: `A required Android SDK/NDK component is missing. Install it yourself: ensure cmdline-tools, accept licenses, then sdkmanager "<package>" (platforms;android-N, build-tools;X.Y.Z, cmake;X.Y.Z, ndk;X) and re-run the build script. ${APK_BUILD_SAFETY_POLICY}`,
      forceDone: false,
    };
  }

  if (/command not found/i.test(blob)) {
    const pm = backend === "termux" ? "pkg install -y" : "apt-get update -y && apt-get install -y";
    return {
      kind: "missing-tool",
      fingerprint: fp,
      suggestedCommand: null,
      instruction: `Command not found. Identify the binary name from stderr, install with: ${pm} <name>, verify, then retry a CHANGED command.`,
      forceDone,
    };
  }

  if (forceDone) {
    return {
      kind: "unknown",
      fingerprint: fp,
      suggestedCommand: null,
      instruction:
        "Same failure repeated. Stop looping. TERMUX_DONE with: what failed, last exit code, and one concrete user action if any. Do not run the same command again.",
      forceDone: true,
    };
  }

  return {
    kind: /BUILD FAILED|Gradle|AAPT2/i.test(blob) ? "build" : "unknown",
    fingerprint: fp,
    suggestedCommand: null,
    instruction:
      "Fix the root cause from [TERMUX_RESULT] (one change only), then retry a DIFFERENT command. Prefer AIB_TOOL diagnostics.log if the log is unclear.",
    forceDone: false,
  };
}

export type AntiStuckGoalHint = Readonly<{
  kind: string;
  mustExist: string[];
  summary: string;
}>;

/** Single SYSTEM message for the model — avoids stacking conflicting instructions. */
export function formatAntiStuckSystemMessage(
  d: StuckDiagnosis,
  backendLabel: string,
  goal?: AntiStuckGoalHint | null,
): string {
  const lines = [
    `[SYSTEM anti-stuck] environment=${backendLabel} kind=${d.kind} forceDone=${d.forceDone ? "yes" : "no"}`,
    d.instruction,
  ];
  if (goal) {
    lines.push(
      `[GOAL_CONTEXT] kind=${goal.kind}` +
        (goal.mustExist.length ? ` must_exist=${goal.mustExist.join(";")}` : "") +
        ` summary=${goal.summary.slice(0, 120)}`,
    );
  }
  if (d.suggestedCommand && !d.forceDone) {
    lines.push(d.missingToolId === "openjdk-17"
      ? "Preferred next action (exact allowlisted recipe ID, not a shell install command):"
      : "Preferred next shell (adapt if needed):");
    lines.push(d.suggestedCommand);
  }
  if (d.forceDone) {
    lines.push(
      "GOAL_AWARE: if GOAL must_exist is still unmet, TERMUX_DONE with honest failure + evidence (paths, exit codes). Never invent success or claim the file/APK exists without verification.",
    );
    if (goal?.mustExist.length) {
      lines.push(
        `Honest DONE example: TERMUX_DONE:\nGOAL unmet: expected ${goal.mustExist[0]} — last error: ${d.kind} (${d.fingerprint}).`,
      );
    }
    lines.push("Next reply MUST be TERMUX_DONE: <honest status>. No more TERMUX_RUN with the same approach.");
  } else {
    lines.push(
      "Next reply MUST be AIB_TOOL: or TERMUX_RUN: (one CHANGED action toward GOAL) or TERMUX_DONE if blocked by the user.",
    );
    if (goal?.mustExist.length) {
      lines.push(`Toward GOAL: ensure ${goal.mustExist.join(", ")} exists before DONE.`);
    }
  }
  return lines.join("\n");
}
