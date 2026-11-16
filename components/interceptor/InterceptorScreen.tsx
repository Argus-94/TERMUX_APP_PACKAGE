import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { ActivityIndicator, Animated, FlatList, KeyboardAvoidingView, Modal, Platform, ScrollView, Share, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../LanguageContext";
import { useTheme } from "../ThemeContext";
import { useDialog } from "../DialogContext";
import { getRuntimeFacade } from "../../lib/runtime-facade";
import { copyAsCurl, copyAsFetch, copyAsHttpie, createPreset, createRuleId, exportSession, INTERCEPTOR_PRESETS } from "../../core/enhancements/interceptor";
import type { CapturedExchange, InterceptorEngineSnapshot, InterceptorRule, InterceptorSettings, ReplayRequest, SavedInterceptorSession } from "../../core/enhancements/interceptor";
import { getInterceptorIndicatorState, isInterceptorListenerLive } from "../../lib/chat-indicator-layout";

const ONBOARDING_KEY = "aib.interceptor.onboarding.v1";
type Tab = "traffic" | "rules" | "settings";
type Filter = "all" | "modified" | "blocked" | "images" | "api";
const RU = {
  removeCertificate: "Удалить сертификат", saveSession: "Сохранить сессию", sessions: "История сессий", load: "Загрузить", noSessions: "Сохранённых сессий нет.", ruleFired: "Правил сработало", domainStats: "Популярные домены",
  exportCa: "Экспортировать публичный CA", caExported: "Публичный CA экспортирован.", certificateStoreHelp: "CA signing key хранится зашифрованным в приложении. Системный CA автоматически не устанавливается; экспортируется только публичный сертификат.", mitmMode: "Расшифровывать HTTPS (MITM)", mitmHelp: "Отдельный opt-in режим: нужен экспортированный и вручную установленный CA. Pinning и TLS-проверки не обходятся.", mitmRestartRequired: "Настройка сохранена. Listener остановлен; включите его вручную снова, чтобы применить режим.", proxyAuthHelp: "Для ручной настройки клиенту нужны этот loopback endpoint и временные proxy credentials. Токен истекает при остановке listener.", copyProxy: "Копировать настройки proxy",
  title: "Перехват трафика", beginner: "Простой", advanced: "Продвинутый", traffic: "Трафик", rules: "Правила", settings: "Настройки",
  off: "Перехват выключен", on: "Перехват включён", start: "Включить перехват", stop: "Выключить", starting: "Запуск listener…", stopping: "Остановка listener…", unsupported: "Запуск proxy недоступен",
  unsupportedBody: "Нативный listener недоступен в этой сборке. Порт не слушает; проверьте, что установлена собранная Android-версия приложения.",
  consent: "Перехват может показывать содержимое запросов и ответов. Используйте его только для своих приложений и устройств. Продолжить?", confirm: "Понимаю, включить", cancel: "Отмена",
  status: "Состояние", port: "Порт", noCertificate: "CA-сертификат не настроен", certificate: "Сертификат CA", certificateHelp: "Как установить сертификат", check: "Проверить установку", generate: "Создать сертификат", noCertAdapter: "Защищённый модуль сертификата недоступен; ничего не создано и не установлено.",
  all: "Все", modified: "Изменённые", blocked: "Заблокированные", images: "Изображения", api: "API", search: "Поиск URL, метода, тела…", empty: "Пока нет перехваченных запросов", trafficHint: "Список пополняется только после запуска реального listener. Сейчас данные не подделываются.",
  newRule: "Создать правило", presets: "Готовые правила", create: "Добавить", save: "Сохранить", enabled: "Включено", noRules: "Правил пока нет", priority: "Приоритет", urlContains: "URL содержит", action: "Действие", block: "Заблокировать", mock: "Подменить ответ", delay: "Задержка", modify: "Изменить JSON", advancedJson: "JSON conditions/actions", invalid: "Не удалось сохранить. Проверьте поля и JSON.",
  beginnerMode: "Простой режим", advancedMode: "Продвинутый режим", maxRecords: "Лимит запросов в памяти", autoClear: "Очищать старые записи при нехватке памяти", importRules: "Импорт правил из JSON", exportRules: "Скопировать правила JSON", reset: "Сбросить interceptor", memoryOnly: "По умолчанию запросы только в памяти; вручную сохранённые сессии редактируются от секретов и лежат в HOME приложения.",
  onboardingTitle: "Знакомство с перехватом", next: "Далее", skip: "Пропустить", done: "Готово", gotIt: "Понятно", replay: "Повторить запрос", copyCurl: "Копировать cURL", copyFetch: "Копировать Fetch", copyHttpie: "Копировать HTTPie", createFrom: "Создать правило", exportHar: "Экспорт HAR", exportJson: "Экспорт JSON", details: "Детали запроса", overview: "Обзор", request: "Запрос", response: "Ответ", timeline: "Время", headers: "Заголовки", body: "Тело", method: "Метод", statusCode: "Статус", duration: "Длительность", copied: "Скопировано в буфер обмена", exportFailed: "Не удалось создать файл экспорта.", sessionSaved: "Сессия сохранена", clear: "Очистить трафик", ruleAdded: "Правило добавлено", ruleDeleted: "Правило удалено", rulesImportHint: "Вставьте массив правил или объект с полем rules. Импорт проверяется и ограничен безопасными типами.",
  noConnection: "Listener не запущен", security: "Безопасность", securityBody: "Listener привязан только к 127.0.0.1 и требует временную proxy-аутентификацию. HTTPS остаётся туннелем, пока отдельно не включён MITM и клиент не доверяет вручную установленному CA. Certificate pinning не обходится.", onboarding1: "Прокси — это локальный посредник для просмотра и тестирования запросов ваших приложений.", onboarding2: "HTTPS зашифрован. Для расшифровки нужен отдельный MITM opt-in и CA, вручную установленный пользователем. Некоторые приложения не доверяют пользовательским CA.", onboarding3: "Добавьте готовое правило одним нажатием. Оно применяется только при работающем локальном listener.", onboarding4: "Перехват выключен по умолчанию. Включайте только для собственного трафика и только если понимаете последствия.",
};
const EN: Record<keyof typeof RU, string> = {
  removeCertificate: "Remove certificate", saveSession: "Save session", sessions: "Session history", load: "Load", noSessions: "No saved sessions.", ruleFired: "Rules fired", domainStats: "Top domains",
  exportCa: "Export public CA", caExported: "Public CA exported.", certificateStoreHelp: "The CA signing key is encrypted in app storage. A system CA is never installed automatically; only the public certificate can be exported.", mitmMode: "Decrypt HTTPS (MITM)", mitmHelp: "Separate opt-in mode: export and install the CA manually first. Pinning and TLS validation are never bypassed.", mitmRestartRequired: "Setting saved. The listener stopped; start it manually again to apply the mode.", proxyAuthHelp: "Configure a client with this loopback endpoint and temporary proxy credentials. The token expires when the listener stops.", copyProxy: "Copy proxy settings",
  title: "Traffic interceptor", beginner: "Beginner", advanced: "Advanced", traffic: "Traffic", rules: "Rules", settings: "Settings", off: "Interception is off", on: "Interception is on", start: "Enable interception", stop: "Turn off", starting: "Starting listener…", stopping: "Stopping listener…", unsupported: "Proxy startup unavailable",
  unsupportedBody: "The Android native listener is unavailable in this build. No port is listening; verify that the installed app is the compiled Android build.", consent: "Interception can expose request and response contents. Use it only with your own apps and devices. Continue?", confirm: "I understand, enable", cancel: "Cancel", status: "Status", port: "Port", noCertificate: "CA certificate is not configured", certificate: "CA certificate", certificateHelp: "How to install a certificate", check: "Check installation", generate: "Create certificate", noCertAdapter: "The protected certificate module is unavailable; nothing was created or installed.", all: "All", modified: "Modified", blocked: "Blocked", images: "Images", api: "API", search: "Search URL, method, body…", empty: "No captured requests yet", trafficHint: "The list only fills after a real listener starts. Traffic is not simulated.", newRule: "Create rule", presets: "Ready-made rules", create: "Add", save: "Save", enabled: "Enabled", noRules: "No rules yet", priority: "Priority", urlContains: "URL contains", action: "Action", block: "Block", mock: "Mock response", delay: "Delay", modify: "Modify JSON", advancedJson: "JSON conditions/actions", invalid: "Could not save. Check fields and JSON.", beginnerMode: "Beginner mode", advancedMode: "Advanced mode", maxRecords: "In-memory request limit", autoClear: "Auto-clear old records", importRules: "Import rules from JSON", exportRules: "Copy rules as JSON", reset: "Reset interceptor", memoryOnly: "Requests stay in memory only and do not survive restart. Secret headers and query parameters are hidden.", onboardingTitle: "Interceptor basics", next: "Next", skip: "Skip", done: "Done", gotIt: "Got it", replay: "Replay request", copyCurl: "Copy cURL", copyFetch: "Copy Fetch", copyHttpie: "Copy HTTPie", createFrom: "Create rule", exportHar: "Export HAR", exportJson: "Export JSON", details: "Request details", overview: "Overview", request: "Request", response: "Response", timeline: "Timing", headers: "Headers", body: "Body", method: "Method", statusCode: "Status", duration: "Duration", copied: "Copied to clipboard", exportFailed: "Could not create export file.", sessionSaved: "Session saved", clear: "Clear traffic", ruleAdded: "Rule added", ruleDeleted: "Rule deleted", rulesImportHint: "Paste a rule array or an object with a rules field. Imports are validated and limited to safe action types.", noConnection: "Listener is not running", security: "Security", securityBody: "The listener binds only to 127.0.0.1 and requires temporary proxy authentication. HTTPS stays tunneled unless MITM is separately enabled and the client trusts the manually installed CA. Certificate pinning is never bypassed.", onboarding1: "A proxy is a local intermediary for viewing and testing requests from your own apps.", onboarding2: "HTTPS decryption requires separate MITM opt-in and a CA you install manually. Some apps do not trust user-installed CAs.", onboarding3: "Add a ready-made rule with one tap. It applies only while the local listener is running.", onboarding4: "Interception is off by default. Use it only for your own traffic and only if you understand the consequences.",
};
const copyFor = (language: string) => language === "en" ? EN : RU;

export default function InterceptorScreen() {
  const { language } = useLanguage(); const { colors } = useTheme(); const insets = useSafeAreaInsets(); const { showDialog } = useDialog();
  const rawText = copyFor(language); const text = language === "en" ? { ...rawText, autoClear: "Clear older requests when memory is low", memoryOnly: "Requests stay in memory by default. Sessions you explicitly save are redacted and stored in the app HOME." } : { ...rawText, memoryOnly: "По умолчанию запросы только в памяти; вручную сохранённые сессии очищаются от секретов и хранятся в HOME приложения." }; const runtime = useMemo(() => getRuntimeFacade(), []);
  const [snapshot, setSnapshot] = useState<InterceptorEngineSnapshot>(() => runtime.interceptorEngine.getSnapshot());
  const [tab, setTab] = useState<Tab>("traffic"); const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [records, setRecords] = useState<readonly CapturedExchange[]>([]); const [rules, setRules] = useState<readonly InterceptorRule[]>([]);
  const [sessions, setSessions] = useState<readonly SavedInterceptorSession[]>([]); const [sessionsVisible, setSessionsVisible] = useState(false);
  const [settings, setSettings] = useState<InterceptorSettings | null>(null); const [query, setQuery] = useState(""); const [statusFilter, setStatusFilter] = useState(""); const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<CapturedExchange | null>(null); const [editorVisible, setEditorVisible] = useState(false); const [onboarding, setOnboarding] = useState(false); const [onboardingStep, setOnboardingStep] = useState(0); const [busy, setBusy] = useState(false); const [switchFocused, setSwitchFocused] = useState(false);
  const [urlPart, setUrlPart] = useState("/api/"); const [ruleAction, setRuleAction] = useState<"block" | "mock" | "delay" | "modify">("block"); const [ruleValue, setRuleValue] = useState("{\"ok\":true}"); const [rulePriority, setRulePriority] = useState("50"); const [advancedRuleJson, setAdvancedRuleJson] = useState(""); const [importJson, setImportJson] = useState(""); const [portText, setPortText] = useState("8888");

  const reload = useCallback(async () => {
    try {
      await runtime.interceptorEngine.initialize();
      const [loadedRules, loadedSettings] = await Promise.all([runtime.interceptorStore.listRules(), runtime.interceptorStore.settings()]);
      setRules(loadedRules); setSettings(loadedSettings); setMode(loadedSettings.mode); setPortText(String(loadedSettings.port)); setSnapshot(runtime.interceptorEngine.getSnapshot());
      runtime.interceptorCapture.setLimit(loadedSettings.maxRecords); runtime.interceptorCapture.setAutoClear(loadedSettings.autoClear);
      setRecords(runtime.interceptorCapture.list({ query: query.trim() || undefined, status: /^\d{3}$/.test(statusFilter) ? Number(statusFilter) : undefined, modified: filter === "modified" ? true : undefined, blocked: filter === "blocked" ? true : undefined, contentType: filter === "images" ? "image/" : undefined }, 500));
    } catch { setSnapshot((current) => ({ ...current, status: "error", error: "INTERCEPTOR_STORE_READ_FAILED" })); }
  }, [filter, query, runtime, statusFilter]);

  useEffect(() => { void AsyncStorage.getItem(ONBOARDING_KEY).then((done) => { if (done !== "done") setOnboarding(true); }).catch(() => setOnboarding(true)); }, []);
  useFocusEffect(useCallback(() => {
    const refreshRecords = () => setRecords(runtime.interceptorCapture.list({ query: query.trim() || undefined, status: /^\d{3}$/.test(statusFilter) ? Number(statusFilter) : undefined, modified: filter === "modified" ? true : undefined, blocked: filter === "blocked" ? true : undefined, contentType: filter === "images" ? "image/" : undefined }, 500));
    const unsubscribeEngine = runtime.interceptorEngine.subscribe(setSnapshot);
    const unsubscribeCapture = runtime.interceptorCapture.subscribe(refreshRecords);
    void reload();
    return () => { unsubscribeEngine(); unsubscribeCapture(); };
  }, [filter, query, reload, runtime, statusFilter]));

  const message = useCallback((ru: string, en: string) => language === "en" ? en : ru, [language]);
  const listenerLive = isInterceptorListenerLive(snapshot);
  const feedback = (value: string) => showDialog(text.title, value);
  const askStart = () => showDialog(text.start, text.consent, [
    { text: text.cancel, style: "cancel" },
    { text: text.confirm, onPress: () => { setBusy(true); void runtime.interceptorEngine.startByUser(true).then((next) => { setSnapshot(next); if (!next.enabled) feedback(`${text.unsupported}\n\n${next.error ?? text.unsupportedBody}`); }).catch((error) => feedback(String(error))).finally(() => setBusy(false)); } },
  ]);
  const toggleEngine = () => listenerLive ? showDialog(text.stop, message("Остановить локальный listener?", "Stop the local listener?"), [{ text: text.cancel, style: "cancel" }, { text: text.stop, onPress: () => { void runtime.interceptorEngine.stop("user").then(setSnapshot); } }]) : askStart();
  const toggleRule = async (rule: InterceptorRule) => { try { await runtime.interceptorStore.putRule({ ...rule, enabled: !rule.enabled, updatedAt: Date.now() }); await reload(); } catch { feedback(text.invalid); } };
  const addPreset = async (id: Parameters<typeof createPreset>[0]) => { const rule = createPreset(id); await runtime.interceptorStore.putRule(rule); await reload(); feedback(text.ruleAdded); };
  const removeRule = (rule: InterceptorRule) => showDialog(text.ruleDeleted, rule.name, [{ text: text.cancel, style: "cancel" }, { text: text.ruleDeleted, style: "destructive", onPress: () => { void runtime.interceptorStore.removeRule(rule.id).then(reload).catch(() => feedback(text.invalid)); } }]);

  const saveRule = async () => {
    try {
      const now = Date.now(); let newRule: InterceptorRule;
      if (mode === "advanced" && advancedRuleJson.trim()) {
        const parsed = JSON.parse(advancedRuleJson) as Partial<InterceptorRule>;
        newRule = { id: createRuleId(now), name: String(parsed.name ?? "Custom rule").slice(0, 120), enabled: true, priority: Number(parsed.priority ?? 50), conditions: parsed.conditions ?? [], actions: parsed.actions ?? [], createdAt: now, updatedAt: now, source: "user" };
      } else {
        const condition = { type: "urlContains" as const, value: urlPart.trim() };
        const action = ruleAction === "block" ? { type: "block" as const } : ruleAction === "mock" ? { type: "mockResponse" as const, status: 200, headers: { "content-type": "application/json" }, body: ruleValue } : ruleAction === "delay" ? { type: "delay" as const, ms: Math.max(0, Math.min(30_000, Number(ruleValue) || 1000)) } : { type: "modifyBody" as const, find: "", replace: ruleValue || "true", jsonPath: "$.premium" };
        newRule = { id: createRuleId(now), name: `${ruleAction}: ${urlPart.slice(0, 50)}`, enabled: true, priority: Math.max(0, Math.min(1000, Number(rulePriority) || 50)), conditions: [condition], actions: [action], createdAt: now, updatedAt: now, source: "user" };
      }
      await runtime.interceptorStore.putRule(newRule); setEditorVisible(false); setAdvancedRuleJson(""); await reload(); feedback(text.ruleAdded);
    } catch { feedback(text.invalid); }
  };

  const openCreateFrom = (item: CapturedExchange) => { setUrlPart(new URL(item.request.url).pathname); setTab("rules"); setSelected(null); setEditorVisible(true); };
  const replay = async (item: CapturedExchange, edit: Partial<ReplayRequest> = {}) => { setBusy(true); try { const result = await runtime.interceptorReplay.replay(item, edit, { capability: true, source: "user" }); feedback(`${text.status}: ${result.response.status}; ${text.duration}: ${result.durationMs} ms\nChanged: ${JSON.stringify(result.changed)}`); } catch (error) { feedback(String(error)); } finally { setBusy(false); } };
  const copy = async (value: string) => { await Clipboard.setStringAsync(value); feedback(text.copied); };
  const exportTraffic = async (format: "har" | "json") => {
    try {
      const data = exportSession(runtime.interceptorCapture.list({}, 5000), format);
      const directory = FileSystem.documentDirectory;
      if (!directory) { await copy(data); return; }
      const file = `${directory}aib-interceptor-${Date.now()}.${format}`;
      await FileSystem.writeAsStringAsync(file, data, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file, { mimeType: format === "har" ? "application/json" : "application/json", dialogTitle: format.toUpperCase() });
      else await copy(data);
    } catch { feedback(text.exportFailed); }
  };
  const exportRules = async () => { try { const data = JSON.stringify({ version: 1, rules: await runtime.interceptorStore.listRules() }, null, 2); await copy(data); } catch { feedback(text.exportFailed); } };
  const saveCurrentSession = async () => { try { const count = runtime.interceptorCapture.size; if (!count) { feedback(text.empty); return; } await runtime.interceptorSessions.save(`Session ${new Date().toLocaleString()}`, runtime.interceptorCapture.list({}, 500)); setSessions(await runtime.interceptorSessions.list()); feedback(text.sessionSaved); } catch (error) { feedback(error instanceof Error ? error.message : text.exportFailed); } };
  const openSessions = async () => { try { setSessions(await runtime.interceptorSessions.list()); setSessionsVisible(true); } catch { feedback(text.exportFailed); } };
  const loadSession = async (session: SavedInterceptorSession) => { try { runtime.interceptorCapture.restore(session.records); setSessionsVisible(false); setTab("traffic"); feedback(`${text.load}: ${session.name}`); } catch { feedback(text.invalid); } };
  const importRules = async () => {
    try {
      const parsed = JSON.parse(importJson) as { rules?: unknown } | unknown[]; const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { rules?: unknown }).rules) ? (parsed as { rules: unknown[] }).rules : [];
      if (!list.length || list.length > 500) throw new Error("invalid");
      for (const candidate of list) { if (!candidate || typeof candidate !== "object") throw new Error("invalid"); const rule = candidate as InterceptorRule; await runtime.interceptorStore.putRule({ ...rule, source: "user", id: createRuleId(), createdAt: Date.now(), updatedAt: Date.now() }); }
      setImportJson(""); await reload(); feedback(message("Правила импортированы.", "Rules imported."));
    } catch { feedback(text.invalid); }
  };
  const saveSettings = async (patch: Partial<InterceptorSettings>) => { try { const next = await runtime.interceptorStore.updateSettings(patch); setSettings(next); setMode(next.mode); setPortText(String(next.port)); runtime.interceptorCapture.setLimit(next.maxRecords); runtime.interceptorCapture.setAutoClear(next.autoClear); } catch { feedback(text.invalid); } };
  const changePort = async () => { const port = Number(portText); try { await runtime.interceptorEngine.setPort(port); await saveSettings({ port }); } catch { feedback(message("Порт должен быть свободным и находиться в диапазоне 1024–65535. Сначала остановите перехват.", "Choose a port from 1024 to 65535 and stop the listener before changing it.")); } };
  const showCertificateHelp = () => showDialog(text.certificateHelp, runtime.interceptorCertificate.installationInstructions().map((line, index) => `${index + 1}. ${line}`).join("\n\n"), [{ text: text.gotIt }]);
  const checkCertificate = async () => { try { const result = await runtime.interceptorCertificate.checkInstallation(); feedback(`${result.message}${result.fingerprint ? `\n${result.fingerprint}` : ""}`); } catch { feedback(text.noCertAdapter); } };
  const createCertificate = () => showDialog(text.generate, message("Создаётся локальный signing key, зашифрованный в приложении. Android trust не меняется; публичный CA можно экспортировать и установить вручную.", "A local signing key is created and encrypted by the app. Android trust is unchanged; you may export the public CA and install it manually."), [{ text: text.cancel, style: "cancel" }, { text: text.generate, onPress: () => { void runtime.interceptorCertificate.createAfterUserConfirmation(true).then((result) => feedback(result.message)).catch(() => feedback(text.noCertAdapter)); } }]);
  const exportCertificate = async () => {
    try {
      const cert = await runtime.interceptorCertificate.exportPublicCertificate();
      const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
      if (!directory) { await copy(cert.pem); return; }
      const file = `${directory}aib-interceptor-public-ca.pem`;
      await FileSystem.writeAsStringAsync(file, cert.pem, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file, { mimeType: "application/x-pem-file", dialogTitle: text.exportCa });
      else await copy(cert.pem);
      feedback(`${text.caExported}\n${cert.fingerprint}`);
    } catch { feedback(text.noCertAdapter); }
  };
  const persistMitmMode = async (enabled: boolean) => {
    const wasRunning = listenerLive;
    if (wasRunning) await runtime.interceptorEngine.stop("user");
    await saveSettings({ mitmEnabled: enabled });
    if (wasRunning) feedback(text.mitmRestartRequired);
  };
  const toggleMitm = (enabled: boolean) => {
    if (!enabled) { void persistMitmMode(false); return; }
    showDialog(text.mitmMode, text.mitmHelp, [
      { text: text.cancel, style: "cancel" },
      { text: text.gotIt, onPress: () => void persistMitmMode(true) },
    ]);
  };
  const copyProxyConfig = () => {
    if (!snapshot.authToken) return;
    void copy(`Proxy URL: http://127.0.0.1:${snapshot.port}\nUsername: aib\nPassword: ${snapshot.authToken}\ncurl --proxy http://127.0.0.1:${snapshot.port} --proxy-user aib:${snapshot.authToken} https://example.com/`);
  };
  const removeCertificate = () => showDialog(text.removeCertificate, message("Удалится локальный signing key приложения. Ранее установленный системный CA автоматически не удаляется — при необходимости удалите его отдельно в настройках Android.", "This removes the app-local signing key. A previously installed system CA is not removed automatically; remove it separately in Android settings if needed."), [{ text: text.cancel, style: "cancel" }, { text: text.removeCertificate, style: "destructive", onPress: () => { void runtime.interceptorCertificate.removeAfterUserConfirmation(true).then((removed) => feedback(removed ? message("Локальный ключ удалён. Системный сертификат не затронут.", "Local key removed. The system certificate was not changed.") : text.noCertAdapter)).catch(() => feedback(text.noCertAdapter)); } }]);
  const reset = () => showDialog(text.reset, message("Удалить все правила, архивы и записи памяти?", "Delete all rules, saved sessions and in-memory records?"), [{ text: text.cancel, style: "cancel" }, { text: text.reset, style: "destructive", onPress: () => { void runtime.interceptorEngine.stop("user").then(() => Promise.all([runtime.interceptorStore.reset(), runtime.interceptorSessions.clear()])).then(() => { runtime.interceptorCapture.clear(); setTab("traffic"); return reload(); }); } }]);
  const finishOnboarding = async () => { setOnboarding(false); await AsyncStorage.setItem(ONBOARDING_KEY, "done").catch(() => undefined); };

  const filteredRecords = useMemo(() => records.filter((item) => {
    if (filter === "images") return (item.response?.headers["content-type"] ?? "").toLowerCase().startsWith("image/");
    if (filter === "api") return /\/api\/|graphql|json/i.test(item.request.url) || (item.response?.headers["content-type"] ?? "").includes("json");
    return true;
  }), [records, filter]);
  const stats = runtime.interceptorCapture.stats();

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: Math.max(insets.top, 8) }]}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) + 18 }}>
        <View style={styles.pageHeader}>
          <View style={[styles.headerIcon, { backgroundColor: colors.accentDim }]}><Ionicons name="pulse-outline" size={23} color={colors.accent} /></View>
          <View style={{ flex: 1 }}><Text style={[styles.title, { color: colors.inkBright }]}>{text.title}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{language === "en" ? "Local testing tool · off by default" : "Локальный инструмент тестирования · выключен по умолчанию"}</Text></View>
          <View style={[{ minWidth: 58, minHeight: 48, borderWidth: 1, borderColor: "transparent", borderRadius: 12, alignItems: "center", justifyContent: "center" }, switchFocused && { borderColor: colors.accent, backgroundColor: colors.accentDim }]}>
            <Switch
              value={listenerLive}
              onValueChange={toggleEngine}
              disabled={busy || snapshot.status === "starting" || snapshot.status === "stopping"}
              trackColor={{ false: colors.line, true: colors.success }}
              thumbColor={listenerLive ? colors.onAccent : colors.inkBright}
              ios_backgroundColor={colors.line}
              hitSlop={8}
              onFocus={() => setSwitchFocused(true)}
              onBlur={() => setSwitchFocused(false)}
              accessibilityRole="switch"
              accessibilityLabel={listenerLive ? text.stop : text.start}
              accessibilityHint={listenerLive
                ? message("Нажмите, чтобы остановить listener.", "Tap to stop the listener.")
                : message("Включение требует подтверждения; статус изменится только после подтверждённого bind.", "Enabling requires confirmation; the status changes only after bind is confirmed.")}
              accessibilityState={{ checked: listenerLive, disabled: busy || snapshot.status === "starting" || snapshot.status === "stopping", busy: snapshot.status === "starting" || snapshot.status === "stopping" }}
              testID="interceptor-live-switch"
            />
          </View>
        </View>
        <InterceptorStatusBar snapshot={snapshot} text={text} colors={colors} />
        {listenerLive && snapshot.authToken ? <View style={[styles.notice, { backgroundColor: colors.accentDim, borderColor: colors.accent }]}><Ionicons name="key-outline" size={19} color={colors.accent} /><View style={{ flex: 1 }}><Text style={{ color: colors.ink, fontSize: 12, lineHeight: 18 }}>{text.proxyAuthHelp}</Text><Text selectable style={{ color: colors.inkBright, fontSize: 12, lineHeight: 18, marginTop: 6 }}>{`http://127.0.0.1:${snapshot.port} · aib:${snapshot.authToken}`}</Text></View><SmallButton title={text.copyProxy} onPress={copyProxyConfig} colors={colors} /></View> : null}
        {(snapshot.status === "unsupported" || snapshot.status === "error") && <View style={[styles.notice, { backgroundColor: colors.warning + "18", borderColor: colors.warning }]}><Ionicons name="information-circle-outline" size={19} color={colors.warning} /><Text style={{ flex: 1, color: colors.ink, fontSize: 13, lineHeight: 19 }}>{snapshot.status === "unsupported" ? text.unsupportedBody : `${text.status}: ${snapshot.error ?? "Error"}`}</Text></View>}
        <View style={[styles.modeRow, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>{language === "en" ? "Interface" : "Интерфейс"}</Text>
          <TouchableOpacity onPress={() => { setMode("simple"); void saveSettings({ mode: "simple" }); }} style={[styles.modeChip, { backgroundColor: mode === "simple" ? colors.accentDim : "transparent" }]}><Text style={{ color: mode === "simple" ? colors.accent : colors.muted, fontWeight: "700" }}>{text.beginner}</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => { setMode("advanced"); void saveSettings({ mode: "advanced" }); }} style={[styles.modeChip, { backgroundColor: mode === "advanced" ? colors.accentDim : "transparent" }]}><Text style={{ color: mode === "advanced" ? colors.accent : colors.muted, fontWeight: "700" }}>{text.advanced}</Text></TouchableOpacity>
        </View>
        <View style={styles.tabs}>
          {(["traffic", "rules", "settings"] as const).map((key) => <TouchableOpacity key={key} onPress={() => { setTab(key); void reload(); }} style={[styles.tab, { borderBottomColor: tab === key ? colors.accent : "transparent" }]}><Text style={{ color: tab === key ? colors.accent : colors.muted, fontWeight: tab === key ? "800" : "600" }}>{text[key]}</Text></TouchableOpacity>)}
        </View>
        {tab === "traffic" ? <TrafficPanel records={filteredRecords} query={query} onQuery={setQuery} statusFilter={statusFilter} onStatusFilter={setStatusFilter} filter={filter} onFilter={setFilter} stats={stats} text={text} colors={colors} onSelect={setSelected} onClear={() => showDialog(text.clear, message("Удалить все записи из памяти?", "Delete all in-memory traffic records?"), [{ text: text.cancel, style: "cancel" }, { text: text.clear, style: "destructive", onPress: () => { runtime.interceptorCapture.clear(); setRecords([]); } }])} onExportHar={() => void exportTraffic("har")} onExportJson={() => void exportTraffic("json")} onSaveSession={() => void saveCurrentSession()} onSessions={() => void openSessions()} /> : null}
        {tab === "rules" ? <RulesPanel rules={rules} mode={mode} text={text} colors={colors} onToggle={toggleRule} onDelete={removeRule} onNew={() => setEditorVisible(true)} onPreset={addPreset} /> : null}
        {tab === "settings" ? <SettingsPanel settings={settings} mode={mode} portText={portText} onPort={setPortText} onPortSave={changePort} text={text} colors={colors} importJson={importJson} onImportJson={setImportJson} onImport={() => void importRules()} onExportRules={() => void exportRules()} onCertHelp={showCertificateHelp} onCheckCert={() => void checkCertificate()} onCreateCert={createCertificate} onExportCa={() => void exportCertificate()} onRemoveCert={removeCertificate} onMitm={toggleMitm} onReset={reset} onMode={(value: "simple" | "advanced") => { setMode(value); void saveSettings({ mode: value }); }} onLimit={(value: number) => void saveSettings({ maxRecords: value })} onAutoClear={(value: boolean) => void saveSettings({ autoClear: value })} /> : null}
      </ScrollView>
      {busy ? <View style={[styles.busy, { backgroundColor: colors.overlay }]}><ActivityIndicator color={colors.accent} /></View> : null}
      <Modal visible={Boolean(selected)} animationType="slide" onRequestClose={() => setSelected(null)}>
        {selected ? <RequestDetail key={selected.id} item={selected} text={text} colors={colors} onClose={() => setSelected(null)} onReplay={(edit: Partial<ReplayRequest>) => void replay(selected, edit)} onCopyCurl={() => void copy(copyAsCurl(selected))} onCopyFetch={() => void copy(copyAsFetch(selected))} onCopyHttpie={() => void copy(copyAsHttpie(selected))} onCreateRule={() => openCreateFrom(selected)} onExport={() => void copy(exportSession([selected], "har"))} onFeedback={(value: string) => showDialog(text.title, value)} /> : null}
      </Modal>
      <Modal visible={sessionsVisible} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setSessionsVisible(false)}>
        <View style={[styles.modalBackdrop, { backgroundColor: colors.overlay, paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 16) }]}><View style={[styles.editor, { backgroundColor: colors.surface, borderColor: colors.line }]}><View style={styles.rowBetween}><Text style={[styles.sectionTitle, { color: colors.inkBright }]}>{text.sessions}</Text><TouchableOpacity onPress={() => setSessionsVisible(false)}><Ionicons name="close" size={22} color={colors.muted} /></TouchableOpacity></View>{sessions.length === 0 ? <Text style={{ color: colors.muted, marginTop: 18 }}>{text.noSessions}</Text> : <ScrollView>{sessions.map((session) => <View key={session.id} style={[styles.ruleRow, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}><View style={{ flex: 1 }}><Text style={{ color: colors.inkBright, fontWeight: "700" }}>{session.name}</Text><Text style={{ color: colors.muted, fontSize: 11 }}>{new Date(session.savedAt).toLocaleString()} · {session.records.length}</Text></View><SmallButton title={text.load} onPress={() => void loadSession(session)} colors={colors} /></View>)}</ScrollView>}</View></View>
      </Modal>
      <Modal visible={editorVisible} animationType="slide" transparent statusBarTranslucent onRequestClose={() => setEditorVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={[styles.modalBackdrop, { backgroundColor: colors.overlay, paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 16) }]}><View style={[styles.editor, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.rowBetween}><Text style={[styles.sectionTitle, { color: colors.inkBright }]}>{text.newRule}</Text><TouchableOpacity onPress={() => setEditorVisible(false)}><Ionicons name="close" size={22} color={colors.muted} /></TouchableOpacity></View>
          <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            <Text style={[styles.label, { color: colors.muted }]}>{text.urlContains}</Text><TextInput value={urlPart} onChangeText={setUrlPart} placeholder="/api/user" placeholderTextColor={colors.muted} style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} />
            {mode === "simple" ? <>
              <Text style={[styles.label, { color: colors.muted }]}>{text.action}</Text>
              <View style={styles.wrap}>{(["block", "mock", "delay", "modify"] as const).map((item) => <TouchableOpacity key={item} onPress={() => setRuleAction(item)} style={[styles.filterChip, { backgroundColor: item === ruleAction ? colors.accentDim : colors.chipBg, borderColor: item === ruleAction ? colors.accent : colors.line }]}><Text style={{ color: item === ruleAction ? colors.accent : colors.chipText }}>{text[item]}</Text></TouchableOpacity>)}</View>
              {ruleAction !== "block" ? <TextInput value={ruleValue} onChangeText={setRuleValue} placeholder={ruleAction === "delay" ? "1000" : "{\"ok\":true}"} placeholderTextColor={colors.muted} multiline style={[styles.input, styles.multiline, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} /> : null}
              <Text style={[styles.label, { color: colors.muted }]}>{text.priority}</Text><TextInput value={rulePriority} onChangeText={setRulePriority} keyboardType="number-pad" style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} />
            </> : <>
              <Text style={[styles.label, { color: colors.muted }]}>{text.advancedJson}</Text><TextInput value={advancedRuleJson} onChangeText={setAdvancedRuleJson} multiline placeholder={'{ "name": "Example", "priority": 50, "conditions": [{"type":"urlContains","value":"/api/"}], "actions": [{"type":"block"}] }'} placeholderTextColor={colors.muted} style={[styles.input, styles.multiline, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line, minHeight: 170 }]} />
              <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>Allowed: urlContains, urlMatches, urlEquals, methodIs, headerExists, headerEquals, statusCodeIs, bodyContains; mockResponse, modifyBody, modifyHeaders, setStatusCode, block, delay, breakpoint, mapLocal, mapRemote.</Text>
            </>}
          </ScrollView>
          <TouchableOpacity onPress={() => void saveRule()} style={[styles.primaryButton, { backgroundColor: colors.accent }]}><Text style={{ color: colors.onAccent, fontWeight: "800" }}>{text.save}</Text></TouchableOpacity>
        </View></KeyboardAvoidingView>
      </Modal>
      <Modal visible={onboarding} transparent animationType="fade" statusBarTranslucent onRequestClose={() => void finishOnboarding()}>
        <View style={[styles.modalBackdrop, { backgroundColor: colors.overlay, paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 16) }]}><View style={[styles.onboarding, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={[styles.headerIcon, { backgroundColor: colors.accentDim }]}><Ionicons name="shield-checkmark-outline" size={24} color={colors.accent} /></View><Text style={[styles.sectionTitle, { color: colors.inkBright, marginTop: 12 }]}>{text.onboardingTitle} · {onboardingStep + 1}/4</Text>
          <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 23, marginTop: 14 }}>{([text.onboarding1, text.onboarding2, text.onboarding3, text.onboarding4] as const)[onboardingStep]}</Text>
          <View style={[styles.notice, { backgroundColor: colors.warning + "18", borderColor: colors.warning, marginTop: 16 }]}><Ionicons name="warning-outline" size={17} color={colors.warning} /><Text style={{ color: colors.ink, flex: 1, fontSize: 12, lineHeight: 17 }}>{text.securityBody}</Text></View>
          <View style={[styles.rowBetween, { marginTop: 22 }]}><TouchableOpacity onPress={() => void finishOnboarding()}><Text style={{ color: colors.muted, padding: 10 }}>{text.skip}</Text></TouchableOpacity><TouchableOpacity onPress={() => onboardingStep < 3 ? setOnboardingStep(onboardingStep + 1) : void finishOnboarding()} style={[styles.primaryButton, { backgroundColor: colors.accent }]}><Text style={{ color: colors.onAccent, fontWeight: "800" }}>{onboardingStep < 3 ? text.next : text.done}</Text></TouchableOpacity></View>
        </View></View>
      </Modal>
    </View>
  );
}

function InterceptorStatusBar({ snapshot, text, colors }: { snapshot: InterceptorEngineSnapshot; text: typeof RU; colors: ReturnType<typeof useTheme>["colors"] }) {
  const pulse = useRef(new Animated.Value(1)).current;
  const state = getInterceptorIndicatorState(snapshot);
  const listenerLive = state === "running";
  useEffect(() => { if (!listenerLive) { pulse.setValue(1); return; } const animation = Animated.loop(Animated.sequence([Animated.timing(pulse, { toValue: 0.35, duration: 650, useNativeDriver: true }), Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true })])); animation.start(); return () => animation.stop(); }, [pulse, listenerLive]);
  const color = state === "running" ? colors.success : state === "starting" || state === "stopping" ? colors.warning : state === "error" || state === "unsupported" ? colors.danger : colors.muted;
  const label = state === "running" ? `${text.on} · 127.0.0.1:${snapshot.port}` : state === "starting" ? text.starting : state === "stopping" ? text.stopping : state === "unsupported" ? text.unsupported : state === "error" ? `${text.status}: ${snapshot.error ?? "Error"}` : text.off;
  return <View accessibilityRole="summary" accessibilityLiveRegion="polite" style={[styles.status, { backgroundColor: colors.surface, borderColor: colors.line }]}><Animated.View accessible={false} style={[styles.dot, { backgroundColor: color, opacity: pulse, transform: [{ scale: pulse }] }]} /><Text style={{ color: colors.inkBright, flex: 1, fontWeight: "700" }}>{label}</Text><Text style={{ color, fontSize: 11, fontWeight: "700" }}>{snapshot.status.toUpperCase()}</Text></View>;
}

function TrafficPanel({ records, query, onQuery, statusFilter, onStatusFilter, filter, onFilter, stats, text, colors, onSelect, onClear, onExportHar, onExportJson, onSaveSession, onSessions }: any) {
  const rulePulse = useRef(new Animated.Value(0.72)).current; const [highlightedRuleId, setHighlightedRuleId] = useState("");
  useEffect(() => { const hit = records.find((item: CapturedExchange) => item.matchedRules.length > 0); if (!hit) return; setHighlightedRuleId(hit.id); rulePulse.setValue(0.55); const animation = Animated.timing(rulePulse, { toValue: 1, duration: 420, useNativeDriver: true }); animation.start(); const timer = setTimeout(() => setHighlightedRuleId(""), 1400); return () => { animation.stop(); clearTimeout(timer); }; }, [records, rulePulse]);
  const filters: Filter[] = ["all", "modified", "blocked", "images", "api"];
  return <View style={styles.panel}>
    <View style={styles.stats}><Stat label={text.status} value={String(stats.requests)} colors={colors} /><Stat label={text.modified} value={String(stats.modified)} colors={colors} /><Stat label={text.blocked} value={String(stats.blocked)} colors={colors} /><Stat label="KB" value={String(Math.round((stats.bytesIn + stats.bytesOut) / 1024))} colors={colors} /></View>
    <TextInput value={query} onChangeText={onQuery} placeholder={text.search} placeholderTextColor={colors.muted} style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} />
    <TextInput value={statusFilter} onChangeText={(value) => onStatusFilter(value.replace(/\D/g, "").slice(0, 3))} keyboardType="number-pad" placeholder={text.statusCode} placeholderTextColor={colors.muted} style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.wrap}>{filters.map((item) => <TouchableOpacity key={item} onPress={() => onFilter(item)} style={[styles.filterChip, { backgroundColor: filter === item ? colors.accentDim : colors.chipBg, borderColor: filter === item ? colors.accent : colors.line }]}><Text style={{ color: filter === item ? colors.accent : colors.chipText }}>{text[item]}</Text></TouchableOpacity>)}</ScrollView>
    <View style={styles.wrap}><SmallButton title={text.exportHar} onPress={onExportHar} colors={colors} /><SmallButton title={text.exportJson} onPress={onExportJson} colors={colors} /><SmallButton title={text.saveSession} onPress={onSaveSession} colors={colors} /><SmallButton title={text.sessions} onPress={onSessions} colors={colors} /><SmallButton title={text.clear} onPress={onClear} colors={colors} /></View>
    {stats.topDomains?.length ? <Text style={{ color: colors.muted, fontSize: 11, marginVertical: 4 }}>{text.domainStats}: {stats.topDomains.slice(0, 5).map((item: { host: string; count: number }) => `${item.host} (${item.count})`).join(" · ")}</Text> : null}
    {records.length === 0 ? <View style={[styles.empty, { borderColor: colors.line, backgroundColor: colors.surface }]}><Ionicons name="git-network-outline" size={26} color={colors.muted} /><Text style={{ color: colors.inkBright, fontWeight: "700", marginTop: 8 }}>{text.empty}</Text><Text style={{ color: colors.muted, textAlign: "center", lineHeight: 18, marginTop: 5 }}>{text.trafficHint}</Text></View> : <FlatList data={records as CapturedExchange[]} keyExtractor={(item) => item.id} scrollEnabled={false} initialNumToRender={12} windowSize={8} renderItem={({ item }) => <Animated.View style={{ opacity: highlightedRuleId === item.id ? rulePulse : 1 }}><TouchableOpacity onPress={() => onSelect(item)} style={[styles.trafficRow, { backgroundColor: colors.surface, borderColor: highlightedRuleId === item.id ? colors.warning : colors.line }]}>
      <View style={{ width: 7, height: 34, borderRadius: 4, backgroundColor: item.blocked ? colors.danger : item.modified ? colors.warning : (item.response?.status ?? 0) >= 400 ? colors.danger : colors.success }} />
      <View style={{ flex: 1 }}><View style={styles.rowBetween}><Text style={{ color: colors.accent, fontWeight: "800", fontSize: 12 }}>{item.request.method}</Text><Text style={{ color: item.blocked ? colors.danger : colors.ink, fontSize: 12 }}>{item.blocked ? text.blocked : item.response?.status ?? "—"}</Text></View><Text numberOfLines={1} style={{ color: colors.inkBright, marginTop: 4 }}>{item.request.url}</Text><Text style={{ color: colors.muted, fontSize: 11, marginTop: 3 }}>{item.timing.totalMs} ms · {item.modified ? text.modified : ""}{item.matchedRules.length ? ` · ${text.ruleFired}: ${item.matchedRules.length}` : ""}</Text></View>
      <Ionicons name="chevron-forward" size={17} color={colors.muted} />
    </TouchableOpacity></Animated.View>} />}
  </View>;
}
function Stat({ label, value, colors }: { label: string; value: string; colors: ReturnType<typeof useTheme>["colors"] }) { return <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.line }]}><Text style={{ color: colors.muted, fontSize: 10 }}>{label}</Text><Text style={{ color: colors.inkBright, fontSize: 16, fontWeight: "800", marginTop: 3 }}>{value}</Text></View>; }
function RulesPanel({ rules, mode, text, colors, onToggle, onDelete, onNew, onPreset }: any) {
  return <View style={styles.panel}><View style={styles.rowBetween}><Text style={[styles.sectionTitle, { color: colors.inkBright }]}>{text.rules}</Text><TouchableOpacity onPress={onNew} style={[styles.smallAction, { backgroundColor: colors.accentDim }]}><Ionicons name="add" size={17} color={colors.accent} /><Text style={{ color: colors.accent, fontWeight: "800" }}>{text.newRule}</Text></TouchableOpacity></View>
    {rules.length === 0 ? <Text style={{ color: colors.muted, marginVertical: 14 }}>{text.noRules}</Text> : rules.map((rule: InterceptorRule) => <View key={rule.id} style={[styles.ruleRow, { backgroundColor: colors.surface, borderColor: colors.line }]}><View style={{ flex: 1 }}><Text style={{ color: colors.inkBright, fontWeight: "700" }}>{rule.name}</Text><Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>{text.priority} {rule.priority} · {rule.conditions.map((condition) => condition.type).join(" + ")}</Text><Text numberOfLines={1} style={{ color: colors.muted, fontSize: 11 }}>{rule.conditions.map((condition) => "value" in condition ? condition.value : condition.type).join(" · ")}</Text></View><Switch value={rule.enabled} onValueChange={() => void onToggle(rule)} trackColor={{ false: colors.line, true: colors.success }} /><TouchableOpacity onPress={() => onDelete(rule)} style={{ padding: 6 }}><Ionicons name="trash-outline" size={17} color={colors.danger} /></TouchableOpacity></View>)}
    <Text style={[styles.sectionTitle, { color: colors.inkBright, marginTop: 22 }]}>{text.presets}</Text>
    {INTERCEPTOR_PRESETS.map((preset) => <TouchableOpacity key={preset.id} onPress={() => void onPreset(preset.id)} style={[styles.preset, { backgroundColor: colors.surface, borderColor: colors.line }]}><View style={{ flex: 1 }}><Text style={{ color: colors.inkBright, fontWeight: "700" }}>{mode === "advanced" ? preset.nameEn : (preset.nameRu)}</Text><Text style={{ color: colors.muted, marginTop: 3, lineHeight: 17 }}>{mode === "advanced" ? preset.descriptionEn : preset.descriptionRu}</Text></View><Ionicons name="add-circle-outline" size={21} color={colors.accent} /></TouchableOpacity>)}
    <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 12 }}>{text.trafficHint}</Text>
  </View>;
}
function SettingsPanel({ settings, mode, portText, onPort, onPortSave, text, colors, importJson, onImportJson, onImport, onExportRules, onCertHelp, onCheckCert, onCreateCert, onExportCa, onRemoveCert, onMitm, onReset, onMode, onLimit, onAutoClear }: any) {
  return <View style={styles.panel}><Text style={[styles.sectionTitle, { color: colors.inkBright }]}>{text.settings}</Text>
    <Text style={[styles.label, { color: colors.muted }]}>{text.port}</Text><View style={styles.row}><TextInput value={portText} onChangeText={onPort} keyboardType="number-pad" style={[styles.input, { flex: 1, backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} /><SmallButton title={text.save} onPress={onPortSave} colors={colors} /></View>
    <Text style={[styles.label, { color: colors.muted, marginTop: 14 }]}>{text.status}</Text><View style={styles.wrap}><SmallButton title={text.beginnerMode} onPress={() => onMode("simple")} colors={colors} active={mode === "simple"} /><SmallButton title={text.advancedMode} onPress={() => onMode("advanced")} colors={colors} active={mode === "advanced"} /></View>
    <Text style={[styles.label, { color: colors.muted, marginTop: 14 }]}>{text.maxRecords}: {settings?.maxRecords ?? 300}</Text><View style={styles.wrap}>{[100, 300, 1000].map((n) => <SmallButton key={n} title={String(n)} onPress={() => onLimit(n)} colors={colors} active={(settings?.maxRecords ?? 300) === n} />)}</View>
    <View style={[styles.ruleRow, { backgroundColor: colors.surface, borderColor: colors.line }]}><Text style={{ color: colors.ink, flex: 1 }}>{text.autoClear}</Text><Switch value={settings?.autoClear ?? true} onValueChange={onAutoClear} /></View>
    <View style={[styles.ruleRow, { backgroundColor: colors.surface, borderColor: colors.line, marginTop: 10 }]}><Text style={{ color: colors.ink, flex: 1 }}>{text.mitmMode}</Text><Switch value={settings?.mitmEnabled ?? false} onValueChange={onMitm} /></View><Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 6 }}>{text.mitmHelp}</Text>
    <View style={[styles.notice, { backgroundColor: colors.warning + "18", borderColor: colors.warning }]}><Ionicons name="shield-outline" size={19} color={colors.warning} /><Text style={{ color: colors.ink, flex: 1, fontSize: 12, lineHeight: 18 }}>{text.memoryOnly}{"\n\n"}{text.securityBody}</Text></View>
    <Text style={[styles.sectionTitle, { color: colors.inkBright, marginTop: 18 }]}>{text.certificate}</Text><Text style={{ color: colors.muted, lineHeight: 18, marginTop: 6 }}>{text.certificateStoreHelp}</Text><View style={styles.wrap}><SmallButton title={text.certificateHelp} onPress={onCertHelp} colors={colors} /><SmallButton title={text.check} onPress={onCheckCert} colors={colors} /><SmallButton title={text.generate} onPress={onCreateCert} colors={colors} /><SmallButton title={text.exportCa} onPress={onExportCa} colors={colors} /><SmallButton title={text.removeCertificate} onPress={onRemoveCert} colors={colors} /></View>
    <Text style={[styles.sectionTitle, { color: colors.inkBright, marginTop: 18 }]}>{text.exportRules}</Text><SmallButton title={text.exportRules} onPress={onExportRules} colors={colors} /><Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 12 }}>{text.rulesImportHint}</Text><TextInput value={importJson} onChangeText={onImportJson} multiline placeholder='{"rules": []}' placeholderTextColor={colors.muted} style={[styles.input, styles.multiline, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} /><SmallButton title={text.importRules} onPress={onImport} colors={colors} />
    <TouchableOpacity onPress={onReset} style={[styles.dangerButton, { borderColor: colors.danger }]}><Ionicons name="trash-outline" size={17} color={colors.danger} /><Text style={{ color: colors.danger, fontWeight: "700" }}>{text.reset}</Text></TouchableOpacity>
  </View>;
}
function RequestDetail({ item, text, colors, onClose, onReplay, onCopyCurl, onCopyFetch, onCopyHttpie, onCreateRule, onExport, onFeedback }: any) {
  const [editMethod, setEditMethod] = useState(item.request.method); const [editUrl, setEditUrl] = useState(item.request.url); const [editHeaders, setEditHeaders] = useState(JSON.stringify(item.request.requestHeaders, null, 2)); const [editBody, setEditBody] = useState(item.request.requestBody ?? "");
  let query = ""; try { const values: Record<string, string> = {}; new URL(item.request.url).searchParams.forEach((value, key) => { values[key] = value; }); query = JSON.stringify(values, null, 2); } catch { /* malformed URLs were redacted */ }
  return <View style={[styles.detail, { backgroundColor: colors.background, paddingTop: 18 }]}><View style={styles.rowBetween}><Text style={[styles.sectionTitle, { color: colors.inkBright, flex: 1 }]}>{text.details}</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={25} color={colors.muted} /></TouchableOpacity></View>
    <View style={[styles.status, { backgroundColor: colors.surface, borderColor: colors.line }]}><Text style={{ color: colors.accent, fontWeight: "800" }}>{item.request.method}</Text><Text style={{ color: colors.inkBright, flex: 1 }} numberOfLines={2}>{item.request.url}</Text><Text style={{ color: item.blocked ? colors.danger : colors.inkBright }}>{item.response?.status ?? "—"}</Text></View>
    <ScrollView style={{ flex: 1 }}>
      <Text style={{ color: colors.accent, fontWeight: "800", marginTop: 8 }}>{text.replay} — editable</Text><TextInput value={editMethod} onChangeText={setEditMethod} placeholder={text.method} placeholderTextColor={colors.muted} style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} /><TextInput value={editUrl} onChangeText={setEditUrl} autoCapitalize="none" placeholder="https://example.com/path" placeholderTextColor={colors.muted} style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} /><TextInput value={editHeaders} onChangeText={setEditHeaders} multiline placeholder={text.headers} placeholderTextColor={colors.muted} style={[styles.input, styles.multiline, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} /><TextInput value={editBody} onChangeText={setEditBody} multiline placeholder={text.body} placeholderTextColor={colors.muted} style={[styles.input, styles.multiline, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]} />
      <DetailSection title={text.overview} value={`${text.duration}: ${item.timing.totalMs} ms\n${text.statusCode}: ${item.response?.status ?? "—"}\nRules: ${item.matchedRules.join(", ") || "—"}\nModified: ${item.modified ? "yes" : "no"}\nBlocked: ${item.blocked ? "yes" : "no"}`} colors={colors} />
      <DetailSection title={`${text.request} · ${text.headers}`} value={JSON.stringify(item.request.requestHeaders, null, 2) || "{}"} colors={colors} />
      <DetailSection title={`${text.request} · ${text.body}`} value={item.request.requestBody ?? "—"} colors={colors} />
      <DetailSection title="Query" value={query || "—"} colors={colors} />
      <DetailSection title={`${text.response} · ${text.headers}`} value={JSON.stringify(item.response?.headers ?? {}, null, 2)} colors={colors} />
      <DetailSection title={`${text.response} · ${text.body}`} value={item.response?.body ?? item.error ?? "—"} colors={colors} />
      <DetailSection title={text.timeline} value={`Start: ${new Date(item.timing.start).toLocaleTimeString()}\nEnd: ${new Date(item.timing.end).toLocaleTimeString()}\n${item.timing.totalMs} ms`} colors={colors} />
    </ScrollView>
    <ScrollView horizontal style={{ maxHeight: 48 }} contentContainerStyle={styles.wrap}><SmallButton title={text.replay} onPress={() => { try { const headers = JSON.parse(editHeaders); if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("invalid"); onReplay({ method: editMethod, url: editUrl, headers, body: editBody }); } catch { onFeedback(text.invalid); } }} colors={colors} /><SmallButton title={text.copyCurl} onPress={onCopyCurl} colors={colors} /><SmallButton title={text.copyFetch} onPress={onCopyFetch} colors={colors} /><SmallButton title={text.copyHttpie} onPress={onCopyHttpie} colors={colors} /><SmallButton title={text.createFrom} onPress={onCreateRule} colors={colors} /><SmallButton title={text.exportHar} onPress={onExport} colors={colors} /></ScrollView>
  </View>;
}
function DetailSection({ title, value, colors }: { title: string; value: string; colors: ReturnType<typeof useTheme>["colors"] }) { return <View style={[styles.detailSection, { backgroundColor: colors.surface, borderColor: colors.line }]}><Text style={{ color: colors.accent, fontWeight: "800", marginBottom: 7 }}>{title}</Text><Text selectable style={{ color: colors.ink, fontFamily: "monospace", fontSize: 12, lineHeight: 17 }}>{value}</Text></View>; }
function SmallButton({ title, onPress, colors, active }: { title: string; onPress: () => void; colors: ReturnType<typeof useTheme>["colors"]; active?: boolean }) { return <TouchableOpacity onPress={onPress} style={[styles.smallButton, { backgroundColor: active ? colors.accentDim : colors.chipBg, borderColor: active ? colors.accent : colors.line }]}><Text style={{ color: active ? colors.accent : colors.chipText, fontWeight: "700", fontSize: 12 }}>{title}</Text></TouchableOpacity>; }

const styles = StyleSheet.create({
  root: { flex: 1 }, pageHeader: { flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, paddingVertical: 13 }, headerIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" }, title: { fontSize: 19, fontWeight: "800" }, status: { marginHorizontal: 14, padding: 12, borderWidth: 1, borderRadius: 13, flexDirection: "row", alignItems: "center", gap: 9 }, dot: { width: 9, height: 9, borderRadius: 5 }, notice: { marginHorizontal: 14, marginTop: 9, padding: 11, borderWidth: 1, borderRadius: 12, flexDirection: "row", gap: 9, alignItems: "flex-start" }, modeRow: { marginHorizontal: 14, marginTop: 10, borderWidth: 1, borderRadius: 12, padding: 5, flexDirection: "row", alignItems: "center", gap: 4 }, modeChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9 }, tabs: { flexDirection: "row", marginTop: 12, marginHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#555" }, tab: { flex: 1, alignItems: "center", paddingVertical: 12, borderBottomWidth: 2 }, panel: { padding: 14 }, stats: { flexDirection: "row", gap: 7, marginBottom: 12 }, stat: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 9 }, input: { borderWidth: 1, borderRadius: 10, minHeight: 42, paddingHorizontal: 11, paddingVertical: 9, fontSize: 14, marginTop: 8 }, multiline: { minHeight: 85, textAlignVertical: "top" }, wrap: { flexDirection: "row", flexWrap: "wrap", gap: 7, paddingVertical: 8 }, filterChip: { borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 18 }, smallButton: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, alignSelf: "flex-start" }, empty: { borderWidth: 1, borderRadius: 14, minHeight: 140, alignItems: "center", justifyContent: "center", padding: 18, marginTop: 12 }, trafficRow: { borderWidth: 1, borderRadius: 12, padding: 11, flexDirection: "row", alignItems: "center", gap: 10, marginTop: 7 }, ruleRow: { borderWidth: 1, borderRadius: 12, padding: 11, flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }, sectionTitle: { fontSize: 17, fontWeight: "800" }, rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, row: { flexDirection: "row", alignItems: "center", gap: 8 }, smallAction: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10 }, preset: { borderWidth: 1, borderRadius: 12, padding: 12, flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 }, label: { fontSize: 12, fontWeight: "700", marginTop: 12 }, detail: { flex: 1, paddingHorizontal: 12, paddingBottom: 8 }, detailSection: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 9 }, modalBackdrop: { flex: 1, justifyContent: "center", padding: 16 }, editor: { maxHeight: "92%", borderWidth: 1, borderRadius: 18, padding: 15 }, onboarding: { borderWidth: 1, borderRadius: 18, padding: 18 }, primaryButton: { alignSelf: "flex-end", paddingVertical: 11, paddingHorizontal: 17, borderRadius: 11, marginTop: 12 }, dangerButton: { marginTop: 24, minHeight: 44, borderWidth: 1, borderRadius: 11, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }, busy: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
