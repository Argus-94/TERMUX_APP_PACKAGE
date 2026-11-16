/**
 * Materialize content:// or app-private file:// URIs to a path Termux can read.
 */
import * as FileSystemLegacy from "expo-file-system/legacy";

const DEFAULT_ROOT = "/storage/emulated/0/AIBuilderTermux/inbox";

function sanitizeFileName(value: string): string {
  const raw = value.trim() || `file-${Date.now()}`;
  const extM = raw.match(/(\.[A-Za-z0-9]{1,8})$/);
  const ext = extM ? extM[1].toLowerCase() : "";
  const base = raw.slice(0, ext ? -ext.length : undefined).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = (base || `file-${Date.now()}`) + ext;
  return name;
}

export async function materializeUriForTermux(
  sourceUri: string,
  preferredName: string,
  rootDir: string = DEFAULT_ROOT,
): Promise<string> {
  const root = String(rootDir || DEFAULT_ROOT).replace(/\/$/, "");
  if (root.includes("..") || !/^(\/storage\/|\/sdcard\/)/.test(root)) {
    throw new Error("INBOX_ROOT_NOT_ALLOWED");
  }
  const name = sanitizeFileName(preferredName) || `picked-${Date.now()}`;
  // Prefer known binary/source extensions for Termux-readable artifacts
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error("FILENAME_NOT_ALLOWED");
  }
  const destPath = `${root}/${name}`;
  const uri = String(sourceUri || "").trim();
  if (!uri) throw new Error("SOURCE_URI_REQUIRED");
  if (uri.includes("\0")) throw new Error("SOURCE_URI_INVALID");

  if (/^\/(storage|sdcard)\//i.test(uri)) {
    if (uri.includes("..")) throw new Error("SOURCE_PATH_TRAVERSAL");
    return uri;
  }
  if (/^file:\/\/\/(storage|sdcard)\//i.test(uri)) {
    try {
      const p = decodeURIComponent(uri.replace(/^file:\/\//i, ""));
      if (p.includes("..")) throw new Error("SOURCE_PATH_TRAVERSAL");
      return p;
    } catch (e) {
      if (e instanceof Error && e.message === "SOURCE_PATH_TRAVERSAL") throw e;
      return uri.replace(/^file:\/\//i, "");
    }
  }
  // Only content:// and file:// from app sandbox are copy targets
  if (!/^(content|file):\/\//i.test(uri)) {
    throw new Error("SOURCE_URI_SCHEME_NOT_ALLOWED");
  }

  const FS = FileSystemLegacy as typeof FileSystemLegacy & {
    makeDirectoryAsync?: (p: string, o?: { intermediates?: boolean }) => Promise<void>;
    copyAsync: (o: { from: string; to: string }) => Promise<void>;
    getInfoAsync?: (p: string) => Promise<{ exists?: boolean }>;
  };
  const parent = destPath.replace(/\/[^/]+$/, "");
  // Ensure inbox directory exists (large log attachments fail when parent is missing)
  for (const candidate of [`file://${parent}`, parent]) {
    try {
      await FS.makeDirectoryAsync?.(candidate, { intermediates: true });
      break;
    } catch {
      /* try next form */
    }
  }

  const destUri = `file://${destPath}`;
  try {
    await FS.copyAsync({ from: uri, to: destUri });
  } catch (e1) {
    try {
      await FS.copyAsync({ from: uri, to: destPath });
    } catch (e2) {
      const msg1 = e1 instanceof Error ? e1.message : String(e1);
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      throw new Error(
        `MATERIALIZE_COPY_FAILED: dest=${destPath} (${msg2 || msg1}). ` +
          `Ensure /storage/emulated/0/AIBuilderTermux/inbox is writable.`,
      );
    }
  }
  return destPath;
}
