import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, AppState, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { getPermissionsOnboarding } from "../lib/permissions-onboarding";
import { FIRST_RUN_PROMPT_VERSION, firstRunPromptDeferralStore } from "../lib/first-run-prompt";
import { PermissionExplainer } from "../core/enhancements/onboarding/PermissionExplainer";
import type { PermissionGrantStatus, PermissionId } from "../core/enhancements/onboarding/types";

const copy = (language: "ru" | "uk" | "en", ru: string, uk: string, en: string) => language === "ru" ? ru : language === "uk" ? uk : en;
const permissionCopy: Record<PermissionId, Record<"ru" | "uk" | "en", { title: string; short: string; detail: string }>> = {
  notifications: {
    ru: { title: "Уведомления", short: "Показывают ход длительных задач и runtime-предупреждения.", detail: "Нужны, чтобы следить за сборкой или длительной runtime-задачей. Необязательны; приложение работает и без них." },
    uk: { title: "Сповіщення", short: "Показують перебіг тривалих завдань і runtime-попередження.", detail: "Потрібні для відстеження збірки або тривалої runtime-задачі. Необов'язкові; застосунок працює і без них." },
    en: { title: "Notifications", short: "Show long-task progress and runtime alerts.", detail: "Useful for tracking a long build or runtime task. Optional; the app continues to work if denied." },
  },
  storage: {
    ru: { title: "Медиа и файлы", short: "Импорт и экспорт файлов проекта и артефактов.", detail: "Используется системный выбор файлов Android. Для этих сценариев приложение не запрашивает широкие READ_MEDIA или доступ ко всем файлам." },
    uk: { title: "Медіа й файли", short: "Імпорт та експорт файлів проєкту й артефактів.", detail: "Використовується системний вибір файлів Android. Для цих сценаріїв застосунок не запитує широкі READ_MEDIA або доступ до всіх файлів." },
    en: { title: "Media and files", short: "Import/export project files and saved artifacts.", detail: "Uses Android's scoped system document/photo picker. These workflows do not request broad READ_MEDIA or all-files access." },
  },
  accessibility: {
    ru: { title: "Служба Accessibility", short: "Опциональные действия управления устройством, которые вы включаете сами.", detail: "Нужна только для выбранных функций управления устройством. Android требует включить её вручную в системных настройках Accessibility. Прочитайте системное раскрытие; терминал и проекты от неё не зависят." },
    uk: { title: "Служба Accessibility", short: "Необов'язкові дії керування пристроєм, які ви вмикаєте самі.", detail: "Потрібна лише для вибраних функцій керування пристроєм. Android вимагає ввімкнути її вручну в системних налаштуваннях Accessibility. Прочитайте системне пояснення; термінал і проєкти від неї не залежать." },
    en: { title: "Accessibility service", short: "Optional device-control actions you explicitly enable.", detail: "Only needed for device-control features you choose. Android requires enabling it manually in system Accessibility settings. Review the disclosure; terminal and project features do not require it." },
  },
  "battery-optimization": {
    ru: { title: "Работа в фоне", short: "Может помочь длительным задачам продолжаться при свёрнутом приложении.", detail: "Некоторые оболочки Android останавливают длительную работу в фоне. Настройки батареи можно проверить вручную, если задача часто прерывается. Снятие ограничений необязательно и может увеличить расход батареи." },
    uk: { title: "Робота у фоні", short: "Може допомогти тривалим завданням працювати зі згорнутим застосунком.", detail: "Деякі оболонки Android зупиняють тривалу роботу у фоні. Налаштування батареї можна перевірити вручну, якщо завдання часто переривається. Зняття обмежень необов'язкове й може збільшити витрати батареї." },
    en: { title: "Background runtime", short: "May help long tasks continue while the app is backgrounded.", detail: "Some Android vendors stop long-running work in the background. Review battery settings manually if a task is repeatedly paused. Unrestricted use is optional and may increase battery consumption." },
  },
  "termux-run-command": {
    ru: { title: "Встроенный runtime", short: "Отдельный Termux не используется.", detail: "Старый пункт RUN_COMMAND больше не предлагается; команды выполняются только во встроенной приватной среде." },
    uk: { title: "Вбудований runtime", short: "Окремий Termux не використовується.", detail: "Старий пункт RUN_COMMAND більше не пропонується; команди виконуються лише у вбудованому приватному середовищі." },
    en: { title: "Embedded runtime", short: "A separate Termux app is not used.", detail: "Commands run only in the embedded private runtime; this app does not dispatch shell commands to another app." },
  },
  "install-packages": {
    ru: { title: "Установка собранных APK", short: "Нужно только если вы сами устанавливаете собранный APK из приложения.", detail: "Это специальный доступ для установки выбранных вами собранных APK; он не нужен для пакетов `pkg` и не требуется при первом запуске. Android: Настройки → Специальный доступ → Установка неизвестных приложений → AI Builder. Перед системной установкой приложение проверяет PackageManager.canRequestPackageInstalls(); открытие настроек не считается выдачей доступа." },
    uk: { title: "Встановлення зібраних APK", short: "Потрібне лише якщо ви самі встановлюєте зібраний APK із застосунку.", detail: "Це спеціальний доступ для встановлення вибраних вами зібраних APK; він не потрібен для пакетів `pkg` і не потрібний під час першого запуску. Android: Налаштування → Спеціальний доступ → Встановлення невідомих застосунків → AI Builder. Перед системним інсталятором застосунок перевіряє PackageManager.canRequestPackageInstalls(); відкриття налаштувань не вважається наданням доступу." },
    en: { title: "Install generated APKs", short: "Needed only if you choose to install a generated APK from this app.", detail: "This special access is for generated APKs you choose to install; it is unrelated to `pkg` packages and is not needed at first launch. Android: Settings → Special app access → Install unknown apps → AI Builder. Before opening the system installer, the app checks PackageManager.canRequestPackageInstalls(); opening Settings does not count as a grant." },
  },
};
const statusLabel = (language: "ru" | "uk" | "en", status: PermissionGrantStatus) => ({
  granted: copy(language, "Разрешено", "Дозволено", "Granted"),
  denied: copy(language, "Не разрешено", "Не дозволено", "Not granted"),
  "manual-required": copy(language, "Проверяется вручную", "Перевіряється вручну", "Manual setting"),
  unavailable: copy(language, "Недоступно в этой сборке", "Недоступно в цій збірці", "Unavailable in this build"),
  "not-applicable": copy(language, "Не требуется на этой платформе", "Не потрібне на цій платформі", "Not applicable on this platform"),
}[status]);

export default function PermissionsOnboardingScreen() {
  const router = useRouter();
  const { firstRunSetup } = useLocalSearchParams<{ firstRunSetup?: string }>();
  const cameFromFirstRun = firstRunSetup === "1";
  const insets = useSafeAreaInsets();
  const { language } = useLanguage();
  const { colors } = useTheme();
  const [state, setState] = useState<Awaited<ReturnType<ReturnType<typeof getPermissionsOnboarding>["refresh"]>> | null>(null);
  const [expanded, setExpanded] = useState<PermissionId | null>(null);
  const [busy, setBusy] = useState<PermissionId | "refresh" | "later" | null>("refresh");
  const [message, setMessage] = useState("");
  const descriptions = new PermissionExplainer().list();
  const refresh = useCallback(async () => {
    setBusy("refresh");
    try { setState(await getPermissionsOnboarding().refresh()); setMessage(""); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  useEffect(() => {
    let leftForSettings = false;
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") leftForSettings = true;
      else if (leftForSettings) {
        leftForSettings = false;
        void refresh();
      }
    });
    return () => sub.remove();
  }, [refresh]);

  const checkAgain = async () => { await refresh(); setMessage(copy(language, "Статус обновлён.", "Статус оновлено.", "Status refreshed.")); };
  const grantOrOpen = async (id: PermissionId) => {
    setBusy(id); setMessage("");
    try {
      let status: PermissionGrantStatus | undefined;
      let opened = false;
      if (id === "notifications") {
        const approved = await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
          Alert.alert(
            copy(language, "Зачем нужны уведомления", "Навіщо потрібні сповіщення", "Why notifications are requested"),
            permissionCopy.notifications[language].detail,
            [
              { text: copy(language, "Не сейчас", "Не зараз", "Not now"), style: "cancel", onPress: () => finish(false) },
              { text: copy(language, "Продолжить", "Продовжити", "Continue"), onPress: () => finish(true) },
            ],
            { cancelable: true, onDismiss: () => finish(false) },
          );
        });
        if (!approved) { setMessage(copy(language, "Запрос разрешения не отправлялся.", "Запит дозволу не надсилався.", "No permission request was sent.")); return; }
        status = await getPermissionsOnboarding().request(id);
      } else {
        opened = await getPermissionsOnboarding().openSettings(id);
      }
      if (status) setMessage(`${statusLabel(language, status)}. ${copy(language, "Статус проверен после действия.", "Статус перевірено після дії.", "Status checked after the action.")}`);
      else setMessage(opened
        ? copy(language, "Открыты системные настройки, если они доступны. Сам факт открытия не означает выдачу доступа; вернитесь сюда для проверки.", "Системні налаштування відкрито, якщо доступні. Сам факт відкриття не означає надання доступу; поверніться сюди для перевірки.", "System settings opened if available. Opening them does not mean access was granted; return here to verify.")
        : copy(language, "Не удалось открыть системные настройки автоматически. Следуйте инструкции в карточке; доступ не выдан и функция остаётся заблокированной.", "Не вдалося автоматично відкрити системні налаштування. Дотримуйтеся інструкції в картці; доступ не надано, функція залишається заблокованою.", "Could not open system settings automatically. Follow the card's instructions; access was not granted and the feature remains blocked."));
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); await refresh(); }
    finally { setBusy(null); }
  };
  const later = async () => {
    setBusy("later");
    try {
      await getPermissionsOnboarding().later();
      if (cameFromFirstRun) {
        await firstRunPromptDeferralStore.defer(FIRST_RUN_PROMPT_VERSION);
        router.replace({ pathname: "/runtime", params: { firstRunSetup: "1" } });
      } else router.back();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setBusy(null); }
  };

  return <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8, backgroundColor: colors.background }}>
    <View style={{ paddingHorizontal: 14, paddingBottom: 10, flexDirection: "row", alignItems: "center", gap: 10 }}>
      <TouchableOpacity accessibilityRole="button" onPress={() => router.back()} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 8 }}><Ionicons name="arrow-back" size={18} color={colors.accent} /></TouchableOpacity>
      <View style={{ flex: 1 }}><Text style={{ color: colors.inkBright, fontWeight: "800", fontSize: 18 }}>{copy(language, "Разрешения и доступ", "Дозволи й доступ", "Permissions & access")}</Text><Text style={{ color: colors.muted, fontSize: 11 }}>{copy(language, "Необязательный обзор. Ничего не запрашивается автоматически.", "Необов'язковий огляд. Нічого не запитується автоматично.", "Optional review. Nothing is requested automatically.")}</Text></View>
      {busy === "refresh" ? <ActivityIndicator color={colors.accent} /> : null}
    </View>
    <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 20, gap: 9 }}>
      <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, backgroundColor: colors.surface, gap: 7 }}>
        <Text style={{ color: colors.inkBright, fontSize: 13, fontWeight: "700" }}>{copy(language, "Вы выбираете, что включать", "Ви обираєте, що вмикати", "You choose what to enable")}</Text>
        <Text style={{ color: colors.muted, fontSize: 11, lineHeight: 16 }}>{copy(language, "Терминал, проекты и runtime работают без Accessibility и без снятия ограничений батареи. Для каждой возможности указаны назначение и риск. Системные экраны открываются только после нажатия.", "Термінал, проєкти й runtime працюють без Accessibility та без зняття обмежень батареї. Для кожної можливості вказано призначення й ризик.", "Terminal, projects, and runtime work without Accessibility or unrestricted battery use. Each optional permission lists its purpose and risk. System settings open only after you tap.")}</Text>
        <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "700" }}>{state ? `${state.granted} / ${state.total} ${copy(language, "доступов доступно", "доступів надано", "granted or not applicable")}` : "—"}</Text>
        {state?.revoked.length ? <Text style={{ color: colors.warning, fontSize: 11 }}>{copy(language, "Некоторые разрешения, ранее выданные приложению, теперь недоступны:", "Деякі дозволи, раніше надані застосунку, тепер недоступні:", "Some permissions previously granted to the app are now unavailable:")} {state.revoked.join(", ")}</Text> : null}
      </View>
      {descriptions.map((item) => {
        const status = state?.statuses[item.id] ?? "unavailable";
        const translated = permissionCopy[item.id][language];
        const open = expanded === item.id;
        const needsGrant = item.id === "notifications";
        return <View key={item.id} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, backgroundColor: colors.surface, gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
            <Ionicons name={status === "granted" ? "checkmark-circle" : item.id === "accessibility" ? "accessibility-outline" : item.id === "battery-optimization" ? "battery-half-outline" : "shield-checkmark-outline"} size={19} color={status === "granted" ? "#22C55E" : colors.accent} />
            <View style={{ flex: 1 }}><Text style={{ color: colors.inkBright, fontSize: 13, fontWeight: "700" }}>{translated.title}</Text><Text style={{ color: colors.muted, fontSize: 10 }}>{statusLabel(language, status)} · {copy(language, item.riskLevel === "low" ? "низкий риск" : "средний риск", item.riskLevel === "low" ? "низький ризик" : "середній ризик", `${item.riskLevel} risk`)} · {item.isRequired ? copy(language, "обязательно", "обов'язково", "required") : copy(language, "необязательно", "необов'язково", "optional")}</Text></View>
            <TouchableOpacity onPress={() => setExpanded(open ? null : item.id)} accessibilityRole="button" accessibilityState={{ expanded: open }}><Ionicons name={open ? "chevron-up" : "information-circle-outline"} size={20} color={colors.muted} /></TouchableOpacity>
          </View>
          <Text style={{ color: colors.muted, fontSize: 11, lineHeight: 15 }}>{translated.short}</Text>
          {open ? <Text style={{ color: colors.inkBright, fontSize: 11, lineHeight: 16 }}>{translated.detail}</Text> : null}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {status !== "granted" && status !== "not-applicable" && status !== "unavailable" ? <TouchableOpacity disabled={busy !== null} onPress={() => void grantOrOpen(item.id)} style={{ borderRadius: 9, backgroundColor: colors.accent, paddingHorizontal: 11, paddingVertical: 8, opacity: busy ? 0.6 : 1 }}><Text style={{ color: colors.background, fontWeight: "700", fontSize: 11 }}>{needsGrant ? copy(language, "Разрешить", "Дозволити", "Allow") : copy(language, "Открыть настройки", "Відкрити налаштування", "Open settings")}</Text></TouchableOpacity> : null}
            {status === "unavailable" ? <TouchableOpacity disabled={busy !== null} onPress={() => void grantOrOpen(item.id)} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 8 }}><Text style={{ color: colors.inkBright, fontSize: 11 }}>{copy(language, "Проверить / открыть", "Перевірити / відкрити", "Check / open settings")}</Text></TouchableOpacity> : null}
            {status === "denied" || status === "manual-required" ? <TouchableOpacity disabled={busy !== null} onPress={() => void checkAgain()} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 8 }}><Text style={{ color: colors.inkBright, fontSize: 11 }}>{copy(language, "Проверить статус", "Перевірити статус", "Check status")}</Text></TouchableOpacity> : null}
          </View>
        </View>;
      })}
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
        <TouchableOpacity disabled={busy !== null} onPress={() => void checkAgain()} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 }}><Text style={{ color: colors.inkBright, fontSize: 12 }}>{copy(language, "Обновить статус", "Оновити статус", "Refresh status")}</Text></TouchableOpacity>
        <TouchableOpacity disabled={busy !== null} onPress={() => void later()} style={{ borderRadius: 10, backgroundColor: colors.accentDim, paddingHorizontal: 14, paddingVertical: 10, opacity: busy ? 0.6 : 1 }}><Text style={{ color: colors.inkBright, fontSize: 12, fontWeight: "700" }}>{cameFromFirstRun ? copy(language, "Продолжить без необязательных прав", "Продовжити без необов'язкових дозволів", "Continue without optional access") : copy(language, "Позже", "Пізніше", "Later")}</Text></TouchableOpacity>
      </View>
      {message ? <Text selectable style={{ color: colors.muted, fontSize: 11 }}>{message}</Text> : null}
    </ScrollView>
  </View>;
}
