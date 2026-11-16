/**
 * Compact floating status — model pin / FG tasks / agent activity.
 * Disabled by default; enable in Settings → «Плавающий статус».
 */
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTheme } from "./ThemeContext";
import { modelKeepAlive } from "../lib/keep-alive";
import { listForegroundTasks, subscribeForegroundTasks, type ForegroundTask } from "../lib/foreground-task";
import { getContextMetrics, formatMetricsLine } from "../lib/context-engine";

const STORAGE_KEY = "aibuilder.ui.statusOverlayEnabled.v1";

/** Default: OFF (does not clutter chat). Settings can enable. */
export async function loadStatusOverlayEnabled(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(STORAGE_KEY);
    if (v === null) return false;
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

export async function saveStatusOverlayEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function Dot({ on, colors }: { on: boolean; colors: { accent: string; danger?: string; muted: string } }) {
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: on ? colors.accent : colors.danger,
        marginRight: 6,
      }}
    />
  );
}

export function RuntimeStatusOverlay({ onOpenRuntime }: { onOpenRuntime?: () => void }) {
  const { colors } = useTheme();
  const [tasks, setTasks] = useState<ForegroundTask[]>([]);
  const [pinned, setPinned] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [ctxLine, setCtxLine] = useState("");
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    void loadStatusOverlayEnabled().then(setEnabled);
    setTasks(listForegroundTasks());
    const unsub = subscribeForegroundTasks((t) => setTasks([...t]));
    const id = setInterval(() => {
      try {
        setPinned(!!(modelKeepAlive.isPinned?.() || modelKeepAlive.isActive()));
      } catch {
        setPinned(false);
      }
      try {
        setCtxLine(formatMetricsLine(getContextMetrics()));
      } catch {
        setCtxLine("");
      }
      void loadStatusOverlayEnabled().then(setEnabled);
    }, 2000);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);

  if (!enabled) return null;

  const topTask = tasks[0];
  const taskLabel = topTask
    ? `${topTask.title || topTask.kind || "task"}${
        typeof topTask.progress === "number" ? ` ${Math.round(topTask.progress * 100)}%` : ""
      }`
    : null;

  if (collapsed) {
    return (
      <TouchableOpacity
        style={[
          styles.fab,
          {
            backgroundColor: pinned ? colors.accent : colors.surface,
            borderWidth: 1,
            borderColor: pinned ? colors.accent : colors.line,
          },
        ]}
        onPress={() => setCollapsed(false)}
        accessibilityLabel="Show status"
      >
        <Ionicons
          name={pinned ? "hardware-chip" : "pulse-outline"}
          size={18}
          color={pinned ? (colors.onAccent || "#00325A") : colors.muted}
        />
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      <View style={styles.row}>
        <Ionicons name="pulse-outline" size={16} color={colors.accent} />
        <Text style={[styles.title, { color: colors.inkBright }]} numberOfLines={1}>
          Статус
        </Text>
        <TouchableOpacity onPress={() => setCollapsed(true)} hitSlop={8} accessibilityLabel="Collapse status">
          <Ionicons name="chevron-down" size={16} color={colors.muted} />
        </TouchableOpacity>
      </View>

      <View style={styles.lineRow}>
        <Dot on={pinned} colors={colors} />
        <Text style={[styles.cell, { color: colors.inkBright }]} numberOfLines={1}>
          {pinned ? "Модель в памяти (RAM)" : "Модель не в памяти"}
        </Text>
      </View>

      <View style={styles.lineRow}>
        <Dot on={!!taskLabel} colors={colors} />
        <Text style={[styles.cell, { color: colors.inkBright }]} numberOfLines={2}>
          {taskLabel ? `Задача: ${taskLabel}` : "Фоновых задач нет"}
        </Text>
      </View>

      {ctxLine ? (
        <Text style={[styles.ctx, { color: colors.muted }]} numberOfLines={2}>
          Контекст: {ctxLine}
        </Text>
      ) : null}

      {onOpenRuntime ? (
        <TouchableOpacity onPress={onOpenRuntime}>
          <Text style={{ color: colors.accent, fontSize: 11, marginTop: 6 }}>Среда →</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    right: 12,
    bottom: 220,
    zIndex: 50,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minWidth: 200,
    maxWidth: 280,
    elevation: 6,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 220,
    zIndex: 50,
    width: 44,
    height: 44,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  title: { flex: 1, fontSize: 13, fontWeight: "700" },
  lineRow: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  cell: { fontSize: 12, flex: 1 },
  ctx: { fontSize: 10, marginTop: 2, lineHeight: 14 },
});
