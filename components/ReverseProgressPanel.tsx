import { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";
import { expandedTitleColor, indicatorHeaderStyle } from "../lib/ui-expanded-highlight";
import { useTermuxContext, type ReverseToolStatus } from "./TermuxContext";

export function ReverseProgressPanel() {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const { activity } = useTermuxContext();
  const [expanded, setExpanded] = useState(false);
  const stages = activity?.stages || [];
  const tools = activity?.reverseTools || [];
  const isReverse = !!activity?.isReverse && stages.length > 0;
  const completed = useMemo(() => stages.filter((s) => s.status === "done").length, [stages]);
  const current = stages.find((s) => s.status === "active") || stages.find((s) => s.status === "error");
  if (!isReverse) return null;
  const progress = stages.length ? Math.round((completed / stages.length) * 100) : 0;
  const installed = tools.filter((t) => t.status === "installed").length;
  const missing = tools.filter((t) => t.status !== "installed").length;

  const head = indicatorHeaderStyle(expanded, colors);

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}> 
      <TouchableOpacity activeOpacity={0.8} onPress={() => setExpanded((v) => !v)} style={[styles.header, head as object]}>
        <View style={styles.headerLeft}>
          <View style={[styles.iconWrap, { backgroundColor: colors.accentDim }]}>
            <Ionicons name="search-outline" size={18} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: expandedTitleColor(expanded, colors.inkBright) }]}>{activity?.title || t("reverseEngineering")}</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>
              {current?.label || activity?.stage || t("prepareAnalysis")}
              {activity?.recovery ? ` · этап ${activity.recovery}/${activity.maxRecovery || "?"}` : ""}
            </Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          <Text style={[styles.counter, { color: colors.accent }]}>{completed} / {stages.length}</Text>
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={17} color={colors.muted} />
        </View>
      </TouchableOpacity>
      <View style={[styles.track, { backgroundColor: colors.line }]}>
        <View style={[styles.fill, { width: `${Math.max(progress, current ? 4 : 0)}%`, backgroundColor: colors.accent }]} />
      </View>
      {expanded && (
        <View style={styles.body}>
          {tools.length > 0 && (
            <View style={[styles.inventory, { backgroundColor: colors.background, borderColor: colors.line }]}>
              <View style={styles.inventoryHeader}>
                <Ionicons name="construct-outline" size={14} color={colors.accent} />
                <Text style={[styles.inventoryTitle, { color: colors.inkBright }]}>{t("environmentTools")}</Text>
                <Text style={[styles.inventoryCount, { color: colors.muted }]}>{installed} установлено · {missing} можно добавить</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {tools.map((tool) => <ToolChip key={tool.id} tool={tool} />)}
              </ScrollView>
            </View>
          )}
          {stages.map((stage, index) => (
            <View key={stage.id} style={styles.row}>
              <View style={styles.markerCol}>
                <View style={[styles.marker, {
                  borderColor: stage.status === "pending" ? colors.line : stage.status === "error" ? "#FFB4AB" : colors.accent,
                  backgroundColor: stage.status === "done" ? colors.accent : stage.status === "error" ? "#FFB4AB" : colors.background,
                }]}>
                  {stage.status === "done" ? <Ionicons name="checkmark" size={11} color={colors.onAccent || "#00325A"} /> : stage.status === "error" ? <Ionicons name="close" size={11} color="#fff" /> : null}
                </View>
                {index < stages.length - 1 && <View style={[styles.line, { backgroundColor: stage.status === "done" ? colors.accent : colors.line }]} />}
              </View>
              <View style={styles.stageText}>
                <Text style={[styles.stageLabel, { color: stage.status === "pending" ? colors.muted : colors.inkBright }]}>{stage.label}</Text>
                {(stage.status === "active" || stage.status === "error") && <Text style={[styles.detail, { color: stage.status === "error" ? "#FFB4AB" : colors.accent }]} numberOfLines={2}>{stage.detail || activity?.detail || t("running")}</Text>}
              </View>
            </View>
          ))}
          {(activity?.diagnosis || activity?.action || activity?.result) && (
            <View style={[styles.smartBox, { backgroundColor: colors.background, borderColor: colors.line }]}>
              <View style={styles.smartHeader}>
                <View style={[styles.smartIcon, { backgroundColor: colors.accentDim }]}>
                  {activity?.result?.includes("готов") || activity?.result?.includes("заверш") || activity?.result?.includes("примен")
                    ? <Ionicons name="checkmark-circle" size={15} color={colors.accent} />
                    : <ActivityIndicator size="small" color={colors.accent} />}
                </View>
                <Text style={[styles.smartTitle, { color: colors.inkBright }]}>{t("analysisProgress")}</Text>
              </View>
              {!!activity?.diagnosis && <InfoRow caption={t("detected")} value={activity.diagnosis} color={colors.inkBright} />}
              {!!activity?.action && <InfoRow caption={t("action")} value={activity.action} color={colors.accent} />}
              {!!activity?.result && <InfoRow caption={t("status")} value={activity.result} color={colors.inkBright} />}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function ToolChip({ tool }: { tool: ReverseToolStatus }) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const ok = tool.status === "installed";
  const optional = tool.status === "optional";
  return <View style={[styles.chip, { borderColor: ok ? colors.accent : colors.line, backgroundColor: ok ? colors.accentDim : colors.surface }]}>
    <Ionicons name={ok ? "checkmark-circle" : optional ? "ellipsis-horizontal-circle-outline" : "add-circle-outline"} size={12} color={ok ? colors.accent : colors.muted} />
    <Text style={[styles.chipText, { color: ok ? colors.inkBright : colors.muted }]}>{tool.label}</Text>
  </View>;
}

function InfoRow({ caption, value, color }: { caption: string; value: string; color: string }) {
  return <View style={styles.smartRow}><Text style={[styles.smartCaption, { color: "#9AA3AC" }]}>{caption}</Text><Text style={[styles.smartText, { color }]} numberOfLines={3}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginBottom: 7, borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  header: { padding: 11, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerLeft: { flexDirection: "row", alignItems: "center", flex: 1, gap: 9 },
  iconWrap: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 14, fontWeight: "700" }, subtitle: { fontSize: 11, marginTop: 2 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 7, marginLeft: 8 }, counter: { fontSize: 11, fontWeight: "700" },
  track: { height: 5, marginHorizontal: 11, borderRadius: 3, overflow: "hidden" }, fill: { height: "100%", borderRadius: 3 },
  body: { paddingHorizontal: 12, paddingBottom: 10, paddingTop: 8 },
  inventory: { borderWidth: 1, borderRadius: 11, padding: 9, marginBottom: 9 },
  inventoryHeader: { flexDirection: "row", alignItems: "center", gap: 6 }, inventoryTitle: { fontSize: 11, fontWeight: "700", flex: 1 }, inventoryCount: { fontSize: 9 },
  chips: { gap: 6, paddingTop: 7 }, chip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 5, flexDirection: "row", alignItems: "center", gap: 4 }, chipText: { fontSize: 9 },
  row: { flexDirection: "row", minHeight: 29 }, markerCol: { width: 22, alignItems: "center" }, marker: { width: 17, height: 17, borderRadius: 9, borderWidth: 2, alignItems: "center", justifyContent: "center", zIndex: 2 }, line: { width: 2, flex: 1, marginTop: -1 },
  stageText: { flex: 1, paddingLeft: 7, paddingBottom: 7 }, stageLabel: { fontSize: 12, lineHeight: 17 }, detail: { fontSize: 10, lineHeight: 14, marginTop: 1 },
  smartBox: { marginTop: 5, borderWidth: 1, borderRadius: 11, padding: 9 }, smartHeader: { flexDirection: "row", alignItems: "center", marginBottom: 6 }, smartIcon: { width: 25, height: 25, borderRadius: 8, alignItems: "center", justifyContent: "center", marginRight: 7 }, smartTitle: { fontSize: 11, fontWeight: "700" }, smartRow: { marginTop: 4 }, smartCaption: { fontSize: 9, marginBottom: 1 }, smartText: { fontSize: 10, lineHeight: 14 },
});
