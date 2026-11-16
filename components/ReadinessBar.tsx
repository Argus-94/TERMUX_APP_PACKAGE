import { useEffect, useState, useCallback } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";
import { useAppSettingsContext } from "./AppSettingsContext";
import { useTermuxContext } from "./TermuxContext";
import { computeReadiness, type ReadyLevel } from "../lib/readiness";
import { localModelEngine } from "../lib/local-model";
import { modelKeepAlive } from "../lib/keep-alive";

const LEVEL_COLOR: Record<Exclude<ReadyLevel, "warn">, string> = {
  ok: "#9FCBFF",
  bad: "#FFB4AB",
  off: "#9AA3AC",
};

export function ReadinessBar() {
  const { colors } = useTheme();
  const { t, language } = useLanguage();
  const { mode, onlineModel, model, customProvider, customProvider1, customProvider2, activeCustomSlot, openCode, manus } =
    useAppSettingsContext();
  const { enabled: termuxEnabled } = useTermuxContext();
  const [summary, setSummary] = useState("");
  const [levels, setLevels] = useState<ReadyLevel[]>([]);
  const [ramLoaded, setRamLoaded] = useState(false);
  const [pinned, setPinned] = useState(false);

  const refresh = useCallback(async () => {
    const loaded = localModelEngine.isLoaded() || !!model.loaded;
    let isPinned = false;
    try {
      isPinned = !!(modelKeepAlive.isPinned?.() || modelKeepAlive.isActive?.());
    } catch {
      isPinned = false;
    }
    setRamLoaded(loaded);
    setPinned(isPinned);

    const slot = activeCustomSlot === 2 ? customProvider2 : customProvider1 || customProvider;
    const customKey = !!slot?.hasApiKey;
    const ocKey = !!openCode?.hasApiKey;

    const snap = await computeReadiness({
      hasApiKey: onlineModel.hasApiKey,
      hasManusApiKey: manus.loaded && manus.hasApiKey,
      hasCustomApiKey: customKey,
      hasOpenCodeApiKey: ocKey,
      mode: mode || "local",
      localLoaded: loaded,
      localDownloaded: model.downloaded,
      termuxEnabled,
      labels: {
        api: t("readyApi"),
        modelOnline: t("readyModelOnline"),
        modelOffline: t("readyModelOffline"),
        modelOfflineNeed: t("readyModelOfflineNeed"),
        modelCustom: language === "en" ? "Custom ✓" : language === "uk" ? "Custom ✓" : "Custom ✓",
        modelOpenCode: "OpenCode",
        modelManus: "Manus · API v2",
        cloudApiSaved: language === "en" ? "Key saved; check in Settings" : language === "uk" ? "Ключ збережено; перевірка в налаштуваннях" : "Ключ сохранён; проверка в настройках",
        cloudNoKey: language === "en" ? "API key not saved" : language === "uk" ? "API-ключ не збережено" : "API-ключ не сохранён",
        cloudLocalUnused: language === "en" ? "Local Termux not used" : language === "uk" ? "Локальний Termux не використовується" : "Локальный Termux не используется",
        termuxOn: t("readyTermuxOn"),
        termuxOff: t("readyTermuxOff"),
        termuxNotReady: t("readyTermuxBad"),
      },
    });
    setSummary(snap.summary);
    setLevels(snap.items.map((i) => i.level));
  }, [
    onlineModel.hasApiKey,
    mode,
    model.loaded,
    model.downloaded,
    termuxEnabled,
    t,
    language,
    customProvider,
    customProvider1,
    customProvider2,
    activeCustomSlot,
    openCode,
    manus,
  ]);

  useFocusEffect(
    useCallback(() => {
      refresh();
      const id = setInterval(refresh, 2500);
      return () => clearInterval(id);
    }, [refresh])
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!summary) return null;

  const isOffline = mode === "local";
  const isCustom = mode === "custom";
  const isOnline = mode === "online";
  const isOpenCode = mode === "opencode";

  const ramLabel = ramLoaded
    ? language === "en"
      ? pinned
        ? "RAM · pinned"
        : "RAM · loaded"
      : language === "uk"
        ? pinned
          ? "ОЗП · закріплено"
          : "ОЗП · в пам'яті"
        : pinned
          ? "ОЗУ · закреплена"
          : "ОЗУ · в памяти"
    : language === "en"
      ? "RAM · empty"
      : language === "uk"
        ? "ОЗП · порожньо"
        : "ОЗУ · пусто";

  const modeChipLabel = mode === "manus" ? "Manus" : isCustom
    ? "Custom"
    : isOpenCode
      ? "OpenCode"
      : isOnline
        ? "Online"
        : null;

  const ramColor = ramLoaded ? "#9FCBFF" : "#9AA3AC";
  const ramBg = ramLoaded ? "rgba(45,212,191,0.15)" : "rgba(100,116,139,0.12)";
  const modeColor = "#9FCBFF";
  const modeBg = "rgba(56,189,248,0.15)";

  return (
    <View style={[styles.wrap, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      <View style={styles.dots}>
        {levels.map((lv, i) => (
          <View key={i} style={[styles.dot, { backgroundColor: lv === "warn" ? colors.warning : LEVEL_COLOR[lv] }]} />
        ))}
      </View>
      <Text style={[styles.text, { color: colors.muted }]} numberOfLines={2}>
        {summary}
      </Text>
      {modeChipLabel ? (
        <View style={[styles.ramChip, { backgroundColor: modeBg, borderColor: modeColor }]}>
          <Ionicons name="cloud-outline" size={12} color={modeColor} />
          <Text style={[styles.ramText, { color: modeColor }]} numberOfLines={1}>
            {modeChipLabel}
          </Text>
        </View>
      ) : null}
      {isOffline || ramLoaded ? (
        <View style={[styles.ramChip, { backgroundColor: ramBg, borderColor: ramColor }]}>
          <Ionicons name={ramLoaded ? "hardware-chip" : "hardware-chip-outline"} size={12} color={ramColor} />
          <Text style={[styles.ramText, { color: ramColor }]} numberOfLines={1}>
            {ramLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dots: { flexDirection: "row", gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { flex: 1, fontSize: 11, lineHeight: 15 },
  ramChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 120,
  },
  ramText: { fontSize: 10, fontWeight: "700" },
});
