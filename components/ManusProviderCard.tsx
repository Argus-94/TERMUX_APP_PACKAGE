import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { validateManusAccount, type ManusProfile } from "../lib/manus-api";
import type { useManusSettings } from "../hooks/useManusSettings";
import type { ModelMode } from "../lib/model-mode";
import type { AppColors } from "../theme/colors";
import { useManusCredits } from "../hooks/useManusCredits";
import { ManusCreditsPanel } from "./ManusCreditsPanel";
import { Checkbox } from "./Checkbox";

const COPY = {
  ru: {
    title: "Manus API v2", description: "Отдельный облачный агент задач — не Chat Completions и не локальная модель Termux. Для локальных сборок и ремонта выберите другой провайдер. Пока поддерживаются текстовые задачи, без загрузки вложений.",
    warning: "API-ключ даёт полный доступ к аккаунту. Создайте собственный ключ в настройках API сервиса. Запуск задач может расходовать ваш API-баланс. Ключ хранится в защищённом хранилище устройства, не в исходниках и не в резервной копии настроек.",
    lifecycle: "Каждый чат использует отдельную облачную задачу. Следующие сообщения продолжают её; история других моделей не переносится. После остановки ожидания следующее сообщение только проверяет текущую задачу, не отправляя новый текст. Очистка чата начинает новую задачу, но не удаляет облачную.",
    placeholder: "Ваш API-ключ", save: "Сохранить ключ", check: "Проверить аккаунт", remove: "Удалить ключ", active: "Использовать этот облачный режим", none: "Ключ не сохранён — аккаунт не подключён", saved: "Ключ сохранён, аккаунт не проверен", verified: "Сохранённый ключ: аккаунт проверен", draftVerified: "Введённый ключ проверен, но ещё не сохранён", failed: "Не удалось проверить аккаунт. Проверьте ключ и сеть.", saveFailed: "Не удалось сохранить изменения. Провайдер не включён.", loading: "Защищённые настройки ещё не загружены; режим недоступен", profile: "Профиль / уровень thinking", profileHint: "Профиль — не выбор версии модели. Уровни max-* задают thinking; фактическая доступность зависит от аккаунта. Температура и лимиты OpenRouter здесь не применяются.", draft: "Есть несохранённый ключ", removed: "Ключ удалён с устройства; облачные задачи не удалены", busy: "Выполняется проверка или сохранение",
  },
  uk: {
    title: "Manus API v2", description: "Окремий хмарний агент завдань — не Chat Completions і не локальна модель Termux. Для локального збирання й ремонту виберіть іншого провайдера. Поки підтримуються текстові завдання без завантаження вкладень.",
    warning: "API-ключ дає повний доступ до акаунта. Створіть власний ключ у налаштуваннях API сервісу. Запуск завдань може витрачати ваш API-баланс. Ключ зберігається в захищеному сховищі пристрою, не у вихідному коді чи резервній копії налаштувань.",
    lifecycle: "Кожен чат має окреме хмарне завдання. Наступні повідомлення продовжують його; історія інших моделей не переноситься. Після зупинки очікування наступне повідомлення лише перевіряє завдання, не надсилаючи новий текст. Очищення чату починає нове завдання, але не видаляє хмарне.",
    placeholder: "Ваш API-ключ", save: "Зберегти ключ", check: "Перевірити акаунт", remove: "Видалити ключ", active: "Використовувати цей хмарний режим", none: "Ключ не збережено — акаунт не підключений", saved: "Ключ збережено, акаунт не перевірено", verified: "Збережений ключ: акаунт перевірено", draftVerified: "Введений ключ перевірено, але ще не збережено", failed: "Не вдалося перевірити акаунт. Перевірте ключ і мережу.", saveFailed: "Не вдалося зберегти зміни. Провайдера не ввімкнено.", loading: "Захищені налаштування ще не завантажені; режим недоступний", profile: "Профіль / рівень thinking", profileHint: "Профіль — не версія моделі. Рівні max-* задають thinking; доступність залежить від акаунта. Температура й ліміти OpenRouter тут не застосовуються.", draft: "Є незбережений ключ", removed: "Ключ видалено з пристрою; хмарні завдання не видалено", busy: "Виконується перевірка чи збереження",
  },
  en: {
    title: "Manus API v2", description: "A separate cloud task agent, not Chat Completions or a local Termux model. Select another provider for local builds and repairs. Currently supports text tasks, without attachment uploads.",
    warning: "An API key grants full account access. Create your own key in the service's API settings. Running tasks may spend your API balance. The key is kept in device secure storage, not source code or settings backups.",
    lifecycle: "Each chat has a separate cloud task. Later messages continue it; other models' history is not transferred. After stopping local waiting, the next message only checks the pending task, without sending new text. Clearing the chat starts a new task but does not delete the remote one.",
    placeholder: "Your API key", save: "Save key", check: "Check account", remove: "Remove key", active: "Use this cloud mode", none: "No key saved — no account connected", saved: "Key saved, account not checked", verified: "Saved key: account verified", draftVerified: "Typed key verified but not saved yet", failed: "Account check failed. Check the key and network.", saveFailed: "Could not save changes. Provider was not enabled.", loading: "Secure settings have not loaded; mode is unavailable", profile: "Profile / thinking level", profileHint: "Profiles do not select a model version. max-* selects thinking level; availability depends on your account. OpenRouter temperature and token settings do not apply.", draft: "Unsaved key entered", removed: "Key removed from this device; cloud tasks were not deleted", busy: "Checking or saving",
  },
};
const PROFILES: ManusProfile[] = ["standard", "lite", "max", "max-medium", "max-high", "max-extra", "max-ultra"];

const MODE_COPY = {
  ru: { enabled: "Облачный режим выбран для чата", inactive: "Облачный режим не выбран", missingKey: "Для включения сначала сохраните API-ключ" },
  uk: { enabled: "Хмарний режим вибрано для чату", inactive: "Хмарний режим не вибрано", missingKey: "Для ввімкнення спочатку збережіть API-ключ" },
  en: { enabled: "Cloud mode selected for chat", inactive: "Cloud mode is not selected", missingKey: "Save an API key first to enable this mode" },
};

type Props = { settings: ReturnType<typeof useManusSettings>; mode: ModelMode; setMode: (mode: ModelMode) => void; language: "ru" | "uk" | "en"; colors: AppColors };
export function ManusProviderCard({ settings, mode, setMode, language, colors }: Props) {
  const { manus, saveManusKey, setManusProfile, removeManusKey } = settings;
  const words = COPY[language];
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const [verifiedBinding, setVerifiedBinding] = useState("");
  const balanceEnabled = manus.loaded && manus.hasApiKey && !draft.trim() && verifiedBinding === manus.binding && !!verifiedBinding;
  const balance = useManusCredits(balanceEnabled, manus.binding, language);
  const invalidate = useCallback(() => { revision.current++; request.current?.abort(); request.current = null; setChecking(false); setStatus(""); setVerifiedBinding(""); }, []);
  useEffect(() => { invalidate(); }, [manus.binding, manus.hasApiKey, language, invalidate]);
  useFocusEffect(useCallback(() => () => { invalidate(); setDraft(""); }, [invalidate]));

  const check = async () => {
    const candidate = draft.trim();
    if ((!candidate && !manus.hasApiKey) || !manus.loaded) return;
    invalidate();
    const id = revision.current;
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setChecking(true);
    try {
      await validateManusAccount(candidate || undefined, controller.signal);
      if (id === revision.current && !controller.signal.aborted) {
        setStatus(candidate ? words.draftVerified : words.verified);
        if (!candidate && manus.hasApiKey) setVerifiedBinding(manus.binding);
      }
    } catch { if (id === revision.current) setStatus(words.failed); }
    finally { clearTimeout(timeout); if (id === revision.current) { request.current = null; setChecking(false); } }
  };
  const save = async () => {
    const candidate = draft.trim(); if (!candidate) return;
    invalidate(); setBusy(true);
    try { if (await saveManusKey(candidate)) { setDraft(""); setStatus(words.saved); } else setStatus(words.saveFailed); }
    catch { setStatus(words.saveFailed); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    invalidate(); setBusy(true);
    try { const ok = await removeManusKey(); setDraft(""); setStatus(ok ? words.removed : words.saveFailed); }
    catch { setStatus(words.saveFailed); }
    finally { setBusy(false); }
  };
  const disabled = !manus.loaded || busy || checking;
  const modeDisabled = disabled || !manus.hasApiKey;
  const modeWords = MODE_COPY[language];
  const modeStatus = !manus.loaded ? words.loading : busy || checking ? words.busy : !manus.hasApiKey ? modeWords.missingKey : mode === "manus" ? modeWords.enabled : modeWords.inactive;
  const button = (label: string, action: () => Promise<void>, extraDisabled = false) => (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={disabled || extraDisabled} onPress={() => void action()} style={[styles.button, { backgroundColor: colors.accentDim, opacity: disabled || extraDisabled ? 0.5 : 1 }]}>
      <Text style={{ color: colors.accent, fontWeight: "600" }}>{label}</Text>
    </TouchableOpacity>
  );
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
    <Checkbox checked={mode === "manus"} disabled={modeDisabled} label={words.active} accessibilityHint={modeStatus} onPress={() => {
      // Selection only changes the active provider; it never starts a paid task.
      if (modeDisabled) return;
      setMode(mode === "manus" ? "local" : "manus");
    }} />
    <Text accessibilityLiveRegion="polite" style={[styles.body, { color: mode === "manus" ? colors.accent : colors.muted }]}>{modeStatus}</Text>
    <Text style={[styles.title, { color: colors.inkBright }]}>{words.title}</Text>
    <Text style={[styles.body, { color: colors.muted }]}>{words.description}</Text>
    <Text style={[styles.body, { color: colors.warning }]}>{words.warning}</Text>
    <Text style={[styles.body, { color: colors.muted }]}>{words.profile}</Text>
    <View style={styles.row}>{PROFILES.map(profile => <TouchableOpacity key={profile} accessibilityRole="button" accessibilityState={{ selected: manus.profile === profile, disabled }} disabled={disabled} onPress={() => {
      setBusy(true); void setManusProfile(profile).then(ok => { if (!ok) setStatus(words.saveFailed); }).finally(() => setBusy(false));
    }} style={[styles.button, { backgroundColor: manus.profile === profile ? colors.accentDim : colors.surfaceRaised, borderWidth: 1, borderColor: manus.profile === profile ? colors.accent : colors.line }]}>
      <Text style={{ color: colors.inkBright }}>{profile}</Text>
    </TouchableOpacity>)}</View>
    <Text style={[styles.body, { color: colors.muted }]}>{words.profileHint}</Text>
    <TextInput accessibilityLabel={words.placeholder} editable={!busy} value={draft} onChangeText={value => { invalidate(); setDraft(value); }} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" importantForAutofill="no" maxLength={8192} placeholder={words.placeholder} placeholderTextColor={colors.muted} style={[styles.input, { color: colors.inkBright, backgroundColor: colors.surfaceRaised, borderColor: colors.line }]} />
    <View style={styles.row}>{button(words.save, save, !draft.trim())}{button(words.check, check, !draft.trim() && !manus.hasApiKey)}{button(words.remove, remove, !manus.hasApiKey)}</View>
    {busy || checking ? <ActivityIndicator accessibilityLabel={words.busy} style={{ marginTop: 8 }} color={colors.accent} /> : null}
    <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.muted }]}>{status || (!manus.loaded ? words.loading : draft.trim() ? words.draft : manus.hasApiKey ? words.saved : words.none)}</Text>
    {balanceEnabled ? <ManusCreditsPanel credits={balance.credits} updatedAt={balance.updatedAt} loading={balance.loading} error={balance.error} onRefresh={() => void balance.refresh()} language={language} colors={colors} /> : null}

    <Text style={[styles.body, { color: colors.muted }]}>{words.lifecycle}</Text>
  </View>;
}
const styles = StyleSheet.create({
  card: { marginTop: 12, padding: 14, borderRadius: 16, borderWidth: 1 },
  title: { fontSize: 17, fontWeight: "700" }, body: { marginTop: 8, fontSize: 12, lineHeight: 18 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 10 },
  button: { paddingVertical: 9, paddingHorizontal: 10, borderRadius: 10 },
  modeRow: { marginTop: 10, paddingVertical: 6, paddingHorizontal: 10, minHeight: 52, borderRadius: 10, borderWidth: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  input: { marginTop: 12, padding: 11, borderRadius: 10, borderWidth: 1 },
});
