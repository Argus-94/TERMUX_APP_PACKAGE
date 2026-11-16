import { ScrollView, View, Text, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { ABOUT_BLOCKS, type AboutLang } from "../lib/about-content";

export default function AboutScreen() {
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const lang = (language === "en" || language === "ru" ? language : "uk") as AboutLang;
  const bottomPad = Math.max(insets.bottom, 12) + 24;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={[
          styles.hero,
          { backgroundColor: colors.surface, borderColor: colors.line },
        ]}
      >
        <Text style={[styles.heroTitle, { color: colors.inkBright }]}>AI Builder</Text>
        <Text style={[styles.heroSub, { color: colors.muted }]}>{t("aboutHeroSub")}</Text>
        <Text style={[styles.heroMeta, { color: colors.accent }]}>Expo SDK 54 · RN 0.81.5</Text>
      </View>

      {ABOUT_BLOCKS.map((block) => (
        <View
          key={block.id}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}
        >
          <Text style={[styles.cardTitle, { color: colors.inkBright }]}>{block.title[lang]}</Text>
          <Text style={[styles.cardBody, { color: colors.muted }]} selectable>
            {block.body[lang]}
          </Text>
        </View>
      ))}

      <Text style={[styles.footer, { color: colors.accent }]}>{t("madeInUkraine")}</Text>
      <Text style={[styles.footerNick, { color: colors.footerMuted }]}>{t("developerNick")}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  hero: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    marginBottom: 12,
  },
  heroTitle: { fontSize: 22, fontWeight: "800" },
  heroSub: { fontSize: 13.5, lineHeight: 19, marginTop: 8 },
  heroMeta: { fontSize: 12, fontWeight: "600", marginTop: 10 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: { fontSize: 15, fontWeight: "700", marginBottom: 8 },
  cardBody: { fontSize: 13.5, lineHeight: 20 },
  footer: {
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 12,
  },
  footerNick: { fontSize: 11, textAlign: "center", marginTop: 4 },
});
