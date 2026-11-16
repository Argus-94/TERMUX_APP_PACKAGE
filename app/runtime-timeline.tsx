import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { useProjectContext } from "../components/ProjectContext";
import { getRuntimeFacade } from "../lib/runtime-facade";
import type { TimelineEvent } from "../core/enhancements/timeline/EventStore";

const label = (language: "ru" | "uk" | "en", ru: string, uk: string, en: string) => language === "ru" ? ru : language === "uk" ? uk : en;

export default function RuntimeTimelineScreen() {
  const router = useRouter();
  const { language } = useLanguage();
  const { colors } = useTheme();
  const { project } = useProjectContext();
  const [events, setEvents] = useState<readonly TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allProjects, setAllProjects] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const projectId = project?.id || project?.name;
      const rows = await getRuntimeFacade().timeline.list(allProjects ? undefined : projectId, undefined, 100);
      setEvents([...rows].reverse());
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally { setLoading(false); }
  }, [allProjects, project?.id, project?.name]);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  return <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 12, paddingHorizontal: 14, gap: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={label(language, "Назад", "Назад", "Back")} onPress={() => router.back()} style={{ padding: 8 }}><Ionicons name="arrow-back" size={22} color={colors.accent} /></TouchableOpacity>
      <Text style={{ color: colors.inkBright, fontSize: 18, fontWeight: "800", flex: 1 }}>{label(language, "Журнал runtime", "Журнал runtime", "Runtime timeline")}</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={label(language, "Обновить", "Оновити", "Refresh")} onPress={() => void refresh()} disabled={loading} style={{ padding: 8 }}><Ionicons name="refresh" size={20} color={loading ? colors.muted : colors.accent} /></TouchableOpacity>
    </View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <TouchableOpacity onPress={() => setAllProjects((value) => !value)} accessibilityRole="button" accessibilityState={{ selected: allProjects }} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 }}>
        <Text style={{ color: colors.inkBright, fontSize: 11 }}>{allProjects ? label(language, "Все проекты", "Усі проєкти", "All projects") : (project?.name || project?.id || label(language, "Текущий проект", "Поточний проєкт", "Current project"))}</Text>
      </TouchableOpacity>
      <Text style={{ color: colors.muted, fontSize: 10 }}>{label(language, "Последние 100 событий · обновление вручную", "Останні 100 подій · ручне оновлення", "Latest 100 events · refresh manually")}</Text>
    </View>
    {loading && events.length === 0 ? <ActivityIndicator color={colors.accent} /> : null}
    {error ? <Text selectable style={{ color: colors.danger ?? "#DC2626", fontSize: 12 }}>{error}</Text> : null}
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8, paddingBottom: 24 }}>
      {!loading && events.length === 0 && !error ? <Text style={{ color: colors.muted, fontSize: 13 }}>{label(language, "Событий пока нет.", "Подій поки немає.", "No events yet.")}</Text> : null}
      {events.map((event) => <View key={event.id} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, gap: 4, backgroundColor: colors.surface }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={{ color: event.level === "error" ? (colors.danger ?? "#DC2626") : event.level === "warn" ? colors.warning : colors.accent, fontWeight: "700", fontSize: 12, flex: 1 }}>{event.type}</Text>
          <Text style={{ color: colors.muted, fontSize: 10 }}>{new Date(event.ts).toLocaleString()}</Text>
        </View>
        <Text style={{ color: colors.muted, fontSize: 10 }}>{event.actor}{event.projectId ? ` · ${event.projectId}` : ""}{event.taskId ? ` · ${event.taskId}` : ""}</Text>
        <Text selectable style={{ color: colors.inkBright, fontFamily: "monospace", fontSize: 10 }}>{JSON.stringify(event.payload)}</Text>
      </View>)}
    </ScrollView>
  </View>;
}
