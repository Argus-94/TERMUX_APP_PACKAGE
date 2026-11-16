/**
 * Export / import AI Builder durable profile (plan P2 — survive reinstall).
 * Exports into the visible AIBuilderTermux shared workspace so backups outlive
 * app-private storage. Packs metadata + projects under HOME; not the full rootfs.
 */
import { runShellCommand } from "./termux-bridge";
import { persistentLogger } from "./persistent-logger";
import { buildProfileExportCommand, buildProfileImportCommand } from "./profile-transfer-shell";
import { AI_BUILDER_SHARED_ROOT, isWithinSharedAppRoot } from "./writable-path-policy";

export type ProfileTransferResult = {
  ok: boolean;
  path?: string;
  message: string;
};

/** Durable user backup path inside the canonical shared workspace. */
export function defaultProfileExportPath(_homeRoot?: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${AI_BUILDER_SHARED_ROOT}/backups/profile-${ts}.tar.gz`;
}

export function fallbackProfileExportPath(homeRoot: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${AI_BUILDER_SHARED_ROOT}/backups/profile-export-${ts}.tar.gz`;
}

export async function exportProfileZip(destPath: string, homeRoot: string): Promise<ProfileTransferResult> {
  let dest = destPath.trim();
  if (!dest || dest.includes("..") || !isWithinSharedAppRoot(dest)) {
    return { ok: false, message: "invalid destination path" };
  }
  // Try primary dest; on failure retry under HOME/logs.
  const tryExport = async (path: string) => {
    const cmd = buildProfileExportCommand(path, homeRoot);
    const r = await runShellCommand(cmd, { timeoutMs: 120_000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const code = r.exitCode ?? 1;
    return { ok: code === 0 && out.includes("PROFILE_EXPORT_OK"), out, path, code };
  };

  try {
    persistentLogger.add("info", "Profile", `export → ${dest}`);
    let res = await tryExport(dest);
    if (!res.ok) {
      const fb = fallbackProfileExportPath(homeRoot);
      const res2 = await tryExport(fb);
      if (res2.ok) {
        return {
          ok: true,
          path: fb,
          message: `exported → ${fb} (primary destination unavailable; used shared backups)`,
        };
      }
      return { ok: false, path: dest, message: (res.out + "\n" + res2.out).slice(0, 500) };
    }
    if (res.ok) {
      persistentLogger.add("info", "Profile", `export OK ${dest}`);
      return { ok: true, path: dest, message: `exported → ${dest}` };
    }
    return { ok: false, path: dest, message: res.out.slice(0, 400) || `exit ${res.code}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function importProfileZip(sourcePath: string, homeRoot: string): Promise<ProfileTransferResult> {
  const src = sourcePath.trim();
  if (!src || src.includes("..")) {
    return { ok: false, message: "invalid source path" };
  }
  const cmd = buildProfileImportCommand(src, homeRoot);
  try {
    persistentLogger.add("info", "Profile", `import ← ${src}`);
    const r = await runShellCommand(cmd, { timeoutMs: 180_000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const code = r.exitCode ?? 1;
    if (code === 0 && out.includes("PROFILE_IMPORT_OK")) {
      persistentLogger.add("info", "Profile", `import OK ${src}`);
      return { ok: true, path: src, message: `imported from ${src}` };
    }
    return { ok: false, path: src, message: out.slice(0, 400) || `exit ${code}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
