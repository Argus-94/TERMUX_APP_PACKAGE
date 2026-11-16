import { View, Text, TouchableOpacity, FlatList, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLLMContext } from "../components/LLMContext";
import { useDialog } from "../components/DialogContext";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { killRuntimeSession } from "../lib/runtime-session";

export default function ChatHistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { showDialog } = useDialog();
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const { sessions, currentSessionId, setCurrentSessionId, deleteChat } = useLLMContext();

  const handleDelete = (id: string, title: string) => {
    showDialog(t("deleteChat"), `${t("deleteChat")} "${title}"?`, [
      { text: t("cancel"), style: "cancel" },
      { text: t("delete"), style: "destructive", onPress: () => deleteChat(id) },
    ]);
  };

  const handleStopSession = (id: string, title: string) => {
    showDialog(t("stopSession"), `${t("stopSessionConfirm")}\n\n${title}`, [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("stopSession"),
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              const result = await killRuntimeSession(id);
              showDialog(
                result.ok ? t("stopSessionDone") : t("stopSessionFail"),
                result.ok
                  ? `${result.sessionName}`
                  : String(result.error || "unknown"),
              );
            } catch (e: any) {
              showDialog(t("stopSessionFail"), String(e?.message || e));
            }
          })();
        },
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.inkBright }]}>{t("chatHistoryTitle")}</Text>
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: 16 + insets.bottom }]}
        renderItem={({ item }) => {
          const active = item.id === currentSessionId;
          return (
            <TouchableOpacity
              style={[
                styles.chatCard,
                {
                  backgroundColor: active ? colors.accentDim : colors.surface,
                  borderColor: active ? colors.accent : colors.line,
                },
              ]}
              onPress={() => {
                setCurrentSessionId(item.id);
                router.back();
              }}
              activeOpacity={0.75}
            >
              <View style={styles.chatInfo}>
                <Text style={[styles.chatTitle, { color: colors.inkBright }]} numberOfLines={1}>
                  {item.title || item.id}
                </Text>
                {active ? (
                  <Text style={[styles.activeBadge, { color: colors.accent }]}>
                    {language === "ru" ? "активный" : language === "uk" ? "активний" : "active"}
                  </Text>
                ) : null}
              </View>
              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.iconButton}
                  onPress={() => handleStopSession(item.id, item.title || item.id)}
                  accessibilityLabel={t("stopSession")}
                >
                  <Text style={styles.iconText}>⏹</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.iconButton}
                  onPress={() => handleDelete(item.id, item.title || item.id)}
                  accessibilityLabel={t("deleteChat")}
                >
                  <Text style={styles.iconText}>🗑️</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.muted }]}>
            {language === "ru" ? "Нет чатов" : language === "uk" ? "Немає чатів" : "No chats yet"}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 12 },
  list: { gap: 8 },
  chatCard: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  chatInfo: { flex: 1, paddingRight: 8 },
  chatTitle: { fontSize: 15, fontWeight: "600" },
  activeBadge: { fontSize: 11, marginTop: 2, textTransform: "uppercase", letterSpacing: 0.4 },
  actions: { flexDirection: "row", alignItems: "center", gap: 4 },
  iconButton: { padding: 8 },
  iconText: { fontSize: 16 },
  empty: { textAlign: "center", marginTop: 40, fontSize: 14 },
});
