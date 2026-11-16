/** Portable, read-only recovery helpers for shell commands in the selected Android backend. */

/**
 * Normalize a path before it is embedded in a recovery probe: keep only the first
 * non-empty line, drop NUL/CR/other control characters and surrounding quotes/space.
 * Task text and escalation prompts are multi-line, so a captured path may carry a
 * trailing "\r" or "\n" that is never part of a real file name.
 */
export function sanitizeRecoveryPath(value: string): string {
  const firstLine = String(value ?? "")
    .split(/[\r\n\0]+/)
    .map((x) => x.trim())
    .find((x) => x.length > 0) || "";
  // eslint-disable-next-line no-control-regex
  return firstLine.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^["'`]+|["'`]+$/g, "").trim();
}

function shellQuote(value: string): string {
  const clean = sanitizeRecoveryPath(value);
  if (!clean) throw new Error("AIB_RECOVERY_PATH_INVALID");
  return `'${clean.replace(/'/g, `'\\''`)}'`;
}

/** Detect the common POSIX shell diagnostics emitted when an executable is absent. */
export function detectMissingShellCommand(exitCode: number, output: string): string | null {
  if (exitCode !== 127) return null;
  const text = String(output ?? "");
  const match =
    text.match(/(?:^|\n)(?:bash|sh|zsh): line \d+: ([A-Za-z0-9_.+-]+): command not found(?:\n|$)/m) ||
    text.match(/(?:^|\n)([A-Za-z0-9_.+-]+): command not found(?:\n|$)/m) ||
    text.match(/(?:^|\n)([A-Za-z0-9_.+-]+): not found(?:\n|$)/m) ||
    text.match(/PROJECT_ARCHIVE_TOOL_MISSING=([A-Za-z0-9_.+-]+)/);
  return (match?.[1] || "").toLowerCase() || null;
}

/**
 * A minimal read-only probe that deliberately does not depend on `file`.
 * All command checks and archive reads happen in the backend executing this script.
 */
export function buildPortableArchiveProbeCommand(sourcePath: string): string {
  const source = shellQuote(sourcePath);
  return [
    "set -u",
    `SRC=${source}`,
    '[ -e "$SRC" ] || { echo "PROJECT_SOURCE_NOT_FOUND=$SRC"; exit 44; }',
    'if [ -d "$SRC" ]; then',
    '  echo PROJECT_DIRECTORY_OK=1',
    '  for marker in gradlew settings.gradle settings.gradle.kts app/build.gradle app/build.gradle.kts android/gradlew package.json app.json app.config.js app.config.ts pubspec.yaml; do',
    '    [ -f "$SRC/$marker" ] && echo "PROJECT_MARKER=$marker"',
    '  done',
    '  exit 0',
    'fi',
    '[ -f "$SRC" ] || { echo PROJECT_SOURCE_NOT_REGULAR_FILE; exit 46; }',
    'case "$SRC" in *.zip|*.ZIP) ;; *) echo PROJECT_SOURCE_NOT_ZIP; exit 46;; esac',
    'if ! command -v unzip >/dev/null 2>&1; then echo PROJECT_ARCHIVE_TOOL_MISSING=unzip; exit 127; fi',
    'unzip -tq "$SRC" >/dev/null 2>&1 || { echo PROJECT_ARCHIVE_INVALID=1; exit 48; }',
    'unzip -Z1 "$SRC" >/dev/null 2>&1 || { echo PROJECT_ARCHIVE_LIST_FAILED=1; exit 49; }',
    'echo PROJECT_ARCHIVE_INTEGRITY_OK=1',
    'if command -v file >/dev/null 2>&1; then echo OPTIONAL_FILE_TOOL=available; else echo OPTIONAL_FILE_TOOL=missing; fi',
  ].join("\n");
}

/** Keep the agent on-protocol and distinguish a missing optional utility from a corrupt archive. */
export function buildMissingCommandRecoveryInstruction(command: string, selectedBackend: string): string {
  const name = String(command || "unknown").trim().toLowerCase();
  const fileSpecific = name === "file"
    ? "`file` is optional; its absence is NOT evidence that a ZIP or project is corrupt. Do not repeat the failed `file` command. For ZIPs, use `command -v unzip` and `unzip -tq` / `unzip -Z1` in this same backend."
    : `Check whether \`${name}\` is actually required; use \`command -v ${name}\` in this same backend and prefer an installed portable alternative when possible.`;
  return (
    `[SYSTEM_TOOL_RECOVERY] Exit 127 means the executable \"${name}\" was unavailable in selected backend \"${selectedBackend}\"; this is a tooling failure, not evidence of bad source input. ` +
    fileSpecific +
    " If a required utility is genuinely missing, install only that package inside the selected backend (Termux: `pkg`; Ubuntu/Debian guest: its package manager inside that guest), then verify it with `command -v`; never install or probe it in a different environment. " +
    "Continue the original build task after this inspection. NDK/toolchain readiness is only an intermediate prerequisite, never a completed APK build. " +
    "Your next whole reply must use exactly one valid machine-protocol marker: TERMUX_RUN: with one real command, or TERMUX_DONE: only after the requested artifact is verified."
  );
}
