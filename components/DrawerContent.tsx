
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Image, ActivityIndicator } from "react-native";
import { useEffect, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "./LanguageContext";
import { useTheme } from "./ThemeContext";
import { darkColors } from "../theme/colors";
import { useTermuxContext } from "./TermuxContext";
import { isNativeModuleAvailable } from "../lib/termux-bridge";
import { AppLanguage, LANGUAGE_LABELS } from "../lib/i18n";
import { getRuntimeFacade } from "../lib/runtime-facade";
import { isInterceptorListenerLive } from "../lib/chat-indicator-layout";

export function DrawerContent(props: any) {
  const currentRoute = props.state?.routeNames?.[props.state?.index] || "index";
  const insets = useSafeAreaInsets();
  const { language, setLanguage, t } = useLanguage();
  const theme = useTheme();
  const colors = theme?.colors ?? darkColors;
  const { enabled: termuxEnabled } = useTermuxContext();
  const termuxBridgeOk = isNativeModuleAvailable();
  const appVersion = Constants.expoConfig?.version ?? "unknown";
  const [interceptorActive, setInterceptorActive] = useState(() => isInterceptorListenerLive(getRuntimeFacade().interceptorEngine.getSnapshot()));
  useEffect(() => getRuntimeFacade().interceptorEngine.subscribe((snapshot) => setInterceptorActive(isInterceptorListenerLive(snapshot))), []);

  // The drawer must remain structurally stable: hiding a route when it has no
  // data made one menu item disappear entirely. Checkpoints can simply open an
  // empty screen, where the user can create the first checkpoint.

  const menuItems = [
    { name: "index", label: termuxEnabled ? t("session") : t("chat"), icon: "chatbubble-outline" as const },
    { name: "chat-history", label: t("chatHistory"), icon: "time-outline" as const },
    { name: "script-runner", label: t("scriptRunner"), icon: "construct-outline" as const },
    { name: "runtime", label: t("runtimeEnvironment"), icon: "hardware-chip-outline" as const },
    { name: "interceptor", label: t("trafficInterceptor"), icon: "pulse-outline" as const, active: interceptorActive },
    { name: "settings", label: t("settings"), icon: "settings-outline" as const },
    { name: "termux-settings", label: t("termuxSettings"), icon: "terminal-outline" as const, warn: !termuxBridgeOk },
    { name: "checkpoints", label: t("checkpoints"), icon: "bookmark-outline" as const },
    { name: "session-replay", label: t("sessionReplay"), icon: "film-outline" as const },
    { name: "terminal", label: language === "ru" ? "Консоль" : language === "uk" ? "Консоль" : "Console", icon: "terminal-outline" as const },
    { name: "github", label: "GitHub", icon: "logo-github" as const },
    { name: "log-screen", label: t("log"), icon: "list-outline" as const },
  ];

  const helpItems = [
    { name: "about", label: t("aboutApp"), icon: "information-circle-outline" as const },
    { name: "commands-guide", label: t("commandsGuide"), icon: "book-outline" as const },
    { name: "settings-guide", label: t("settingsGuide"), icon: "help-circle-outline" as const },
  ];

  const languages: AppLanguage[] = ["uk", "ru", "en"];

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: colors.drawerBg,
          paddingTop: Math.max(insets.top, 12),
          paddingBottom: Math.max(insets.bottom, 12),
        },
      ]}
    >
      {/* Brand */}
      <View style={[styles.brand, { borderBottomColor: colors.line }]}>
        <View style={[styles.logoWrap, { backgroundColor: colors.accentDim }]}>
          <Ionicons name="code-slash" size={22} color={colors.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.brandTitle, { color: colors.inkBright }]}>AI Builder</Text>
          <Text style={[styles.brandSub, { color: colors.muted }]}>Expo SDK 54 · v{appVersion}</Text>
        </View>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Main nav */}
        <View style={styles.sectionPad}>
          {menuItems.map((item) => {
            const active = currentRoute === item.name;
            return (
              <TouchableOpacity
                key={item.name}
                style={[
                  styles.navItem,
                  active && { backgroundColor: colors.drawerActiveBg },
                ]}
                onPress={() => {
                  props.navigation.navigate(item.name);
                }}
                activeOpacity={0.7}
              >
                <Ionicons
                  name={item.icon}
                  size={20}
                  color={active ? colors.accent : colors.muted}
                />
                <Text
                  style={[
                    styles.navLabel,
                    { color: active ? colors.accent : colors.inkBright },
                    active && styles.navLabelActive,
                  ]}
                >
                  {item.label}
                </Text>
                {"active" in item && (item as { active?: boolean }).active ? (
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success, marginLeft: "auto" }} />
                ) : null}
                {"warn" in item && (item as { warn?: boolean }).warn ? (
                  <Ionicons name="warning-outline" size={16} color={colors.danger} style={{ marginLeft: "auto" }} />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Language */}
        <View style={[styles.block, { borderTopColor: colors.line }]}>
          <Text style={[styles.blockTitle, { color: colors.muted }]}>{t("language") || "Language"}</Text>
          <View style={styles.row}>
            {languages.map((lang) => {
              const on = language === lang;
              return (
                <TouchableOpacity
                  key={lang}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: on ? colors.accentDim : colors.chipBg,
                      borderColor: on ? colors.accent : colors.line,
                    },
                  ]}
                  onPress={() => setLanguage(lang)}
                >
                  <Text style={{ color: on ? colors.accent : colors.chipText, fontWeight: on ? "700" : "500", fontSize: 13 }}>
                    {LANGUAGE_LABELS[lang]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Help */}
        <View style={[styles.block, { borderTopColor: colors.line }]}>
          {helpItems.map((item) => {
            const active = currentRoute === item.name;
            return (
              <TouchableOpacity
                key={item.name}
                style={[styles.navItem, active && { backgroundColor: colors.drawerActiveBg }]}
                onPress={() => props.navigation.navigate(item.name)}
              >
                <Ionicons name={item.icon} size={20} color={active ? colors.accent : colors.muted} />
                <Text style={[styles.navLabel, { color: active ? colors.accent : colors.ink }]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      <View style={[styles.footer, { borderTopColor: colors.line }]}>
        <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "700" }}>{t("madeInUkraine")}</Text>
        <Text style={{ color: colors.footerMuted, fontSize: 11 }}>Expo SDK 54 · RN 0.81.5</Text>
        <Text style={{ color: colors.muted, fontSize: 12, fontWeight: "600", marginTop: 2 }}>
          {t("developerNick")}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logoWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  brandTitle: { fontSize: 17, fontWeight: "800", letterSpacing: -0.3 },
  brandSub: { fontSize: 11, marginTop: 2 },
  scroll: { flex: 1 },
  sectionPad: { paddingHorizontal: 10, paddingTop: 10 },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 2,
  },
  navLabel: { fontSize: 15, fontWeight: "500" },
  navLabelActive: { fontWeight: "700" },
  block: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  blockTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
  },
  chipGrow: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 42,
  },
  hint: { fontSize: 11, marginTop: 8, lineHeight: 15 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    gap: 2,
  },
});
