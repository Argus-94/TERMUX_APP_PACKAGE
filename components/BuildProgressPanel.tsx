import { useState, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, LayoutAnimation, Platform, UIManager, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "./ThemeContext";
import { expandedIconColors, expandedIconChipStyle, expandedIconChipInnerStyle, indicatorCardStyle, indicatorHeaderStyle } from "../lib/ui-expanded-highlight";
import { useLanguage } from "./LanguageContext";
import { useTermuxContext, type BuildStage } from "./TermuxContext";
import { buildIndicatorModel } from "../lib/build-indicator-presentation";
import { redactTaskActivityText, taskKindTitle } from "../lib/task-activity";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type Props = {
  compact?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  maxBodyHeight?: number;
  equalShare?: boolean;
};

export function BuildProgressPanel({ compact = false, expanded: controlledExpanded, onExpandedChange, maxBodyHeight, equalShare = false }: Props = {}) {
  const { colors } = useTheme();
  const { t, language } = useLanguage();
  const { activity } = useTermuxContext();
  // Пока идёт сборка — по умолчанию свёрнут (шапка + прогресс-бар), список стадий по тапу.
  // Так индикаторы равномерно «закрывают» зону над чатом, не раздувая её.
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = typeof controlledExpanded === "boolean";
  const expanded = controlledExpanded ?? internalExpanded;
  const setExpanded = (next: boolean) => {
    if (!isControlled) setInternalExpanded(next);
    onExpandedChange?.(next);
  };
  const stages = activity?.stages || [];
  useEffect(() => {
    if (compact) setExpanded(false);
  }, [compact]);
  // Новый цикл activity (смена title) — снова свернуть
  useEffect(() => {
    setExpanded(false);
  }, [activity?.title, activity?.taskKind, activity?.recovery]);
  const hasStages = stages.length > 0;
  const hasTask = !!activity && (!!activity.taskKind || !!activity.title || !!activity.stage || !!activity.detail || !!activity.command);
  if (!hasStages && !hasTask) return null;

  const safeStages = stages.map((stage) => ({ ...stage, detail: stage.detail ? redactTaskActivityText(stage.detail) : undefined }));
  const safeDetail = redactTaskActivityText(activity?.errorMessage || activity?.detail || activity?.stage || activity?.command || "");
  const model = buildIndicatorModel({
    stages: safeStages,
    command: activity?.command,
    detail: activity?.detail,
    buildStatus: activity?.buildStatus,
    taskStatus: activity?.taskStatus,
    progressPercent: activity?.progressPercent,
    step: activity?.step,
    maxSteps: activity?.maxSteps,
  });
  const title = activity?.taskKind
    ? taskKindTitle(activity.taskKind, language)
    : activity?.title || (language === "en" ? "Task" : language === "uk" ? "Завдання" : "Задача");
  const statusLabel = model.status === "verified"
    ? t("buildStatusVerified")
    : model.status === "recovering"
    ? (language === "en" ? "Recovering" : language === "uk" ? "Відновлення" : "Восстановление")
    : model.status === "attention"
      ? (language === "en" ? (activity?.taskStatus === "failed" ? "Failed" : "Needs attention") : language === "uk" ? (activity?.taskStatus === "failed" ? "Помилка" : "Потрібна увага") : (activity?.taskStatus === "failed" ? "Ошибка" : "Требуется внимание"))
      : model.status === "completed"
        ? (language === "en" ? "Completed" : language === "uk" ? "Завершено" : "Завершено")
        : model.status === "cancelled"
          ? (language === "en" ? "Cancelled" : language === "uk" ? "Скасовано" : "Остановлено")
          : (language === "en" ? "In progress" : language === "uk" ? "Виконується" : "Выполняется");
  const statusColor = model.status === "attention" ? colors.danger : model.status === "recovering" ? colors.warning : colors.accent;
  const attemptLabel = activity?.recovery
    ? (language === "en" ? `Attempt ${activity.recovery}/${activity.maxRecovery || "?"}` : language === "uk" ? `Спроба ${activity.recovery}/${activity.maxRecovery || "?"}` : `Попытка ${activity.recovery}/${activity.maxRecovery || "?"}`)
    : "";
  const operationLabel = model.current
    ? `${language === "en" ? "Step" : language === "uk" ? "Крок" : "Этап"} ${model.currentIndex}/${model.total} · ${model.current.label}`
    : model.total > 0
      ? (language === "en" ? `${model.completed}/${model.total} observed stages completed` : language === "uk" ? `Підтверджено етапів: ${model.completed}/${model.total}` : `Подтверждено этапов: ${model.completed}/${model.total}`)
      : activity?.step
        ? `${language === "en" ? "Operation" : language === "uk" ? "Операція" : "Операция"} ${activity.step}`
        : (language === "en" ? "Task started" : language === "uk" ? "Завдання запущено" : "Задача запущена");
  const pct = Math.max(0, Math.min(100, Number(model.percent) || 0));
  const statusAndPercent = `${statusLabel} · ${pct}%`;

  const card = indicatorCardStyle(colors);
  const head = indicatorHeaderStyle(expanded, colors);
  const icons = expandedIconColors(expanded, colors);

  return (
    <View style={[styles.card, card as object]}>
      <TouchableOpacity activeOpacity={0.8} accessibilityState={{ expanded }} onPress={() => {
          try {
            if (LayoutAnimation && typeof LayoutAnimation.configureNext === "function") {
              const preset = LayoutAnimation.Presets && LayoutAnimation.Presets.easeInEaseOut;
              if (preset) LayoutAnimation.configureNext(preset);
            }
          } catch { /* ignore animation failures */ }
          setExpanded(!expanded);
        }} style={[styles.header, head as object]}>
        <View style={styles.headerLeft}>
          <View style={expandedIconChipStyle(expanded, colors, 34) as object}>
            <View style={expandedIconChipInnerStyle(colors, 34) as object}>
              <Ionicons name="list-outline" size={17} color={icons.fg} />
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: colors.inkBright }]} numberOfLines={1}>{title}</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>
              {operationLabel}
            </Text>
            <Text style={[styles.statusLine, { color: statusColor }]} numberOfLines={1}>{statusAndPercent}</Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          {!!attemptLabel && <Text style={[styles.counter, { color: colors.accent }]} numberOfLines={1}>{attemptLabel}</Text>}
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={17} color={icons.chevron} />
        </View>
      </TouchableOpacity>

      {expanded && (
        <ScrollView
          style={[styles.bodyScroll, maxBodyHeight !== undefined ? { maxHeight: maxBodyHeight, ...(equalShare ? { height: maxBodyHeight } : {}) } : undefined]}
          contentContainerStyle={styles.body}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {safeStages.map((stage, index) => (
            <StageRow key={stage.id} stage={stage} isLast={index === stages.length - 1} colors={colors} />
          ))}
          {!!safeDetail && (!hasStages || activity?.taskStatus === "failed" || activity?.taskStatus === "running" || !activity?.taskStatus) && (
            <View style={[styles.smartBox, { backgroundColor: colors.background, borderColor: colors.line }]}>
              <Text style={[styles.smartTitle, { color: colors.inkBright }]}>
                {activity?.taskStatus === "failed"
                  ? (language === "en" ? "Error" : language === "uk" ? "Помилка" : "Ошибка")
                  : (language === "en" ? "Current operation" : language === "uk" ? "Поточна операція" : "Текущая операция")}
              </Text>
              <Text style={[styles.smartText, { color: activity?.taskStatus === "failed" ? colors.danger : colors.inkBright }]}>{safeDetail}</Text>
              {activity?.taskStatus !== "failed" ? (
                <View style={styles.opProgressBlock}>
                  <View style={[styles.opTrack, { backgroundColor: colors.line }]}>
                    <View
                      style={[
                        styles.opFill,
                        {
                          width: `${pct}%`,
                          backgroundColor: colors.accent,
                        },
                      ]}
                    />
                  </View>
                  <Text style={[styles.opPercent, { color: colors.accent }]}>
                    {`${pct}%`}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
          {(activity?.diagnosis || activity?.action || activity?.result) && (
            <View style={[styles.smartBox, { backgroundColor: colors.background, borderColor: colors.line }]}>
              <View style={styles.smartHeader}>
                <View style={[styles.smartIcon, { backgroundColor: colors.accentDim }]}>
                  {activity?.result?.includes("завершено") || activity?.result?.includes("применено") ? (
                    <Ionicons name="checkmark-circle" size={15} color={colors.accent} />
                  ) : (
                    <ActivityIndicator size="small" color={colors.accent} />
                  )}
                </View>
                <Text style={[styles.smartTitle, { color: colors.inkBright }]}>{t("autoDiagnosis")}</Text>
              </View>
              {!!activity?.diagnosis && (
                <View style={styles.smartRow}>
                  <Text style={[styles.smartCaption, { color: colors.muted }]}>{t("detected")}</Text>
                  <Text style={[styles.smartText, { color: colors.inkBright }]} numberOfLines={3}>
                    {activity.diagnosis}
                  </Text>
                </View>
              )}
              {!!activity?.action && (
                <View style={styles.smartRow}>
                  <Text style={[styles.smartCaption, { color: colors.muted }]}>{t("action")}</Text>
                  <Text style={[styles.smartText, { color: colors.accent }]} numberOfLines={3}>
                    {activity.action}
                  </Text>
                </View>
              )}
              {!!activity?.result && (
                <View style={styles.smartRow}>
                  <Text style={[styles.smartCaption, { color: colors.muted }]}>{t("status")}</Text>
                  <Text style={[styles.smartText, { color: colors.inkBright }]} numberOfLines={2}>
                    {activity.result}
                  </Text>
                </View>
              )}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function StageRow({
  stage,
  isLast,
  colors,
}: {
  stage: BuildStage;
  isLast: boolean;
  colors: { line: string; accent: string; background: string; muted: string; inkBright: string; onAccent?: string };
}) {
  const skipped = stage.status === "skipped";
  const done = stage.status === "done";
  const active = stage.status === "active";
  const error = stage.status === "error";

  let borderColor = colors.line;
  let bg = colors.background;
  if (done) {
    borderColor = colors.accent;
    bg = colors.accent;
  } else if (error) {
    borderColor = "#FFB4AB";
    bg = "#FFB4AB";
  } else if (active) {
    borderColor = colors.accent;
    bg = "transparent";
  } else if (skipped) {
    borderColor = colors.line;
    bg = "transparent";
  }

  const labelColor = skipped ? colors.muted : error ? "#FFB4AB" : active ? colors.inkBright : done ? colors.inkBright : colors.muted;

  return (
    <View style={[styles.row, skipped && { opacity: 0.55 }]}>
      <View style={styles.markerCol}>
        <View style={[styles.marker, { borderColor, backgroundColor: bg }]}>
          {done ? (
            <Ionicons name="checkmark" size={11} color={colors.onAccent || "#00325A"} />
          ) : error ? (
            <Ionicons name="close" size={11} color="#fff" />
          ) : active ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : skipped ? (
            <View style={[styles.skipDash, { backgroundColor: colors.muted }]} />
          ) : null}
        </View>
        {!isLast && (
          <View
            style={[
              styles.line,
              {
                backgroundColor: done ? colors.accent : colors.line,
              },
            ]}
          />
        )}
      </View>
      <View style={styles.stageText}>
        <Text
          style={[
            styles.stageLabel,
            {
              color: labelColor,
              textDecorationLine: skipped ? "line-through" : "none",
              fontWeight: active ? "700" : "500",
            },
          ]}
        >
          {stage.label}
        </Text>
        {active && !!stage.detail && (
          <Text style={[styles.detail, { color: colors.accent }]} numberOfLines={2}>
            {stage.detail}
          </Text>
        )}
        {error && !!stage.detail && (
          <Text style={[styles.detail, { color: "#FFB4AB" }]} numberOfLines={2}>
            {stage.detail}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, marginBottom: 7, borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  header: { padding: 11, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerLeft: { flexDirection: "row", alignItems: "center", flex: 1, gap: 9 },
  iconWrap: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 14, fontWeight: "700" },
  subtitle: { fontSize: 11, marginTop: 2 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 7, marginLeft: 8 },
  counter: { fontSize: 10, fontWeight: "700" },
  statusLine: { fontSize: 10, fontWeight: "700", marginTop: 2 },
  opProgressBlock: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  opTrack: { height: 8, flex: 1, borderRadius: 4, overflow: "hidden" },
  opFill: { height: "100%", borderRadius: 4 },
  opPercent: { fontSize: 12, fontWeight: "800", minWidth: 36, textAlign: "right" },
  bodyScroll: { flexGrow: 0, maxHeight: 320 },
  body: { paddingHorizontal: 12, paddingBottom: 10, paddingTop: 8 },
  row: { flexDirection: "row", minHeight: 28 },
  markerCol: { width: 22, alignItems: "center" },
  marker: {
    width: 17,
    height: 17,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  skipDash: { width: 8, height: 2, borderRadius: 1 },
  line: { width: 2, flex: 1, marginTop: -1 },
  stageText: { flex: 1, paddingLeft: 7, paddingBottom: 6 },
  stageLabel: { fontSize: 12, lineHeight: 17 },
  detail: { fontSize: 10, lineHeight: 14, marginTop: 1 },
  smartBox: { marginTop: 5, borderWidth: 1, borderRadius: 11, padding: 9 },
  smartHeader: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  smartIcon: { width: 25, height: 25, borderRadius: 8, alignItems: "center", justifyContent: "center", marginRight: 7 },
  smartTitle: { fontSize: 11, fontWeight: "700" },
  smartRow: { marginTop: 4 },
  smartCaption: { fontSize: 9, marginBottom: 1 },
  smartText: { fontSize: 10, lineHeight: 14 },
});
