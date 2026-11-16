/**
 * Hermetic selftest for Native Priority + pkg profiles + system rules (no device).
 * Run: node scripts/aib-native-priority-selftest.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Dynamic import of TS is not available without loader; test pure logic by re-implementing
// the classification rules inline to stay hermetic (mirrors lib/native-priority.ts).

const HOST_SAFE_PATTERNS = [
  /^\s*(pkg|termux-)\b/i,
  /^\s*(git|gh)\b/i,
  /^\s*(python3?|pip3?|node|npm|npx|yarn|pnpm)\b/i,
  /^\s*(clang|clang\+\+|gcc|g\+\+|make|cmake|ninja)\b/i,
  /^\s*(ls|cat|head|tail|grep|rg|find|sed|awk|cut|sort|uniq|wc|cp|mv|rm|mkdir|touch|chmod|ln|tar|unzip|zip|curl|wget|ssh|scp)\b/i,
  /^\s*(echo|printf|true|false|test|\[|which|command|type|pwd|cd|export|env)\b/i,
  /^\s*(bash|sh)\s+-c\b/i,
];

const PROOT_HINT_PATTERNS = [
  /^\s*(apt|apt-get|dpkg)\b/i,
  /\b(ubuntu|debian|proot-distro)\b/i,
  /\b(systemctl|systemd|service)\b/i,
  /\b(\/usr\/bin\/python3|\/usr\/lib)\b/i,
];

function commandLooksHostSafe(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (PROOT_HINT_PATTERNS.some((re) => re.test(cmd))) return false;
  return HOST_SAFE_PATTERNS.some((re) => re.test(cmd));
}

function commandLooksProotRequired(command) {
  return PROOT_HINT_PATTERNS.some((re) => re.test(String(command || "")));
}

function resolveBackendForCommand(command, configuredBackend, mode) {
  if (mode === "force-proot") return "ubuntu-proot";
  if (mode === "prefer-termux") {
    if (commandLooksProotRequired(command)) return "ubuntu-proot";
    return "termux";
  }
  if (configuredBackend === "termux") return "termux";
  if (commandLooksHostSafe(command) && !commandLooksProotRequired(command)) return "termux";
  return configuredBackend;
}

// --- tests ---
assert.equal(commandLooksHostSafe("git status"), true);
assert.equal(commandLooksHostSafe("pkg install nodejs"), true);
assert.equal(commandLooksHostSafe("python3 -m pip list"), true);
assert.equal(commandLooksHostSafe("apt-get install foo"), false);
assert.equal(commandLooksProotRequired("apt-get update"), true);

assert.equal(resolveBackendForCommand("git status", "ubuntu-proot", "auto"), "termux");
assert.equal(resolveBackendForCommand("apt-get update", "ubuntu-proot", "auto"), "ubuntu-proot");
assert.equal(resolveBackendForCommand("git status", "ubuntu-proot", "force-proot"), "ubuntu-proot");
assert.equal(resolveBackendForCommand("ls -la", "ubuntu-proot", "prefer-termux"), "termux");
assert.equal(resolveBackendForCommand("apt install x", "termux", "prefer-termux"), "ubuntu-proot");

// pkg profiles presence (read source)
import fs from "node:fs";
const pkgSrc = fs.readFileSync(path.join(root, "lib/agent-tools/pkg-bootstrap.ts"), "utf8");
assert.match(pkgSrc, /base:/);
assert.match(pkgSrc, /node:/);
assert.match(pkgSrc, /python:/);
assert.match(pkgSrc, /android-build/);

const typesSrc = fs.readFileSync(path.join(root, "lib/agent-tools/types.ts"), "utf8");
assert.match(typesSrc, /"pkg\.ensure"/);
assert.match(typesSrc, /"hardware\.probe"/);
assert.match(typesSrc, /"runtime\.killSession"/);

const indexSrc = fs.readFileSync(path.join(root, "lib/agent-tools/index.ts"), "utf8");
assert.match(indexSrc, /pkgEnsure/);
assert.match(indexSrc, /hardwareProbeTool/);
assert.match(indexSrc, /runtimeKillSession/);

const settingsSrc = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
assert.match(settingsSrc, /nativePriorityTitle|Native Priority/);
assert.match(settingsSrc, /desktopModeLabel|Desktop Mode/);
assert.match(settingsSrc, /saveNativePriorityMode/);
assert.match(settingsSrc, /saveDesktopMode/);


const chatSrc = fs.readFileSync(path.join(root, "app/chat-history.tsx"), "utf8");
assert.match(chatSrc, /killRuntimeSession/);
assert.match(chatSrc, /stopSession/);

const runtimeSrc = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(runtimeSrc, /killAllRuntimeSessions/);
assert.match(runtimeSrc, /stopAllSessions/);

const i18nSrc = fs.readFileSync(path.join(root, "AIBuilder/lib/i18n.ts"), "utf8");
assert.match(i18nSrc, /stopSession:/);
assert.match(i18nSrc, /nativePriorityTitle:/);
assert.match(i18nSrc, /desktopModeLabel:/);

const cmdSrc = fs.readFileSync(path.join(root, "lib/termux-commands.ts"), "utf8");
assert.match(cmdSrc, /aib-pkg-ensure/);
assert.match(cmdSrc, /category: "agent"/);


const appPrefs = fs.readFileSync(path.join(root, "lib/appearance-prefs.ts"), "utf8");
assert.match(appPrefs, /getDesktopContentStyle/);
assert.match(appPrefs, /DESKTOP_CONTENT_MAX_WIDTH/);

const runtimeSrc2 = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(runtimeSrc2, /getDesktopContentStyle/);

const scriptSrc = fs.readFileSync(path.join(root, "app/script-runner.tsx"), "utf8");
assert.match(scriptSrc, /getDesktopContentStyle/);


const shellBackend = fs.readFileSync(path.join(root, "lib/agent-shell-backend.ts"), "utf8");
assert.match(shellBackend, /from "\.\/native-priority"/);
assert.match(shellBackend, /resolveBackendForCommand/);
assert.match(shellBackend, /Native Priority \(Fast Path\)/);

const envMgr = fs.readFileSync(path.join(root, "lib/environment-manager.ts"), "utf8");
assert.match(envMgr, /loadNativePriorityMode/);

const registryHelpers = fs.readFileSync(path.join(root, "scripts/aib-agent-tool-registry-selftest.mjs"), "utf8");
assert.match(registryHelpers, /pkg-bootstrap\.ts/);
assert.match(registryHelpers, /hardware-probe\.ts/);

console.log("aib-native-priority-selftest: OK");
