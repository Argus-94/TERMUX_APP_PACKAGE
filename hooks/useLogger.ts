import { useState, useCallback, useEffect } from "react";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { persistentLogger, redactLogText, type LogEntry, type LogLevel } from "../lib/persistent-logger";
import { createLogExportService, type LogExportResult } from "../lib/log-export";
import { Platform } from "react-native";
import Constants from "expo-constants";

export type { LogEntry, LogLevel };
export type { LogExportResult } from "../lib/log-export";

function formatTime(ts: number) {
  const d = new Date(ts);
  return (
    d.getFullYear().toString().slice(2) +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0") +
    " " +
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

const logExportService = createLogExportService({
  platform: Platform.OS === "android" ? "android" : "other",
  requestDirectoryPermission: async () => {
    const grant = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    return grant.granted ? { granted: true, directoryUri: grant.directoryUri } : { granted: false };
  },
  createSafFile: (directoryUri, fileName, mimeType) =>
    FileSystem.StorageAccessFramework.createFileAsync(directoryUri, fileName, mimeType),
  writeText: (uri, content) => FileSystem.writeAsStringAsync(uri, content, {
    encoding: FileSystem.EncodingType.UTF8,
  }),
  writeCacheFile: async (fileName, content) => {
    const cacheDirectory = FileSystem.cacheDirectory;
    if (!cacheDirectory) throw new Error("CACHE_DIRECTORY_UNAVAILABLE");
    const base = cacheDirectory.endsWith("/") ? cacheDirectory : `${cacheDirectory}/`;
    const uri = `${base}${fileName}`;
    await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 });
    return uri;
  },
  isSharingAvailable: () => Sharing.isAvailableAsync(),
  shareFile: async (uri, dialogTitle) => {
    await Sharing.shareAsync(uri, {
      mimeType: "text/plain",
      dialogTitle,
      UTI: "public.plain-text",
    });
  },
});

/**
 * Persistent log state is shared from lib/persistent-logger.ts. Export only
 * redacted log entries and minimal app/OS version metadata; Android writes via
 * the user's scoped SAF grant inside AIBuilderTermux, never broad storage APIs.
 */
export function useLogger() {
  const [logs, setLogs] = useState<LogEntry[]>(() => [...persistentLogger.getAll()].reverse());

  useEffect(() => {
    persistentLogger.hydrate();
    const unsubscribe = persistentLogger.subscribe((entries) => {
      setLogs([...entries].reverse());
    });
    return unsubscribe;
  }, []);

  const logInfo = useCallback((tag: string, message: string) => {
    persistentLogger.add("info", tag, message);
  }, []);
  const logWarn = useCallback((tag: string, message: string) => {
    persistentLogger.add("warn", tag, message);
  }, []);
  const logError = useCallback((tag: string, message: string) => {
    persistentLogger.add("error", tag, message);
  }, []);
  const logDebug = useCallback((tag: string, message: string) => {
    persistentLogger.add("debug", tag, message);
  }, []);

  const clearLogs = useCallback(() => {
    persistentLogger.clear();
  }, []);

  const exportLogsToFile = useCallback(async (dialogTitle?: string): Promise<LogExportResult> => {
    try {
      const current = persistentLogger.getAll(); // already chronological (oldest → newest)
      if (current.length === 0) return { kind: "empty" };

      const lines = current.map(
        (entry) => `[${formatTime(entry.timestamp)}] [${entry.level.toUpperCase()}] [${entry.source || "app"}] [${entry.sessionId || "unknown-session"}] [${entry.tag}] ${entry.message}`,
      );
      const appVersion = Constants.expoConfig?.version || Constants.nativeAppVersion || "unknown";
      const buildNumber = Constants.nativeBuildVersion || Constants.expoConfig?.android?.versionCode || "unknown";
      const osVersion = Platform.Version == null ? "unknown" : String(Platform.Version);
      const content = [
        "=== AI Builder Log ===",
        `Generated: ${new Date().toISOString()}`,
        `Total entries: ${lines.length}`,
        `App version: ${appVersion} (${buildNumber})`,
        `OS: ${Platform.OS} ${osVersion}`,
        "",
        "=== Log entries ===",
        lines.join("\n"),
      ].join("\n");

      return await logExportService(redactLogText(content), { dialogTitle });
    } catch {
      // Never allow an export exception to escape a UI event handler, and do
      // not log raw exception text (it may contain private paths or content).
      return { kind: "failed", reason: "write-failed" };
    }
  }, []);

  const getLogsByLevel = useCallback(
    (level: LogLevel) => logs.filter((entry) => entry.level === level),
    [logs],
  );

  return {
    logs,
    logInfo,
    logWarn,
    logError,
    logDebug,
    clearLogs,
    exportLogsToFile,
    getLogsByLevel,
  };
}
