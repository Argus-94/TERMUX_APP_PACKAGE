const SECRET_ASSIGNMENT = /\b(?:[A-Z0-9_]*(?:API[_-]?KEY|KEY|TOKEN|PASSWORD|SECRET|PAIRING[_-]?CODE|AUTHORIZATION)[A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/gi;
const SECRET_OPTION = /(--(?:api[-_]?key|token|password|secret|pairing[-_]?code)(?:=|\s+))(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/gi;
const BEARER = /(\bauthorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const ADB_PAIR = /\badb\s+pair\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i;

function capturedSecrets(input: string): string[] {
  const values = new Set<string>();
  SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of input.matchAll(SECRET_ASSIGNMENT)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) values.add(value);
  }
  SECRET_OPTION.lastIndex = 0;
  for (const match of input.matchAll(SECRET_OPTION)) {
    const value = match[2] ?? match[3] ?? match[4];
    if (value) values.add(value);
  }
  const pair = input.match(ADB_PAIR);
  const pairCode = pair?.[1] ?? pair?.[2] ?? pair?.[3];
  if (pairCode) values.add(pairCode);
  return [...values].filter((value) => value.length > 0);
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function redactCommandForLogs(command: string): string {
  return String(command)
    .replace(ADB_PAIR, (_whole, doubleQuoted: string | undefined, singleQuoted: string | undefined, plain: string | undefined) => {
      const original = _whole;
      const code = doubleQuoted ?? singleQuoted ?? plain;
      return code ? original.replace(code, "[REDACTED]") : original;
    })
    .replace(SECRET_ASSIGNMENT, (_whole, doubleQuoted: string | undefined, singleQuoted: string | undefined, plain: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? plain;
      return value ? _whole.replace(value, "[REDACTED]") : _whole;
    })
    .replace(SECRET_OPTION, (_whole, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, plain: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? plain;
      return value ? _whole.replace(value, "[REDACTED]") : prefix;
    })
    .replace(BEARER, "$1[REDACTED]");
}

/** Legacy UI-only output redaction. Never persist this unbounded value as a diagnostic. */
export function redactCommandOutputForLogs(command: string, output: string): string {
  let safe = String(output);
  for (const secret of capturedSecrets(command)) safe = safe.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  safe = safe
    .replace(SECRET_ASSIGNMENT, (_whole, doubleQuoted: string | undefined, singleQuoted: string | undefined, plain: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? plain;
      return value ? _whole.replace(value, "[REDACTED]") : _whole;
    })
    .replace(SECRET_OPTION, (_whole, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, plain: string | undefined) => {
      const value = doubleQuoted ?? singleQuoted ?? plain;
      return value ? _whole.replace(value, "[REDACTED]") : prefix;
    })
    .replace(BEARER, "$1[REDACTED]");
  return safe;
}

/** Coarse, content-free command category for diagnostics; no shell text or paths are returned. */
export function classifyCommandForDiagnostics(command: string): string {
  const text = String(command ?? "").toLowerCase();
  // Real rootfs install only (NOT every proot-wrapped command that mentions "install").
  if (
    /proot-distro\s+install\b/.test(text) ||
    /\b(?:ubuntu|debian)_install_ok\b/.test(text) ||
    /aib_rootfs_bootstrap/.test(text)
  ) {
    return "rootfs-install";
  }
  if (
    /\baib_toolchain_(?:start|end)\b/.test(text) ||
    /\b(?:gradle|gradlew|flutter|aapt2?|d8|zipalign|apksigner)\b/.test(text) ||
    /android-sdk|android_home|java=|sdk_platforms=/.test(text)
  ) {
    return "build-tool";
  }
  if (/\b(?:apt-get|apt|dpkg)\b/.test(text)) return "guest-package-manager";
  if (/\b(?:pkg|termux-change-repo)\b/.test(text)) return "termux-package-manager";
  if (/proot-distro|aib_(?:probe|list|login|proot_tool)|rootfs/.test(text)) return "rootfs-probe";
  if (/\b(?:curl|wget)\b/.test(text)) return "network-fetch";
  if (/(^|[;&|\s])git\s/.test(text)) return "git";
  if (/\b(?:mkdir|rm|cp|mv|touch|cat|find|grep|sed|awk|stat|test)\b/.test(text)) return "filesystem-operation";
  if (/^\s*echo\b/.test(text)) return "shell-probe";
  return "shell-command";
}

const SAFE_PROBE_MARKERS = new Set([
  "AIB_PROBE_BEGIN", "AIB_PROBE_END", "AIB_LIST_BEGIN", "AIB_LIST_END", "AIB_LOGIN_BEGIN", "AIB_LOGIN_END",
  "AIB_LIST_MODE:quiet", "AIB_LIST_MODE:human",
  "AIB_PROOT_TOOL:AVAILABLE", "AIB_PROOT_TOOL:MISSING", "AIB_LIST_EXIT:0", "AIB_LIST_EXIT:1",
  "AIB_LOGIN_EXIT:0", "AIB_LOGIN_EXIT:1", "AIB_PROBE_ID:ubuntu", "AIB_PROBE_ID:debian",
  "ROOTFS_STATE_UNVERIFIED:ubuntu", "ROOTFS_STATE_UNVERIFIED:debian",
  "ROOTFS_ALREADY_HEALTHY:ubuntu", "ROOTFS_ALREADY_HEALTHY:debian",
  "ROOTFS_INSTALLED_LOGIN_FAILED:ubuntu", "ROOTFS_INSTALLED_LOGIN_FAILED:debian",
  "AIB_UBUNTU_ROOTFS_OK", "AIB_DEBIAN_ROOTFS_OK", "AIB_UBUNTU_ROOTFS_MISSING", "AIB_DEBIAN_ROOTFS_MISSING",
  "AIB_UBUNTU_ROOTFS_STATE_UNVERIFIED", "AIB_DEBIAN_ROOTFS_STATE_UNVERIFIED",
]);
const SAFE_ARCHES = new Set(["aarch64", "arm64", "x86_64", "amd64", "i386", "i686", "armv7l", "riscv64"]);

/** UTF-8 byte size for diagnostic counters; never returns or stores the text. */
export function utf8ByteLengthForDiagnostics(value: string): number {
  let bytes = 0;
  for (const character of String(value ?? "")) {
    const codePoint = character.codePointAt(0) ?? 0xfffd;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function isSafeProbeMarker(line: string): boolean {
  if (SAFE_PROBE_MARKERS.has(line)) return true;
  const architecture = line.match(/^(AIB_(?:PROBE|HOST)_UNAME):([A-Za-z0-9._-]{1,64})$/);
  if (architecture && SAFE_ARCHES.has(architecture[2].toLowerCase())) return true;
  return /^AIB_PROBE_UID:\d{1,12}$/.test(line);
}

/** Validate and canonicalize an already summarized output value before preserving it. */
export function sanitizeCommandOutputSummary(value: string): string | null {
  const text = String(value ?? "");
  if (text === "[OUTPUT_EMPTY]") return text;
  const safeMatch = text.match(/^\[SAFE_MARKERS ([^\]]+)\] \[OTHER_OUTPUT_OMITTED chars=(\d+)(?: utf8Bytes=(\d+))?\]$/);
  if (safeMatch) {
    const markers = [...new Set(safeMatch[1].split(/\s+/).filter(isSafeProbeMarker))].slice(0, 32);
    if (!markers.length) return null;
    const byteField = safeMatch[3] === undefined ? "" : ` utf8Bytes=${safeMatch[3]}`;
    return `[SAFE_MARKERS ${markers.join(" ")}] [OTHER_OUTPUT_OMITTED chars=${safeMatch[2]}${byteField}]`;
  }
  const omitted = text.match(/^\[COMMAND_OUTPUT_OMITTED chars=(\d+)(?: utf8Bytes=(\d+))? lines=(\d+)\]$/);
  if (omitted) {
    const byteField = omitted[2] === undefined ? "" : ` utf8Bytes=${omitted[2]}`;
    return `[COMMAND_OUTPUT_OMITTED chars=${omitted[1]}${byteField} lines=${omitted[3]}]`;
  }
  return null;
}

/** Summarize a command result for persistent logs while keeping full output only in the transient console UI. */
export function summarizeCommandOutputForLogs(_command: string, output: string): string {
  const text = String(output ?? "");
  if (!text) return "[OUTPUT_EMPTY]";
  const metrics = `chars=${text.length} utf8Bytes=${utf8ByteLengthForDiagnostics(text)}`;
  const markers: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (SAFE_PROBE_MARKERS.has(line)) markers.push(line);
    else {
      const m = line.match(/^(AIB_(?:PROBE|HOST)_UNAME):([A-Za-z0-9._-]{1,64})$/);
      if (m && SAFE_ARCHES.has(m[2].toLowerCase())) markers.push(`${m[1]}:${m[2].toLowerCase()}`);
      const uid = line.match(/^AIB_PROBE_UID:(\d{1,12})$/);
      if (uid) markers.push(`AIB_PROBE_UID:${uid[1]}`);
    }
    if (markers.length >= 32) break;
  }
  const unique = [...new Set(markers)];
  return unique.length
    ? `[SAFE_MARKERS ${unique.join(" ")}] [OTHER_OUTPUT_OMITTED ${metrics}]`
    : `[COMMAND_OUTPUT_OMITTED ${metrics} lines=${text.split(/\r?\n/).length}]`;
}
