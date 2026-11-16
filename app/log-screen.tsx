import { useEffect, useState, useMemo, useRef } from "react";
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLoggerContext } from "../components/LoggerContext";
import { useDialog } from "../components/DialogContext";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import {
  runSelfChecks,
  formatSelfCheckReport,
  formatSelfCheckLogLine,
} from "../lib/self-checks";
import type { LogEntry } from "../lib/persistent-logger";
import { loadRecentTraces, formatTraceSummary, type AgentTrace } from "../lib/agent-trace";
import { summarizeFailure, isTermuxSetupFailure } from "../lib/scripted-task-engine";
import { getCurrentTermuxSetupIssues } from "../lib/termux-setup-evidence";

const FILTER_OPTIONS: Array<"all" | "info" | "warn" | "error" | "debug"> = ["all", "info", "warn", "error", "debug"];
const SOURCE_OPTIONS: Array<"all" | "app" | "termux" | "linux" | "native" | "console" | "network" | "agent"> = ["all", "app", "termux", "linux", "native", "console", "network", "agent"];

export default function LogScreen() {
  const insets = useSafeAreaInsets();
  const logger = useLoggerContext();
  const { logs, clearLogs, exportLogsToFile, logInfo } = logger;
  const { showDialog } = useDialog();
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const [filter, setFilter] = useState<"all" | "info" | "warn" | "error" | "debug">("all");
  const [sourceFilter, setSourceFilter] = useState<typeof SOURCE_OPTIONS[number]>("all");
  const [lastTrace, setLastTrace] = useState<AgentTrace | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const exportBusyRef = useRef(false);

  useEffect(() => {
    loadRecentTraces(1).then((list) => setLastTrace(list[0] || null)).catch(() => setLastTrace(null));
  }, [logs.length]);

  const levelColors = {
    info: colors.info,
    warn: colors.warning,
    error: colors.danger,
    debug: colors.muted,
  };

  const filteredLogs = logs.filter((l: LogEntry) => (filter === "all" || l.level === filter) && (sourceFilter === "all" || (l.source || "app") === sourceFilter));

  /** Log state is newest-first; actionable setup banners require current-session structured evidence. */
  const failureBanner = useMemo(() => {
    const recent = logs.slice(0, 120);
    const setupIssues = getCurrentTermuxSetupIssues(logs);
    const isNoiseProbe = (msg: string) =>
      /test -e |startup-trace|runtime-journal|mkdir -p -- .*metadata/i.test(msg) &&
      /SecurityException|allow-external|RUN_COMMAND/i.test(msg);

    const hardErr = recent.find(
      (l) =>
        (l.level === "error" || l.level === "warn") &&
        /TERMUX_NO_OUTPUT|BUILD FAILED|exit=[1-9]|Permission denied|gradle|assemble|prebuild|pnpm|npm ERR/i.test(
          l.message,
        ) &&
        !isTermuxSetupFailure(l.message) &&
        !isNoiseProbe(l.message),
    );
    if (hardErr) {
      const em = /exit=(\d+)/.exec(hardErr.message);
      return {
        why: summarizeFailure(hardErr.message, em ? Number(em[1]) : 1),
        tag: hardErr.tag,
        message: hardErr.message.slice(0, 280),
        kind: "crash" as const,
      };
    }
    return setupIssues.length ? { kind: "setup" as const, issues: setupIssues } : null;
  }, [logs]);

  const handleClear = () => {
    showDialog(t("logClearTitle"), t("logClearConfirm", { count: logs.length }), [
      { text: t("cancel"), style: "cancel" },
      { text: t("delete"), style: "destructive", onPress: clearLogs },
    ]);
  };

  const handleSelfCheck = () => {
    const results = runSelfChecks();
    // В лог — коротко и по-технически; в диалог — простыми словами
    logInfo("SelfCheck", formatSelfCheckLogLine(results));
    const report = formatSelfCheckReport(results, (key, params) => t(key as Parameters<typeof t>[0], params));
    showDialog(t("selfCheckTitle"), report);
  };

  const handleExport = () => {
    if (exportBusyRef.current) return;
    if (logs.length === 0) {
      showDialog(t("logEmptyAlert"), t("logEmptyMessage"));
      return;
    }
    exportBusyRef.current = true;
    setExportBusy(true);
    void (async () => {
      try {
        const result = await exportLogsToFile(t("saveLogDialogTitle"));
        if (result.kind === "saved") {
          showDialog(t("logExportSuccess"), t("logExportSuccess"));
        } else if (result.kind === "cancelled" || result.kind === "empty") {
          // Closing the SAF/share picker is an ordinary user cancellation.
        } else if (result.kind === "failed") {
          const messageKey = result.reason === "permission-denied"
            ? "logExportPermissionDenied"
            : result.reason === "wrong-directory"
              ? "logExportWrongDirectory"
              : result.reason === "storage-unavailable"
                ? "logExportStorageUnavailable"
                : result.reason === "too-large"
                  ? "logExportTooLarge"
                  : "logExportWriteFailed";
          showDialog(t("modelError"), t(messageKey));
        }
      } catch {
        // Last-resort UI boundary: an export failure must never close the screen.
        try { showDialog(t("modelError"), t("logExportError")); } catch { /* UI already unavailable */ }
      } finally {
        exportBusyRef.current = false;
        setExportBusy(false);
      }
    })();
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0") +
      ":" +
      String(d.getSeconds()).padStart(2, "0") +
      "." +
      String(d.getMilliseconds()).padStart(3, "0")
    );
  };

  const sourceLabel = (s: typeof sourceFilter) => {
    const labels: Record<typeof SOURCE_OPTIONS[number], import("../lib/i18n").TranslationKey> = {
      all: "logSourceAll", app: "logSourceApp", termux: "logSourceTermux", linux: "logSourceLinux", native: "logSourceNative",
      console: "logSourceConsole", network: "logSourceNetwork", agent: "logSourceAgent",
    };
    if (s === "termux") return language === "en" ? "Embedded runtime" : language === "uk" ? "Вбудоване середовище" : "Встроенная среда";
    return t(labels[s]);
  };

  const filterLabel = (f: typeof filter) => {
    if (f === "all") return t("logAll");
    if (f === "info") return t("logInfo");
    if (f === "warn") return t("logWarn");
    if (f === "debug") return "Debug";
    return t("logError");
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.line }]}>
        <Text style={[styles.title, { color: colors.inkBright }]}>{t("logTitle")}</Text>
        <Text style={[styles.count, { color: colors.muted }]}>{filteredLogs.length}</Text>
      </View>
      {failureBanner ? (
        <View style={{
          marginHorizontal: 12, marginTop: 8, padding: 10, borderRadius: 10, borderWidth: 1,
          backgroundColor: failureBanner.kind === "setup" ? colors.warningDim : colors.dangerDim,
          borderColor: failureBanner.kind === "setup" ? colors.warning : colors.danger,
        }}>
          <Text style={{
            color: failureBanner.kind === "setup" ? colors.warning : colors.danger,
            fontWeight: "800", fontSize: 13,
          }}>
            {(
              failureBanner.kind === "setup"
                ? (language === "en" ? "Embedded runtime check needed" : language === "uk" ? "Потрібна перевірка вбудованого середовища" : "Нужна проверка встроенной среды")
                : (language === "en" ? "Why it failed" : language === "uk" ? "Чому впало" : "Почему упало")
            ) + ": " + (failureBanner.kind === "setup"
              ? (language === "en" ? "Embedded runtime is not ready. Open Runtime for current diagnostics." : language === "uk" ? "Вбудоване середовище не готове. Відкрийте Runtime для поточної діагностики." : "Встроенная среда не готова. Откройте Runtime для актуальной диагностики.")
              : failureBanner.why)}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }} numberOfLines={4}>
            {failureBanner.kind === "setup"
              ? failureBanner.issues.map((issue) => `${issue}: ${language === "en" ? "see embedded Runtime diagnostics" : language === "uk" ? "див. діагностику Runtime" : "см. диагностику Runtime"}`).join("\n")
              : `[${failureBanner.tag}] ${failureBanner.message}`}
          </Text>
        </View>
      ) : null}

      {lastTrace ? (
        <View style={{
          marginHorizontal: 12, marginTop: 8, padding: 10, borderRadius: 10, borderWidth: 1,
          backgroundColor: colors.surface, borderColor: colors.line,
        }}>
          <Text style={{ color: colors.muted, fontSize: 11, fontWeight: "800", letterSpacing: 0.4 }}>
            LAST AGENT TRACE
          </Text>
          <Text style={{
            color: lastTrace.status === "pass" ? "#8FD69A" : lastTrace.status === "fail" ? colors.danger : colors.warning,
            fontWeight: "700", fontSize: 13, marginTop: 3, textTransform: "uppercase",
          }}>
            {lastTrace.status}
          </Text>
          <Text style={{ color: colors.inkBright, fontSize: 12, marginTop: 3 }} numberOfLines={2}>
            {lastTrace.task}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 11, marginTop: 2 }} numberOfLines={2}>
            {formatTraceSummary(lastTrace)}
          </Text>
          {lastTrace.failureCluster ? (
            <Text style={{ color: colors.warning, fontSize: 11, marginTop: 2 }}>
              {lastTrace.failureCluster}{lastTrace.recipeId ? ` → ${lastTrace.recipeId}` : ""}
            </Text>
          ) : null}
        </View>
      ) : null}

      <FlatList
        horizontal
        data={SOURCE_OPTIONS}
        keyExtractor={(s) => `src-${s}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
        renderItem={({ item: s }) => {
          const active = sourceFilter === s;
          return <TouchableOpacity key={s} style={[styles.filterBtn, { backgroundColor: active ? colors.accentDim : colors.surface, borderColor: active ? colors.accent : colors.line }]} onPress={() => setSourceFilter(s)}><Text style={[styles.filterText, { color: active ? colors.accent : colors.muted }]}>{sourceLabel(s)}</Text></TouchableOpacity>;
        }}
      />

      <View style={[styles.filterRow, { borderBottomColor: colors.line }]}>
        {FILTER_OPTIONS.map((f) => {
          const active = filter === f;
          return (
            <TouchableOpacity
              key={f}
              style={[
                styles.filterBtn,
                {
                  backgroundColor: active ? colors.accentDim : colors.surface,
                  borderColor: active ? colors.accent : colors.line,
                },
              ]}
              onPress={() => setFilter(f)}
            >
              <Text
                style={[
                  styles.filterText,
                  { color: active ? colors.accent : colors.muted },
                ]}
              >
                {filterLabel(f)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View
        style={[
          styles.logBox,
          { backgroundColor: colors.surface, borderColor: colors.line },
        ]}
      >
        <FlatList
          data={filteredLogs}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.logList}
          inverted
          ItemSeparatorComponent={() => (
            <View style={[styles.logDivider, { backgroundColor: colors.line }]} />
          )}
          renderItem={({ item }) => (
            <View style={styles.logRow}>
              <View style={styles.logRowHeader}>
                <Text style={[styles.logLevel, { color: levelColors[item.level as keyof typeof levelColors] || colors.ink }]}>
                  {item.level.toUpperCase()}
                </Text>
                <Text style={[styles.logTime, { color: colors.footerMuted }]}>{formatTime(item.timestamp)}</Text>
                <Text style={[styles.logTag, { color: colors.muted }]}>[{item.tag}]</Text>
                <Text style={[styles.logMeta, { color: colors.footerMuted }]}>{item.source || "app"} · {(item.sessionId || "-").slice(-12)}</Text>
              </View>
              <Text
                style={[styles.logMessage, { color: colors.inkBright, fontFamily: undefined }]}
                selectable
              >
                {item.message}
              </Text>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={[styles.emptyText, { color: colors.footerMuted }]}>{t("logEmpty")}</Text>
            </View>
          }
        />
      </View>

      <View style={[styles.actions, { paddingBottom: 16 + insets.bottom, borderTopColor: colors.line }]}>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}
          onPress={handleSelfCheck}
        >
          <Text style={[styles.actionBtnText, { color: colors.inkBright }]}>{t("selfCheckBtn")}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}
          onPress={handleExport}
          disabled={exportBusy}
        >
          <Text style={[styles.actionBtnText, { color: colors.inkBright, opacity: exportBusy ? 0.55 : 1 }]}>
            {exportBusy ? t("logExportSaving") : t("logSaveTxt")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.dangerDim, borderColor: "rgba(248, 113, 113, 0.25)" }]}
          onPress={handleClear}
        >
          <Text style={[styles.actionBtnText, { color: colors.danger }]}>{t("logClear")}</Text>
        </TouchableOpacity>
      </View>
      {Platform.OS === "android" ? (
        <Text style={{ color: colors.footerMuted, fontSize: 10, textAlign: "center", paddingHorizontal: 12, paddingBottom: Math.max(4, insets.bottom / 3) }}>
          {t("logExportFolderHint")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontWeight: "700" },
  count: { fontSize: 12 },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  filterBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1,
  },
  filterText: { fontSize: 12, fontWeight: "600" },
  logBox: {
    flex: 1,
    margin: 12,
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  logList: { padding: 12, flexGrow: 1 },
  logDivider: { height: 1, marginVertical: 8 },
  logRow: { gap: 3 },
  logRowHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  logLevel: { fontSize: 10, fontWeight: "700" },
  logTime: { fontSize: 10 },
  logTag: { fontSize: 11, fontWeight: "600" },
  logMeta: { fontSize: 9 },
  logMessage: { fontSize: 12 },
  empty: { alignItems: "center", marginTop: 60 },
  emptyText: { fontSize: 14 },
  actions: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
  },
  actionBtnText: { fontSize: 14, fontWeight: "600" },
});
