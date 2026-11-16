/**
 * Панель «Думаю…» в стиле Grok-чата:
 *  - таймер «Думаю Ns»
 *  - заголовок текущего действия (лампочка)
 *  - список шагов (bullet)
 *  - выполненные команды (галочка)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, LayoutAnimation, Platform, UIManager, ScrollView, Dimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "./ThemeContext";
import { expandedIconColors, expandedBodyStyle, indicatorCardStyle, indicatorHeaderStyle } from "../lib/ui-expanded-highlight";
import { useLanguage } from "./LanguageContext";
import { useTermuxContext } from "./TermuxContext";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export type ThinkingLogItem = {
  id: string;
  kind: "plan" | "step" | "command" | "done" | "info";
  text: string;
  done?: boolean;
  at: number;
};

type Props = {
  /** Идёт генерация / агент */
  active: boolean;
  /** Доп. лог шагов из LLM (опционально) */
  log?: ThinkingLogItem[];
  /** Компактный режим (терминал открыт): свёрнут по умолчанию, меньше maxHeight */
  compact?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  maxBodyHeight?: number;
  equalShare?: boolean;
};

export function AgentThinkingPanel({ active, log = [], compact = false, expanded: controlledExpanded, onExpandedChange, maxBodyHeight, equalShare = false }: Props) {
  const { colors } = useTheme();
  const { language } = useLanguage();
  const { activity } = useTermuxContext();
  const [internalExpanded, setInternalExpanded] = useState(!compact);
  const isControlled = typeof controlledExpanded === "boolean";
  const expanded = controlledExpanded ?? internalExpanded;
  const setExpanded = (next: boolean) => {
    if (!isControlled) setInternalExpanded(next);
    onExpandedChange?.(next);
  };
  useEffect(() => {
    if (compact || !active) setExpanded(false);
  }, [compact]);
  const [seconds, setSeconds] = useState(0);
  const startedAt = useRef<number | null>(null);
  const [history, setHistory] = useState<ThinkingLogItem[]>([]);
  const lastCmd = useRef<string>("");
  const scrollRef = useRef<ScrollView>(null);

  // Таймер «Думаю Ns»
  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setSeconds(0);
      return;
    }
    if (!startedAt.current) startedAt.current = Date.now();
    const t = setInterval(() => {
      if (startedAt.current) setSeconds(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [active]);

  // Накапливаем историю из termux activity + внешний log
  useEffect(() => {
    if (!active) return;
    if (activity?.command && activity.command !== lastCmd.current) {
      lastCmd.current = activity.command;
      const cmdShort =
        activity.command.length > 120 ? activity.command.slice(0, 117) + "…" : activity.command;
      setHistory((prev) => {
        // пометить предыдущие command как done
        const marked = prev.map((h) =>
          h.kind === "command" && !h.done ? { ...h, done: true } : h
        );
        return [
          ...marked,
          {
            id: `cmd-${Date.now()}`,
            kind: "command" as const,
            text: cmdShort,
            done: false,
            at: Date.now(),
          },
        ].slice(-40);
      });
    }
    if (activity?.title || activity?.detail || activity?.stage) {
      const title = activity.title || activity.stage || activity.detail || "";
      if (title) {
        setHistory((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "plan" && last.text === title) return prev;
          return [
            ...prev,
            {
              id: `plan-${Date.now()}`,
              kind: "plan" as const,
              text: title,
              at: Date.now(),
            },
          ].slice(-40);
        });
      }
    }
    if (activity?.step && activity?.maxSteps) {
      const stepText =
        language === "en"
          ? `Step ${activity.step}/${activity.maxSteps}`
          : language === "uk"
            ? `Крок ${activity.step}/${activity.maxSteps}`
            : `Шаг ${activity.step}/${activity.maxSteps}`;
      setHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === "step" && last.text.startsWith(stepText.split("/")[0])) {
          return prev.map((h, i) => (i === prev.length - 1 ? { ...h, text: stepText } : h));
        }
        return [...prev, { id: `step-${Date.now()}`, kind: "step" as const, text: stepText, at: Date.now() }].slice(-40);
      });
    }
  }, [activity?.command, activity?.title, activity?.detail, activity?.stage, activity?.step, activity?.maxSteps, active, language]);

  // Сброс истории при новом запуске.
  // Пока индикатор работает — по умолчанию СВЁРНУТ (только шапка «Думаю…»),
  // чтобы не съедать поле чата; пользователь может развернуть по тапу.
  useEffect(() => {
    if (active) {
      setHistory([]);
      lastCmd.current = "";
      setExpanded(false);
    }
  }, [active]);

  // Подмешиваем внешний log
  const items = useMemo(() => {
    const merged = [...history].filter((m) => m && m.id);
    for (const l of log || []) {
      if (!l || !l.id) continue;
      if (!merged.find((m) => m.id === l.id)) merged.push(l);
    }
    return merged.sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-30);
  }, [history, log]);

  // Автопрокрутка к последнему шагу/команде
  useEffect(() => {
    if (!expanded || !active) return;
    const id = requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    });
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 80);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(t);
    };
  }, [items.length, activity?.command, activity?.step, activity?.title, expanded, active]);

  if (!active) return null;

  const formatThinkingTime = (sec: number): string => {
    if (sec < 60) {
      return language === "en" ? `${sec}s` : language === "uk" ? `${sec}с` : `${sec}s`;
    }
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    if (language === "en") return r > 0 ? `${m}m ${r}s` : `${m}m`;
    if (language === "uk") return r > 0 ? `${m}хв ${r}с` : `${m}хв`;
    return r > 0 ? `${m}м ${r}с` : `${m}м`;
  };
  const taskInProgress = !!activity && (activity.taskStatus === "running" || activity.buildStatus === "running" || !!activity.taskKind);
  const thinkingLabel = taskInProgress
    ? (language === "en" ? `Working · ${formatThinkingTime(seconds)}` : language === "uk" ? `Виконується · ${formatThinkingTime(seconds)}` : `Выполняется · ${formatThinkingTime(seconds)}`)
    : language === "en"
      ? `Thinking ${formatThinkingTime(seconds)}`
      : language === "uk"
        ? `Думаю ${formatThinkingTime(seconds)}`
        : `Думаю ${formatThinkingTime(seconds)}`;

  const headline =
    activity?.title ||
    activity?.stage ||
    (activity?.command
      ? language === "en"
        ? "Running Termux command"
        : language === "uk"
          ? "Виконую команду Termux"
          : "Выполняю команду Termux"
      : language === "en"
        ? "Working on your request"
        : language === "uk"
          ? "Працюю над запитом"
          : "Работаю над запросом");

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(!expanded);
  };

  const card = indicatorCardStyle(colors);
  const head = indicatorHeaderStyle(expanded, colors);
  const icons = expandedIconColors(expanded, colors);
  const bodyExtra = expandedBodyStyle(expanded);

  return (
    <View style={[styles.wrap, card as object]}>
      <TouchableOpacity style={[styles.header, head as object]} onPress={toggle} activeOpacity={0.7} accessibilityState={{ expanded }}>
        <Ionicons name="ellipse" size={8} color={icons.fg} style={{ marginRight: 6 }} />
        <Text style={[styles.thinking, { color: colors.inkBright }]}>{thinkingLabel}</Text>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={16}
          color={icons.chevron}
          style={{ marginLeft: "auto" }}
        />
      </TouchableOpacity>

      {expanded && (
        <ScrollView
          ref={scrollRef}
          style={[styles.bodyScroll, bodyExtra as object, maxBodyHeight !== undefined
            ? { maxHeight: maxBodyHeight, ...(equalShare ? { height: maxBodyHeight } : {}) }
            : { maxHeight: compact ? Math.min(240, Math.round(Dimensions.get("window").height * 0.3)) : Math.min(320, Math.round(Dimensions.get("window").height * 0.42)) }]}
          contentContainerStyle={styles.body}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
          onContentSizeChange={() => {
            if (expanded) scrollRef.current?.scrollToEnd({ animated: false });
          }}
        >
          <View style={styles.planRow}>
            <Ionicons name="bulb-outline" size={16} color={colors.accent} />
            <Text style={[styles.planTitle, { color: colors.inkBright }]} numberOfLines={2}>
              {headline}
            </Text>
          </View>
          {!!activity?.detail && <Text style={[styles.activityDetail, { color: colors.muted }]}>{activity.detail}</Text>}
          {!!activity && (activity.taskStatus === "running" || activity.buildStatus === "running") && (
            <View style={styles.progressArea}>
              <View style={[styles.progressTrack, { backgroundColor: colors.line }]}>
                <View style={[styles.progressFill, { backgroundColor: colors.accent, width: `${Math.max(3, Math.min(100, Number(activity.progressPercent) || 3))}%` }]} />
              </View>
              <Text style={[styles.progressHint, { color: colors.muted }]}>
                {Number(activity.progressPercent) > 0 ? `${Math.max(0, Math.min(100, Number(activity.progressPercent)))}% · ` : ""}
                {language === "en" ? "Progress reflects reported steps; no time estimate is available." : language === "uk" ? "Прогрес показує підтверджені етапи; оцінки часу немає." : "Прогресс отражает подтверждённые этапы; оценки времени нет."}
              </Text>
            </View>
          )}
          {!!activity?.stages?.length && (
            <View style={[styles.taskSteps, { borderColor: colors.line, backgroundColor: colors.background }]}>
              <View style={styles.taskStepsHeader}>
                <Text style={[styles.taskStepsTitle, { color: colors.inkBright }]}>{language === "en" ? "Task steps" : language === "uk" ? "Етапи завдання" : "Этапы задачи"}</Text>
                <Text style={[styles.taskStepsCount, { color: colors.accent }]}>{activity.stages.filter((stage) => stage.status === "done").length}/{activity.stages.length}</Text>
              </View>
              {activity.stages.map((stage) => (
                <View key={stage.id} style={styles.taskStepRow}>
                  <Ionicons name={stage.status === "done" ? "checkmark-circle" : stage.status === "error" ? "close-circle" : stage.status === "active" ? "play-circle" : "ellipse-outline"} size={16} color={stage.status === "done" ? colors.success : stage.status === "error" ? colors.danger : stage.status === "active" ? colors.accent : colors.muted} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.taskStepLabel, { color: stage.status === "pending" ? colors.muted : colors.inkBright }]}>{stage.label}</Text>
                    {!!stage.detail && (stage.status === "active" || stage.status === "error") ? <Text style={[styles.taskStepDetail, { color: stage.status === "error" ? colors.danger : colors.muted }]}>{stage.detail}</Text> : null}
                  </View>
                  <Text style={[styles.taskStepStatus, { color: stage.status === "done" ? colors.success : stage.status === "error" ? colors.danger : stage.status === "active" ? colors.accent : colors.muted }]}>{stage.status === "done" ? (language === "en" ? "Done" : "Готово") : stage.status === "active" ? (language === "en" ? "Now" : "Сейчас") : stage.status === "error" ? (language === "en" ? "Error" : "Ошибка") : (language === "en" ? "Waiting" : "Ожидает")}</Text>
                </View>
              ))}
            </View>
          )}

          {items.filter((item) => item && item.id).map((item) => {
            if (item.kind === "command") {
              return (
                <View key={item.id} style={styles.row}>
                  <Ionicons
                    name={item.done ? "checkbox-outline" : "square-outline"}
                    size={15}
                    color={item.done ? colors.success : colors.muted}
                  />
                  <Text style={[styles.cmdText, { color: colors.muted }]} numberOfLines={2}>
                    {language === "en"
                      ? item.done
                        ? `Command done: ${item.text}`
                        : `Running: ${item.text}`
                      : language === "uk"
                        ? item.done
                          ? `Виконана команда: ${item.text}`
                          : `Виконую: ${item.text}`
                        : item.done
                          ? `Выполнена команда: ${item.text}`
                          : `Выполняю: ${item.text}`}
                  </Text>
                </View>
              );
            }
            if (item.kind === "plan") {
              return (
                <View key={item.id} style={styles.row}>
                  <Ionicons name="bulb-outline" size={14} color={colors.accent} />
                  <Text style={[styles.bulletText, { color: colors.inkBright }]} numberOfLines={2}>
                    {item.text}
                  </Text>
                </View>
              );
            }
            return (
              <View key={item.id} style={styles.row}>
                <Text style={{ color: colors.muted, fontSize: 12 }}>•</Text>
                <Text style={[styles.bulletText, { color: colors.muted }]} numberOfLines={2}>
                  {item.text}
                </Text>
              </View>
            );
          })}


        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
    // Не фиксируем maxHeight на свёрнутой шапке — иначе пустое место поверх чата
    flexShrink: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  thinking: { fontSize: 12, fontWeight: "600" },
  bodyScroll: { flexGrow: 0 },
  body: { paddingHorizontal: 12, paddingBottom: 10, gap: 6 },
  planRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  planTitle: { fontSize: 13, fontWeight: "700", flex: 1, lineHeight: 18 },
  activityDetail: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  progressArea: { marginTop: 7, marginBottom: 5 },
  progressTrack: { height: 6, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 4 },
  progressHint: { fontSize: 10, lineHeight: 14, marginTop: 5 },
  taskSteps: { borderWidth: 1, borderRadius: 10, padding: 9, marginTop: 6, marginBottom: 6 },
  taskStepsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 5 },
  taskStepsTitle: { fontSize: 12, fontWeight: "700" },
  taskStepsCount: { fontSize: 11, fontWeight: "700" },
  taskStepRow: { flexDirection: "row", alignItems: "flex-start", gap: 7, paddingVertical: 4 },
  taskStepLabel: { fontSize: 11, lineHeight: 15 },
  taskStepDetail: { fontSize: 10, lineHeight: 14, marginTop: 2 },
  taskStepStatus: { fontSize: 9, fontWeight: "600", marginLeft: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingLeft: 2 },
  bulletText: { fontSize: 12, flex: 1, lineHeight: 17 },
  cmdText: { fontSize: 11, flex: 1, lineHeight: 16, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  liveCmd: {
    marginTop: 4,
    borderRadius: 10,
    borderWidth: 1,
    padding: 8,
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
  },
});
