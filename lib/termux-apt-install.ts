/** Package operations are private-runtime-only. No public Termux mirror is compatible. */

/** Short shell-safe label; never interpolate an executable script inside echo. */
export function describeInstallCommand(command: string): string {
  const lines = String(command || "").split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return "install script (" + lines.length + " lines)";
  const safe = (lines[0] || "").replace(/[^A-Za-z0-9 _.:\/=+,-]/g, "").slice(0, 100);
  return safe || "install script";
}

/**
 * Production feed pins and device qualification have not been provisioned.
 * This deliberately performs no mkdir, apt, pkg, dpkg, download or source rewrite.
 * Re-enable only alongside the reviewed signed private feed, never by an env flag.
 */
export const TERMUX_REPO_PREFLIGHT =
  'echo "AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED: package operations require the signed app-compatible feed" >&2; exit 78; ';

/** Compatibility name: no external mirror or repair transaction remains. */
export const TERMUX_MIRROR_REPAIR = TERMUX_REPO_PREFLIGHT;

/** Keep caller API stable while preventing the supplied installation body from running. */
export function wrapTermuxAptInstallWithUpdate(_installCmd: string, emitPkgMarkers = false): string {
  return (emitPkgMarkers
    ? 'echo "AIB_PKG_UPDATE_EXIT:78"; echo "AIB_PKG_INSTALL_EXIT:78"; echo "PKG_EXIT:78"; '
    : "") + TERMUX_REPO_PREFLIGHT;
}

/** A blocked private feed must not trigger any legacy mirror retry. */
export function isPkgMirrorFailure(_result: { exitCode?: number; stdout?: string; stderr?: string }): boolean {
  return false;
}
