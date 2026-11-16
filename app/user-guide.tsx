import { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  TouchableOpacity,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import {
  USER_GUIDE,
  filterUserGuide,
  type UserGuideLang,
  type UserGuideSection,
} from "../lib/user-guide";

export default function UserGuideScreen() {
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const listBottomPad = Math.max(insets.bottom, 12) + 28;
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>("first-steps");
  const lang = (language === "uk" || language === "ru" || language === "en" ? language : "ru") as UserGuideLang;
  const data = useMemo(() => filterUserGuide(query, lang), [query, lang]);

  const renderItem = ({ item }: { item: UserGuideSection }) => {
    const open = expandedId === item.id || (!!query && query.trim().length > 0);
    return (
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.line },
        ]}
      >
        <TouchableOpacity
          onPress={() => setExpandedId(open && !query.trim() ? null : item.id)}
          activeOpacity={0.75}
          style={styles.cardHeader}
        >
          <Ionicons
            name={open ? "chevron-down" : "chevron-forward"}
            size={18}
            color={colors.accent}
          />
          <Text style={[styles.cardTitle, { color: colors.inkBright }]}>
            {item.title[lang]}
          </Text>
        </TouchableOpacity>
        {open ? (
          <Text style={[styles.cardBody, { color: colors.muted }]}>
            {item.body[lang]}
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.searchWrap, { borderColor: colors.line, backgroundColor: colors.surface }]}>
        <Ionicons name="search" size={18} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={
            language === "uk"
              ? "Пошук у довідці…"
              : language === "en"
                ? "Search the guide…"
                : "Поиск в справке…"
          }
          placeholderTextColor={colors.muted}
          style={[styles.searchInput, { color: colors.inkBright }]}
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery("")} hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={colors.muted} />
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={[styles.hint, { color: colors.muted }]}>
        {language === "uk"
          ? "Повна інструкція для новачка. Натисніть розділ, щоб розгорнути."
          : language === "en"
            ? "Full beginner guide. Tap a section to expand."
            : "Полная инструкция для новичка. Нажмите раздел, чтобы раскрыть."}
      </Text>
      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingBottom: listBottomPad, gap: 10 }}
        ListEmptyComponent={
          <Text style={{ color: colors.muted, textAlign: "center", marginTop: 24 }}>
            {language === "uk" ? "Нічого не знайдено" : language === "en" ? "Nothing found" : "Ничего не найдено"}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchWrap: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  hint: {
    marginHorizontal: 16,
    marginBottom: 4,
    fontSize: 12,
    lineHeight: 16,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: "700" },
  cardBody: { fontSize: 13.5, lineHeight: 20 },
});
