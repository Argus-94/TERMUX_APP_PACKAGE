import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { useProjectContext } from "../components/ProjectContext";
import { getRuntimeFacade } from "../lib/runtime-facade";
import { executeGuardedTermuxCommand } from "../lib/termux-executor";
import { privateRuntimeProvider } from "../lib/private-runtime-provider";
import { persistentLogger } from "../lib/persistent-logger";
import { getTermuxCommandWaitState } from "../lib/termux-command-wait-status";
import { subscribeTerminalOutput, type TerminalBusEvent } from "../core/terminal/TerminalOutputBus";
import { TerminalQuickActions } from "../core/enhancements/terminal/TerminalQuickActions";
import type { TerminalQuickActionId, TerminalSessionSnapshot, TerminalThemeDefinition, TerminalFontPreferences } from "../core/enhancements/terminal/types";
import { applyTerminalCommandInputAction, createTerminalCommandInputState, insertTerminalCommandText } from "../core/enhancements/terminal/TerminalCommandInputActions";
import { parseAnsiText } from "../core/enhancements/terminal/AnsiParser";
import { TerminalPreferencesPanel } from "../components/RuntimeEnhancementPanels";
import { EmbeddedTermuxTerminalView } from "../components/EmbeddedTermuxTerminalView";

const QUICK_ACTIONS_KEY = "aib.terminal.quick-actions.v1";
const label = (language: "ru" | "uk" | "en", ru: string, uk: string, en: string) => language === "ru" ? ru : language === "uk" ? uk : en;

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { language } = useLanguage();
  const { colors } = useTheme();
  const { project } = useProjectContext();
  const projectId = project?.id || project?.name || "demo";
  const projectRoot = typeof project?.path === "string" ? project.path : undefined;
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [sessions, setSessions] = useState<readonly TerminalSessionSnapshot[]>([]);
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const [commandSelection, setCommandSelection] = useState({ start: 0, end: 0 });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState<TerminalThemeDefinition | null>(null);
  const [font, setFont] = useState<TerminalFontPreferences>({ family: "monospace", size: 14, lineHeight: 1.35, letterSpacing: 0 });
  const [toolbarVisible, setToolbarVisible] = useState(true);
  // Both modes remain in the embedded private Termux runtime.
  const [embeddedMode, setEmbeddedMode] = useState(true);
  const [customizing, setCustomizing] = useState(false);
  const [actionsReady, setActionsReady] = useState(false);
  const [visibleActions, setVisibleActions] = useState<readonly TerminalQuickActionId[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const probeAbortControllerRef = useRef<AbortController | null>(null);
  const screenMountedRef = useRef(true);
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeCancelling, setProbeCancelling] = useState(false);
  const [commandElapsedSeconds, setCommandElapsedSeconds] = useState(0);
  const commandStartedAtRef = useRef<number | null>(null);
  const outputRef = useRef("");
  const inputStateRef = useRef(createTerminalCommandInputState());
  const commandHistoryRef = useRef<string[]>([]);
  const commandInputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollMetricsRef = useRef({ offset: 0, viewportHeight: 0 });

  const refreshSessionRows = useCallback(async () => {
    const rows = await getRuntimeFacade().terminalUx.list();
    setSessions(rows.filter((item) => item.projectId === projectId && (!projectRoot || item.projectRoot === undefined || item.projectRoot === projectRoot)));
    const active = rows.find((item) => item.id === sessionIdRef.current);
    if (active) setSession(active);
  }, [projectId, projectRoot]);
  const activateSession = useCallback((selected: TerminalSessionSnapshot) => {
    sessionIdRef.current = selected.id;
    setSession(selected);
    outputRef.current = selected.scrollback;
    setOutput(selected.scrollback);
    setNotice("");
  }, []);
  const refreshPreferences = useCallback(async () => {
    const facade = getRuntimeFacade();
    const [activeTheme, preferences] = await Promise.all([facade.terminalTheme.getActiveTheme(), facade.terminalFont.getPreferences()]);
    setTheme(activeTheme); setFont(preferences);
  }, []);
  const selectOrCreateSession = useCallback(async () => {
    const facade = getRuntimeFacade();
    const rows = await facade.terminalUx.list();
    let selected = rows.find((item) => item.projectId === projectId && item.state === "attached" && Boolean(facade.terminals?.has(item.id)) && (!projectRoot || item.projectRoot === projectRoot));
    if (!selected) {
      const saved = rows.find((item) => item.projectId === projectId && !facade.terminals?.has(item.id));
      if (saved) selected = await facade.terminalUx.restoreSession(saved.id, projectRoot);
    }
    if (!selected || selected.state !== "attached") selected = await facade.terminalUx.openProjectSession(projectId, projectRoot);
    activateSession(selected);
    await refreshSessionRows();
  }, [activateSession, projectId, projectRoot, refreshSessionRows]);
  const createNewSession = useCallback(async () => {
    setBusy(true);
    try {
      const selected = await getRuntimeFacade().terminalUx.openProjectSession(projectId, projectRoot);
      activateSession(selected);
      await refreshSessionRows();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }, [activateSession, projectId, projectRoot, refreshSessionRows]);
  const selectSession = useCallback(async (row: TerminalSessionSnapshot) => {
    if (busy) return;
    setBusy(true);
    try {
      const facade = getRuntimeFacade();
      const isAttached = row.state === "attached" && Boolean(facade.terminals?.has(row.id));
      const rootMatches = !projectRoot || row.projectRoot === projectRoot;
      const selected = isAttached && rootMatches ? row : isAttached
        ? await facade.terminalUx.openProjectSession(projectId, projectRoot)
        : await facade.terminalUx.restoreSession(row.id, projectRoot);
      if (!selected || selected.state !== "attached") { setNotice(label(language, "Сессия сейчас недоступна.", "Сесія зараз недоступна.", "This session is currently unavailable.")); return; }
      activateSession(selected);
      await refreshSessionRows();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }, [activateSession, busy, language, projectRoot, refreshSessionRows]);
  const closeCurrentSession = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id || busy) return;
    setBusy(true);
    try {
      await getRuntimeFacade().terminalUx.close(id);
      sessionIdRef.current = null; setSession(null); outputRef.current = ""; setOutput("");
      await refreshSessionRows();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }, [busy, refreshSessionRows]);

  const commitCommandInput = useCallback((next: ReturnType<typeof createTerminalCommandInputState>) => {
    inputStateRef.current = next;
    setCommand(next.value);
    setCommandSelection(next.selection);
  }, []);
  const changeCommandInput = useCallback((value: string) => {
    const previous = inputStateRef.current.value;
    let prefix = 0;
    while (prefix < previous.length && prefix < value.length && previous[prefix] === value[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < previous.length - prefix && suffix < value.length - prefix && previous[previous.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix += 1;
    const cursor = Math.min(value.length, prefix + value.length - prefix - suffix);
    commitCommandInput({ value, selection: { start: cursor, end: cursor }, historyIndex: -1, draftBeforeHistory: value });
  }, [commitCommandInput]);

  const dispatchQuickAction = useCallback(async (action: TerminalQuickActionId) => {
    if (action === "clear") { outputRef.current = ""; setOutput(""); const id = sessionIdRef.current; if (id) await getRuntimeFacade().terminalUx.clearScrollback(id); return { ok: true, supported: true }; }
    if (action === "copy-all") { await Clipboard.setStringAsync(outputRef.current); setNotice(label(language, "Вывод скопирован.", "Вивід скопійовано.", "Terminal output copied.")); return { ok: true, supported: true }; }
    if (action === "paste") {
      const clip = await Clipboard.getStringAsync();
      const current = inputStateRef.current;
      const selectedLength = current.selection.end - current.selection.start;
      const available = Math.max(0, 16_000 - current.value.length + selectedLength);
      const inserted = insertTerminalCommandText(current, clip.slice(0, available));
      commitCommandInput({ ...inserted, historyIndex: -1, draftBeforeHistory: inserted.value });
      commandInputRef.current?.focus();
      return { ok: true, supported: true };
    }
    if (action === "new-session") { await createNewSession(); return { ok: true, supported: true }; }
    const result = applyTerminalCommandInputAction(action, inputStateRef.current, commandHistoryRef.current);
    if (!result.supported) return { ok: false, supported: false, reason: result.reason };
    if (result.effect) {
      const { offset, viewportHeight } = scrollMetricsRef.current;
      const direction = result.effect === "page-up" ? -1 : 1;
      scrollRef.current?.scrollTo({ y: Math.max(0, offset + direction * Math.max(1, viewportHeight)), animated: true });
    } else {
      commitCommandInput(result.state);
      commandInputRef.current?.focus();
    }
    return { ok: true, supported: true };
  }, [commitCommandInput, createNewSession, language]);
  const quickActions = useMemo(() => new TerminalQuickActions(dispatchQuickAction), [dispatchQuickAction]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([refreshPreferences(), selectOrCreateSession()]).catch((error: unknown) => { if (mounted) setNotice(error instanceof Error ? error.message : String(error)); });
    const unsubscribe = subscribeTerminalOutput((event: TerminalBusEvent) => {
      if (!event.sessionId || !event.data) return;
      const chunk = event.stream === "stderr" ? `\n${event.data}` : event.data;
      if (event.sessionId !== sessionIdRef.current) return;
      outputRef.current = `${outputRef.current}${chunk}`.slice(-24_000);
      setOutput(outputRef.current);
    });
    return () => { mounted = false; unsubscribe(); };
  }, [refreshPreferences, selectOrCreateSession]);

  useEffect(() => {
    screenMountedRef.current = true;
    return () => {
      screenMountedRef.current = false;
      probeAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!busy || commandStartedAtRef.current === null) return;
    const updateElapsed = () => setCommandElapsedSeconds(Math.floor((Date.now() - (commandStartedAtRef.current ?? Date.now())) / 1000));
    updateElapsed();
    const timer = setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    let mounted = true;
    const catalog = quickActions.all().map((action) => action.id);
    void AsyncStorage.getItem(QUICK_ACTIONS_KEY).then((raw) => {
      if (!mounted) return;
      let ids = catalog;
      try { if (raw) { const parsed: unknown = JSON.parse(raw); if (Array.isArray(parsed)) ids = parsed.filter((id): id is TerminalQuickActionId => typeof id === "string" && catalog.includes(id as TerminalQuickActionId)); } } catch { /* corrupt preference falls back to the full allowlist */ }
      quickActions.setVisible(ids); setVisibleActions(ids); setActionsReady(true);
    }).catch(() => { if (mounted) { quickActions.setVisible(catalog); setVisibleActions(catalog); setActionsReady(true); } });
    return () => { mounted = false; };
  }, [quickActions]);

  const toggleQuickAction = useCallback(async (id: TerminalQuickActionId) => {
    const catalog = quickActions.all().map((action) => action.id);
    const current = new Set(actionsReady ? visibleActions : catalog);
    if (current.has(id)) current.delete(id); else current.add(id);
    const next = catalog.filter((item) => current.has(item));
    quickActions.setVisible(next); setVisibleActions(next); setActionsReady(true);
    await AsyncStorage.setItem(QUICK_ACTIONS_KEY, JSON.stringify(next)).catch(() => undefined);
  }, [actionsReady, quickActions, visibleActions]);

  const runCommand = useCallback(async () => {
    const input = command.trim();
    if (!input || busy) return;
    commandStartedAtRef.current = Date.now();
    setCommandElapsedSeconds(0);
    setBusy(true);
    setNotice("");
    let id = sessionIdRef.current;
    try {
      if (!id) {
        const created = await getRuntimeFacade().terminalUx.openProjectSession(projectId, projectRoot);
        id = created.id;
        activateSession(created);
      }
      commitCommandInput(createTerminalCommandInputState());
      if (commandHistoryRef.current[0] !== input) commandHistoryRef.current = [input, ...commandHistoryRef.current].slice(0, 100);
      const prompt = `\n$ ${input}\n`;
      outputRef.current = `${outputRef.current}${prompt}`.slice(-24_000);
      setOutput(outputRef.current);
      await getRuntimeFacade().terminalUx.send(id, `${input}\n`, prompt);
      await refreshSessionRows();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(detail);
      if (id) {
        const suffix = `\n[command failed: ${detail}]\n`;
        outputRef.current = `${outputRef.current}${suffix}`.slice(-24_000); setOutput(outputRef.current);
        await getRuntimeFacade().terminalUx.appendScrollback(id, suffix).catch(() => undefined);
      }
    } finally {
      commandStartedAtRef.current = null;
      setCommandElapsedSeconds(0);
      setBusy(false);
    }
  }, [activateSession, busy, command, commitCommandInput, projectId, projectRoot, refreshSessionRows]);

  const runEmbeddedRuntimeProbe = useCallback(async () => {
    if (busy || probeAbortControllerRef.current) return;
    const controller = new AbortController();
    probeAbortControllerRef.current = controller;
    setProbeRunning(true);
    setProbeCancelling(false);
    setBusy(true);
    setNotice("");
    const probe = `set -euo pipefail
case "$PREFIX:$HOME" in
  /data/data/com.karat.aibuilder/files/usr:/data/data/com.karat.aibuilder/files/home|/data/user/0/com.karat.aibuilder/files/usr:/data/user/0/com.karat.aibuilder/files/home) echo AIB_PRIVATE_NAMESPACE_OK ;;
  *) echo AIB_PRIVATE_NAMESPACE_MISSING; exit 42 ;;
esac
printf 'AIB_PRIVATE_EXEC_OK\\nPREFIX=%s\\nHOME=%s\\n' "$PREFIX" "$HOME"
"$PREFIX/bin/bash" --version | head -n 1
"$PREFIX/bin/apt" --version | head -n 1
"$PREFIX/bin/dpkg" --version | head -n 1`;
    try {
      const result = await privateRuntimeProvider.execute(probe, {
        timeoutMs: 25_000,
        trustedInternal: true,
        preserveOutput: true,
        signal: controller.signal,
      });
      const passed = result.exitCode === 0 && !result.timedOut && !result.outputTruncated &&
        result.stdout.includes("AIB_PRIVATE_EXEC_OK") && result.stdout.includes("AIB_PRIVATE_NAMESPACE_OK");
      const status = passed
        ? label(language, "Проверка private exec прошла.", "Перевірка private exec пройшла.", "Private exec probe passed.")
        : label(language, `Проверка private exec не пройдена (exit ${result.exitCode}).`, `Перевірка private exec не пройдена (exit ${result.exitCode}).`, `Private exec probe failed (exit ${result.exitCode}).`);
      if (screenMountedRef.current) setNotice(`${status}${result.timedOut ? " · timeout" : ""}${result.outputTruncated ? " · output truncated" : ""}\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`.slice(0, 3_000));
    } catch (error) {
      if (screenMountedRef.current) {
        const detail = error instanceof Error ? error.message : String(error);
        setNotice(controller.signal.aborted || detail === "ABORTED"
          ? label(language, "Отмена проверки запрошена; native one-shot запрос завершился.", "Скасування перевірки запитано; native one-shot запит завершився.", "Probe cancellation requested; the native one-shot request settled.")
          : label(language, "Встроенная приватная среда не выполнила команду.", "Вбудоване приватне середовище не виконало команду.", "The embedded private runtime did not execute the command.") + `\n${detail}`);
      }
    } finally {
      if (probeAbortControllerRef.current === controller) probeAbortControllerRef.current = null;
      if (screenMountedRef.current) {
        setProbeRunning(false);
        setProbeCancelling(false);
        setBusy(false);
      }
    }
  }, [busy, language]);

  const cancelEmbeddedRuntimeProbe = useCallback(() => {
    const controller = probeAbortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setProbeCancelling(true);
    controller.abort();
  }, []);

  const toggleTerminalMode = useCallback(() => {
    // Do not hide probe cancellation or switch away from a pending command.
    if (busy || probeAbortControllerRef.current) {
      persistentLogger.add("info", "TerminalUI", JSON.stringify({ event: "mode-switch", outcome: "blocked", reason: "operation-pending" }));
      return;
    }
    persistentLogger.add("info", "TerminalUI", JSON.stringify({ event: "mode-switch", from: embeddedMode ? "pty" : "command", to: embeddedMode ? "command" : "pty", backend: "embedded-private" }));
    setEmbeddedMode((value) => !value);
    setNotice("");
  }, [busy, embeddedMode]);

  const toolbarActions = actionsReady ? quickActions.list() : quickActions.all();
  const isUnsupportedAction = (id: TerminalQuickActionId) => id === "ctrl" || id === "alt" || id === "kill-process";
  const emptyOutput = label(language, "Введите команду ниже. Выполнение остаётся в встроенной приватной среде.", "Введіть команду нижче. Виконання залишається у вбудованому приватному середовищі.", "Enter a command below. Execution stays in the embedded private environment.");
  const outputSegments = useMemo(() => parseAnsiText(output || emptyOutput, theme?.ansi ?? [], theme?.foreground ?? "#E6E8EF", theme?.background ?? "#111318"), [emptyOutput, output, theme]);
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={insets.top + 12}>
    <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8, paddingHorizontal: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={label(language, "Назад", "Назад", "Back")} onPress={() => { const historyAvailable = router.canGoBack(); persistentLogger.add("info", "TerminalUI", JSON.stringify({ event: "back", target: historyAvailable ? "history" : "runtime" })); if (historyAvailable) router.back(); else router.replace("/runtime"); }} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 8 }}><Ionicons name="arrow-back" size={18} color={colors.accent} /></TouchableOpacity>
        <View style={{ flex: 1 }}><Text style={{ color: colors.inkBright, fontWeight: "800", fontSize: 17 }}>{label(language, "Консоль", "Консоль", "Console")}</Text><Text numberOfLines={1} style={{ color: colors.muted, fontSize: 10 }}>{session ? `session ${session.id} · ${session.cwd}` : `project ${projectId}`}</Text></View>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy }} accessibilityLabel={embeddedMode ? label(language, "Переключить на Termux: команды по одной", "Перемкнути на Termux: команди по одній", "Switch to Termux: one-shot commands") : label(language, "Переключить на интерактивный PTY", "Перемкнути на інтерактивний PTY", "Switch to interactive PTY")} onPress={toggleTerminalMode} disabled={busy} style={{ opacity: busy ? 0.5 : 1 }}><Text style={{ color: colors.accent, fontSize: 10, borderWidth: 1, borderColor: colors.accent, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6 }}>{embeddedMode ? "PTY" : "Termux"}</Text></TouchableOpacity>
        <TouchableOpacity accessibilityLabel={label(language, "Новая сессия", "Нова сесія", "New session")} onPress={() => void createNewSession()} disabled={busy} style={{ padding: 6 }}><Ionicons name="add-circle-outline" size={23} color={colors.accent} /></TouchableOpacity>
        <TouchableOpacity accessibilityLabel={label(language, "Закрыть сессию", "Закрити сесію", "Close session")} onPress={() => void closeCurrentSession()} disabled={busy || !session} style={{ padding: 6 }}><Ionicons name="close-circle-outline" size={22} color={colors.muted} /></TouchableOpacity>
      </View>
      <Text style={{ color: colors.muted, fontSize: 11 }}>{embeddedMode
        ? label(language, "PTY выполняет команды только во встроенной приватной среде. Её готовность проверяется на экране Runtime; установка пакетов и сборка не подтверждены до квалификации feed и toolchain.", "PTY виконує команди лише у вбудованому приватному середовищі. Його готовність перевіряється на екрані Runtime; встановлення пакетів і збирання не підтверджені до кваліфікації feed і toolchain.", "PTY executes commands only in the embedded private runtime. Check readiness on Runtime; package installation and builds are unconfirmed until the feed and toolchain are qualified.")
        : label(language, "Termux выполняет команды по одной в той же встроенной приватной среде. Нажмите Termux, чтобы вернуться в интерактивный PTY.", "Termux виконує команди по одній у тому самому вбудованому приватному середовищі. Натисніть Termux, щоб повернутися до інтерактивного PTY.", "Termux runs one-shot commands in the same embedded private runtime. Tap Termux to return to interactive PTY.")}</Text>
      {embeddedMode ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy }} onPress={() => void runEmbeddedRuntimeProbe()} disabled={busy} style={{ borderWidth: 1, borderColor: colors.accent, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, opacity: busy ? 0.5 : 1 }}><Text style={{ color: colors.accent, fontSize: 11 }}>{probeRunning ? label(language, "Проверка…", "Перевірка…", "Checking…") : label(language, "Проверить запуск bash / apt / dpkg", "Перевірити запуск bash / apt / dpkg", "Probe bash / apt / dpkg execution")}</Text></TouchableOpacity>
        {probeRunning ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={label(language, "Отменить проверку private runtime", "Скасувати перевірку private runtime", "Cancel private runtime probe")} accessibilityState={{ disabled: probeCancelling }} onPress={cancelEmbeddedRuntimeProbe} disabled={probeCancelling} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, opacity: probeCancelling ? 0.5 : 1 }}><Text style={{ color: colors.inkBright, fontSize: 11 }}>{probeCancelling ? label(language, "Отмена…", "Скасування…", "Cancelling…") : label(language, "Отменить", "Скасувати", "Cancel probe")}</Text></TouchableOpacity> : null}
      </View> : null}
      {sessions.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>{sessions.map((row) => <TouchableOpacity key={row.id} onPress={() => void selectSession(row)} disabled={busy} style={{ borderWidth: 1, borderColor: session?.id === row.id ? colors.accent : colors.line, backgroundColor: session?.id === row.id ? colors.accentDim : colors.surface, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6, opacity: busy ? 0.6 : 1 }}><Text numberOfLines={1} style={{ maxWidth: 155, color: colors.inkBright, fontSize: 10 }}>{row.cwd.split("/").pop() || row.projectId} · {row.state}</Text></TouchableOpacity>)}</ScrollView> : null}
      {embeddedMode ? <View style={{ flex: 1, minHeight: 220, borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden" }}>
        <EmbeddedTermuxTerminalView style={{ flex: 1, minHeight: 220 }} workingDirectory={session?.cwd} projectRoot={session?.projectRoot} sessionId={session?.id ?? ""} enabled={!!session && session.state === "attached" && !!session.cwd} fontSize={font.size} language={language} />
      </View> : <>
      <ScrollView ref={scrollRef} onLayout={(event) => { scrollMetricsRef.current.viewportHeight = event.nativeEvent.layout.height; }} onScroll={(event) => { scrollMetricsRef.current.offset = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })} style={{ flex: 1, minHeight: 110, borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: theme?.background ?? "#111318" }} contentContainerStyle={{ padding: 10 }}>
        <Text selectable style={{ color: theme?.foreground ?? "#E6E8EF", fontFamily: font.family, fontSize: font.size, lineHeight: font.size * font.lineHeight, letterSpacing: font.letterSpacing }}>{outputSegments.map((segment, index) => <Text key={index} style={segment.style}>{segment.text}</Text>)}</Text>
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors.muted, fontSize: 10, flex: 1 }}>{label(language, "Быстрые действия", "Швидкі дії", "Quick actions")}</Text>
        <TouchableOpacity onPress={() => setCustomizing((value) => !value)}><Text style={{ color: colors.accent, fontSize: 10 }}>{customizing ? label(language, "Готово", "Готово", "Done") : label(language, "Настроить", "Налаштувати", "Customize")}</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => setToolbarVisible((value) => !value)}><Text style={{ color: colors.accent, fontSize: 10 }}>{toolbarVisible ? label(language, "Скрыть", "Сховати", "Hide") : label(language, "Показать", "Показати", "Show")}</Text></TouchableOpacity>
      </View>
      {customizing ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>{quickActions.all().map((action) => { const visible = (actionsReady ? visibleActions : quickActions.all().map((item) => item.id)).includes(action.id); return <TouchableOpacity key={action.id} onPress={() => void toggleQuickAction(action.id)} style={{ borderWidth: 1, borderColor: visible ? colors.accent : colors.line, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 5 }}><Text style={{ color: visible ? colors.inkBright : colors.muted, fontSize: 10 }}>{visible ? "✓ " : ""}{action.label}</Text></TouchableOpacity>; })}</View> : null}
      {toolbarVisible ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>{toolbarActions.map((action) => { const unsupported = isUnsupportedAction(action.id); const disabled = unsupported || (busy && action.id === "new-session"); return <TouchableOpacity key={action.id} accessibilityRole="button" accessibilityState={{ disabled }} accessibilityLabel={`${action.label}${unsupported ? label(language, ", недоступно без интерактивного PTY", ", недоступно без інтерактивного PTY", ", unavailable without an interactive PTY") : ""}`} disabled={disabled} onPress={() => void quickActions.execute(action.id).then((result) => { if (!result.supported) setNotice(result.reason ?? label(language, "Действие недоступно.", "Дія недоступна.", "Action unavailable.")); }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))} style={{ borderWidth: 1, borderColor: action.kind === "key" ? colors.line : colors.accent, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 5, opacity: unsupported ? 0.38 : busy && action.id === "new-session" ? 0.5 : 1 }}><Text style={{ color: colors.inkBright, fontSize: 10 }}>{action.label}</Text></TouchableOpacity>; })}</View> : null}
      {toolbarVisible ? <Text style={{ color: colors.muted, fontSize: 9 }}>{label(language, "Ctrl, Alt и Kill Process недоступны: адаптер не предоставляет интерактивный PTY или управляемый PID. Стрелки работают с историей/курсор команды; PgUp/PgDn — с выводом.", "Ctrl, Alt і Kill Process недоступні: адаптер не має інтерактивного PTY або керованого PID. Стрілки працюють з історією/курсор команди; PgUp/PgDn — з виводом.", "Ctrl, Alt and Kill Process are unavailable: the adapter exposes no interactive PTY or cancellable PID. Arrows edit command history/cursor; PgUp/PgDn scroll output.")}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 7 }}>
        <TextInput ref={commandInputRef} value={command} selection={commandSelection} selectionColor={theme?.selection ?? colors.accent} cursorColor={theme?.cursor ?? colors.accent} onChangeText={changeCommandInput} onSelectionChange={(event) => { const selection = event.nativeEvent.selection; const current = inputStateRef.current; commitCommandInput({ ...current, selection: { start: selection.start, end: selection.end } }); }} onSubmitEditing={() => void runCommand()} editable={!busy} multiline autoCapitalize="none" autoCorrect={false} blurOnSubmit={false} returnKeyType="send" placeholder={label(language, "Команда…", "Команда…", "Command…")} placeholderTextColor={colors.muted} style={{ flex: 1, maxHeight: 110, color: colors.inkBright, fontFamily: font.family, fontSize: font.size, borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9 }} />
        <TouchableOpacity onPress={() => void runCommand()} disabled={busy || !command.trim()} style={{ borderRadius: 10, backgroundColor: colors.accent, padding: 11, opacity: busy || !command.trim() ? 0.5 : 1 }}><Ionicons name="play" size={18} color="#FFFFFF" /></TouchableOpacity>
      </View>
      {busy ? <Text style={{ color: colors.muted, fontSize: 10 }}>{commandStartedAtRef.current !== null
        ? getTermuxCommandWaitState(commandElapsedSeconds) === "waiting-for-result"
          ? label(language,
            `Результат вбудованого середовища не отримано за ${commandElapsedSeconds} с. Heartbeat не подтверждает, что команда работает или выдаёт вывод. Проверьте состояние встроенного runtime на экране Runtime.`,
            `Вбудоване середовище не повернуло результат за ${commandElapsedSeconds} с. Heartbeat не підтверджує, що команда виконується або видає вивід. Перевірте стан вбудованого runtime на екрані Runtime.`,
            `No result from the embedded runtime after ${commandElapsedSeconds}s. Heartbeats do not prove the command is running or producing output. Check the embedded runtime status on the Runtime screen.`)
          : label(language,
            `Выполняется во встроенной среде… ${commandElapsedSeconds} с. Вывод появится после завершения; для команд, ожидающих ввод, используйте PTY.`,
            `Виконується у вбудованому середовищі… ${commandElapsedSeconds} с. Вивід з’явиться після завершення; для команд, що чекають на ввід, використовуйте PTY.`,
            `Running in embedded runtime… ${commandElapsedSeconds}s. Output appears when the command finishes; use PTY for commands that wait for input.`)
        : label(language, "Выполняется…", "Виконується…", "Running…")}</Text> : null}
      {notice ? <Text selectable style={{ color: colors.muted, fontSize: 10 }}>{notice}</Text> : null}
      </>}
      {embeddedMode && notice ? <Text selectable style={{ color: colors.muted, fontSize: 10, maxHeight: 110 }}>{notice}</Text> : null}
      <TerminalPreferencesPanel colors={colors} language={language} compact onThemeChanged={setTheme} onFontChanged={setFont} />
    </View>
  </KeyboardAvoidingView>;
}
