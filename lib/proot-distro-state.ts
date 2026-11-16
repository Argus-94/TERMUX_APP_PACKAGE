export type ProotDistroAlias = "debian" | "ubuntu";
export type ProotDistroInstallDecision = "already-healthy" | "install-once" | "repair-required" | "state-unverified";
export type ProotDistroListEvidence = "alias-listed" | "alias-not-listed" | "explicit-empty" | "unrecognized" | "incomplete";
export type ProotDistroParserOutcome = "healthy" | "missing" | "tool-unavailable" | "incomplete-envelope" | "evidence-conflict" | "architecture-mismatch" | "identity-unverified" | "list-unverified" | "installed-unhealthy";
export type InstalledDistroList = Readonly<{ known: boolean; aliases: readonly ProotDistroAlias[] }>;
const installLocks = new Map<ProotDistroAlias, Promise<unknown>>();
let hostToolLockTail: Promise<void> = Promise.resolve();

/** Serialize the shared Termux-side proot-distro prerequisite across both distros and package UI. */
export async function withProotDistroHostToolLock<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const previous = hostToolLockTail;
  hostToolLockTail = previous.then(() => gate, () => gate);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally { release(); }
}

/** Serialize concurrent install attempts across UI/runtime/container entry points. */
export async function withProotDistroInstallLock<T>(alias: ProotDistroAlias, operation: () => Promise<T>): Promise<T> {
  const active = installLocks.get(alias);
  if (active) return active as Promise<T>;
  const work = Promise.resolve().then(operation);
  installLocks.set(alias, work);
  try { return await work; }
  finally { if (installLocks.get(alias) === work) installLocks.delete(alias); }
}

export type ProotDistroState = Readonly<{
  alias: ProotDistroAlias;
  toolAvailable: boolean;
  installed: boolean | null;
  healthy: boolean;
  aiBuilderRegistration: "not-required-for-health" | "unknown";
  evidence: "login-smoke" | "login-smoke-unhealthy" | "login-not-installed" | "installed-list" | "unverified";
  listEvidence: ProotDistroListEvidence;
  parserOutcome: ProotDistroParserOutcome;
  listExitCode: number | null;
  osReleaseId?: string;
  uid?: string;
  uname?: string;
  hostUname?: string;
  architectureMatches: boolean;
  listOutput: string;
  diagnostic: string;
}>;

const ALIASES: readonly ProotDistroAlias[] = ["debian", "ubuntu"];
export const PROOT_ARCH_NORMALIZER_SHELL = `aib_normalize_arch() {
  case "$1" in
    aarch64|arm64) printf arm64 ;;
    arm|armv[5-8]*) printf arm32 ;;
    x86_64|amd64) printf x86_64 ;;
    x86|i[3-6]86) printf x86 ;;
    *) printf '%s' "$1" ;;
  esac
}`;
function safeAlias(value: string): ProotDistroAlias {
  if ((ALIASES as readonly string[]).includes(value)) return value as ProotDistroAlias;
  throw new Error("PROOT_DISTRO_ALIAS_NOT_ALLOWED");
}

/** Parse only the installed section or the exact current empty-list message; never infer absence from an unrecognized list. */
export function parseInstalledProotDistroList(raw: string, quietList = false): InstalledDistroList {
  const output = String(raw ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const lines = output.split("\n");
  // Current upstream `proot-distro list --quiet` prints one bare container
  // identifier per line. Accept that machine-readable form only when every
  // non-empty line is one of the two supported aliases; unknown/custom output
  // remains inconclusive and cannot authorize an install.
  const quietLines = lines.map((line) => line.trim()).filter(Boolean);
  if (quietList && quietLines.length === 0) return { known: true, aliases: [] };
  if (quietLines.length > 0 && quietLines.every((line) => /^(?:debian|ubuntu)$/i.test(line))) {
    return { known: true, aliases: [...new Set(quietLines.map((line) => line.toLowerCase() as ProotDistroAlias))] };
  }
  const noContainersLines = lines.filter((line) => /^\s*No containers are installed\.\s*$/i.test(line));
  if (noContainersLines.length > 0) {
    return noContainersLines.length === 1 && aliasesFromLines(lines).length === 0
      ? { known: true, aliases: [] }
      : { known: false, aliases: [] };
  }
  let section = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*installed\s+(?:distributions|containers)\s*:/i.test(lines[i])) { section = i; break; }
  }
  if (section < 0) {
    const explicit = output.match(/^\s*installed\s*:\s*(.*)$/im);
    if (!explicit) return { known: false, aliases: [] };
    const tail = explicit[1];
    if (/^(?:none|no\s+installed\s+distributions|\(none\))\s*$/i.test(tail)) return { known: true, aliases: [] };
    const aliases = aliasesFromLines([tail]);
    return aliases.length ? { known: true, aliases } : { known: false, aliases: [] };
  }
  const installedLines: string[] = [];
  const sameLine = lines[section].replace(/^\s*installed\s+(?:distributions|containers)\s*:/i, "");
  if (sameLine.trim()) installedLines.push(sameLine);
  for (let i = section + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:supported|available|usage|options|commands)\s+(?:distributions|containers|profiles)?\s*:/i.test(line)) break;
    if (/^\s*\S[^:]{0,50}:\s*$/.test(line) && !/^\s*installed\s+(?:distributions|containers)\s*:/i.test(line)) break;
    installedLines.push(line);
  }
  const aliases = aliasesFromLines(installedLines);
  const explicitNone = installedLines.some((line) => /^\s*(?:\(none\)|none|no\s+installed\s+distributions|none\s+installed)\s*$/i.test(line));
  if (explicitNone) {
    // Contradictory output is corrupt evidence, not proof of absence.
    return aliases.length ? { known: false, aliases: [] } : { known: true, aliases: [] };
  }
  // An empty heading (or unrecognized/corrupt content) is not proof that the
  // distro is absent. Only an explicit empty marker or a recognized alias set
  // is authoritative enough to permit an install decision.
  return aliases.length ? { known: true, aliases } : { known: false, aliases: [] };
}

function aliasesFromLines(lines: readonly string[]): ProotDistroAlias[] {
  const found = new Set<ProotDistroAlias>();
  for (const line of lines) {
    const parenthesized = line.matchAll(/\(\s*(debian|ubuntu)\s*\)/ig);
    for (const match of parenthesized) found.add(match[1].toLowerCase() as ProotDistroAlias);
    const standalone = line.match(/^\s*(?:[*✓-]\s*)?(debian|ubuntu)(?:\s|\[|$)/i);
    if (standalone) found.add(standalone[1].toLowerCase() as ProotDistroAlias);
  }
  return [...found];
}

export function decideProotDistroInstall(state: Pick<ProotDistroState, "toolAvailable" | "installed" | "healthy">): ProotDistroInstallDecision {
  if (!state.toolAvailable) return "state-unverified";
  if (state.healthy) return "already-healthy";
  if (state.installed === false) return "install-once";
  return state.installed === true ? "repair-required" : "state-unverified";
}

export type ProotDistroPreflightKind = "healthy" | "confirmed-absent" | "installed-login-failed" | "unverified" | "other";
export function classifyProotDistroPreflight(aliasInput: ProotDistroAlias, rawOutput: string): Readonly<{ kind: ProotDistroPreflightKind; message: string }> {
  const alias = safeAlias(aliasInput);
  const marker = alias.toUpperCase();
  const output = String(rawOutput ?? "");
  if (output.includes(`AIB_${marker}_ROOTFS_OK`) || output.includes(`${marker}_ROOTFS_OK`)) {
    return { kind: "healthy", message: `${alias} passed a real proot-distro login check.` };
  }
  if (output.includes(`AIB_${marker}_ROOTFS_INSTALLED_LOGIN_FAILED`)) {
    return { kind: "installed-login-failed", message: `${alias} is listed as installed but login failed. The rootfs is preserved; automatic reinstall/reset is blocked. Inspect the Termux error before any manual repair.` };
  }
  if (output.includes(`AIB_${marker}_ROOTFS_STATE_UNVERIFIED`)) {
    return { kind: "unverified", message: `${alias} installation state could not be verified. No install or reset is allowed until the list/login check succeeds.` };
  }
  if (output.includes(`AIB_${marker}_ROOTFS_MISSING`)) {
    return { kind: "confirmed-absent", message: `${alias} is confirmed absent by proot-distro. Use the guarded Environment/Packages install action; it rechecks state and never resets or removes a rootfs.` };
  }
  return { kind: "other", message: `${alias} state was not classified; preserve existing data and inspect the Termux/proot-distro output.` };
}

/**
 * Uses proot-distro's own listing plus a real `login` smoke instead of assuming an AI Builder path.
 * The alias is allowlisted; guest code only prints fixed, non-executable health fields.
 */
export function buildProotDistroProbeCommand(aliasInput: ProotDistroAlias): string {
  const alias = safeAlias(aliasInput);
  // Keep the guest snippet free of single quotes: the guarded Termux executor
  // wraps the complete command in `bash -c`, where each embedded quote expands
  // the payload. In v281 this pushed the otherwise short probe over the native
  // long-command staging threshold (1,251 > 1,200 chars); that staged route
  // returned an unframed transcript in the attached runtime log. These fixed,
  // read-only substitutions preserve the same ID/UID/architecture evidence.
  const guestProbe = `grep -m1 ^ID= /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d \\" | sed s/^/AIB_PROBE_ID:/; id -u 2>/dev/null | sed s/^/AIB_PROBE_UID:/; uname -m 2>/dev/null | sed s/^/AIB_PROBE_UNAME:/`;
  const body = [
    "echo AIB_PROBE_BEGIN",
    "if ! command -v proot-distro >/dev/null 2>&1; then echo AIB_PROOT_TOOL:MISSING; echo AIB_PROBE_END; exit 0; fi",
    "echo AIB_PROOT_TOOL:AVAILABLE",
    "HOST_UNAME=$(uname -m 2>/dev/null)",
    'case "$HOST_UNAME" in *[!A-Za-z0-9._-]*|"") HOST_UNAME=invalid;; esac',
    'echo "AIB_HOST_UNAME:$HOST_UNAME"',
    "echo AIB_LIST_BEGIN",
    'proot-distro list --quiet 2>&1; LIST_EC=$?; LIST_MODE=quiet; if [ "$LIST_EC" -ne 0 ]; then proot-distro list 2>&1; LIST_EC=$?; LIST_MODE=human; fi; echo "AIB_LIST_MODE:$LIST_MODE"',
    'echo "AIB_LIST_EXIT:$LIST_EC"',
    "echo AIB_LIST_END",
    "echo AIB_LOGIN_BEGIN",
    `proot-distro login ${alias} -- sh -c '${guestProbe.replace(/'/g, `'\\''`)}' 2>&1`,
    "PROBE_EC=$?",
    'echo "AIB_LOGIN_EXIT:$PROBE_EC"',
    "echo AIB_LOGIN_END",
    "echo AIB_PROBE_END",
  ];
  // The device RUN_COMMAND callback is cut at roughly 90-100 bytes, which dropped
  // the framing and left the state "unverified" forever. Run the probe into a
  // temp file and print ONE short summary line first (it survives truncation),
  // followed by the full transcript for the strict parser.
  const summary = [
    "T=0; grep -qx AIB_PROOT_TOOL:AVAILABLE \"$F\" && T=1",
    "E=$(sed -n s/^AIB_LOGIN_EXIT://p \"$F\" | head -1)",
    "N=0; grep -Eqx \"Error: container .?" + alias + ".? is not installed\\.?\" \"$F\" && N=1",
    "I=$(sed -n s/^AIB_PROBE_ID://p \"$F\" | head -1 | tr -cd A-Za-z0-9._-)",
    "M=$(sed -n s/^AIB_PROBE_UNAME://p \"$F\" | head -1 | tr -cd A-Za-z0-9._-)",
    "H=$(sed -n s/^AIB_HOST_UNAME://p \"$F\" | head -1 | tr -cd A-Za-z0-9._-)",
    'echo "AIB_C T=$T E=${E:--} N=$N I=${I:--} M=${M:--} H=${H:--}"',
  ];
  return [
    "set +e",
    'D="${TMPDIR:-${PREFIX:-}/tmp}"; mkdir -p "$D" 2>/dev/null; F="$D/aib-probe.$$"',
    "{ " + body.join("; ") + "; } >\"$F\" 2>&1",
    ...summary,
    'cat "$F"',
    'rm -f "$F"',
    "exit 0",
  ].join("; ");
}

/** Set LIST_ALIAS_VERIFIED only when one complete legacy/current installed section names this alias. */
export function buildProotInstalledAliasGuardShell(aliasInput: ProotDistroAlias): string {
  const alias = safeAlias(aliasInput);
  return `# Supports the legacy "Installed distributions" and current "Installed containers" headings.
LIST_HEADER_COUNT=$(printf '%s\\n' "$LIST_OUTPUT" | grep -Eic '^[[:space:]]*[Ii]nstalled (distributions|containers)[[:space:]]*:')
INSTALLED_BLOCK=$(printf '%s\\n' "$LIST_OUTPUT" | awk '/^[[:space:]]*[Ii]nstalled (distributions|containers)[[:space:]]*:/ { inside=1; sub(/^[^:]*:[[:space:]]*/, ""); if (length) print; next } inside && /^[[:space:]]*(supported|available|usage|options|commands)[[:space:]]/ { exit } inside && /^[^[:space:]].*:/ { exit } inside { print }')
LIST_ALIAS_COUNT=$(printf '%s\\n' "$INSTALLED_BLOCK" | grep -Eic '(^|[[:space:]()])${alias}([[:space:]()]|$)')
LIST_NONE_COUNT=$(printf '%s\\n' "$INSTALLED_BLOCK" | grep -Eic '^[[:space:]]*(\\(none\\)|none|no installed distributions|none installed)[[:space:]]*$')
LIST_ALIAS_VERIFIED=0
if [ "$LIST_EXIT_CODE" = 0 ] && [ "$LIST_HEADER_COUNT" = 1 ] && [ "$LIST_ALIAS_COUNT" -ge 1 ] && [ "$LIST_NONE_COUNT" -eq 0 ]; then
  LIST_ALIAS_VERIFIED=1
fi`;
}

/** One guarded install invocation only; it never resets, removes, or deletes an existing rootfs. */
export function buildProotDistroInstallCommand(aliasInput: ProotDistroAlias): string {
  const alias = safeAlias(aliasInput);
  const guestProbe = `ID=$(grep '^ID=' /etc/os-release 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'); case "$ID" in *[!a-zA-Z0-9._-]*) ID=invalid;; esac; printf 'AIB_PROBE_ID:%s\\n' "$ID"; printf 'AIB_PROBE_UID:%s\\n' "$(id -u 2>/dev/null)"; printf 'AIB_PROBE_UNAME:%s\\n' "$(uname -m 2>/dev/null)"`;
  return `set +e
if ! command -v proot-distro >/dev/null 2>&1; then echo AIB_PROOT_TOOL:MISSING; exit 127; fi
HEALTH_OUTPUT=$(proot-distro login ${alias} -- sh -c '${guestProbe.replace(/'/g, `'\\''`)}' 2>&1)
HEALTH_EC=$?
${PROOT_ARCH_NORMALIZER_SHELL}
HOST_UNAME=$(uname -m 2>/dev/null)
GUEST_UNAME=$(printf '%s\\n' "$HEALTH_OUTPUT" | sed -n 's/^AIB_PROBE_UNAME://p')
HOST_ARCH=$(aib_normalize_arch "$HOST_UNAME")
GUEST_ARCH=$(aib_normalize_arch "$GUEST_UNAME")
HEALTH_ID_COUNT=$(printf '%s\\n' "$HEALTH_OUTPUT" | grep -Fx -c 'AIB_PROBE_ID:${alias}')
HEALTH_UID_COUNT=$(printf '%s\\n' "$HEALTH_OUTPUT" | grep -c '^AIB_PROBE_UID:[0-9][0-9]*$')
HEALTH_UNAME_COUNT=$(printf '%s\\n' "$HEALTH_OUTPUT" | grep -c '^AIB_PROBE_UNAME:[A-Za-z0-9._-][A-Za-z0-9._-]*$')
if [ "$HEALTH_EC" -eq 0 ]; then
  if [ "$HEALTH_ID_COUNT" = 1 ] && [ "$HEALTH_UID_COUNT" = 1 ] && [ "$HEALTH_UNAME_COUNT" = 1 ] && [ -n "$HOST_ARCH" ] && [ "$HOST_ARCH" != invalid ] && [ "$HOST_ARCH" = "$GUEST_ARCH" ]; then
    echo ROOTFS_ALREADY_HEALTHY:${alias}
    exit 0
  fi
  echo ROOTFS_STATE_UNVERIFIED:${alias}
  echo ROOTFS_LOGIN_IDENTITY_OR_ARCH_UNVERIFIED:${alias}
  exit 78
fi
LIST_OUTPUT=$(proot-distro list 2>&1)
LIST_EXIT_CODE=$?
${buildProotInstalledAliasGuardShell(alias)}
LOGIN_NOT_INSTALLED_COUNT=$(printf '%s\\n' "$HEALTH_OUTPUT" | grep -Fxc "Error: container '${alias}' is not installed.")
if [ "$HEALTH_EC" -eq 1 ] && [ "$LOGIN_NOT_INSTALLED_COUNT" = 1 ] && [ "$LIST_ALIAS_VERIFIED" != 1 ]; then
  LOG_DIR="\${TMPDIR:-\${PREFIX:-}/tmp}"
  mkdir -p "$LOG_DIR" 2>/dev/null
  LOG_FILE="$LOG_DIR/aib-bootstrap-${alias}.$$.log"
  : > "$LOG_FILE" || { echo "INSTALL_EXIT:73"; echo "INSTALL_ERR:cannot create log file in $LOG_DIR"; exit 73; }
  proot-distro install ${alias} >"$LOG_FILE" 2>&1
  INSTALL_EC=$?
  echo "INSTALL_EXIT:$INSTALL_EC"
  INSTALL_LAST=$(grep -v '^[[:space:]]*$' "$LOG_FILE" 2>/dev/null | tail -1 | tr -d '\\r' | cut -c1-70)
  [ "$INSTALL_EC" -eq 0 ] || echo "INSTALL_ERR:$INSTALL_LAST"
  while IFS= read -r line || [ -n "$line" ]; do printf 'INSTALL_LINE:%s\\n' "$line"; done < "$LOG_FILE"
  exit "$INSTALL_EC"
fi
if [ "$LIST_ALIAS_VERIFIED" = 1 ]; then
  echo ROOTFS_INSTALLED_LOGIN_FAILED:${alias}
  printf '%s\\n' "$HEALTH_OUTPUT" | tail -20
  exit 78
fi
echo ROOTFS_STATE_UNVERIFIED:${alias}
printf '%s\\n' "$HEALTH_OUTPUT" | tail -20
exit 78`;
}

/** Quote user-selected paths as shell data; reject control characters rather than interpreting them. */
export function shellQuoteData(value: string): string {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("UNSAFE_SHELL_DATA");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Restore only into a confirmed-absent alias; never move, remove, reset, or extract over a rootfs. */
export function buildProotDistroRestoreCommand(aliasInput: ProotDistroAlias, sourcePath: string): string {
  const alias = safeAlias(aliasInput);
  const source = shellQuoteData(sourcePath);
  return `set +e
if ! command -v proot-distro >/dev/null 2>&1; then echo AIB_PROOT_TOOL:MISSING; exit 127; fi
if [ ! -f ${source} ]; then echo AIB_ROOTFS_RESTORE_ARCHIVE_MISSING; exit 2; fi
HEALTH_OUTPUT=$(proot-distro login ${alias} -- sh -c 'ID=$(grep "^ID=" /etc/os-release 2>/dev/null | head -1 | cut -d= -f2 | tr -d "\\\""); printf "AIB_PROBE_ID:%s\\n" "$ID"; uname -m' 2>&1)
HEALTH_EC=$?
if [ "$HEALTH_EC" -eq 0 ]; then echo AIB_ROOTFS_RESTORE_REFUSED_ALREADY_LOGINABLE:${alias}; exit 78; fi
LIST_OUTPUT=$(proot-distro list 2>&1)
LIST_EXIT_CODE=$?
${buildProotInstalledAliasGuardShell(alias)}
LOGIN_NOT_INSTALLED_COUNT=$(printf '%s\\n' "$HEALTH_OUTPUT" | grep -Fxc "Error: container '${alias}' is not installed.")
if [ "$HEALTH_EC" -ne 1 ] || [ "$LOGIN_NOT_INSTALLED_COUNT" != 1 ]; then
  if [ "$LIST_ALIAS_VERIFIED" = 1 ]; then echo AIB_ROOTFS_RESTORE_REFUSED_ALREADY_REGISTERED:${alias}; else echo AIB_ROOTFS_RESTORE_REFUSED_STATE_UNVERIFIED:${alias}; fi
  exit 78
fi
if [ "$LIST_ALIAS_VERIFIED" = 1 ]; then echo AIB_ROOTFS_RESTORE_REFUSED_STATE_UNVERIFIED:${alias}; exit 78; fi
LOG_DIR="\${TMPDIR:-\${PREFIX:-}/tmp}"; mkdir -p "$LOG_DIR" 2>/dev/null
LOG_FILE="$LOG_DIR/aib-restore-${alias}.$$.log"
proot-distro restore ${source} >"$LOG_FILE" 2>&1
RESTORE_EC=$?
while IFS= read -r line || [ -n "$line" ]; do printf 'RESTORE_LINE:%s\\n' "$line"; done < "$LOG_FILE"
if [ "$RESTORE_EC" -ne 0 ]; then echo "RESTORE_EXIT:$RESTORE_EC"; exit "$RESTORE_EC"; fi
VERIFY_OUTPUT=$(proot-distro login ${alias} -- sh -c 'ID=$(grep "^ID=" /etc/os-release 2>/dev/null | head -1 | cut -d= -f2 | tr -d "\\\""); printf "AIB_PROBE_ID:%s\\n" "$ID"; uname -m | grep -Eq "^[A-Za-z0-9._-]+$"')
VERIFY_EC=$?
if [ "$VERIFY_EC" -ne 0 ] || ! printf '%s\\n' "$VERIFY_OUTPUT" | grep -Fq 'AIB_PROBE_ID:${alias}'; then echo "AIB_ROOTFS_RESTORE_LOGIN_FAILED:${alias}; existing data was not removed"; exit 78; fi
echo AIB_ROOTFS_RESTORE_OK:${alias}
exit 0`;
}

/** A deletion request must be performed explicitly in Termux, never by the package helper. */
export function buildProotDistroRemoveGuardCommand(aliasInput: ProotDistroAlias): string {
  const alias = safeAlias(aliasInput);
  return `echo 'ROOTFS_PRESERVED:${alias}:automatic removal is disabled'; exit 64`;
}


interface ProotCompactSummary { tool: boolean; loginExit: number | null; notInstalled: boolean; id?: string; uname?: string; hostUname?: string }

function parseCompactSummary(output: string): ProotCompactSummary | null {
  const lines = output.split("\n").filter((l) => l.startsWith("AIB_C "));
  if (lines.length !== 1) return null;
  const m = lines[0].match(/^AIB_C T=([01]) E=(-?\d+|-) N=([01]) I=(\S+) M=(\S+) H=(\S+)$/);
  if (!m) return null;
  const val = (v: string) => (v === "-" ? undefined : v);
  return {
    tool: m[1] === "1",
    loginExit: m[2] === "-" ? null : Number(m[2]),
    notInstalled: m[3] === "1",
    id: val(m[4])?.toLowerCase(),
    uname: val(m[5]),
    hostUname: val(m[6]),
  };
}

export function parseProotDistroProbe(aliasInput: ProotDistroAlias, rawOutput: string, commandExitCode = 0): ProotDistroState {
  const alias = safeAlias(aliasInput);
  // ANSI sequences may be emitted by proot-distro or a Termux shell profile.
  // Strip presentation-only escapes before strict marker matching; keep framing,
  // exact alias identity and all exit-code checks strict.
  const output = String(rawOutput ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const listFrame = between(output, "AIB_LIST_BEGIN", "AIB_LIST_END");
  const loginFrame = between(output, "AIB_LOGIN_BEGIN", "AIB_LOGIN_END");
  const outputTruncated = markerCount(output, "TERMUX_RESULT_OUTPUT_TRUNCATED") > 0;

  // Short summary line (survives the device callback truncation).
  const compact = parseCompactSummary(output);
  if (compact && !outputTruncated && commandExitCode === 0 && markerCount(output, "AIB_PROBE_END") === 0) {
    const host = compact.hostUname ? normalizeProotArchitecture(compact.hostUname) : null;
    const guest = compact.uname ? normalizeProotArchitecture(compact.uname) : null;
    const archOk = guest !== null && (host === null || host === guest);
    const compactHealthy = compact.tool && compact.loginExit === 0 && compact.id === alias && archOk;
    if (compactHealthy || (compact.tool && compact.notInstalled && compact.loginExit === 1) || !compact.tool) {
      const parserOutcome: ProotDistroParserOutcome = compactHealthy ? "healthy" : compact.tool ? "missing" : "tool-unavailable";
      return {
        alias,
        toolAvailable: compact.tool,
        installed: compactHealthy ? true : compact.tool ? false : null,
        healthy: compactHealthy,
        aiBuilderRegistration: compact.tool ? "not-required-for-health" : "unknown",
        evidence: compactHealthy ? "login-smoke" : compact.tool ? "login-not-installed" : "unverified",
        listEvidence: "incomplete",
        parserOutcome,
        listExitCode: null,
        ...(compact.id ? { osReleaseId: compact.id } : {}),
        ...(compact.uname ? { uname: compact.uname } : {}),
        ...(compact.hostUname ? { hostUname: compact.hostUname } : {}),
        architectureMatches: compactHealthy,
        listOutput: "",
        diagnostic: compactHealthy ? "ROOTFS_HEALTHY" : compact.tool ? "ROOTFS_ABSENT" : "PROOT_DISTRO_UNAVAILABLE",
      } as ProotDistroState;
    }
  }
  const envelopeFrame = between(output, "AIB_PROBE_BEGIN", "AIB_PROBE_END");
  const completeEnvelope = commandExitCode === 0 && !outputTruncated && envelopeFrame !== null;
  const toolAvailable = completeEnvelope && markerCount(output, "AIB_PROOT_TOOL:AVAILABLE") === 1 && markerCount(output, "AIB_PROOT_TOOL:MISSING") === 0;
  const completeList = listFrame !== null;
  const completeLogin = loginFrame !== null;
  const listExitMatches = completeList ? [...output.matchAll(/^AIB_LIST_EXIT:(-?\d+)$/gm)] : [];
  const listExitCode = listExitMatches.length === 1 ? Number(listExitMatches[0][1]) : null;
  const listModeMatches = completeList ? [...(listFrame ?? "").matchAll(/^AIB_LIST_MODE:(quiet|human)$/gm)] : [];
  const listMode = listModeMatches.length === 1 ? listModeMatches[0][1] : null;
  const listPayload = (listFrame ?? "").replace(/^AIB_LIST_MODE:(?:quiet|human)$/gm, "").replace(/^AIB_LIST_EXIT:-?\d+$/gm, "").trim();
  const list = completeEnvelope && listExitCode === 0 && completeList
    ? parseInstalledProotDistroList(listPayload, listMode === "quiet")
    : { known: false, aliases: [] as readonly ProotDistroAlias[] };
  const loginExitMatches = completeLogin ? [...output.matchAll(/^AIB_LOGIN_EXIT:(-?\d+)$/gm)] : [];
  const loginExit = completeEnvelope && completeLogin && loginExitMatches.length === 1 ? Number(loginExitMatches[0][1]) : -1;
  const loginOutput = (loginFrame ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  // Prefer framed login body; if the bridge dropped AIB_LOGIN_* frames, read
  // identity markers from the full transcript (same fixed probe format).
  const identitySource = completeLogin ? loginOutput : output;
  const idMatches = [...identitySource.matchAll(/^AIB_PROBE_ID:([A-Za-z0-9._-]{1,64})$/gm)];
  const uidMarkerLines = [...identitySource.matchAll(/^AIB_PROBE_UID:.*$/gm)];
  const uidMatches = [...identitySource.matchAll(/^AIB_PROBE_UID:([0-9]{1,12})$/gm)];
  const uidEvidenceValid = uidMarkerLines.length === 0 || (uidMarkerLines.length === 1 && uidMatches.length === 1);
  const unameMatches = [...identitySource.matchAll(/^AIB_PROBE_UNAME:([A-Za-z0-9._-]{1,64})$/gm)];
  const osReleaseId = idMatches.length === 1 ? idMatches[0][1].toLowerCase() : undefined;
  const uid = uidEvidenceValid && uidMatches.length === 1 ? uidMatches[0][1] : undefined;
  const uname = unameMatches.length === 1 ? unameMatches[0][1] : undefined;
  const hostUnameMatches = [...output.matchAll(/^AIB_HOST_UNAME:([A-Za-z0-9._-]{1,64})$/gm)];
  const hostUname = hostUnameMatches.length === 1 ? hostUnameMatches[0][1] : undefined;
  const hostArchitecture = hostUname ? normalizeProotArchitecture(hostUname) : null;
  const guestArchitecture = uname ? normalizeProotArchitecture(uname) : null;
  const architectureMatches = hostArchitecture !== null && guestArchitecture !== null && hostArchitecture === guestArchitecture;
  const listOutput = listFrame ?? "";
  const listEvidence: ProotDistroListEvidence = !completeEnvelope || !completeList || listExitCode !== 0
    ? "incomplete"
    : !list.known
      ? "unrecognized"
      : list.aliases.includes(alias)
        ? "alias-listed"
        : list.aliases.length === 0
          ? "explicit-empty"
          : "alias-not-listed";
  const listVerified = listEvidence === "alias-listed";
  const loginIdentityVerified = completeLogin && loginExit === 0 && osReleaseId === alias && Boolean(uid) && Boolean(uname) && architectureMatches;
  // Device RUN_COMMAND may drop trailing AIB_*_END frames while still delivering
  // exact guest identity (observed ~87–103 B callbacks with ID/UID/UNAME). Accept
  // only when ID matches the alias; if host uname is missing, require a normalized
  // guest arch so random text cannot pass. Never promote that case to "missing".
  const partialGuestArch = uname ? normalizeProotArchitecture(uname) : null;
  // UID may be absent in the shortest ~87 B callbacks; ID + normalized UNAME
  // are enough then. If a UID marker is present, it must be one numeric value.
  const partialIdentityVerified =
    !outputTruncated
    && !loginIdentityVerified
    && osReleaseId === alias
    && Boolean(uname)
    && partialGuestArch !== null
    && markerCount(output, "AIB_PROBE_BEGIN") >= 1
    && markerCount(output, `AIB_PROBE_ID:${alias}`) === 1
    && uidEvidenceValid
    && (architectureMatches || !hostUname);
  // In upstream proot-distro, login resolves the exact container and opens
  // its rootfs before executing the guest command. These framed identity
  // markers therefore prove presence; list output is only secondary evidence.
  const healthy = (completeEnvelope && toolAvailable && loginIdentityVerified) || partialIdentityVerified;
  const loginSucceeded = completeEnvelope && toolAvailable && completeLogin && loginExit === 0;
  const loginNotInstalled = completeEnvelope && toolAvailable && completeLogin && loginExit === 1
    && loginOutput.split("\n").filter((line) => line === `Error: container '${alias}' is not installed.`).length === 1;
  const evidenceConflict = loginNotInstalled && listVerified;
  const installed = healthy || loginSucceeded || listVerified
    ? true
    : loginNotInstalled
      ? false
      : null;
  const parserOutcome: ProotDistroParserOutcome = healthy ? "healthy"
    : !completeEnvelope && !partialIdentityVerified ? "incomplete-envelope"
      : markerCount(output, "AIB_PROOT_TOOL:MISSING") === 1 ? "tool-unavailable"
        : evidenceConflict ? "evidence-conflict"
          : loginNotInstalled ? "missing"
            : installed === true && osReleaseId === alias && Boolean(uid) && Boolean(uname) && !architectureMatches ? "architecture-mismatch"
              : listEvidence === "unrecognized" || listEvidence === "incomplete" ? "list-unverified"
                : installed === true ? "installed-unhealthy" : "identity-unverified";
  return {
    alias,
    toolAvailable: toolAvailable || partialIdentityVerified,
    installed,
    healthy,
    aiBuilderRegistration: toolAvailable || partialIdentityVerified ? "not-required-for-health" : "unknown",
    evidence: healthy ? "login-smoke" : loginSucceeded ? "login-smoke-unhealthy" : loginNotInstalled && !evidenceConflict ? "login-not-installed" : installed === true ? "installed-list" : "unverified",
    listEvidence,
    parserOutcome,
    listExitCode,
    ...(osReleaseId ? { osReleaseId } : {}),
    ...(uid ? { uid } : {}),
    ...(uname ? { uname } : {}),
    ...(hostUname ? { hostUname } : {}),
    architectureMatches: architectureMatches || (partialIdentityVerified && partialGuestArch !== null),
    listOutput,
    diagnostic: healthy ? "ROOTFS_HEALTHY" : !completeEnvelope && !partialIdentityVerified ? "PROOT_PROBE_INCOMPLETE" : !toolAvailable ? "PROOT_DISTRO_UNAVAILABLE" : evidenceConflict ? "ROOTFS_STATE_UNVERIFIED" : loginNotInstalled ? "ROOTFS_ABSENT" : installed === true && osReleaseId === alias && Boolean(uid) && Boolean(uname) && !architectureMatches ? "ROOTFS_ARCH_MISMATCH" : listVerified ? "ROOTFS_INSTALLED_LOGIN_FAILED" : "ROOTFS_LIST_UNVERIFIED",
  };
}

export function normalizeProotArchitecture(value: string): string | null {
  const machine = String(value ?? "").trim().toLowerCase();
  if (!machine || machine === "invalid" || !/^[a-z0-9._-]{1,64}$/.test(machine)) return null;
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  if (machine === "arm" || /^armv[5-8]/.test(machine)) return "arm32";
  if (machine === "x86_64" || machine === "amd64") return "x86_64";
  if (machine === "x86" || /^i[3-6]86$/.test(machine)) return "x86";
  return machine;
}

function markerCount(text: string, marker: string): number {
  return text.split("\n").filter((line) => line === marker).length;
}

function between(text: string, start: string, end: string): string | null {
  const lines = text.split("\n");
  const startIndex = lines.indexOf(start);
  const endIndex = lines.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex || startIndex !== lines.lastIndexOf(start) || endIndex !== lines.lastIndexOf(end)) return null;
  return lines.slice(startIndex + 1, endIndex).join("\n").trim();
}
