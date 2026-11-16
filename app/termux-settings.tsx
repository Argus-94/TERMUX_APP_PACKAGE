import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { AppState, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { useTermuxContext } from "../components/TermuxContext";
import { useDialog } from "../components/DialogContext";
import { useAppSettingsContext } from "../components/AppSettingsContext";
import { SystemPromptDialog } from "../components/SystemPromptDialog";
import { RECOMMENDED_TERMUX_SUPER_PROMPT, type PromptLang } from "../lib/ide-core-prompt";
import {
  getTermuxNative,
  isNativeModuleAvailable,
  checkTermuxReadiness,
  type TermuxReadiness,
} from "../lib/termux-bridge";
import { persistentLogger } from "../lib/persistent-logger";
import { errorMessage } from "../lib/error-utils";

interface AddonCardProps {
  number: number;
  icon: ComponentProps<typeof Ionicons>["name"];
  title: string;
  description: string;
  version: string | null;
  installed: boolean;
  installing: boolean;
  progress: number;
  actionLabel: string;
  installedLabel: string;
  cancelLabel: string;
  onInstall: () => void;
  onCancel?: () => void;
}

function AddonCard(props: AddonCardProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      <View style={styles.cardHeader}>
        <View style={[styles.number, { backgroundColor: colors.surfaceRaised }]}>
          <Text style={[styles.numberText, { color: colors.inkBright }]}>{props.number}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: colors.inkBright }]}>{props.title}</Text>
        </View>
        <View
          style={[
            styles.badge,
            { backgroundColor: props.installed ? "rgba(34,197,94,0.18)" : props.installing ? "rgba(251,191,36,0.18)" : colors.dangerDim },
          ]}
        >
          <Text
            style={{
              color: props.installed ? colors.success : props.installing ? colors.warning : colors.danger,
              fontWeight: "800",
              fontSize: 12,
            }}
          >
            {props.installed ? props.version || props.installedLabel : props.installing ? `${Math.round(props.progress * 100)}%` : "НЕТ"}
          </Text>
        </View>
      </View>

      <View style={styles.descriptionRow}>
        <Ionicons name={props.icon} size={22} color={colors.muted} />
        <Text style={[styles.description, { color: colors.muted }]}>{props.description}</Text>
      </View>

      {props.installing ? (
        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: colors.dangerDim, borderColor: colors.danger }]}
          onPress={() => props.onCancel?.()}
          activeOpacity={0.8}
        >
          <Ionicons name="close-circle-outline" size={20} color={colors.danger} />
          <Text style={[styles.primaryButtonText, { color: colors.danger }]}>{props.cancelLabel}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[
            styles.primaryButton,
            {
              backgroundColor: props.installed ? colors.accentDim : colors.accent,
              borderColor: colors.accent,
            },
          ]}
          onPress={props.onInstall}
          activeOpacity={0.8}
        >
          <Ionicons name={props.installed ? "checkmark-circle-outline" : "download-outline"} size={20} color={props.installed ? colors.accent : colors.background} />
          <Text style={[styles.primaryButtonText, { color: props.installed ? colors.accent : colors.background }]}>
            {props.installed ? props.installedLabel : props.actionLabel}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default function TermuxSettingsScreen() {
  const router = useRouter();
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const { enabled: termuxEnabled, checking: termuxChecking, setEnabled: setTermuxEnabled } = useTermuxContext();
  const { showDialog } = useDialog();
  const settings = useAppSettingsContext();
  const termuxAgentPrompt = String(settings?.termuxAgentPrompt ?? "");
  const setTermuxAgentPrompt =
    typeof settings?.setTermuxAgentPrompt === "function"
      ? settings.setTermuxAgentPrompt
      : (_: string) => {};
  const clearTermuxAgentPrompt =
    typeof settings?.clearTermuxAgentPrompt === "function"
      ? settings.clearTermuxAgentPrompt
      : () => {};
  const insets = useSafeAreaInsets();
  const [termuxPromptDialogVisible, setTermuxPromptDialogVisible] = useState(false);
  const [abis, setAbis] = useState<string[]>([]);
  const [shizuku, setShizuku] = useState({ installed: false, version: null as string | null });
  const [bridgeAvailable, setBridgeAvailable] = useState(() => isNativeModuleAvailable());
  const [readiness, setReadiness] = useState<TermuxReadiness | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const refresh = useCallback(async () => {
    setBridgeAvailable(isNativeModuleAvailable());
    const [arch, shizukuVersion, ready] = await Promise.all([
      getTermuxNative()?.getSupportedAbis().catch(() => []) ?? Promise.resolve([]),
      getTermuxNative()?.getPackageVersion("moe.shizuku.privileged.api").catch(() => null) ?? Promise.resolve(null),
      checkTermuxReadiness({ deep: true, refreshPermission: true }).catch(() => ({ ready: false, reasons: ["native_module_missing"] as TermuxReadiness["reasons"] })),
    ]);
    setAbis(arch);
    setShizuku({ installed: shizukuVersion !== null, version: shizukuVersion });
    setReadiness(ready);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const openShizuku = useCallback(async () => {
    try {
      const opened = await getTermuxNative()?.openPackage("moe.shizuku.privileged.api");
      if (!opened) showDialog(t("shizukuTitle"), language === "ru" ? "Shizuku — отдельная необязательная интеграция. Она не заменяет встроенную среду и не требует отдельного Termux. Установленное приложение Shizuku не найдено." : language === "uk" ? "Shizuku — окрема необов’язкова інтеграція, а не заміна вбудованого середовища. Встановлений застосунок Shizuku не знайдено." : "Shizuku is an independent optional integration, not a replacement for the embedded runtime. The Shizuku app was not found.");
    } catch (e: unknown) { showDialog(t("shizukuTitle"), errorMessage(e)); }
  }, [language, showDialog, t]);

  const reasonLabel = useCallback(
    (code: TermuxReadiness["reasons"][number]) => {
      switch (code) {
        case "not_android":
          return t("termuxReasonNotAndroid");
        case "native_module_missing":
          return t("termuxReasonNativeMissing");
        case "termux_not_installed":
        case "termux_install_check_failed":
        case "run_command_permission_missing":
        case "run_command_permission_check_failed":
        case "run_command_probe_failed":
          return language === "en" ? "Embedded runtime readiness check failed" : language === "uk" ? "Перевірка готовності вбудованого середовища не пройдена" : "Проверка готовности встроенной среды не пройдена";
        default:
          return t("termuxReasonUnknown");
      }
    },
    [language, t]
  );

  const recheckReadiness = useCallback(async () => {
    if (rechecking) return;
    setRechecking(true);
    try {
      await refresh();
      const r = await checkTermuxReadiness({ deep: true, refreshPermission: true });
      setReadiness(r);
      persistentLogger.markAppEvent("TERMUX_READINESS_RECHECK", { ready: r.ready, reasons: r.reasons });
      if (r.ready) {
        showDialog(t("termuxRecheckTitle"), t("termuxRecheckReady"), [{ text: "OK" }]);
      } else {
        const lines = r.reasons.map((x) => `• ${reasonLabel(x)}`).join("\n");
        showDialog(t("termuxRecheckTitle"), `${t("termuxRecheckNotReady")}\n\n${lines}${r.probeDetail ? `\n\n${r.probeDetail}` : ""}`, [{ text: "OK" }]);
      }
    } catch (e: unknown) {
      showDialog(t("termuxRecheckTitle"), errorMessage(e), [{ text: "OK" }]);
    } finally {
      setRechecking(false);
    }
  }, [rechecking, refresh, showDialog, t, reasonLabel]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
        <View style={[styles.intro, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}>
          <View style={[styles.introIcon, { backgroundColor: colors.accentDim }]}><Ionicons name="terminal-outline" size={25} color={colors.accent} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.introTitle, { color: colors.inkBright }]}>{language === "en" ? "Embedded runtime" : language === "uk" ? "Вбудоване середовище" : "Встроенная среда"}</Text>
            <Text style={[styles.introText, { color: colors.muted }]}>{language === "en" ? "Private runtime status and agent preferences. Commands stay within this app." : language === "uk" ? "Стан приватного середовища та налаштування агента. Команди залишаються в застосунку." : "Состояние приватной среды и настройки агента. Команды остаются внутри приложения."}</Text>
            <Text style={[styles.archText, { color: colors.accent }]}>{language === "en" ? "Embedded runtime architecture" : language === "uk" ? "Архітектура вбудованого середовища" : "Архитектура встроенной среды"}: {abis.length ? abis.join(", ") : "—"}</Text>
          </View>
        </View>


        {!bridgeAvailable ? (
          <View style={[styles.banner, { backgroundColor: colors.dangerDim, borderColor: colors.danger }]}>
            <Ionicons name="warning-outline" size={22} color={colors.danger} />
            <Text style={[styles.bannerText, { color: colors.inkBright }]}>{t("termuxBridgeMissingBanner")}</Text>
          </View>
        ) : null}

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.cardHeader}>
            <View style={[styles.number, { backgroundColor: readiness?.ready ? "rgba(34,197,94,0.18)" : colors.surfaceRaised }]}>
              <Ionicons
                name={
                  readiness == null
                    ? "hourglass-outline"
                    : readiness.ready
                    ? "checkmark-circle"
                    : "alert-circle-outline"
                }
                size={20}
                color={
                  readiness == null
                    ? colors.muted
                    : readiness.ready
                    ? colors.success
                    : colors.warning
                }
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, { color: colors.inkBright }]}>{t("termuxReadinessTitle")}</Text>
            </View>
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: readiness?.ready
                    ? "rgba(34,197,94,0.18)"
                    : bridgeAvailable
                    ? "rgba(251,191,36,0.18)"
                    : colors.dangerDim,
                },
              ]}
            >
              <Text
                style={{
                  color: readiness?.ready ? colors.success : bridgeAvailable ? colors.warning : colors.danger,
                  fontWeight: "800",
                  fontSize: 12,
                }}
              >
                {readiness?.ready ? "OK" : bridgeAvailable ? "…" : "N/A"}
              </Text>
            </View>
          </View>
          <View style={styles.descriptionRow}>
            <Ionicons name="pulse-outline" size={22} color={colors.muted} />
            <Text style={[styles.description, { color: colors.muted }]}>
              {bridgeAvailable
                ? readiness?.ready
                  ? (language === "en" ? "The embedded runtime check passed." : language === "uk" ? "Перевірку вбудованого середовища пройдено." : "Проверка встроенной среды пройдена.")
                  : (language === "en" ? "The embedded runtime is not ready. Review Runtime diagnostics; install/build support is not implied." : language === "uk" ? "Вбудоване середовище не готове. Перегляньте діагностику Runtime; підтримка встановлення/збирання не підтверджена." : "Встроенная среда не готова. Проверьте диагностику Runtime; поддержка установки/сборки не подтверждена.")
                : t("termuxBridgeMissingBanner")}
            </Text>
          </View>
          {bridgeAvailable && readiness && !readiness.ready && readiness.reasons.length > 0 ? (
            <Text style={[styles.description, { color: colors.warning, marginTop: 6 }]}>
              {readiness.reasons.map((x) => `• ${reasonLabel(x)}`).join("\n")}
              {readiness.probeDetail ? `\n(${readiness.probeDetail})` : ""}
            </Text>
          ) : null}

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.accentDim, borderColor: colors.accent, opacity: rechecking ? 0.7 : 1 }]}
            onPress={() => void recheckReadiness()}
            disabled={rechecking}
            activeOpacity={0.8}
          >
            <Ionicons name={rechecking ? "hourglass-outline" : "refresh-outline"} size={20} color={colors.accent} />
            <Text style={[styles.primaryButtonText, { color: colors.accent }]}>
              {rechecking ? t("termuxRechecking") : t("termuxRecheckButton")}
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: colors.accentDim, borderColor: colors.accent }]}
          onPress={() => router.push("/terminal")}
          activeOpacity={0.8}
        >
          <Ionicons name="terminal-outline" size={20} color={colors.accent} />
          <Text style={[styles.primaryButtonText, { color: colors.accent }]}>
            {language === "ru" ? "Открыть встроенный терминал" : language === "uk" ? "Відкрити вбудований термінал" : "Open embedded terminal"}
          </Text>
        </TouchableOpacity>
        {/* === Промпт агента Termux (пользовательский) === */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.cardHeader}>
            <View style={[styles.number, { backgroundColor: colors.surfaceRaised }]}>
              <Ionicons name="sparkles-outline" size={20} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, { color: colors.inkBright }]}>{t("termuxAgentPromptSection")}</Text>
            </View>
          </View>
          <View style={styles.descriptionRow}>
            <Ionicons name="document-text-outline" size={22} color={colors.muted} />
            <Text style={[styles.description, { color: colors.muted }]}>{t("termuxAgentPromptSectionDesc")}</Text>
          </View>
          <Text style={[styles.description, { color: colors.inkBright, marginTop: 8 }]}>
            {termuxAgentPrompt.trim()
              ? t("termuxAgentPromptSet", { count: termuxAgentPrompt.trim().length })
              : t("termuxAgentPromptNotSet")}
          </Text>
          <View style={styles.controlRow}>
            <TouchableOpacity
              style={[styles.controlButton, { backgroundColor: colors.accentDim, borderColor: colors.accent }]}
              onPress={() => setTermuxPromptDialogVisible(true)}
              activeOpacity={0.8}
            >
              <Ionicons name="create-outline" size={18} color={colors.accent} />
              <Text style={{ color: colors.accent, fontWeight: "800", fontSize: 13 }}>{t("termuxAgentPromptButton")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlButton, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}
              onPress={() => {
                const lang = (language === "en" || language === "ru" ? language : "uk") as PromptLang;
                setTermuxAgentPrompt(RECOMMENDED_TERMUX_SUPER_PROMPT[lang] || RECOMMENDED_TERMUX_SUPER_PROMPT.en);
              }}
              activeOpacity={0.8}
            >
              <Ionicons name="flash-outline" size={18} color={colors.inkBright} />
              <Text style={{ color: colors.inkBright, fontWeight: "800", fontSize: 12 }} numberOfLines={1}>
                {t("termuxAgentPromptInsertSuper")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={[styles.cardTitle, { color: colors.inkBright }]}>{language === "ru" ? "Встроенная приватная среда" : language === "uk" ? "Вбудоване приватне середовище" : "Embedded private runtime"}</Text>
          <Text style={[styles.description, { color: colors.muted, marginTop: 10 }]}>{language === "ru" ? "Отдельный Termux, внешние APK-дополнения и команды termux-setup-storage не используются. Проверяйте фактическое состояние встроенной среды на экране Runtime. Установка пакетов и сборка APK остаются недоступны, пока не готова проверенная приватная поставка." : language === "uk" ? "Окремий Termux, зовнішні APK-додатки й команди termux-setup-storage не використовуються. Перевіряйте фактичний стан вбудованого середовища на екрані Runtime. Встановлення пакетів і збирання APK недоступні, доки не готова перевірена приватна поставка." : "A separate Termux app, external add-on APKs, and termux-setup-storage commands are not used. Check the actual embedded runtime status on Runtime. Package installation and APK builds remain unavailable until the private distribution is qualified."}</Text>
        </View>
        {/* 7. Сессия Termux (On / Off) */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.cardHeader}>
            <View style={[styles.number, { backgroundColor: colors.surfaceRaised }]}>
              <Text style={[styles.numberText, { color: colors.inkBright }]}>7</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.cardTitle, { color: colors.inkBright }]}>{language === "en" ? "Embedded runtime session" : language === "uk" ? "Сеанс вбудованого середовища" : "Сеанс встроенной среды"}</Text>
            </View>
          </View>
          <View style={styles.descriptionRow}>
            <Ionicons name="flash-outline" size={22} color={colors.muted} />
            <Text style={[styles.description, { color: colors.muted }]}>{termuxEnabled ? (language === "en" ? "Embedded runtime enabled" : language === "uk" ? "Вбудоване середовище увімкнено" : "Встроенная среда включена") : (language === "en" ? "Embedded runtime disabled" : language === "uk" ? "Вбудоване середовище вимкнено" : "Встроенная среда выключена")}</Text>
          </View>
          <View style={styles.controlRow}>
            <TouchableOpacity
              style={[styles.controlButton, { backgroundColor: termuxEnabled ? colors.accentDim : colors.chipBg, borderColor: termuxEnabled ? colors.accent : colors.line }]}
              onPress={() => void setTermuxEnabled(true)}
              disabled={termuxChecking}
            >
              <Ionicons name="power-outline" size={18} color={termuxEnabled ? colors.accent : colors.muted} />
              <Text style={{ color: termuxEnabled ? colors.accent : colors.muted, fontWeight: "800" }}>{t("termuxOn")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlButton, { backgroundColor: !termuxEnabled ? colors.dangerDim : colors.chipBg, borderColor: !termuxEnabled ? colors.danger : colors.line }]}
              onPress={() => void setTermuxEnabled(false)}
              disabled={termuxChecking}
            >
              <Ionicons name="power-outline" size={18} color={!termuxEnabled ? colors.danger : colors.muted} />
              <Text style={{ color: !termuxEnabled ? colors.danger : colors.muted, fontWeight: "800" }}>{t("termuxOff")}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 9. Shizuku */}
        <AddonCard
          number={9}
          icon="apps-outline"
          title={t("shizukuTitle")}
          description={t("shizukuDescription")}
          version={shizuku.version}
          installed={shizuku.installed}
          installing={false}
          progress={0}
          actionLabel={language === "ru" ? "Открыть Shizuku" : language === "uk" ? "Відкрити Shizuku" : "Open Shizuku"}
          installedLabel={language === "ru" ? "Открыть Shizuku" : language === "uk" ? "Відкрити Shizuku" : "Open Shizuku"}
          cancelLabel={t("termuxDownloadCancel")}
          onInstall={() => void openShizuku()}
        />
      </ScrollView>

      <SystemPromptDialog
        visible={termuxPromptDialogVisible}
        value={termuxAgentPrompt}
        onSave={(next) => setTermuxAgentPrompt(next)}
        onClear={() => clearTermuxAgentPrompt()}
        onRequestClose={() => setTermuxPromptDialogVisible(false)}
        titleKey="termuxAgentPromptDialogTitle"
        descKey="termuxAgentPromptSectionDesc"
        placeholderKey="termuxAgentPromptPlaceholder"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  intro: { flexDirection: "row", gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, marginBottom: 12 },
  introIcon: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  introTitle: { fontSize: 17, fontWeight: "800", marginBottom: 3 },
  introText: { fontSize: 13, lineHeight: 19 },
  archText: { fontSize: 11, fontWeight: "700", marginTop: 7 },
  card: { borderRadius: 18, borderWidth: 1, padding: 14, marginBottom: 12 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 11 },
  number: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  numberText: { fontSize: 18, fontWeight: "800" },
  cardTitle: { fontSize: 17, fontWeight: "800" },
  badge: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 20, minWidth: 68, alignItems: "center" },
  descriptionRow: { flexDirection: "row", gap: 11, marginTop: 13, alignItems: "flex-start" },
  description: { flex: 1, fontSize: 14, lineHeight: 21 },
  primaryButton: { marginTop: 14, minHeight: 48, borderRadius: 14, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  primaryButtonText: { fontSize: 14, fontWeight: "800" },
  commandBox: { marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1 },
  commandText: { fontSize: 13, fontFamily: "monospace", lineHeight: 20 },
  banner: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, marginBottom: 12, alignItems: "flex-start" },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  versionPlain: { marginTop: 16, alignItems: "center", justifyContent: "center", width: "100%" },
  versionPlainText: { fontSize: 16, fontWeight: "800", paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22, overflow: "hidden", textAlign: "center", minWidth: 160 },
  controlRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  controlButton: { flex: 1, minHeight: 46, borderRadius: 13, borderWidth: 1, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 7 },
});
