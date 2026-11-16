/**
 * Where the agent executes shell commands:
 * - termux: native Termux ($PREFIX, pkg)
 * - ubuntu-proot: inside proot-distro Ubuntu (apt, full userspace) with storage binds
 *
 * Debian and Kali were removed. Legacy saved "debian-proot" migrates to ubuntu-proot.
 */
import { agentAutonomyPromptBlock } from "./agent-autonomy-policy";
import { buildProotDistroRootfsCheckCommand } from "./termux-bootstrap-install";
import { AI_BUILDER_SHARED_ROOT, isWithinSharedAppRoot } from "./writable-path-policy";
import { getNativePriorityMode, resolveBackendForCommand } from "./native-priority";

/** Hermes on older Android may lack String.prototype.replaceAll. */
function replaceAllSafe(haystack: string, search: string, replacement: string): string {
  if (typeof (haystack as any).replaceAll === "function") {
    return (haystack as any).replaceAll(search, replacement);
  }
  if (!search) return haystack;
  return haystack.split(search).join(replacement);
}

export type AgentShellBackend = "termux" | "ubuntu-proot";

const STORAGE_KEY = "aibuilder.buildBackend.v1";
// Backward-compatible read key for installations created before the build/agent
// environments were unified. New writes use the buildBackend key only.
export const LEGACY_AGENT_SHELL_BACKEND_STORAGE_KEY = "aibuilder.agentShellBackend.v1";

let current: AgentShellBackend = "termux";

export function getBuildBackend(): AgentShellBackend {
  return current;
}

export function setBuildBackend(backend: AgentShellBackend): void {
  const raw = backend as string;
  if (raw === "debian-proot" || raw === "kali" || raw === "kali-proot") {
    current = "ubuntu-proot";
    return;
  }
  current = backend === "ubuntu-proot" ? "ubuntu-proot" : "termux";
}

export function isUbuntuProotBackend(): boolean {
  return current === "ubuntu-proot";
}

export function isDebianProotBackend(): boolean {
  return false;
}

export function isLinuxProotBackend(): boolean {
  return current === "ubuntu-proot";
}

/** Convert a path emitted inside proot back to the host-visible Termux path. */
export function hostVisiblePath(value: string): string {
  const raw = String(value || "");
  const hostHome = "/data/data/com.karat.aibuilder/files/home";
  const guestHome = "/termux-home";
  if (isLinuxProotBackend() && (raw === guestHome || raw.startsWith(`${guestHome}/`))) {
    return hostHome + raw.slice(guestHome.length);
  }
  return raw;
}

export function backendLabel(backend: AgentShellBackend = current): string {
  if (backend === "ubuntu-proot") return "Ubuntu proot";
  return "Termux";
}

// The agent has no independent environment anymore: it always follows the build backend.
export const getAgentShellBackend = getBuildBackend;
export const setAgentShellBackend = setBuildBackend;

export const BUILD_BACKEND_STORAGE_KEY = STORAGE_KEY;

export function isAgentShellBackend(value: unknown): value is AgentShellBackend {
  return value === "termux" || value === "ubuntu-proot" || false;
}
// Compatibility alias for older imports; the persisted setting is now a build setting.
export const AGENT_SHELL_BACKEND_STORAGE_KEY = BUILD_BACKEND_STORAGE_KEY;

// Explicit markers retained for regression diagnostics across both Linux backends.
export const PROOT_ROOTFS_ERROR_MARKERS = [
  "AIB_UBUNTU_ROOTFS_MISSING", "AIB_DEBIAN_ROOTFS_MISSING",
  "AIB_UBUNTU_ROOTFS_INSTALLED_LOGIN_FAILED", "AIB_DEBIAN_ROOTFS_INSTALLED_LOGIN_FAILED",
  "AIB_UBUNTU_ROOTFS_STATE_UNVERIFIED", "AIB_DEBIAN_ROOTFS_STATE_UNVERIFIED",
] as const;

export function parseAgentShellBackend(raw: string | null | undefined): AgentShellBackend {
  if (raw === "ubuntu-proot" || raw === "debian-proot") return "ubuntu-proot";
  return "termux";
}

/**
 * Commands limited to Android shared storage (Download, /sdcard, …).
 * These may run in the selected Ubuntu guest while its storage binds work;
 * they are eligible for a Termux-host retry only when Ubuntu startup fails.
 */
export function isAndroidSharedStorageOnlyCommand(command: string): boolean {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  // Block anything that clearly needs a real Linux userspace / package manager.
  if (/\b(proot-distro|apt-get|apt\s|dpkg|pkg\s|npm\s|gradle|java\b|python3?\b|clang|cmake|make\s)\b/i.test(cmd)) {
    return false;
  }
  if (/\b(pip3?|gem\s|cargo\s|go\s|rustc|node\s)\b/i.test(cmd)) return false;
  // Absolute shared storage OR bare Download/Загрузки/Documents relative paths.
  const touchesShared =
    /\/sdcard\b|\/storage\/emulated\/\d+\b|\$\{?HOME\}?\/storage\/shared\b|~\/storage\/shared\b|(?:^|[\s"'=])(?:Download|Downloads|Загрузки|Завантаження|Documents|Документы|Документи|DCIM|Pictures|Music|Movies|Alarms|AIBuilderTermux)\b/i.test(cmd);
  if (!touchesShared) return false;
  if (/\/data\/data\/com\.karat\.aibuilder\b|\$PREFIX\b|\/usr\/(bin|lib|local)\b/i.test(cmd)) return false;
  return true;
}

/** Retry only when the Ubuntu guest could not start, never after an ordinary
 * command or permission failure that might have partially changed a file. */
export function shouldFallbackSharedStorageToHost(
  command: string,
  backend: AgentShellBackend,
  exitCode: number,
  output: string,
): boolean {
  if (backend !== "ubuntu-proot" || exitCode === 0 || !isAndroidSharedStorageOnlyCommand(command)) {
    return false;
  }
  return /\bAIB_PROOT_DISTRO_MISSING\b|\bAIB_UBUNTU_ROOTFS_(?:MISSING|STATE_UNVERIFIED|INSTALLED_LOGIN_FAILED)\b/.test(
    String(output || ""),
  );
}

/**
 * User task that only needs host shared-storage file ops (Download/sdcard/…).
 * When true, Ubuntu rootfs preflight MUST be skipped — otherwise a simple
 * "create file in Download" fails with AIB_*_ROOTFS_STATE_UNVERIFIED even though
 * the work never enters the guest.
 */
export function isSharedStorageOnlyUserTask(task: string): boolean {
  const t = String(task || "");
  if (!t.trim()) return false;
  // Build / toolchain / package-manager work is NOT shared-storage-only.
  if (
    /\b(assemble|gradlew?|apktool|aapt2?|sdkmanager|ndk-build|cmake|expo\s+prebuild|javac?\b)\b/i.test(t) ||
    /\b(проот-?distro|apt-get|openjdk|android\s*sdk|tool-?pack)\b/i.test(t) ||
    /(?:собери|собрать|скомпилир|compile|build)\s+(?:мне\s+)?(?:apk|aab|приложение|app)\b/i.test(t)
  ) {
    return false;
  }
  const touchesShared =
    /\b(?:download|downloads|загрузк\w*|завантаж\w*|documents|документ\w*|pictures?|изображен\w*|dcim|music|музык\w*|movies?|видео|sdcard|aibuildertermux)\b|\/storage\/emulated\/\d+|\/sdcard\b/i.test(t);
  if (!touchesShared) return false;
  // File / folder verbs (RU/UK/EN) — create, write, delete, rename, copy, move, list.
  return /\b(?:создай|создать|створи|create|write|запиш\w*|файл|file|удал\w*|delete|rename|переимен\w*|скопир\w*|copy|перемест\w*|move|mkdir|папк\w*|folder|каталог|txt|zip|сохрани|save|list|ls\b|покажи|содержим\w*)\b/i.test(t);
}

/**
 * Resolve which backend executes a command.
 *
 * Selected environment is AUTHORITATIVE:
 * - Termux selected → all work (including APK build) on Termux (pkg, $PREFIX)
 * - Ubuntu selected → all work inside Ubuntu proot (apt-get, guest paths)
  *
 * Exception: pure shared-storage file ops (/sdcard, Download) skip the hard
 * rootfs preflight and may retry on the host if the Ubuntu guest cannot start.
 * The selected guest remains preferred while it is healthy.
 */
export function resolveAgentExecutionBackend(
  command: string,
  preferred: AgentShellBackend = current,
): AgentShellBackend {
  if (preferred === "termux") return "termux";
  // Native Priority (Fast Path): when the user selected ubuntu-proot but policy
  // is auto/prefer-termux, simple host-safe commands run on Termux without proot.
  // force-proot keeps the guest; apt/full-Linux commands still use ubuntu-proot.
  const mode = getNativePriorityMode();
  if (mode !== "force-proot") {
    const routed = resolveBackendForCommand(command, preferred, mode);
    if (routed === "termux") return "termux";
  }
  // Shared-storage commands MAY run in Ubuntu guest (binds /storage/emulated/0).
  // Host Termux is also chosen via hostTermux option or playbook fallback when rootfs is broken.
  return preferred;
}

/** User-visible run marker for chat bubbles (backend-aware). */
export function shellRunMarker(backend: AgentShellBackend = current): string {
  if (backend === "ubuntu-proot") return "UBUNTU_RUN:";
  return "TERMUX_RUN:";
}

/** User-visible done marker for chat bubbles (backend-aware). */
export function shellDoneMarker(backend: AgentShellBackend = current): string {
  if (backend === "ubuntu-proot") return "UBUNTU_DONE:";
  return "TERMUX_DONE:";
}

/**
 * Wrap a shell command for the active backend.
 * Termux: returned as-is.
 * Ubuntu proot: proot-distro login with binds so /storage projects stay reachable.
 * Shared-storage commands use the selected guest; callers choose the host
 * explicitly when applying the rootfs-failure fallback.
 */
export function wrapCommandForAgentShell(
  command: string,
  cwd?: string | null,
  backend: AgentShellBackend = current,
): string {
  const resolved = resolveAgentExecutionBackend(command, backend);
  if (resolved === "termux") return command;
  const inner = String(command || "").trim();
  if (!inner) return command;
  const distro = "ubuntu";
  if (new RegExp(`^\\s*proot-distro\\s+login\\s+${distro}\\b`, "i").test(inner)) return inner;

  const hostHome = "/data/data/com.karat.aibuilder/files/home";
  const guestHome = "/termux-home";
  // Termux HOME remains a Termux-owned package/cache location; user projects
  // and default relative writes belong to the canonical shared app workspace.
  const translateHostPaths = (value: string): string =>
    replaceAllSafe(value, hostHome, guestHome);
  const requestedCwd = cwd == null || String(cwd).trim() === ""
    ? `${AI_BUILDER_SHARED_ROOT}/workspace`
    : String(cwd).trim();
  if (!isWithinSharedAppRoot(requestedCwd)) {
    return `printf '%s\\n' 'AIB_CWD_OUTSIDE_SHARED_ROOT: user work must stay under ${AI_BUILDER_SHARED_ROOT}' >&2; exit 64`;
  }
  const guestCwd = translateHostPaths(requestedCwd);
  const quotedCwd = `'${guestCwd.replace(/'/g, `'"'"'`)}'`;
  const quotedRoot = `'${AI_BUILDER_SHARED_ROOT}'`;
  const cd =
    `AIB_ROOT=${quotedRoot}; mkdir -p "$AIB_ROOT/workspace"; ` +
    `AIB_ROOT_REAL=$(realpath -e "$AIB_ROOT") || { echo AIB_SHARED_ROOT_UNAVAILABLE >&2; exit 72; }; ` +
    `cd ${quotedCwd} || { echo AIB_CWD_UNAVAILABLE >&2; exit 72; }; ` +
    `AIB_CWD_REAL=$(pwd -P) || { echo AIB_CWD_UNAVAILABLE >&2; exit 72; }; ` +
    `case "$AIB_CWD_REAL" in "$AIB_ROOT_REAL"|"$AIB_ROOT_REAL"/*) ;; *) echo AIB_CWD_SYMLINK_ESCAPE >&2; exit 73;; esac; ` +
    `export AI_BUILDER_HOME="$AIB_ROOT_REAL"; `;

  const full = cd + translateHostPaths(inner);
  const escaped = full.replace(/'/g, `'\"'\"'`);
  const prefixExport = 'if [ -z "$PREFIX" ]; then PREFIX=/root/.aibuilder-prefix; fi; export PREFIX; mkdir -p "$PREFIX"; export AIB_PRIVATE_ROOT="/termux-home/.aibuilder"; mkdir -p "$AIB_PRIVATE_ROOT"; chmod 700 "$AIB_PRIVATE_ROOT"; ';
  const rootfsCheck = buildProotDistroRootfsCheckCommand(distro);
  const binds = [
    `--bind ${AI_BUILDER_SHARED_ROOT}:${AI_BUILDER_SHARED_ROOT}`,
    '--bind "$HOME":/termux-home',
  ].join(" ");

  return (
    `if ! command -v proot-distro >/dev/null 2>&1; then ` +
    `echo 'AIB_PROOT_DISTRO_MISSING: install proot-distro in Termux (host bootstrap)' >&2; exit 127; ` +
    `fi; ` +
    `ROOTFS_CHECK_OUTPUT=$(${rootfsCheck}); ROOTFS_CHECK_EC=$?; ` +
    `if [ "$ROOTFS_CHECK_EC" -ne 0 ]; then printf '%s\\n' "$ROOTFS_CHECK_OUTPUT" >&2; exit "$ROOTFS_CHECK_EC"; fi; ` +
    `proot-distro login ${distro} ${binds} -- bash -lc ` +
    `'export DEBIAN_FRONTEND=noninteractive; ${prefixExport}export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"; ` +
    `aib_pkg(){ verb="$1"; shift || true; case "$verb" in update) apt-get update;; install) yes apt-get install -y "$@";; uninstall|remove) apt-get remove -y "$@";; *) echo "AIB_PKG_UNSUPPORTED:$verb" >&2; return 2;; esac; }; ` +
    `pkg(){ aib_pkg "$@"; }; export -f aib_pkg pkg 2>/dev/null || true; ${escaped}'`
  );
}

/** Short hint for agent system prompt / [ENV]. */
export function agentShellBackendPromptHint(): string {
  if (current === "ubuntu-proot") {
    const distro = "Ubuntu";
    const id = "ubuntu-proot";
    const run = shellRunMarker(current);
    const done = shellDoneMarker(current);
    return (
      `[SHELL_BACKEND=${id}]\n` +
      `ACTIVE ENVIRONMENT = ${distro}. ALL task work stays HERE (create app, build APK, install tools, compile).\n` +
      `Do NOT switch to Termux pkg/host for builds. Package manager = apt/apt-get only.\n` +
      `APK/Gradle/Expo: install openjdk (apt), put Android SDK under $HOME/android-sdk or $HOME/Android/Sdk, export ANDROID_HOME/JAVA_HOME, then gradlew inside this guest.\n` +
      `STORAGE: pure file ops under /storage/emulated/0|sdcard (Download,Documents,Pictures,DCIM,Music,Movies,…) use absolute paths. Prefer the Ubuntu guest (binds /storage); the guarded runner may retry only eligible shared-storage commands on Termux after a verified Ubuntu/proot startup failure. Packages and builds stay in Ubuntu. Labels ${run}/${done}.\n` +
      `Projects/APKs under ${AI_BUILDER_SHARED_ROOT}. Metadata at /termux-home/.aibuilder (bind).\n` +
      `NEVER proot-distro install/reset/remove for ordinary tasks. Rootfs install only if list+login confirm absence.\n` +
      `Long installs: tell the user in plain language first.\n` +
      agentAutonomyPromptBlock(current)
    );
  }
  return (
    "[SHELL_BACKEND=termux]\n" +
    "ACTIVE ENVIRONMENT = AI Builder bundled private runtime. No external Termux is used.\n" +
    "Package/toolchain/build capabilities remain blocked until their signed feed and workspace contracts are qualified. Never bypass the capability gate.\n" +
    "Package manager = pkg (NOT apt). JDK/SDK under $PREFIX (tool-pack / openjdk packages).\n" +
    `Projects/APKs under ${AI_BUILDER_SHARED_ROOT}. Metadata $HOME/.aibuilder.\n` +
    "For long installs, tell the user what is starting.\n" +
    agentAutonomyPromptBlock("termux")
  );
}
