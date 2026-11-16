import { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Platform,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import {
  TERMUX_COMMANDS,
  TERMUX_COMMAND_CATEGORIES,
  filterTermuxCommands,
  type CommandLang,
} from "../lib/termux-commands";
import { COMPILE_PACKAGES } from "../lib/compile-packages";
import { getBuildBackend } from "../lib/agent-shell-backend";
import {
  buildCompileGuideRows,
  filterCompileGuideRows,
  type CompileGuideRow,
} from "../lib/commands-guide-helpers";

const MONO = Platform.select({ android: "monospace", ios: "Menlo", default: "monospace" });

export default function CommandsGuideScreen() {
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const listBottomPad = Math.max(insets.bottom, 12) + 28;
  const lang = (language === "en" || language === "ru" ? language : "uk") as CommandLang;
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [compileExpanded, setCompileExpanded] = useState(false);
  const backend = getBuildBackend();
  const data = useMemo(() => filterTermuxCommands(query, lang), [query, lang]);
  const compileGuideRows = useMemo(
    () => buildCompileGuideRows(COMPILE_PACKAGES, backend, lang),
    [backend, lang],
  );
  const compileMatches = useMemo(
    () => filterCompileGuideRows(compileGuideRows, query),
    [compileGuideRows, query],
  );
  const searchActive = query.trim().length > 0;
  const visibleCompileRows = searchActive
    ? compileMatches
    : compileExpanded
      ? compileGuideRows
      : [];
  const showCompileSearchResults = searchActive && compileMatches.length > 0 && !compileExpanded;
  const totalGuideItems = TERMUX_COMMANDS.length + COMPILE_PACKAGES.length;
  const foundGuideItems = searchActive
    ? data.length + compileMatches.length
    : totalGuideItems;

  const onCopy = useCallback(async (id: string, command: string) => {
    await Clipboard.setStringAsync(command);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
  }, []);

  const renderCompileGuideCard = (row: CompileGuideRow) => {
    const id = `compile-${row.source.id}`;
    const command = row.instruction.command;
    const copied = copiedId === id;
    return (
      <View key={row.source.id} style={[styles.compileCommandCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.compileCommandName, { color: colors.inkBright }]}>{row.title}</Text>
        <Text style={[styles.compileDescription, { color: colors.muted }]}>{row.instruction.description}</Text>
        <View style={[styles.cmdBlock, { backgroundColor: colors.background, borderColor: colors.line }]}>
          <Text style={[styles.cmd, { color: colors.inkBright, fontFamily: MONO }]} selectable>
            {command ?? row.instruction.display}
          </Text>
          {command && (
            <TouchableOpacity
              style={[styles.copyBtn, { backgroundColor: colors.accentDim }, copied && { backgroundColor: colors.accentGlow }]}
              onPress={() => void onCopy(id, command)}
              accessibilityRole="button"
            >
              <Text style={[styles.copyBtnText, { color: colors.accent }]}>
                {copied
                  ? t("termuxCopiedOne")
                  : lang === "en"
                    ? "Copy"
                    : lang === "uk"
                      ? "Скопіювати"
                      : "Копировать"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: listBottomPad }]}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListHeaderComponent={
          <View>
            <Text style={[styles.hint, { color: colors.muted }]}>{t("commandsGuideHint")}</Text>
            <TextInput
              style={[
                styles.search,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.line,
                  color: colors.inkBright,
                },
              ]}
              value={query}
              onChangeText={setQuery}
              placeholder={t("commandsGuideSearch")}
              placeholderTextColor={colors.footerMuted}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
            <Text style={[styles.count, { color: colors.footerMuted }]}>
              {t("commandsGuideCount", { count: foundGuideItems, total: totalGuideItems })}
            </Text>
            {showCompileSearchResults && (
              <View style={styles.compileSearchResults}>
                <Text style={[styles.compileHeading, styles.compileSearchHeading, { color: colors.inkBright }]}>
                  {lang === "en"
                    ? `Compilation tools · ${compileMatches.length} matches`
                    : lang === "uk"
                      ? `Інструменти компіляції · збігів: ${compileMatches.length}`
                      : `Инструменты компиляции · совпадений: ${compileMatches.length}`}
                </Text>
                <View style={styles.compileCommands}>{compileMatches.map(renderCompileGuideCard)}</View>
              </View>
            )}
            <View style={[styles.compileSection, { backgroundColor: colors.surface, borderColor: colors.line }]}>
              <TouchableOpacity
                style={styles.compileHeader}
                onPress={() => setCompileExpanded((value) => !value)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ expanded: compileExpanded }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.compileHeading, { color: colors.inkBright }]}>
                    {lang === "en" ? "Compilation tools" : lang === "uk" ? "Інструменти компіляції" : "Инструменты компиляции"}
                  </Text>
                  <Text style={[styles.compileHint, { color: colors.muted }]}>
                    {lang === "en"
                      ? "Compact install routes from the compilation tools menu. SDK Manager and direct downloads are identified as such."
                      : lang === "uk"
                        ? "Короткі способи встановлення з меню компіляції. Для SDK Manager і прямих завантажень указано фактичний маршрут."
                        : "Краткие способы установки из меню компиляции. Для SDK Manager и прямых загрузок указан фактический маршрут."}
                  </Text>
                </View>
                <Text style={[styles.compileToggle, { color: colors.accent }]}>{compileExpanded ? "⌃" : "⌄"}</Text>
              </TouchableOpacity>
              {compileExpanded && (
                <View style={styles.compileCommands}>
                  {visibleCompileRows.map(renderCompileGuideCard)}
                </View>
              )}
            </View>
          </View>
        }
        renderItem={({ item }) => {
          const cat =
            TERMUX_COMMAND_CATEGORIES[item.category as keyof typeof TERMUX_COMMAND_CATEGORIES]?.[
              lang
            ] || item.category;
          const copied = copiedId === item.id;
          return (
            <View
              style={[
                styles.card,
                { backgroundColor: colors.surface, borderColor: colors.line },
              ]}
            >
              <View style={styles.cardHeader}>
                <Text style={[styles.name, { color: colors.inkBright }]}>{item.name[lang]}</Text>
                <View style={[styles.catBadge, { backgroundColor: colors.accentDim }]}>
                  <Text style={[styles.catText, { color: colors.accent }]}>{cat}</Text>
                </View>
              </View>
              <Text style={[styles.desc, { color: colors.muted }]}>{item.description[lang]}</Text>
              <View
                style={[
                  styles.cmdBlock,
                  { backgroundColor: colors.background, borderColor: colors.line },
                ]}
              >
                <Text style={[styles.cmd, { color: colors.inkBright, fontFamily: MONO }]} selectable>
                  {item.command}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.copyBtn,
                    { backgroundColor: colors.accentDim },
                    copied && { backgroundColor: colors.accentGlow },
                  ]}
                  onPress={() => onCopy(item.id, item.command)}
                >
                  <Text style={[styles.copyBtnText, { color: colors.accent }]}>
                    {copied ? t("termuxCopiedOne") : t("termuxCopyOne")}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          data.length === 0 && compileMatches.length === 0
            ? <Text style={[styles.empty, { color: colors.footerMuted }]}>{t("commandsGuideEmpty")}</Text>
            : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  hint: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
  compileSection: { borderRadius: 14, borderWidth: 1, padding: 12, marginBottom: 10 },
  compileHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  compileHeading: { fontSize: 15, fontWeight: "700" },
  compileHint: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  compileToggle: { fontSize: 22, fontWeight: "700", paddingHorizontal: 4 },
  compileCommands: { marginTop: 10, gap: 8 },
  compileSearchResults: { marginBottom: 10 },
  compileSearchHeading: { marginBottom: 8 },
  compileCommandCard: { borderRadius: 12, borderWidth: 1, padding: 10 },
  compileCommandName: { fontSize: 13, fontWeight: "700" },
  compileDescription: { fontSize: 11, lineHeight: 16, marginTop: 4 },
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
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  name: { fontSize: 15, fontWeight: "700", flex: 1 },
  catBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  catText: { fontSize: 10, fontWeight: "700" },
  desc: { fontSize: 13, lineHeight: 18, marginTop: 6 },
  cmdBlock: {
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  cmd: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  copyBtn: {
    alignSelf: "flex-end",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  copyBtnText: { fontSize: 12, fontWeight: "700" },
  empty: { textAlign: "center", marginTop: 40, fontSize: 14 },
});
