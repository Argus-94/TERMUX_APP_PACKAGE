/**
 * User-visible Android shared storage roots (NOT system/root partitions).
 * Agent may create/edit under these; never under /system /data /vendor /proc …
 */
export const ANDROID_SHARED_ROOT = "/storage/emulated/0" as const;
export const ANDROID_SDCARD_ROOT = "/sdcard" as const;

/** Well-known public media directories under emulated storage. */
export const USER_STORAGE_DIRS: ReadonlyArray<{ keys: RegExp; path: string }> = [
  { keys: /\b(?:download|downloads|загрузк\w*|завантаж\w*)\b/i, path: `${ANDROID_SHARED_ROOT}/Download` },
  { keys: /\b(?:documents?|документ\w*|документац\w*)\b/i, path: `${ANDROID_SHARED_ROOT}/Documents` },
  { keys: /\b(?:pictures?|изображен\w*|зображен\w*|photos?|фото)\b/i, path: `${ANDROID_SHARED_ROOT}/Pictures` },
  { keys: /\b(?:dcim)\b/i, path: `${ANDROID_SHARED_ROOT}/DCIM` },
  { keys: /\b(?:music|музык\w*|музик\w*|audio)\b/i, path: `${ANDROID_SHARED_ROOT}/Music` },
  { keys: /\b(?:movies?|video|видео|відео)\b/i, path: `${ANDROID_SHARED_ROOT}/Movies` },
  { keys: /\b(?:alarms?|будильник\w*)\b/i, path: `${ANDROID_SHARED_ROOT}/Alarms` },
  { keys: /\b(?:notifications?|уведомлен\w*|сповіщен\w*)\b/i, path: `${ANDROID_SHARED_ROOT}/Notifications` },
  { keys: /\b(?:podcasts?|подкаст\w*)\b/i, path: `${ANDROID_SHARED_ROOT}/Podcasts` },
  { keys: /\b(?:ringtones?|рингтон\w*)\b/i, path: `${ANDROID_SHARED_ROOT}/Ringtones` },
  {
    keys: /\b(?:aibuildertermux|aibuilder\s*termux|workspace\s*aib)\b/i,
    path: `${ANDROID_SHARED_ROOT}/AIBuilderTermux`,
  },
];

const SYSTEM_PATH_RE =
  /^\/(?:system|data|vendor|proc|dev|sys|apex|acct|cfg|odm|oem|product|bootstrap|root|etc|bin|sbin|usr|lib|lib64)(?:\/|$)/i;

/** Absolute path under shared user storage (emulated or sdcard), not system root. */
export function isUserSharedAbsolutePath(p: string): boolean {
  const s = String(p || "").trim();
  if (!s.startsWith("/") || s.includes("\0") || /\.\./.test(s)) return false;
  if (SYSTEM_PATH_RE.test(s)) return false;
  if (/^\/storage\/emulated\/\d+(?:\/|$)/i.test(s)) return true;
  if (/^\/sdcard(?:\/|$)/i.test(s)) return true;
  if (/^\/storage\/[0-9A-Fa-f-]+(?:\/|$)/i.test(s)) return true; // secondary volumes
  return false;
}

/** Detect which public folder the user mentioned; default Download when "shared" is vague. */
export function resolveUserStorageBase(task: string, opts?: { defaultTo?: "download" | "aibuilder" | null }): string | null {
  const t = String(task || "");
  // Explicit absolute path in task wins
  const abs =
    t.match(/(\/storage\/emulated\/\d+\/[^\s"'`]+)/) ||
    t.match(/(\/sdcard\/[^\s"'`]+)/);
  if (abs) {
    const full = abs[1].replace(/\/+$/, "");
    // If it's a file path, return parent; if dir-ish return as base when creating inside
    if (isUserSharedAbsolutePath(full)) {
      // For "create X in /storage/.../Documents" base is the dir
      return full;
    }
  }
  for (const d of USER_STORAGE_DIRS) {
    if (d.keys.test(t)) return d.path;
  }
  // Generic "на телефоне / в памяти / в storage / sdcard" without named folder
  if (/\b(?:sdcard|\/storage|на\s+телефон|в\s+памяти|shared\s+storage|внутренн\w*\s+памят)\b/i.test(t)) {
    if (opts?.defaultTo === "aibuilder") return `${ANDROID_SHARED_ROOT}/AIBuilderTermux/workspace`;
    if (opts?.defaultTo === null) return null;
    return `${ANDROID_SHARED_ROOT}/Download`;
  }
  return opts?.defaultTo === "aibuilder"
    ? `${ANDROID_SHARED_ROOT}/AIBuilderTermux/workspace`
    : opts?.defaultTo === null
      ? null
      : null;
}

/** Join base + name safely (single path segment for name). */
export function joinUserStorage(base: string, name: string): string {
  const n = String(name || "").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).pop() || "item";
  const b = base.replace(/\/+$/, "");
  return `${b}/${n}`;
}
