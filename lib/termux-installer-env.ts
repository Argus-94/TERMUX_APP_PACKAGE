/**
 * Package installer environments for Termux and Linux proot backends.
 *
 * Termux preserves the user's configured sources and validates non-empty package
 * indexes below $PREFIX. Debian/Ubuntu proot use the guest's system apt state.
 */

import { isLinuxProotBackend } from "./agent-shell-backend";
import { adaptTermuxPackageCommand, androidSdkRootEnvironment, type PackageBackendTarget } from "./package-command-routing";
import {
  TERMUX_REPO_PREFLIGHT,
  TERMUX_MIRROR_REPAIR,
  isPkgMirrorFailure,
  wrapTermuxAptInstallWithUpdate,
  describeInstallCommand,
} from "./termux-apt-install";

export { TERMUX_REPO_PREFLIGHT, TERMUX_MIRROR_REPAIR, isPkgMirrorFailure };

const AI_BUILDER_CHECK_ENV =
  ': "${PREFIX:?AI_BUILDER_PRIVATE_PREFIX_REQUIRED}"; ' +
  'export PATH="$PREFIX/bin:$PREFIX/bin/applets:$PATH"; ';

const AI_BUILDER_TERMUX_INSTALLER_ENV =
  ': "${PREFIX:?AI_BUILDER_PRIVATE_PREFIX_REQUIRED}"; ' +
  'TERMUX_CACHE="$HOME/.cache"; ' +
  'mkdir -p "$TERMUX_CACHE/pip" "$TERMUX_CACHE/npm" "$TERMUX_CACHE/corepack" "$HOME/.local" "$PREFIX/var/lib/apt/lists/partial" "$PREFIX/tmp"; ' +
  'export PYTHONUSERBASE="$HOME/.local" PIP_CACHE_DIR="$TERMUX_CACHE/pip" NPM_CONFIG_CACHE="$TERMUX_CACHE/npm" COREPACK_HOME="$TERMUX_CACHE/corepack" XDG_CACHE_HOME="$TERMUX_CACHE" TMPDIR="$PREFIX/tmp"; ' +
  'export PATH="$PREFIX/bin:$PREFIX/bin/applets:$PATH"; ';

const AI_BUILDER_LINUX_INSTALLER_ENV =
  'PREFIX="${PREFIX:-/root/.aibuilder-prefix}"; export PREFIX; ' +
  androidSdkRootEnvironment() +
  'GUEST_CACHE="$HOME/.cache"; ' +
  'mkdir -p "$GUEST_CACHE/pip" "$GUEST_CACHE/npm" "$GUEST_CACHE/corepack" "${TMPDIR:-/tmp}"; ' +
  'export PIP_CACHE_DIR="$GUEST_CACHE/pip" NPM_CONFIG_CACHE="$GUEST_CACHE/npm" COREPACK_HOME="$GUEST_CACHE/corepack" XDG_CACHE_HOME="$GUEST_CACHE" TMPDIR="${TMPDIR:-/tmp}"; ' +
  // The proot rootfs is isolated from the Android host; permit pip's normal
  // package workflow on distro Python versions that enforce PEP 668.
  'export PIP_BREAK_SYSTEM_PACKAGES=1 PIP_ROOT_USER_ACTION=ignore; ';

export const AI_BUILDER_INSTALLER_ENV = AI_BUILDER_TERMUX_INSTALLER_ENV + TERMUX_REPO_PREFLIGHT;

export function preferAptGetInstall(cmd: string): string {
  let c = String(cmd || "");
  c = c.replace(/\bpkg\s+install\s+-y\b/g, "apt-get install -y");
  c = c.replace(/\bpkg\s+install\b/g, "apt-get install -y");
  c = c.replace(/\bpkg\s+update\s+-y\b/g, "apt-get update -y");
  c = c.replace(/\bpkg\s+update\b/g, "apt-get update -y");
  c = c.replace(/\bpkg\s+uninstall\s+-y\b/g, "apt-get remove -y");
  c = c.replace(/\bpkg\s+uninstall\b/g, "apt-get remove -y");
  c = c.replace(/\bpkg\s+remove\s+-y\b/g, "apt-get remove -y");
  c = c.replace(/\bpkg\s+remove\b/g, "apt-get remove -y");
  c = c.replace(/\bpkg\s+clean\b/g, "apt-get clean");
  return c;
}

function wrapLinuxAptInstallWithUpdate(installCmd: string): string {
  // c is inserted as a shell command in parentheses, not as a quoted value.
  const c = preferAptGetInstall(installCmd).trim();
  return (
    "set +e; export DEBIAN_FRONTEND=noninteractive; " +
    'AIB_UP_LOG="$PREFIX/tmp/aib-apt-update.log"; AIB_INSTALL_LOG="$PREFIX/tmp/aib-apt-install.log"; mkdir -p "$PREFIX/tmp"; ' +
    'echo "[aib] apt-get update in Linux proot"; ' +
    'apt-get update -y -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 >"$AIB_UP_LOG" 2>&1; upd=$?; ' +
    'if [ "$upd" != 0 ]; then ' +
    '  echo "[aib] APT_UPDATE_DIAGNOSTIC_BEGIN"; if [ -f "$AIB_UP_LOG" ]; then cat "$AIB_UP_LOG"; else echo "[aib] apt output log unavailable"; fi; echo "[aib] APT_UPDATE_DIAGNOSTIC_END"; ' +
    '  echo "[aib] Linux apt-get update failed (exit=$upd)"; echo "AIB_APT_UPDATE_EXIT:$upd"; echo "AIB_APT_EXIT:$upd"; exit "$upd"; ' +
    'fi; ' +
    'tail -30 "$AIB_UP_LOG" 2>/dev/null || true; ' +
    'echo "[aib] run: ' + describeInstallCommand(c) + '"; ' +
    '(' + c + ') >"$AIB_INSTALL_LOG" 2>&1; ec=$?; ' +
    'if [ "$ec" != 0 ]; then ' +
    '  echo "[aib] install exit=$ec — attempting dpkg/apt repair"; ' +
    '  dpkg --configure -a >>"$AIB_INSTALL_LOG" 2>&1 || true; ' +
    '  apt-get -f install -y >>"$AIB_INSTALL_LOG" 2>&1 || true; ' +
    '  (' + c + ') >>"$AIB_INSTALL_LOG" 2>&1; ec=$?; ' +
    'fi; ' +
    'if [ "$ec" != 0 ]; then echo "[aib] APT_INSTALL_DIAGNOSTIC_BEGIN"; if [ -f "$AIB_INSTALL_LOG" ]; then cat "$AIB_INSTALL_LOG"; else echo "[aib] apt install output log unavailable"; fi; echo "[aib] APT_INSTALL_DIAGNOSTIC_END"; ' +
    'else tail -40 "$AIB_INSTALL_LOG" 2>/dev/null || true; fi; ' +
    'echo "AIB_APT_EXIT:$ec"; exit "$ec"'
  );
}

/**
 * Run apt-get install/remove only after successful update and package-index
 * validation in Termux. The Linux branch uses the guest's native apt lists.
 */
export function wrapAptInstallWithUpdate(installCmd: string, linuxBackend = false): string {
  if (linuxBackend) return wrapLinuxAptInstallWithUpdate(installCmd);
  return wrapTermuxAptInstallWithUpdate(preferAptGetInstall(installCmd));
}

/** Correctly update indexes for whichever package environment the menu targets. */
export function withPackageIndexUpdate(): string {
  if (!isLinuxProotBackend()) return AI_BUILDER_INSTALLER_ENV + TERMUX_MIRROR_REPAIR;
  return (
    AI_BUILDER_LINUX_INSTALLER_ENV +
    'AIB_UP_LOG="$PREFIX/tmp/aib-apt-update.log"; mkdir -p "$PREFIX/tmp"; ' +
    'apt-get update -y -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 >"$AIB_UP_LOG" 2>&1; upd=$?; ' +
    'if [ "$upd" != 0 ]; then echo "[aib] APT_UPDATE_DIAGNOSTIC_BEGIN"; if [ -f "$AIB_UP_LOG" ]; then cat "$AIB_UP_LOG"; else echo "[aib] apt output log unavailable"; fi; echo "[aib] APT_UPDATE_DIAGNOSTIC_END"; fi; ' +
    'if [ "$upd" = 0 ]; then tail -30 "$AIB_UP_LOG" 2>/dev/null || true; fi; ' +
    'echo "AIB_MIRROR_REPAIR_DONE upd=$upd"; exit "$upd";'
  );
}

export function withInstallerEnvironment(cmd: string, targetBackend?: PackageBackendTarget): string {
  const linuxBackend = targetBackend ? targetBackend === "linux" : isLinuxProotBackend();
  if (linuxBackend) {
    const adapted = preferAptGetInstall(cmd);
    if (adapted === TERMUX_MIRROR_REPAIR || adapted.includes("AIB_MIRROR_REPAIR_DONE upd=")) {
      return withPackageIndexUpdate();
    }
    if (/\bapt-get\s+install\b/i.test(adapted)) {
      return AI_BUILDER_LINUX_INSTALLER_ENV + wrapAptInstallWithUpdate(adapted, true);
    }
    // apt-get remove needs no package-index preflight; ordinary shell commands
    // must not run Termux's mirror selector from inside a Linux guest either.
    return AI_BUILDER_LINUX_INSTALLER_ENV + adapted;
  }
  const adapted = adaptTermuxPackageCommand(cmd);
  if (/\bpkg\s+(?:install|uninstall)\b/i.test(adapted)) {
    // Use apt-get directly so a transaction-scoped APT_CONFIG also governs the
    // ensuing install; the pkg wrapper may otherwise discard or replace it.
    return AI_BUILDER_TERMUX_INSTALLER_ENV + wrapTermuxAptInstallWithUpdate(preferAptGetInstall(adapted));
  }
  return AI_BUILDER_INSTALLER_ENV + adapted;
}

export function withCheckEnvironment(cmd: string, targetBackend?: PackageBackendTarget): string {
  const linuxBackend = targetBackend ? targetBackend === "linux" : isLinuxProotBackend();
  if (linuxBackend) {
    return (
      'PREFIX="${PREFIX:-/root/.aibuilder-prefix}"; export PREFIX; ' +
      androidSdkRootEnvironment() +
      'export PATH="$PREFIX/bin:$PREFIX/bin/applets:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"; ' +
      cmd
    );
  }
  return AI_BUILDER_CHECK_ENV + cmd;
}

export async function ensureTermuxMirrorsReady(
  run: (
    cmd: string,
    opts?: { timeoutMs?: number },
  ) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>,
): Promise<boolean> {
  try {
    const r = await run(TERMUX_REPO_PREFLIGHT + TERMUX_MIRROR_REPAIR, { timeoutMs: 180_000 });
    const log = `${r.stdout || ""}\n${r.stderr || ""}`;
    const updateStatus = log.match(/AIB_MIRROR_REPAIR_DONE upd=(\d+)/)?.[1];
    if (updateStatus !== undefined) return updateStatus === "0";
    return r.exitCode === 0 && !isPkgMirrorFailure(r);
  } catch {
    return false;
  }
}

/** Alias expected by compile-packages.ts */
export async function ensureTermuxMirrors(
  run: (
    cmd: string,
    opts?: { timeoutMs?: number },
  ) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>,
): Promise<boolean> {
  return ensureTermuxMirrorsReady(run);
}
