/**
 * AI Builder device-command security policy (inspired by DSHA ideas, written for AIB).
 * Always-on allowlist for elevated / shell entry points — not a kernel sandbox.
 */
import { persistentLogger } from "./persistent-logger";
import { catastrophicCommandReason, isAgentUnrestrictedShell } from "./agent-unrestricted.ts";

export type ExecChannel = "termux" | "shizuku" | "adb" | "plugin";

export type PolicyVerdict = {
  ok: boolean;
  reason?: string;
  normalized?: string;
};

/** High-risk path prefixes — never allow as write targets via policy-checked exec. */
export const FORBIDDEN_PATH_PREFIXES = [
  "/system",
  "/vendor",
  "/proc",
  "/sys",
  "/data/data/", // other apps; our own package is handled separately
  "/data/user/",
] as const;

/** Command name allowlist (first token after env vars). Empty = deny unknown for elevated channels. */
const ELEVATED_COMMAND_ALLOW = new Set([
  "echo",
  "true",
  "false",
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "test",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "chmod",
  "stat",
  "find",
  "grep",
  "sed",
  "awk",
  "tar",
  "gzip",
  "curl",
  "wget",
  "node",
  "npm",
  "pnpm",
  "python",
  "python3",
  "java",
  "javac",
  "gradle",
  "gradlew",
  "pkill",
  "kill",
  "adb",
  "sdkmanager",
  "pkg",
  "apt",
  "apt-get",
  "proot-distro",
  "proot",
  "bash",
  "sh",
  "uname",
  "id",
  "whoami",
  "df",
  "du",
  "which",
  "command",
  "rish",
  "git",
  "zip",
  "unzip",
  "aapt",
  "aapt2",
  "d8",
  "zipalign",
  "apksigner",
  "kotlinc",
  "keytool",
]);

const FORBIDDEN_SUBSTRINGS = [
  "mkfs",
  "dd if=",
  ":(){",
  "rm -rf /",
  "rm -rf /*",
  "chmod -R 777 /",
  "> /dev/sd",
  "reboot",
  "fastboot",
];

function firstCommandToken(cmd: string): string {
  const s = cmd.trim().replace(/^(\w+=\S+\s+)+/, "");
  const m = s.match(/^([a-zA-Z0-9_./+-]+)/);
  return m ? m[1].split("/").pop() || m[1] : "";
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { current += ch; escaped = true; continue; }
    if (quote === "'") { current += ch; if (ch === "'") quote = null; continue; }
    if (quote === '"') { current += ch; if (ch === '"') quote = null; continue; }
    if (ch === "'") { quote = "'"; current += ch; continue; }
    if (ch === '"') { quote = '"'; current += ch; continue; }
    if (";&|()\n\r".includes(ch)) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellWords(command: string): string[] {
  return (command.match(/'(?:[^']*)'|"(?:\\.|[^"\\])*"|[^\s]+/g) ?? []).map((word) => {
    if (word.length >= 2 && ((word[0] === "'" && word.at(-1) === "'") || (word[0] === '"' && word.at(-1) === '"'))) return word.slice(1, -1).replace(/\\([\\"'$`])/g, "$1");
    return word;
  });
}

function isAdbInvocation(command: string, depth = 0): boolean {
  if (depth > 4) return true;
  for (const segment of splitShellSegments(command)) {
    const words = shellWords(segment);
    let index = 0;
    while (index < words.length) {
      const word = words[index];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { index++; continue; }
      const name = word.replace(/^.*[\\/]/, "").toLowerCase();
      if (name === "env") {
        index++;
        while (index < words.length && (words[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index++;
        continue;
      }
      if (["command", "exec", "nohup", "time", "nice", "sudo", "doas", "eval", "source"].includes(name)) { index++; while (index < words.length && words[index].startsWith("-")) index++; continue; }
      if (name === "busybox") { index++; continue; }
      if (["sh", "bash", "dash", "ash", "zsh", "ksh"].includes(name)) {
        const commandFlag = words.findIndex((candidate, at) => at > index && (candidate === "-c" || candidate === "--command"));
        if (commandFlag >= 0 && words[commandFlag + 1] !== undefined && isAdbInvocation(words[commandFlag + 1], depth + 1)) return true;
      }
      if (name === "adb") return true;
      break;
    }
    for (const match of segment.matchAll(/\$\(([^()]*)\)/g)) if (isAdbInvocation(match[1], depth + 1)) return true;
    for (const match of segment.matchAll(/`([^`]*)`/g)) if (isAdbInvocation(match[1], depth + 1)) return true;
  }
  return false;
}

/** Reject shell syntax that can dispatch additional commands in restricted channels. */
function hasShellControlSyntax(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return true;
      continue;
    }
    if (ch === "'") quote = "'";
    else if (ch === '"') quote = '"';
    else if (";&|<>\n\r`".includes(ch)) return true;
    else if (ch === "$" && command[i + 1] === "(") return true;
  }
  return false;
}

function elevatedCommandExecutionRisk(command: string, token: string): string | null {
  if (["bash", "sh", "rish", "node", "python", "python3", "java"].includes(token)) {
    return `executable can interpret or launch arbitrary code: ${token}`;
  }
  if (token === "find" && /(?:^|\s)-(?:exec|execdir|ok|okdir|delete)(?=\s|$)/i.test(command)) {
    return "find execution or delete options are not allowed";
  }
  if (token === "awk" && /\bsystem\s*\(/i.test(command)) {
    return "awk system() execution is not allowed";
  }
  if (token === "tar" && /--(?:to-command|checkpoint-action|use-compress-program)(?:=|\s)/i.test(command)) {
    return "tar command-execution options are not allowed";
  }
  return null;
}

/**
 * Policy check before elevated or agent-driven shell.
 * channel "termux" interactive user input is more permissive (only blocks forbidden patterns).
 */
export function evaluateCommandPolicy(
  command: string,
  channel: ExecChannel,
  opts?: { interactive?: boolean },
): PolicyVerdict {
  const raw = String(command || "").trim();
  if (!raw) return { ok: false, reason: "empty command" };

  // No compatibility mode may access another application's private data.
  for (const match of raw.matchAll(/\/data\/(?:data|user(?:_de)?\/\d+)\/([A-Za-z0-9_.]+)/g)) {
    if (match[1] !== "com.karat.aibuilder") return { ok: false, reason: "foreign app-private path is forbidden" };
  }
  // The private agent shell retains its catastrophic floor.
  // Elevated channels (Shizuku/ADB/plugin) keep their strict allowlist.
  if (channel === "termux" && isAgentUnrestrictedShell()) {
    const floor = catastrophicCommandReason(raw);
    return floor ? { ok: false, reason: `forbidden pattern: ${floor}` } : { ok: true, normalized: raw };
  }

  const lower = raw.toLowerCase();
  if (isAdbInvocation(raw) && !(channel === "termux" && opts?.interactive)) {
    return { ok: false, reason: "generic ADB execution is not allowed; use an explicit DeviceBridge operation" };
  }
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(bad.toLowerCase())) {
      return { ok: false, reason: `forbidden pattern: ${bad}` };
    }
  }

  // Path probes in write-like forms.
  // Only AI Builder owns this private PREFIX; no other application is exempt.
  // Deny foreign app-private write targets.
  if (/\b(rm|mv|chmod|chown)\b/i.test(raw)) {
    const hasTermuxData = /\/data\/data\/com\.karat\.aibuilder\b/i.test(raw);
    const hasOtherAppData =
      /\/data\/data\/(?!com\.karat\.aibuilder\b)[\w.]+/i.test(raw) ||
      (/\/data\/data\//i.test(raw) && !hasTermuxData && !/\$PREFIX\b|\$HOME\b/.test(raw));
    if (hasOtherAppData && !/aibuilder|com\.anonymous/i.test(raw)) {
      return { ok: false, reason: "forbidden path scope: /data/data/ (non-Termux)" };
    }
    if (/\/(system|vendor)\b/i.test(raw) && /\b(rm|mv|chmod|chown)\b/i.test(raw)) {
      if (!hasTermuxData) {
        return { ok: false, reason: "forbidden path scope: /system or /vendor" };
      }
    }
  }

  if (channel === "termux" && opts?.interactive) {
    return { ok: true, normalized: raw };
  }

  if (channel === "shizuku" || channel === "adb" || channel === "plugin") {
    const tok = firstCommandToken(raw);
    if (!tok || !ELEVATED_COMMAND_ALLOW.has(tok)) {
      return { ok: false, reason: `command not allowlisted for ${channel}: ${tok || "?"}` };
    }
    if (hasShellControlSyntax(raw)) {
      return { ok: false, reason: `shell control syntax is not allowed for ${channel}` };
    }
    if (channel === "shizuku" || channel === "plugin") {
      const risk = elevatedCommandExecutionRisk(raw, tok);
      if (risk) return { ok: false, reason: `command not allowed for ${channel}: ${risk}` };
    }
  }

  // Agent termux (non-interactive): still block forbidden; prefer known tools
  if (channel === "termux" && !opts?.interactive) {
    const tok = firstCommandToken(raw);
    // pipelines / compound — allow but log
    if (tok && !ELEVATED_COMMAND_ALLOW.has(tok) && !raw.includes("|") && !raw.startsWith("cd ")) {
      persistentLogger.add("debug", "Policy", `termux agent uncommon cmd: ${tok}`);
    }
  }

  return { ok: true, normalized: raw };
}

export function assertCommandAllowed(
  command: string,
  channel: ExecChannel,
  opts?: { interactive?: boolean },
): string {
  const v = evaluateCommandPolicy(command, channel, opts);
  if (!v.ok) {
    persistentLogger.add("warn", "Policy", `deny ${channel}: ${v.reason}`);
    throw new Error(`SECURITY_POLICY_DENIED: ${v.reason}`);
  }
  return v.normalized || command;
}

export type SecurityPolicySummary = {
  elevatedAllowCount: number;
  forbiddenPathCount: number;
  channels: ExecChannel[];
};

export function getSecurityPolicySummary(): SecurityPolicySummary {
  return {
    elevatedAllowCount: ELEVATED_COMMAND_ALLOW.size,
    forbiddenPathCount: FORBIDDEN_PATH_PREFIXES.length,
    channels: ["termux", "shizuku", "adb", "plugin"],
  };
}
