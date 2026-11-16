import { catastrophicCommandReason, isAgentUnrestrictedShell } from "./agent-unrestricted.ts";
/**
 * Whitelist путей и опасных команд для Termux-агента.
 * Опасные операции требуют allowDangerous=true или UI confirm (confirmable).
 * По умолчанию dangerous mode выключен (caller не должен передавать allowDangerous).
 */

const SAFE_ROOTS = [
  "$HOME",
  "$AIB_PRIVATE_ROOT",
  "~",
  "/storage/emulated/0/AIBuilderTermux",
  "$PREFIX",
];

/** Жёсткий блок — не confirmable, только allowDangerous. */
const HARD_BLOCK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/i, reason: "Refusing rm on filesystem root" },
  { re: /\brm\s+(-[rf]+\s+)+\/(?!data\/data\/com\.karat\.aibuilder|storage|sdcard|home|tmp|var\/tmp)/i, reason: "Refusing rm -rf outside allowed roots" },
  { re: /\bmkfs\b/i, reason: "Blocked mkfs" },
  { re: /\bdd\s+.*\bof=\/dev\//i, reason: "Blocked dd to device" },
  { re: /\bdd\s+if=/i, reason: "Blocked dd if=" },
  { re: /(?:^|[^A-Za-z0-9_]):\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/i, reason: "Blocked fork bomb" },
  { re: /\bchmod\s+-R\s+777\s+\//i, reason: "Blocked chmod -R 777 /" },
  { re: /\bcd\s+(?:["\']?[^;&|\n]*\/)?\.\.(?:\/|["\']?(?:\s|$))/i, reason: "Blocked directory traversal via cd" },
  { re: />\s*\/dev\/sd[a-z]/i, reason: "Blocked write to block device" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "Blocked power control command" },
];

/** Confirmable — можно разрешить через UI. */
const CONFIRMABLE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(?:curl|wget|ftp|sftp|ssh|scp|nc|ncat|netcat)\b/i, reason: "network access from model-generated shell" },
  { re: /\bgit\s+(?:clone|fetch|pull|push|submodule\s+(?:add|update))\b/i, reason: "Git network operation" },
  { re: /\b(?:pkg|apt|apt-get)\s+(?:install|update|upgrade|download|remove|purge)\b/i, reason: "package-manager operation" },
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|publish|link)\b/i, reason: "package-manager operation" },
  { re: /\bpip(?:3)?\s+install\b/i, reason: "package installation" },
  { re: /\bfind\b[^;&|\n]*\s-(?:delete|exec|execdir|ok|okdir)(?=\s|$)/i, reason: "find mutation or command execution" },
  { re: /\bcurl\b[\s\S]{0,200}\|\s*(ba)?sh\b/i, reason: "curl piped to shell" },
  { re: /\bwget\b[\s\S]{0,200}\|\s*(ba)?sh\b/i, reason: "wget piped to shell" },
  { re: /\b(?:sh|bash|dash|ash|zsh|ksh)\s+(?:--command|-[A-Za-z]*c[A-Za-z]*)(?=\s|$)/i, reason: "nested shell command string" },
  { re: /\b(curl|wget)\b[\s\S]{0,120}\|\s*(ba)?sh\b/i, reason: "download piped to shell" },
  { re: /\bbase64\b[\s\S]{0,80}\|\s*(ba)?sh\b/i, reason: "base64 piped to shell" },
  { re: /\bpython(?:3)?\s+-c\b/i, reason: "python -c inline code" },
  { re: /\bperl\s+-e\b/i, reason: "perl -e inline code" },
  { re: /\bnode\s+-e\b/i, reason: "node -e inline code" },
  { re: /\bphp\s+-r\b/i, reason: "php -r inline code" },
  { re: /\bruby\s+-e\b/i, reason: "ruby -e inline code" },
  { re: /\$\([^)]+\)/, reason: "command substitution $()" },
  { re: /`[^`]+`/, reason: "backtick command substitution" },
  { re: /\bchmod\s+-R\s+777\b/i, reason: "chmod -R 777" },
  { re: /\bchown\s+-R\b/i, reason: "chown -R" },
  { re: /\bsudo\b/i, reason: "sudo" },
  { re: /\bsu\s+-/i, reason: "su -" },
  { re: /(?:^|[;|&]\s*)su(?:\s|$)/i, reason: "su (privilege escalation)" },
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive)\b/i, reason: "rm -rf (destructive delete)" },
  { re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b/i, reason: "recursive tree delete" },
  { re: /\bproot-distro\s+(?:reset|remove|uninstall)\b/i, reason: "proot rootfs reset/removal" },
  { re: /\bzip\s+(?:-[^\s]*?(?:FS|f)[^\s]*\s+|[^\n;]*--(?:overwrite|force)\b)/i, reason: "ZIP archive overwrite/repack" },
  { re: /\bapktool\s+b\b/i, reason: "apktool rebuild (APK repack)" },
  { re: /\b(apktool|aapt|aapt2)\b[\s\S]{0,80}\b(package|build)\b/i, reason: "APK repack/package" },
  { re: /\b(jarsigner|apksigner)\b/i, reason: "APK signing" },
  { re: /\bnc\s+-[el]/i, reason: "netcat listen/exec" },
  { re: /\bncat\b.*\s-e\b/i, reason: "ncat -e" },
  { re: /\bbusybox\s+nc\b/i, reason: "busybox nc" },
  { re: /\biptables\b/i, reason: "iptables" },
  { re: /\bmount\b/i, reason: "mount" },
  { re: /\bumount\b/i, reason: "umount" },
  { re: /\bexport\s+(PATH|LD_PRELOAD|LD_LIBRARY_PATH)=/i, reason: "sensitive env override" },
];

function isPathWithinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function isPathAllowed(target: string, projectPath?: string | null): boolean {
  const t = target.replace(/^["']|["']$/g, "");
  // Default sandbox: AIBuilderTermux + $HOME/aibuilder-* + Termux home/prefix + tmp
  const roots = [
    "~",
    "$HOME",
    "$AIB_PRIVATE_ROOT",
    "$PREFIX",
      "/termux-home/.aibuilder",
    "/storage/emulated/0/AIBuilderTermux",
    "/tmp",
    "/var/tmp",
  ];
  if (roots.some((root) => isPathWithinRoot(t, root))) return true;
  if (projectPath && isPathWithinRoot(t, projectPath.replace(/\/$/, ""))) return true;
  return false;
}

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: string; confirmable?: boolean };

function isSensitiveFileToken(token: string): boolean {
  const normalized = token.replace(/\\/g, "/").replace(/^[({[]+|[)}\],]+$/g, "");
  const leaf = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (/^\.env\.(?:example|sample|template|dist)$/.test(leaf)) return false;
  return /^\.env(?:\..*)?$/.test(leaf) || /^\.envrc(?:\..*)?$/.test(leaf) ||
    /^(?:\.ssh|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/.test(leaf) ||
    /^(?:secrets?|credentials?)(?:\.[^/]*)?$/.test(leaf) ||
    /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|credential|secret)/i.test(leaf) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(leaf);
}

function isAuthorizedDebugKeystoreToken(token: string): boolean {
  const normalized = token.replace(/\\/g, "/").replace(/^["']|["']$/g, "");
  return /^(?:\$AIB_KEYS|\$KEYS|\$WORK)\/aib-debug\.keystore$/i.test(normalized) ||
    /^(?:\$AIB_KEYS|\$AIB_PRIVATE_ROOT\/keys|\/termux-home\/\.aibuilder\/keys|\/data\/data\/com\.karat\.aibuilder\/files\/home\/\.aibuilder\/keys)\/\.aib-debug\.[A-Za-z0-9_$.-]+\.keystore$/i.test(normalized) ||
    /^(?:\$AIB_PRIVATE_ROOT|\/termux-home|\/data\/data\/com\.karat\.aibuilder\/files\/home)\/\.aibuilder\/keys\/aib-debug\.keystore$/i.test(normalized) ||
    /^\/storage\/emulated\/0\/AIBuilderTermux\/\.aibuilder\/keys\/aib-debug\.keystore$/i.test(normalized);
}

function referencesSensitiveFile(command: string, allowInternalDebugKeystore = false, allowSigningKeyAccess = false): boolean {
  return command.split(/[\s"'`=<>|;&]+/).filter(Boolean).some((token) => {
    if (!isSensitiveFileToken(token)) return false;
    if (allowSigningKeyAccess && (/\.(?:keystore|jks)$/i.test(token.replace(/^["']|["']$/g, "")) || /^(?:KEYSTORE_PASSWORD|KEY_PASSWORD|STORE_PASSWORD)$/i.test(token))) return false;
    return !(allowInternalDebugKeystore && isAuthorizedDebugKeystoreToken(token));
  });
}

function readShellWord(command: string, start: number): { value: string; end: number; malformed: boolean } {
  let value = "";
  let quote = "";
  let escaped = false;
  let i = start;
  for (; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { value += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ""; else value += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch) || /[;|<>]/.test(ch)) break;
    value += ch;
  }
  return { value, end: i, malformed: Boolean(quote || escaped) };
}

function outputRedirectionTargets(command: string): string[] | null {
  const targets: string[] = [];
  let quote = "";
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    const appendAll = ch === "&" && command[i + 1] === ">";
    if (ch !== ">" && !appendAll) continue;
    let start = i + (appendAll ? 2 : 1);
    if (command[start] === ">" || command[start] === "|") start++;
    while (/\s/.test(command[start] ?? "")) start++;
    const word = readShellWord(command, start);
    if (word.malformed) return null;
    if (word.value) targets.push(word.value);
    i = Math.max(i, word.end - 1);
  }
  return quote || escaped ? null : targets;
}

function isAuthorizedSdkLicenseTarget(target: string): boolean {
  return /^\$SDK\/licenses\/android-sdk(?:-preview)?-license$/i.test(target.replace(/^['"]|['"]$/g, ""));
}

function unsafeOutputRedirection(command: string, projectPath?: string | null, allowSdkLicenseWrites = false): string | null {
  const targets = outputRedirectionTargets(command);
  if (!targets) return "malformed output redirection";
  for (const target of targets) {
    if (/^&(?:\d+|-)$/.test(target)) continue; // fd duplication, e.g. 2>&1
    if (target === "/dev/null" || /^\/dev\/null\)+$/.test(target)) continue;
    if (allowSdkLicenseWrites && isAuthorizedSdkLicenseTarget(target)) continue;
    const failure = unsafeMutationTarget(target, command, projectPath, allowSdkLicenseWrites);
    if (failure) return failure;
  }
  return null;
}

function splitShellSegments(command: string): string[] | null {
  const segments: string[] = [];
  let quote = "";
  let escaped = false;
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
      segments.push(command.slice(start, i));
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
      start = i + 1;
    }
  }
  if (quote || escaped) return null;
  segments.push(command.slice(start));
  return segments;
}

function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  let i = 0;
  while (i < segment.length) {
    if (/\s/.test(segment[i])) { i++; continue; }
    if (/[<>|&;]/.test(segment[i])) { i++; continue; }
    const parsed = readShellWord(segment, i);
    if (parsed.malformed || parsed.end <= i) return null;
    words.push(parsed.value);
    i = parsed.end;
  }
  return words;
}

function executableName(word: string): string {
  return word.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function inPlaceSedTargets(args: readonly string[]): string[] {
  const inPlace = args.some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || /^-[a-z]*i[a-z]*(?:\..*)?$/.test(arg));
  if (!inPlace) return [];
  const positional: string[] = [];
  let explicitProgram = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { positional.push(...args.slice(i + 1)); break; }
    if (arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file") { explicitProgram = true; i++; continue; }
    if (/^-e.+/.test(arg) || /^--expression=/.test(arg) || /^-f.+/.test(arg) || /^--file=/.test(arg)) { explicitProgram = true; continue; }
    if (arg === "-i" || arg.startsWith("--in-place") || /^-[a-z]*i[a-z]*(?:\..*)?$/.test(arg)) {
      if (arg === "-i" && args[i + 1] === "") i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  return explicitProgram ? positional : positional.slice(1);
}

function inPlacePerlTargets(args: readonly string[]): string[] {
  const inPlace = args.some((arg) => arg === "--inplace" || arg.startsWith("--inplace=") || /^-[a-z]*i[a-z]*(?:\..*)?$/.test(arg));
  if (!inPlace) return [];
  const positional: string[] = [];
  let explicitProgram = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { positional.push(...args.slice(i + 1)); break; }
    if (arg === "-e" || arg === "-E" || arg === "-f") { explicitProgram = true; i++; continue; }
    if (/^-[^-]*[eE].+/.test(arg) || /^-f.+/.test(arg)) { explicitProgram = true; continue; }
    if (/^-[^-]*[eE]$/.test(arg)) { explicitProgram = true; i++; continue; }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  return explicitProgram ? positional : positional.slice(1);
}

function inPlaceAwkTargets(args: readonly string[]): string[] {
  const inPlace = args.some((arg, index) => arg === "--inplace" || arg.startsWith("--inplace=") || (arg === "-i" && args[index + 1] === "inplace"));
  if (!inPlace) return [];
  const positional: string[] = [];
  let explicitProgram = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { positional.push(...args.slice(i + 1)); break; }
    if (arg === "-f" || arg === "--file" || arg === "-v" || arg === "--assign" || arg === "-F" || arg === "--field-separator") {
      if (arg === "-f" || arg === "--file") explicitProgram = true;
      i++;
      continue;
    }
    if (arg.startsWith("--file=") || arg.startsWith("--assign=") || arg.startsWith("--field-separator=")) { if (arg.startsWith("--file=")) explicitProgram = true; continue; }
    if (/^-v.+/.test(arg) || /^-F.+/.test(arg) || /^-f.+/.test(arg)) { if (arg.startsWith("-f")) explicitProgram = true; continue; }
    if (arg === "-i" && args[i + 1] === "inplace") { i++; continue; }
    if (arg === "--inplace" || arg.startsWith("--inplace=")) continue;
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  return explicitProgram ? positional : positional.slice(1);
}

function modeledMutationTargets(command: string): { targets: string[]; nestedShells: string[] } | null {
  const segments = splitShellSegments(command);
  if (!segments) return null;
  const targets: string[] = [];
  const nestedShells: string[] = [];
  const editors = new Set(["vi", "vim", "nvim", "nano", "emacs", "emacsclient", "ed", "ex"]);
  const shells = new Set(["sh", "bash", "dash", "ash", "zsh", "ksh"]);
  for (const segment of segments) {
    const words = shellWords(segment);
    if (!words) return null;
    for (let index = 0; index < words.length; index++) {
      const name = executableName(words[index]);
      const args = words.slice(index + 1);
      if (name === "sed") targets.push(...inPlaceSedTargets(args));
      if (name === "perl") targets.push(...inPlacePerlTargets(args));
      if (name === "awk" || name === "gawk") targets.push(...inPlaceAwkTargets(args));
      if (editors.has(name)) {
        for (const arg of args) {
          if (/^(?:\/|~|\$)/.test(arg) || /(?:^|\/)\.\.(?:\/|$)/.test(arg) || arg === "..") targets.push(arg);
          const editorWrite = /(?:^|\s):?(?:w|write|saveas)!?\s+([^\s;&|]+)/i.exec(arg);
          if (editorWrite) targets.push(editorWrite[1].replace(/^['"]|['"]$/g, ""));
        }
      }
      if (name === "cd") {
        const target = args.find((arg) => arg && arg !== "--");
        if (target === "-") targets.push("__AIB_UNRESOLVED_CWD__");
        else if (target && (/^(?:\/|~|\$)/.test(target) || /(?:^|\/)\.\.(?:\/|$)/.test(target) || target === "..")) targets.push(target);
      }
      if (name === "git") {
        const isConfig = args.includes("config");
        if (isConfig && args.includes("--system")) targets.push("/etc/gitconfig");
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "-C" || args[i] === "--git-dir" || args[i] === "--work-tree") targets.push(args[++i] ?? "");
          else if (/^(?:--git-dir|--work-tree)=/.test(args[i])) targets.push(args[i].slice(args[i].indexOf("=") + 1));
          else if (/^-C.+/.test(args[i])) targets.push(args[i].slice(2));
          else if (isConfig && (args[i] === "--file" || args[i] === "-f")) targets.push(args[++i] ?? "");
          else if (isConfig && /^--file=/.test(args[i])) targets.push(args[i].slice(args[i].indexOf("=") + 1));
        }
      }
      if (shells.has(name)) {
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (arg === "--command" || (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("c"))) {
            if (args[i + 1] !== undefined) {
              const overrides = [...command.matchAll(/\b(?:export\s+)?(?:HOME|PREFIX)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g)].map((match) => match[0]);
              nestedShells.push([...overrides, args[i + 1]].join("; "));
            }
            break;
          }
        }
      }
    }
  }
  return { targets, nestedShells };
}

const SHELL_MUTATION_COMMANDS = new Set([
  "rm", "mv", "cp", "chmod", "chown", "ln", "mkdir", "rmdir", "touch",
  "truncate", "tee", "install", "tar", "unzip", "zip", "rsync", "sponge",
  "vi", "vim", "nvim", "nano", "emacs", "emacsclient", "ed", "ex",
]);

function hasUnscopedShellMutation(command: string): boolean {
  const segments = splitShellSegments(command);
  if (!segments) return true;
  for (const segment of segments) {
    const words = shellWords(segment);
    if (!words) return true;
    for (let index = 0; index < words.length; index++) {
      const name = executableName(words[index]);
      const args = words.slice(index + 1);
      if (name === "git" && /^(?:checkout|switch|restore|reset|clean|commit|stash|branch|tag|config)$/.test(args[0] ?? "")) return true;
      let targets: string[] | null = null;
      if (SHELL_MUTATION_COMMANDS.has(name)) {
        const positional = args.filter((arg) => !arg.startsWith("-") && arg !== "--");
        if (["cp", "mv", "install"].includes(name)) targets = positional.slice(1);
        else if (name === "ln") targets = positional.slice(-1);
        else if (["tar", "unzip", "zip", "rsync", "sponge"].includes(name)) targets = positional;
        else targets = positional;
        if (!targets.length) return true;
      } else if (name === "sed") targets = inPlaceSedTargets(args);
      else if (name === "perl") targets = inPlacePerlTargets(args);
      else if (name === "awk" || name === "gawk") targets = inPlaceAwkTargets(args);
      if (targets?.some((target) => !/^(?:\/|~|\$)/.test(target))) return true;
    }
  }
  return false;
}

function unsafeMutationTarget(target: string, command: string, projectPath?: string | null, allowSdkLicenseWrites = false): string | null {
  if (!target) return "malformed mutation target";
  if (target === "__AIB_UNRESOLVED_CWD__") return "working directory is not statically contained";
  if (/(?:^|\/)\.\.(?:\/|$)/.test(target) || target === "..") return "path traversal is not allowed";
  if (allowSdkLicenseWrites && isAuthorizedSdkLicenseTarget(target)) return null;
  const variable = /^\$(HOME|PREFIX|AIB_PRIVATE_ROOT)(?:\/|$)/.exec(target)?.[1] ?? ((target === "~" || target.startsWith("~/")) ? "HOME" : undefined);
  if (variable) {
    const assignment = new RegExp(`(?:^|[;\\s])(?:export\\s+)?${variable}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, "m").exec(command);
    if (assignment) {
      const value = assignment[1] ?? assignment[2] ?? assignment[3] ?? "";
      if (variable === "AIB_PRIVATE_ROOT") {
        const allowedPrivateRoot = /^(?:\$HOME\/\.aibuilder|\$\{AIB_PRIVATE_ROOT:-\$HOME\/\.aibuilder\}|\/data\/data\/com\.karat\.aibuilder\/files\/home\/\.aibuilder|\/termux-home\/\.aibuilder)$/.test(value);
        if (!allowedPrivateRoot) return `output variable ${variable} resolves outside the app-private Termux root`;
      } else if (!isPathAllowed(value, projectPath)) return `output variable ${variable} resolves outside trusted roots`;
    }
  }
  if (/^(?:\/|~|\$)/.test(target) && !isPathAllowed(target, projectPath)) return `output target is outside trusted roots: ${target}`;
  return null;
}

function guardTermuxCommandInternal(
  command: string,
  opts?: { allowDangerous?: boolean; projectPath?: string | null; allowSdkLicenseWrites?: boolean; allowInternalDebugKeystore?: boolean; allowSigningKeyAccess?: boolean },
  shellDepth = 0,
): GuardResult {
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: "empty command" };
  for (const match of cmd.matchAll(/\/data\/(?:data|user(?:_de)?\/\d+)\/([A-Za-z0-9_.]+)/g)) {
    if (match[1] !== "com.karat.aibuilder") return { ok: false, reason: "foreign app-private path is forbidden" };
  }

  if (referencesSensitiveFile(cmd, opts?.allowInternalDebugKeystore === true, opts?.allowSigningKeyAccess === true)) return { ok: false, reason: "Blocked: sensitive file access is not allowed" };

  const unsafeRedirect = unsafeOutputRedirection(cmd, opts?.projectPath, opts?.allowSdkLicenseWrites === true);
  if (unsafeRedirect) return { ok: false, reason: `Blocked: ${unsafeRedirect}`, ...(/outside trusted roots: \$/.test(unsafeRedirect) ? { confirmable: true } : {}) };

  // Relative writes have no trustworthy scope unless the caller supplied the
  // selected project workdir. This is a confirmation boundary, not a claim
  // that the shell is sandboxed; absolute path checks remain authoritative.
  const redirects = outputRedirectionTargets(cmd);
  if (!opts?.projectPath && redirects?.some((target) => !/^(?:\/|~|\$)/.test(target) && target !== "/dev/null")) {
    return { ok: false, reason: "Needs confirmation: relative write target has no project scope", confirmable: true };
  }

  // Regression examples: `cp safe /etc/passwd`, `mv safe /etc/x`, and
  // `ln safe /etc/x` must all be rejected when the destination is outside the
  // whitelist, even though the first operand is relative/safe.
  // Fail-closed invariant: validate EVERY absolute path operand before dispatch.
  // Validate absolute path operands for common file-mutating utilities,
  // not only the first one. A command such as `cp safe /etc/passwd` must not
  // pass merely because its first operand is inside an allowed root.
  const pathOps = cmd.matchAll(/\b(rm|mv|cp|chmod|chown|ln|mkdir|rmdir|touch|truncate|tee|install|tar|unzip|zip|rsync|sponge)\s+([^;&|\n]+)/gi);
  for (const m of pathOps) {
    const operands = m[2] || "";
    if (/(?:^|[\/\s"'])\.\.(?:[\/\s"']|$)/.test(operands)) {
      return { ok: false, reason: "Path traversal is not allowed in filesystem operation" };
    }
    const absolutePaths = operands.match(/(?:^|[\s"'])(?:\/|~|\$)(?:[^\s;&|"']*)/g) || [];
    for (const raw of absolutePaths) {
      const target = raw.trim().replace(/^["']|["']$/g, "");
      if (!target) continue;
      if (m[1].toLowerCase() === "tee" && target === "/dev/null") continue;
      if (target === "/" || target === "/*") {
        return { ok: false, reason: "Refusing to touch filesystem root" };
      }
      const failure = unsafeMutationTarget(target, cmd, opts?.projectPath, opts?.allowSdkLicenseWrites === true);
      if (failure) return { ok: false, reason: `Blocked: ${failure}`, ...(failure.includes("traversal") ? {} : { confirmable: true }) };
    }
  }

  // File-output options do not use shell redirection and therefore need their
  // own target checks (curl/wget -o/-O, tar/unzip destination directories).
  const optionOutputTargets = [
    ...[...cmd.matchAll(/\bcurl\b[^;&|\n]*?(?:^|\s)(?:-o|--output)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)].map((m) => m[1] ?? m[2] ?? m[3] ?? ""),
    ...[...cmd.matchAll(/\bwget\b[^;&|\n]*?(?:^|\s)(?:-O|--output-document)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)].map((m) => m[1] ?? m[2] ?? m[3] ?? ""),
    ...[...cmd.matchAll(/\bdd\b[^;&|\n]*?\bof=(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)].map((m) => m[1] ?? m[2] ?? m[3] ?? ""),
    ...[...cmd.matchAll(/\b(?:tar|unzip)\b[^;&|\n]*?(?:-C|-d|--directory(?:=|\s+))(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)].map((m) => m[1] ?? m[2] ?? m[3] ?? ""),
    ...[...cmd.matchAll(/\b(?:cp|ln|install)\b[^;&|\n]*?(?:--target-directory(?:=|\s+)|\s-t(?:=|\s+))(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)].map((m) => m[1] ?? m[2] ?? m[3] ?? ""),
  ];
  for (const target of optionOutputTargets) {
    if (!target) return { ok: false, reason: "Blocked: malformed file-output option" };
    const failure = unsafeMutationTarget(target, cmd, opts?.projectPath, opts?.allowSdkLicenseWrites === true);
    if (failure) return { ok: false, reason: `Blocked: ${failure}` };
  }

  const modeled = modeledMutationTargets(cmd);
  if (!modeled) return { ok: false, reason: "Blocked: malformed shell command arguments" };
  for (const target of modeled.targets) {
    const failure = unsafeMutationTarget(target, cmd, opts?.projectPath, opts?.allowSdkLicenseWrites === true);
    if (failure) return { ok: false, reason: `Blocked: ${failure}`, ...(failure.includes("traversal") ? {} : { confirmable: true }) };
  }
  if (modeled.nestedShells.length) {
    if (shellDepth >= 4) return { ok: false, reason: "Blocked: nested shell depth limit exceeded" };
    for (const nested of modeled.nestedShells) {
      if (/[`]/.test(nested) || /\$\s*\(/.test(nested) || /\b(?:eval|source)\b/i.test(nested)) {
        return { ok: false, reason: "Blocked: dynamic nested-shell execution is not allowed" };
      }
      const nestedResult = guardTermuxCommandInternal(nested, opts, shellDepth + 1);
      if (!nestedResult.ok) return nestedResult;
    }
  }

  if (!opts?.projectPath && hasUnscopedShellMutation(cmd)) {
    return { ok: false, reason: "Needs confirmation: shell mutation has no project scope", confirmable: true };
  }

  // Dangerous-mode opt-in may authorize dangerous operations, never path escapes.
  if (opts?.allowDangerous === true) return { ok: true };

  for (const { re, reason } of HARD_BLOCK_PATTERNS) {
    if (re.test(cmd)) return { ok: false, reason: `Blocked: ${reason}` };
  }
  for (const { re, reason } of CONFIRMABLE_PATTERNS) {
    if (re.test(cmd)) return { ok: false, reason: `Needs confirmation: ${reason}`, confirmable: true };
  }

  return { ok: true };
}

export type GuardOptions = { allowDangerous?: boolean; projectPath?: string | null; allowSdkLicenseWrites?: boolean; allowInternalDebugKeystore?: boolean; allowSigningKeyAccess?: boolean; strict?: boolean };

/** Строгий default guard (path checks + confirmation boundaries + hard-blocks). */
export function guardTermuxCommandStrict(command: string, opts?: GuardOptions): GuardResult {
  return guardTermuxCommandInternal(command, opts, 0);
}

/**
 * Model-generated shell uses strict checks by default. The compatibility
 * override is opt-in only; interactive PTY commands use their separate path.
 */
export function guardTermuxCommand(command: string, opts?: GuardOptions): GuardResult {
  if (opts?.strict === true || !isAgentUnrestrictedShell()) return guardTermuxCommandStrict(command, opts);
  const cmd = String(command || "").trim();
  for (const match of cmd.matchAll(/\/data\/(?:data|user(?:_de)?\/\d+)\/([A-Za-z0-9_.]+)/g)) {
    if (match[1] !== "com.karat.aibuilder") return { ok: false, reason: "foreign app-private path is forbidden" };
  }
  if (!cmd) return { ok: false, reason: "empty command" };
  const floor = catastrophicCommandReason(cmd);
  return floor ? { ok: false, reason: `Blocked: ${floor}` } : { ok: true };
}

/** Dangerous mode is an explicit opt-in; missing/invalid values fail closed. */
export function isDangerousCommandOptedIn(value: unknown): boolean {
  return value === true;
}



/**
 * Strict policy for read-only subagents.
 * This is intentionally separate from the general command guard: a read-only
 * worker must not be able to turn a confirmation prompt into write/network/
 * process execution. Shell metacharacters and path traversal are rejected
 * rather than parsed heuristically.
 */
const READ_ONLY_COMMANDS = new Set([
  // Shell operands cannot be reliably canonicalized through Termux symlinks.
  // Project file access therefore stays on the symlink-guarded AIB_TOOL path.
  "pwd", "git", "which", "type", "printf",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse",
  "describe", "cat-file",
]);

function hasShellMutationOrEscapeSyntax(command: string): string | null {
  if (/[;&|<>]/.test(command)) return "shell control/redirection syntax is not allowed";
  if (/[`]/.test(command) || /\$\s*\(/.test(command)) return "command substitution is not allowed";
  if (/\b(?:eval|exec|source|\.\s|alias|unalias|function)\b/i.test(command)) return "shell metaprogramming is not allowed";
  if (/(^|[\s'\"])(?:\.\.)(?:[\/\s'\"]|$)/.test(command) || /(?:^|[\/])\.\.(?:[\/]|$)/.test(command)) {
    return "path traversal is not allowed";
  }
  return null;
}

function shellWordsForReadOnly(command: string): string[] | null {
  // Deliberately conservative tokenizer: quoted strings are retained as one
  // token; malformed quoting fails closed.
  const words: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const ch of command.trim()) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ""; else current += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) { words.push(current); current = ""; } continue; }
    current += ch;
  }
  if (escaped || quote) return null;
  if (current) words.push(current);
  return words;
}

export function guardReadOnlyTermuxCommand(command: string): GuardResult {
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: "empty command" };
  const syntaxReason = hasShellMutationOrEscapeSyntax(cmd);
  if (syntaxReason) return { ok: false, reason: `Read-only blocked: ${syntaxReason}` };
  const words = shellWordsForReadOnly(cmd);
  if (!words?.length) return { ok: false, reason: "Read-only blocked: malformed shell quoting" };

  if (words[0].includes("/")) return { ok: false, reason: "Read-only blocked: executable paths are not allowed" };
  const executable = words[0];
  if (!READ_ONLY_COMMANDS.has(executable)) {
    return { ok: false, reason: `Read-only blocked: command '${executable}' is not allowlisted` };
  }
  if (executable === "git") {
    const sub = words[1];
    if (!sub || !READ_ONLY_GIT_SUBCOMMANDS.has(sub) || words.includes("-C") || words.includes("--git-dir") || words.includes("--work-tree") || words.includes("-c") || words.includes("--ext-diff")) {
      return { ok: false, reason: "Read-only blocked: git operation is not allowlisted" };
    }
  }

  // No explicit absolute filesystem target is accepted. Subagents should use
  // their supplied project workdir and the AIB_TOOL for structured access.
  for (const word of words.slice(1)) {
    if (word === "-i" || word.startsWith("--in-place") || word === "-delete" || /^-(?:exec|execdir|ok|okdir)(?:$|=)/.test(word) || word === "-o" || word === "--output" || word.startsWith("--output=")) {
      return { ok: false, reason: "Read-only blocked: mutating option is not allowed" };
    }
    if (word.startsWith("/") || word.startsWith("~") || word.startsWith("$")) {
      return { ok: false, reason: "Read-only blocked: absolute/home/environment paths are not allowed" };
    }
  }
  return { ok: true };
}

export function getPreferredProjectRoot(): string {
  return "/storage/emulated/0/AIBuilderTermux/projects";
}

export { SAFE_ROOTS, HARD_BLOCK_PATTERNS, CONFIRMABLE_PATTERNS };
