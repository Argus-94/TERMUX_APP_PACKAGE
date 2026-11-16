/** Safe cleanup of explicitly enumerated embedded Termux cache paths only. */
import { runEmbeddedTermuxCommand } from "./termux-bridge";
import { persistentLogger } from "./persistent-logger";

export type CacheCleanupProgress = { percent: number; detail: string };
export type CacheCleanupResult = { ok: boolean; log: string; freedHint?: string };

function buildCleanupScript(): string {
  return `
set -eu
printf 'STAGE:5:start\n'
# The embedded native runtime supplies these roots. Require canonical, existing,
# non-root directories; no fallback to external Termux or host /tmp is permitted.
case "\${PREFIX:-}" in /*) ;; *) echo 'CLEANUP_REJECTED:invalid_prefix'; exit 2;; esac
case "\${HOME:-}" in /*) ;; *) echo 'CLEANUP_REJECTED:invalid_home'; exit 2;; esac
[ -d "$PREFIX" ] && [ -d "$HOME" ] || { echo 'CLEANUP_REJECTED:missing_roots'; exit 2; }
P=$(realpath -e -- "$PREFIX") || { echo 'CLEANUP_REJECTED:prefix'; exit 2; }
H=$(realpath -e -- "$HOME") || { echo 'CLEANUP_REJECTED:home'; exit 2; }
[ "$P" = "$PREFIX" ] && [ "$H" = "$HOME" ] && [ "$P" != / ] && [ "$H" != / ] || { echo 'CLEANUP_REJECTED:noncanonical_roots'; exit 2; }
[ -d "$P/bin" ] && [ -d "$P/lib" ] || { echo 'CLEANUP_REJECTED:prefix_layout'; exit 2; }
case "$P" in */usr) ;; *) echo 'CLEANUP_REJECTED:prefix_name'; exit 2;; esac
[ "$H" = "\${P%/usr}/home" ] || { echo 'CLEANUP_REJECTED:root_relationship'; exit 2; }
BEFORE=$(df -Pk "$H" 2>/dev/null | tail -1 | awk '{print $4}')

# Remove only these exact known cache directories. Each must resolve exactly to
# its expected lexical location; symlink aliases and protected-path aliases fail closed.
safe_remove() {
  target=$1; expected=$2
  case "$target" in "$H"/*|"$P"/*) ;; *) echo "CLEANUP_REJECTED:path:$target"; return 1;; esac
  resolved=$(realpath -m -- "$target" 2>/dev/null) || { echo "CLEANUP_REJECTED:resolve:$target"; return 1; }
  [ "$resolved" = "$expected" ] || { echo "CLEANUP_REJECTED:alias:$target"; return 1; }
  case "$resolved" in "$P/bin"|"$P/bin/"*|"$P/lib"|"$P/lib/"*|"$P/opt"|"$P/opt/"*|"$P/var/lib/proot-distro/installed-rootfs"|"$P/var/lib/proot-distro/installed-rootfs/"*|"$H/.termux"|"$H/.termux/"*|"$H/exports"|"$H/exports/"* ) echo "CLEANUP_REJECTED:protected:$target"; return 1;; esac
  rm -rf -- "$target"
}
# Prefix cache paths are approved only under this exact embedded PREFIX.
for rel in 'var/cache/apt/archives/*.deb' 'var/cache/apt/archives/partial' 'tmp/npm-*' 'tmp/aib-*' 'tmp/aibuilder*' 'tmp/aib-android-sdk-*' 'tmp/aib-ndk-*' 'tmp/aibuilder'; do
  # Globs are expanded only after the prefix has been validated.
  for item in "$P"/$rel; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    safe_remove "$item" "$item" || exit 2
  done
done
for rel in .aibuilder-gradle/caches .aibuilder-gradle/daemon .aibuilder-gradle/native .aibuilder-gradle/workers .aibuilder-gradle/.tmp .aibuilder-gradle/kotlin-profile .gradle/caches .gradle/daemon .gradle/native .gradle/workers .gradle/.tmp .gradle/kotlin-profile .cache/pip .cache/pnpm .cache/yarn .cache/typescript .npm/_cacache .npm/_logs .cargo/registry/cache var/lib/proot-distro/dlcache var/lib/proot-distro/download; do
  # var/lib is a prefix location, all others are HOME-relative.
  case "$rel" in var/lib/*) item="$P/$rel";; *) item="$H/$rel";; esac
  [ -e "$item" ] || [ -L "$item" ] || continue
  safe_remove "$item" "$item" || exit 2
done
# No exports, projects, ~/.termux, installed tools/rootfs, or external /tmp touched.
AFTER=$(df -Pk "$H" 2>/dev/null | tail -1 | awk '{print $4}')
[ -n "$BEFORE" ] && [ -n "$AFTER" ] && [ "$AFTER" -ge "$BEFORE" ] 2>/dev/null && echo "FREED_KB:$((AFTER-BEFORE))"
echo 'STAGE:100:done'
echo 'CLEANUP_OK'
exit 0
`.trim();
}

export async function runTermuxCacheCleanup(
  onProgress?: (p: CacheCleanupProgress) => void,
): Promise<CacheCleanupResult> {
  const report = (percent: number, detail: string) => onProgress?.({ percent, detail });
  report(2, "Подготовка…");
  try {
    const r = await runEmbeddedTermuxCommand(buildCleanupScript(), { timeoutMs: 180_000 });
    const log = `${r.stdout || ""}\n${r.stderr || ""}`;
    for (const line of log.split("\n")) {
      const m = line.match(/^STAGE:(\d+):(\w+)/);
      if (m) report(Math.min(99, Number(m[1]) || 0), m[2]);
    }
    const freed = log.match(/FREED_KB:(\d+)/);
    const freedHint = freed ? `~${Math.max(0, Math.round(Number(freed[1]) / 1024))} МБ свободно дополнительно` : undefined;
    const ok = r.exitCode === 0 && !r.timedOut && /^CLEANUP_OK$/m.test(r.stdout || "");
    report(ok ? 100 : 0, ok ? "Готово" : "Ошибка");
    persistentLogger.add(ok ? "info" : "warn", "CacheCleanup", ok ? `cleanup ok ${freedHint || ""}`.trim() : `cleanup failed exit=${r.exitCode} timeout=${r.timedOut}`, "app");
    return { ok, log: log.slice(-4000), freedHint };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    persistentLogger.add("error", "CacheCleanup", msg, "app");
    report(0, "Ошибка");
    return { ok: false, log: msg };
  }
}
