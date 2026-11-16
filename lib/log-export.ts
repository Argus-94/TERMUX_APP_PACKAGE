export type LogExportFailureReason =
  | "permission-denied"
  | "storage-unavailable"
  | "wrong-directory"
  | "write-failed"
  | "share-unavailable"
  | "too-large";

export type LogExportResult =
  | Readonly<{ kind: "saved"; uri: string }>
  | Readonly<{ kind: "cancelled"; reason: "directory-picker-cancelled" | "share-cancelled" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "failed"; reason: LogExportFailureReason }>;

export type LogExportDirectoryPermission = Readonly<{
  granted: boolean;
  directoryUri?: string | null;
}>;

export type LogExportAdapter = Readonly<{
  platform: "android" | "other";
  requestDirectoryPermission?: () => Promise<LogExportDirectoryPermission>;
  createSafFile?: (directoryUri: string, fileName: string, mimeType: string) => Promise<string>;
  writeText?: (uri: string, content: string) => Promise<void>;
  writeCacheFile?: (fileName: string, content: string) => Promise<string>;
  isSharingAvailable?: () => Promise<boolean>;
  shareFile?: (uri: string, dialogTitle: string) => Promise<void>;
}>;

export type LogExportOptions = Readonly<{
  fileName?: string;
  dialogTitle?: string;
}>;

export const MAX_LOG_EXPORT_CHARACTERS = 8_000_000;
const ALLOWED_SHARED_ROOT = "AIBuilderTermux";

function primaryStoragePath(uri: string, segment: "tree" | "document"): string | null {
  if (typeof uri !== "string" || !uri.startsWith("content://")) return null;
  const authority = uri.match(/^content:\/\/([^/]+)/i)?.[1]?.toLowerCase();
  if (authority !== "com.android.externalstorage.documents") return null;
  const marker = uri.match(new RegExp(`/${segment}/([^/?#]+)`, "i"));
  if (!marker) return null;
  let documentId: string;
  try {
    documentId = decodeURIComponent(marker[1]);
  } catch {
    return null;
  }
  const colon = documentId.indexOf(":");
  if (colon < 0 || documentId.slice(0, colon).toLowerCase() !== "primary") return null;
  const segments = documentId.slice(colon + 1).split("/").filter(Boolean);
  if (!segments.length || segments[0] !== ALLOWED_SHARED_ROOT) return null;
  if (segments.some((part) => part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) return null;
  return segments.join("/");
}

/**
 * SAF grants are accepted only for the shared-storage `AIBuilderTermux` tree
 * (or a descendant selected by the user). No raw external-storage path or
 * broad Android storage permission is used by this flow.
 */
export function isAllowedLogExportDirectoryUri(uri: string): boolean {
  const selectedPath = primaryStoragePath(uri, "tree");
  return selectedPath === ALLOWED_SHARED_ROOT || Boolean(selectedPath?.startsWith(`${ALLOWED_SHARED_ROOT}/`));
}

export function isAllowedLogExportFileUri(uri: string, selectedDirectoryUri: string): boolean {
  const filePath = primaryStoragePath(uri, "document");
  const directoryPath = primaryStoragePath(selectedDirectoryUri, "tree");
  return Boolean(filePath && directoryPath && filePath.startsWith(`${directoryPath}/`) && filePath.toLowerCase().endsWith(".txt"));
}

function isPermissionFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /permission|securityexception|eacces|eperm|denied/i.test(text);
}

function isShareCancellation(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /cancel(?:led|ed)?|dismiss(?:ed)?|e_canceled|e_cancelled/i.test(text);
}

function safeFileName(value: string | undefined): string {
  const candidate = typeof value === "string" ? value : `ai-builder-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const safe = candidate.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.endsWith(".txt") ? safe : `${safe}.txt`;
}

/**
 * Create a testable export service. Concurrent taps share one in-flight task;
 * a failed/cancelled export always resolves to a bounded result and never leaks
 * platform exception text (which can contain private paths or provider data).
 */
export function createLogExportService(adapter: LogExportAdapter) {
  let active: Promise<LogExportResult> | null = null;

  const execute = async (content: string, options: LogExportOptions = {}): Promise<LogExportResult> => {
    if (content.length === 0) return { kind: "empty" };
    if (content.length > MAX_LOG_EXPORT_CHARACTERS) return { kind: "failed", reason: "too-large" };
    const fileName = safeFileName(options.fileName);

    if (adapter.platform === "android") {
      if (!adapter.requestDirectoryPermission || !adapter.createSafFile || !adapter.writeText) {
        return { kind: "failed", reason: "storage-unavailable" };
      }
      try {
        const grant = await adapter.requestDirectoryPermission();
        if (!grant?.granted) return { kind: "cancelled", reason: "directory-picker-cancelled" };
        const directoryUri = typeof grant.directoryUri === "string" ? grant.directoryUri : "";
        if (!directoryUri) return { kind: "failed", reason: "storage-unavailable" };
        if (!isAllowedLogExportDirectoryUri(directoryUri)) return { kind: "failed", reason: "wrong-directory" };
        const fileUri = await adapter.createSafFile(directoryUri, fileName, "text/plain");
        if (!isAllowedLogExportFileUri(fileUri, directoryUri)) {
          return { kind: "failed", reason: "storage-unavailable" };
        }
        await adapter.writeText(fileUri, content);
        return { kind: "saved", uri: fileUri };
      } catch (error: unknown) {
        return { kind: "failed", reason: isPermissionFailure(error) ? "permission-denied" : "write-failed" };
      }
    }

    if (!adapter.writeCacheFile || !adapter.isSharingAvailable || !adapter.shareFile) {
      return { kind: "failed", reason: "storage-unavailable" };
    }
    try {
      const fileUri = await adapter.writeCacheFile(fileName, content);
      if (!fileUri) return { kind: "failed", reason: "storage-unavailable" };
      if (!await adapter.isSharingAvailable()) return { kind: "failed", reason: "share-unavailable" };
      try {
        await adapter.shareFile(fileUri, options.dialogTitle || "Save log");
      } catch (error: unknown) {
        if (isShareCancellation(error)) return { kind: "cancelled", reason: "share-cancelled" };
        return { kind: "failed", reason: isPermissionFailure(error) ? "permission-denied" : "write-failed" };
      }
      return { kind: "saved", uri: fileUri };
    } catch (error: unknown) {
      return { kind: "failed", reason: isPermissionFailure(error) ? "permission-denied" : "write-failed" };
    }
  };

  return (content: string, options: LogExportOptions = {}): Promise<LogExportResult> => {
    if (active) return active;
    const work = execute(content, options);
    active = work;
    void work.then(
      () => { if (active === work) active = null; },
      () => { if (active === work) active = null; },
    );
    return work;
  };
}
