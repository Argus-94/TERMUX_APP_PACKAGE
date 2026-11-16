import { useCallback, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { useLLMContext } from "../components/LLMContext";
import { useDialog } from "../components/DialogContext";
import {
  listCheckpoints,
  getCheckpoint,
  deleteCheckpoint,
  deleteCheckpointsForSession,
  resolveCheckpointDisplay,
  type Checkpoint,
} from "../lib/checkpoints";
import { persistentLogger } from "../lib/persistent-logger";
import { errorMessage } from "../lib/error-utils";

function formatRelativeTime(ts: number, lang: string): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 45) {
    if (lang === "en") return "just now";
    if (lang === "uk") return "щойно";
    return "только что";
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    if (lang === "en") return `${min} min ago`;
    if (lang === "uk") return `${min} хв тому`;
    return `${min} мин назад`;
  }
  const hrs = Math.floor(min / 60);
  if (hrs < 24) {
    if (lang === "en") return `${hrs} h ago`;
    if (lang === "uk") return `${hrs} год тому`;
    return `${hrs} ч назад`;
  }
  const days = Math.floor(hrs / 24);
  if (days < 7) {
    if (lang === "en") return `${days} d ago`;
    if (lang === "uk") return `${days} дн тому`;
    return `${days} дн назад`;
  }
  return new Date(ts).toLocaleString(
    lang === "en" ? "en-US" : lang === "uk" ? "uk-UA" : "ru-RU",
    { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }
  );
}

export default function CheckpointsScreen() {
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const { currentSession, restoreSessionMessages } = useLLMContext();
  const { showDialog } = useDialog();
  const [items, setItems] = useState<Checkpoint[]>([]);

  useFocusEffect(
    useCallback(() => {
      listCheckpoints(currentSession?.id || "default")
        .then(setItems)
        .catch((error: unknown) => {
          persistentLogger.add("error", "Checkpoint", `CHECKPOINT_LIST_FAILED: ${errorMessage(error)}`, "app");
          setItems([]);
        });
    }, [currentSession?.id])
  );

  const onRestore = (cp: Checkpoint) => {
    const disp = resolveCheckpointDisplay(cp);
    showDialog(
      t("checkpointRestoreTitle"),
      `${t("checkpointRestoreConfirm")}\n\n«${disp.title}»`,
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("checkpointRestore"),
          onPress: async () => {
            const full = await getCheckpoint(cp.id);
            if (full && restoreSessionMessages) {
              restoreSessionMessages(full.messages.map((message) => ({
                ...message,
                role: message.role === "user" || message.role === "assistant" ? message.role : "system",
              })));
              persistentLogger.markAppEvent("CHECKPOINT_RESTORED", {
                id: cp.id,
                messages: full.messages.length,
              });
            }
          },
        },
      ]
    );
  };

  const onDelete = (cp: Checkpoint) => {
    showDialog(t("checkpointDeleteTitle"), t("checkpointDeleteConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("checkpointDelete"),
        style: "destructive",
        onPress: async () => {
          const previous = items;
          setItems((current) => current.filter((item) => item.id !== cp.id));
          try {
            await deleteCheckpoint(cp.id);
          } catch (error: unknown) {
            setItems(previous);
            persistentLogger.add(
              "error",
              "Checkpoint",
              `CHECKPOINT_DELETE_FAILED id=${cp.id}: ${errorMessage(error)}`,
              "app"
            );
          }
        },
      },
    ]);
  };

  const onDeleteAll = () => {
    if (items.length === 0) return;
    showDialog(
      t("checkpointDeleteAllTitle"),
      t("checkpointDeleteAllConfirm").replace("{count}", String(items.length)),
      [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("checkpointDeleteAll"),
          style: "destructive",
          onPress: async () => {
            const previous = items;
            setItems([]);
            try {
              await deleteCheckpointsForSession(currentSession?.id || "default");
            } catch (error: unknown) {
              setItems(previous);
              persistentLogger.add(
                "error",
                "Checkpoint",
                `CHECKPOINT_DELETE_ALL_FAILED: ${errorMessage(error)}`,
                "app"
              );
            }
          },
        },
      ]
    );
  };

  if (items.length === 0) {
    return (
      <View style={[styles.container, styles.emptyContainer, { backgroundColor: colors.background }]}>
        <Ionicons name="bookmark-outline" size={40} color={colors.muted} />
        <Text style={[styles.emptyTitle, { color: colors.inkBright }]}>{t("checkpoints")}</Text>
        <Text style={[styles.emptyText, { color: colors.muted }]}>{t("checkpointEmpty")}</Text>
        <Text style={[styles.emptyText, { color: colors.muted, marginTop: 4 }]}>{t("checkpointHint")}</Text>
      </View>
    );
  }

  // Нумерация: самый новый = #N, самый старый = #1
  const total = items.length;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 32 }}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={[styles.listHeaderTitle, { color: colors.muted }]}>
              {total} {total === 1 ? "checkpoint" : "checkpoint'ов"}
            </Text>
            <TouchableOpacity
              style={[styles.deleteAllButton, { backgroundColor: colors.dangerDim, borderColor: colors.danger }]}
              onPress={onDeleteAll}
              accessibilityRole="button"
              accessibilityLabel={t("checkpointDeleteAll")}
              activeOpacity={0.75}
            >
              <Ionicons name="trash-bin-outline" size={16} color={colors.danger} />
              <Text style={[styles.deleteAllText, { color: colors.danger }]}>{t("checkpointDeleteAll")}</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item, index }) => {
          const disp = resolveCheckpointDisplay(item);
          const ordinal = total - index; // #7 = newest when total=7
          const rel = formatRelativeTime(item.createdAt, language || "ru");
          const exact = new Date(item.createdAt).toLocaleString(
            language === "en" ? "en-US" : language === "uk" ? "uk-UA" : "ru-RU",
            { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }
          );

          return (
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
              <TouchableOpacity
                style={styles.cardBody}
                onPress={() => onRestore(item)}
                accessibilityRole="button"
                accessibilityLabel={`#${ordinal}, ${disp.title}, ${exact}`}
                activeOpacity={0.75}
              >
                <View style={styles.titleRow}>
                  <View style={[styles.badge, { backgroundColor: colors.accentDim || colors.line }]}>
                    <Text style={[styles.badgeText, { color: colors.accent || colors.inkBright }]}>#{ordinal}</Text>
                  </View>
                  <Text style={[styles.reason, { color: colors.inkBright }]} numberOfLines={2}>
                    {disp.title}
                  </Text>
                </View>

                {!!disp.preview && (
                  <Text style={[styles.preview, { color: colors.muted }]} numberOfLines={1}>
                    {disp.preview}
                  </Text>
                )}

                <View style={styles.metaRow}>
                  <Text style={[styles.meta, { color: colors.muted }]}>{rel}</Text>
                  <Text style={[styles.metaDot, { color: colors.line }]}>·</Text>
                  <Text style={[styles.meta, { color: colors.muted }]}>
                    {disp.stats.user}↑ {disp.stats.assistant}↓
                  </Text>
                  <Text style={[styles.metaDot, { color: colors.line }]}>·</Text>
                  <Text style={[styles.meta, { color: colors.muted }]}>{disp.stats.total} msg</Text>
                </View>
                <Text style={[styles.exactTime, { color: colors.muted }]} numberOfLines={1}>
                  {exact}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.deleteButton, { backgroundColor: colors.dangerDim, borderColor: colors.danger }]}
                onPress={() => onDelete(item)}
                accessibilityRole="button"
                accessibilityLabel={t("checkpointDelete")}
                hitSlop={8}
                activeOpacity={0.7}
              >
                <Ionicons name="trash-outline" size={21} color={colors.danger} />
              </TouchableOpacity>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyContainer: { alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  emptyTitle: { fontSize: 16, fontWeight: "700", textAlign: "center" },
  emptyText: { fontSize: 13, lineHeight: 19, textAlign: "center" },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  listHeaderTitle: { fontSize: 12, fontWeight: "700" },
  deleteAllButton: {
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteAllText: { fontSize: 12, fontWeight: "700" },
  card: {
    minHeight: 96,
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    paddingRight: 68,
    justifyContent: "center",
    position: "relative",
  },
  cardBody: { minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 4 },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginTop: 1,
  },
  badgeText: { fontSize: 11, fontWeight: "800" },
  reason: { flex: 1, fontWeight: "700", fontSize: 14, lineHeight: 19 },
  preview: { fontSize: 12, lineHeight: 17, marginBottom: 6 },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
  meta: { fontSize: 11, fontWeight: "600" },
  metaDot: { fontSize: 11 },
  exactTime: { fontSize: 10, marginTop: 3, opacity: 0.75 },
  deleteButton: {
    position: "absolute",
    right: 12,
    top: "50%",
    marginTop: -21,
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
