import { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { useDialog } from "../components/DialogContext";
import {
  SETTINGS_GUIDE,
  filterSettingsGuide,
  type GuideLang,
  type GuideDownload,
} from "../lib/settings-guide";

export default function SettingsGuideScreen() {
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const { showDialog } = useDialog();
  const insets = useSafeAreaInsets();
  const listBottomPad = Math.max(insets.bottom, 12) + 28;
  const [query, setQuery] = useState("");
  const lang = (language === "uk" || language === "ru" || language === "en" ? language : "ru") as GuideLang;
  const data = useMemo(() => filterSettingsGuide(query, lang), [query, lang]);

  const openDownload = async (url: string, label: string) => {
    try {
      const can = await Linking.canOpenURL(url);
      if (!can) {
        showDialog(
          t("settingsGuideDownloadFailTitle") || "Не удалось открыть",
          t("settingsGuideDownloadFailBody") || "Ссылка недоступна. Скопируйте её из справки или откройте Hugging Face вручную.",
        );
        return;
      }
      await Linking.openURL(url);
    } catch {
      showDialog(
        t("settingsGuideDownloadFailTitle") || "Не удалось открыть",
        `${label}\n${url}`,
      );
    }
  };

  const renderDownload = (d: GuideDownload, index: number) => {
    const isMmproj = d.kind === "mmproj";
    const bg = isMmproj ? "rgba(124, 58, 237, 0.12)" : colors.accentDim;
    const fg = isMmproj ? "#9FCBFF" : colors.accent;
    const icon = isMmproj ? "eye-outline" : "cloud-download-outline";
    return (
      <View key={`${d.url}-${index}`} style={styles.downloadBlock}>
        <TouchableOpacity
          style={[styles.downloadBtn, { backgroundColor: bg, borderColor: fg }]}
          onPress={() => openDownload(d.url, d.label[lang])}
          activeOpacity={0.75}
        >
          <Ionicons name={icon as any} size={18} color={fg} />
          <Text style={[styles.downloadBtnText, { color: fg }]} numberOfLines={2}>
            {t("settingsGuideDownload") || "Скачать"} · {d.label[lang]}
          </Text>
        </TouchableOpacity>
        {!!d.hint?.[lang] && (
          <Text style={[styles.downloadHint, { color: colors.footerMuted }]}>{d.hint[lang]}</Text>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.hint, { color: colors.muted }]}>{t("settingsGuideHint")}</Text>
      <TextInput
        style={[
          styles.search,
          {
            backgroundColor: colors.inputBg,
            borderColor: colors.line,
            color: colors.inkBright,
          },
        ]}
        value={query}
        onChangeText={setQuery}
        placeholder={t("settingsGuideSearch")}
        placeholderTextColor={colors.footerMuted}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <Text style={[styles.count, { color: colors.footerMuted }]}>
        {t("settingsGuideCount", { count: data.length, total: SETTINGS_GUIDE.length })}
      </Text>
      <FlatList
        data={data.filter(Boolean)}
        keyExtractor={(item) => item?.id ?? `guide-${Math.random()}`}
        contentContainerStyle={[styles.list, { paddingBottom: listBottomPad }]}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        renderItem={({ item, index }) => {
          if (!item?.title || !item?.body) return null;
          const downloads = item.downloads ?? [];
          return (
            <View
              style={[
                styles.card,
                { backgroundColor: colors.surface, borderColor: colors.line },
              ]}
            >
              <View style={styles.stepRow}>
                <View style={[styles.stepBadge, { backgroundColor: colors.accentDim }]}>
                  <Text style={[styles.stepNum, { color: colors.accent }]}>{index + 1}</Text>
                </View>
                <Text style={[styles.title, { color: colors.inkBright }]}>{item.title[lang]}</Text>
              </View>
              <Text style={[styles.body, { color: colors.muted }]} selectable>
                {item.body[lang]}
              </Text>
              {downloads.length > 0 && (
                <View style={styles.downloadsWrap}>
                  <Text style={[styles.downloadsTitle, { color: colors.inkBright }]}>
                    {t("settingsGuideDownloadsTitle") || "Скачать модель"}
                  </Text>
                  {downloads.map(renderDownload)}
                </View>
              )}
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.footerMuted }]}>{t("settingsGuideEmpty")}</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  hint: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
  search: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
  },
  count: { fontSize: 11, marginTop: 8, marginBottom: 8 },
  list: {},
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
  },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNum: { fontSize: 13, fontWeight: "800" },
  title: { fontSize: 15, fontWeight: "700", flex: 1 },
  body: { fontSize: 13.5, lineHeight: 20 },
  empty: { textAlign: "center", marginTop: 40, fontSize: 14 },
  downloadsWrap: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(148, 163, 184, 0.35)",
    gap: 8,
  },
  downloadsTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
    marginBottom: 2,
  },
  downloadBlock: { gap: 3 },
  downloadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  downloadBtnText: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: "700",
    lineHeight: 16,
  },
  downloadHint: {
    fontSize: 11,
    lineHeight: 14,
    paddingHorizontal: 4,
  },
});
