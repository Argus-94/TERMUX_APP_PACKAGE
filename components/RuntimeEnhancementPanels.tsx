import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppLanguage } from "../lib/i18n";
import { getRuntimeFacade } from "../lib/runtime-facade";
import type { RuntimeLiveSnapshot } from "../core/enhancements/runtime-status/types";
import type { PortForwardStatus } from "../core/enhancements/networking/types";
import type { TerminalFontPreferences, TerminalThemeDefinition } from "../core/enhancements/terminal/types";
import { getPermissionsOnboarding } from "../lib/permissions-onboarding";
import { GOLD } from "../theme/colors";

export type EnhancementPanelColors = Readonly<{ background: string; surface: string; surfaceRaised?: string; inkBright: string; muted: string; line: string; accent: string; warning?: string; danger?: string }>;
const text = (language: AppLanguage, ru: string, uk: string, en: string): string => language === "ru" ? ru : language === "uk" ? uk : en;

function ActionButton({ label, onPress, colors, disabled = false }: { label: string; onPress: () => void; colors: EnhancementPanelColors; disabled?: boolean }) {
  return <TouchableOpacity onPress={onPress} disabled={disabled} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, opacity: disabled ? 0.45 : 1, backgroundColor: colors.surfaceRaised ?? colors.surface }}><Text style={{ color: colors.inkBright, fontWeight: "600", fontSize: 12 }}>{label}</Text></TouchableOpacity>;
}

/** Shows a soft runtime notice only when a previously granted permission was later revoked. */
export function RevokedPermissionsNotice({ colors, language }: { colors: EnhancementPanelColors; language: AppLanguage }) {
  const router = useRouter();
  const [revoked, setRevoked] = useState<readonly string[]>([]);
  useFocusEffect(useCallback(() => {
    let current = true;
    void getPermissionsOnboarding().refresh().then((state) => { if (current) setRevoked(state.revoked); }).catch(() => { if (current) setRevoked([]); });
    return () => { current = false; };
  }, []));
  if (revoked.length === 0) return null;
  return <View style={{ borderWidth: 1, borderColor: colors.warning ?? GOLD, borderRadius: 12, padding: 12, gap: 8, backgroundColor: colors.surface }}>
    <Text style={{ color: colors.inkBright, fontWeight: "700", fontSize: 13 }}>{text(language, "Доступ изменился", "Доступ змінився", "A permission changed")}</Text>
    <Text style={{ color: colors.muted, fontSize: 11 }}>{text(language, "Ранее выданное разрешение теперь недоступно. Основные функции продолжают работать; обзор нужен только для соответствующей возможности.", "Раніше наданий дозвіл тепер недоступний. Основні функції продовжують працювати.", "A previously granted permission is no longer available. Core features continue to work; review only if you need that feature.")} {revoked.join(", ")}</Text>
    <ActionButton label={text(language, "Проверить разрешения", "Перевірити дозволи", "Review permissions")} colors={colors} onPress={() => router.push("/permissions-onboarding")} />
  </View>;
}

/** Theme/font controls shared by Runtime and the in-app command terminal. */
export function TerminalPreferencesPanel({ colors, language, compact = false, onThemeChanged, onFontChanged }: { colors: EnhancementPanelColors; language: AppLanguage; compact?: boolean; onThemeChanged?: (theme: TerminalThemeDefinition) => void; onFontChanged?: (font: TerminalFontPreferences) => void }) {
  const [themes, setThemes] = useState<readonly TerminalThemeDefinition[]>([]);
  const [activeId, setActiveId] = useState("dark");
  const [font, setFont] = useState<TerminalFontPreferences>({ family: "monospace", size: 14, lineHeight: 1.35, letterSpacing: 0 });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void Promise.all([getRuntimeFacade().terminalTheme.getActiveTheme(), getRuntimeFacade().terminalFont.getPreferences()]).then(([theme, preferences]) => {
      if (!mounted) return;
      setThemes(getRuntimeFacade().terminalTheme.listThemes()); setActiveId(theme.id); setFont(preferences);
    }).catch((value: unknown) => { if (mounted) setError(value instanceof Error ? value.message : String(value)); });
    return () => { mounted = false; };
  }, []);
  const chooseTheme = useCallback(async (id: string) => { try { const theme = await getRuntimeFacade().terminalTheme.setActiveTheme(id); setActiveId(theme.id); onThemeChanged?.(theme); setError(null); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } }, [onThemeChanged]);
  const updateFont = useCallback(async (next: Partial<TerminalFontPreferences>) => { try { const preferences = await getRuntimeFacade().terminalFont.setPreferences(next); setFont(preferences); onFontChanged?.(preferences); setError(null); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } }, [onFontChanged]);
  return <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, gap: 8, backgroundColor: colors.surface }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Ionicons name="color-palette-outline" size={18} color={colors.accent} /><Text style={{ color: colors.inkBright, fontWeight: "700", fontSize: 14 }}>{text(language, "Оформление терминала", "Оформлення термінала", "Terminal appearance")}</Text></View>
    <Text style={{ color: colors.muted, fontSize: 11 }}>{text(language, "Настройки сохраняются локально. Шрифты — системные моноширинные, bundled-шрифты не предполагаются.", "Налаштування зберігаються локально. Шрифти — системні моноширинні.", "Preferences stay local. Fonts use system monospace families; no bundled font is assumed.")}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{themes.map((theme) => <TouchableOpacity key={theme.id} onPress={() => void chooseTheme(theme.id)} accessibilityRole="button" accessibilityState={{ selected: activeId === theme.id }} style={{ borderWidth: 1, borderColor: activeId === theme.id ? colors.accent : colors.line, borderRadius: 16, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: theme.background }}><Text style={{ color: theme.foreground, fontSize: 11, fontWeight: activeId === theme.id ? "800" : "500" }}>{theme.name}</Text></TouchableOpacity>)}</View>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7 }}>
      <Text style={{ color: colors.inkBright, fontSize: 12 }}>{text(language, "Шрифт", "Шрифт", "Font")}</Text>
      {getRuntimeFacade().terminalFont.listFamilies().map((family) => <TouchableOpacity key={family} onPress={() => void updateFont({ family })} style={{ borderWidth: 1, borderColor: font.family === family ? colors.accent : colors.line, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 5 }}><Text style={{ color: colors.inkBright, fontSize: 10 }}>{family}</Text></TouchableOpacity>)}
      <ActionButton label="−" colors={colors} disabled={font.size <= 12} onPress={() => void updateFont({ size: font.size - 1 })} />
      <Text style={{ color: colors.inkBright, fontSize: 12 }}>{font.size} pt</Text>
      <ActionButton label="+" colors={colors} disabled={font.size >= 22} onPress={() => void updateFont({ size: font.size + 1 })} />
    </View>
    {error ? <Text style={{ color: colors.danger ?? "#DC2626", fontSize: 11 }}>{error}</Text> : null}
    {compact ? null : <Text style={{ color: colors.muted, fontSize: 10 }}>{text(language, "Активная тема и размер применяются к встроенному command terminal; interactive PTY-клавиши зависят от host adapter.", "Активна тема й розмір застосовуються у вбудованому command terminal.", "The active theme and size apply to the in-app command terminal. Interactive PTY keys depend on the host adapter.")}</Text>}
  </View>;
}

/** Cached runtime status: updates are subscriber-driven and RAM/battery remain explicitly unavailable. */
export function RuntimeStatusPanel({ colors, language, onDetails }: { colors: EnhancementPanelColors; language: AppLanguage; onDetails?: () => void }) {
  const [snapshot, setSnapshot] = useState<RuntimeLiveSnapshot | null>(() => getRuntimeFacade().runtimeLiveStatus.getSnapshot());
  const [showDetails, setShowDetails] = useState(false);
  useFocusEffect(useCallback(() => getRuntimeFacade().runtimeLiveStatus.subscribe(setSnapshot), []));
  const running = snapshot?.containers.filter((item) => item.state === "running").length ?? 0;
  const sleeping = snapshot?.containers.filter((item) => item.state === "sleeping").length ?? 0;
  return <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, gap: 8, backgroundColor: colors.surface }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Ionicons name="pulse-outline" size={18} color={colors.accent} /><Text style={{ color: colors.inkBright, fontWeight: "700", fontSize: 14 }}>{text(language, "Живой статус runtime", "Живий статус runtime", "Runtime live status")}</Text><View style={{ flex: 1 }} />{snapshot ? <Text style={{ color: colors.muted, fontSize: 10 }}>{new Date(snapshot.timestamp).toLocaleTimeString()}</Text> : <ActivityIndicator size="small" color={colors.accent} />}</View>
    {snapshot ? <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{snapshot.backends.map((backend) => <View key={backend.id} style={{ borderWidth: 1, borderColor: backend.status === "up" ? "#22C55E" : backend.status === "degraded" ? (colors.warning ?? GOLD) : colors.line, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 }}><Text style={{ color: colors.inkBright, fontSize: 11 }}>{backend.id}: {backend.status}{backend.latencyMs === undefined ? "" : ` · ${Math.round(backend.latencyMs)} ms`}</Text></View>)}</View>
      <Text style={{ color: colors.inkBright, fontSize: 12 }}>{text(language, "Контейнеры", "Контейнери", "Containers")}: {running} {text(language, "работает", "працює", "running")} · {sleeping} {text(language, "спит", "спить", "sleeping")} · {snapshot.processes.total} {text(language, "процессов", "процесів", "processes")} · {snapshot.processes.quarantined} quarantined</Text>
      <Text style={{ color: colors.muted, fontSize: 11 }}>{snapshot.resources.memUsedMb === undefined || snapshot.resources.memTotalMb === undefined ? text(language, "RAM: недоступно через имеющиеся bridges", "RAM: недоступно через наявні bridges", "RAM: unavailable through existing bridges") : `RAM: ${snapshot.resources.memUsedMb} / ${snapshot.resources.memTotalMb} MB`} · {snapshot.resources.batteryLevel === undefined ? text(language, "батарея: недоступно", "батарея: недоступно", "battery: unavailable") : `battery: ${snapshot.resources.batteryLevel}%`}</Text>
      <Text style={{ color: colors.inkBright, fontSize: 12 }}>{text(language, "Активные port forwards", "Активні port forwards", "Active port forwards")}: {snapshot.portForwards}</Text>
      {snapshot.unavailable?.length ? <Text style={{ color: colors.warning ?? GOLD, fontSize: 11 }}>{text(language, "Источники статуса недоступны", "Джерела статусу недоступні", "Status sources unavailable")}: {snapshot.unavailable.join(", ")}</Text> : null}
      <Text style={{ color: snapshot.interceptorActive ? colors.accent : colors.muted, fontSize: 12 }}>{text(language, "Traffic Interceptor", "Traffic Interceptor", "Traffic Interceptor")}: {snapshot.interceptorActive ? text(language, "активен", "активний", "active") : text(language, "выключен", "вимкнений", "off")}</Text>
      {snapshot.lastError ? <Text style={{ color: colors.danger ?? "#DC2626", fontSize: 11 }}>{snapshot.lastError}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}><ActionButton label={showDetails ? text(language, "Скрыть детали", "Сховати деталі", "Hide details") : text(language, "Подробнее", "Докладніше", "Details")} colors={colors} onPress={() => setShowDetails((value) => !value)} />{onDetails ? <ActionButton label={text(language, "Журнал", "Журнал", "Timeline")} colors={colors} onPress={onDetails} /> : null}</View>
      {showDetails ? <Text selectable style={{ color: colors.muted, fontSize: 10, fontFamily: "monospace" }}>{JSON.stringify(snapshot, null, 2)}</Text> : null}
    </> : <Text style={{ color: colors.muted, fontSize: 12 }}>{text(language, "Ожидание первого снимка состояния…", "Очікування першого знімка стану…", "Waiting for the first status snapshot…")}</Text>}
  </View>;
}

/** User-facing loopback-only forwarding controls; all status comes from the actual host adapter. */
export function PortForwardPanel({ colors, language }: { colors: EnhancementPanelColors; language: AppLanguage }) {
  const [rows, setRows] = useState<readonly PortForwardStatus[]>([]);
  const lastActiveCount = useRef<number | null>(null);
  const [hostPort, setHostPort] = useState("8080");
  const [targetPort, setTargetPort] = useState("3000");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setRows(await getRuntimeFacade().portForwards.list()); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useFocusEffect(useCallback(() => getRuntimeFacade().runtimeLiveStatus.subscribe((snapshot) => {
    if (lastActiveCount.current === snapshot.portForwards) return;
    lastActiveCount.current = snapshot.portForwards;
    void refresh();
  }), [refresh]));
  const restore = useCallback(async () => { setBusy(true); try { const statuses = await getRuntimeFacade().portForwards.applyAll(); await refresh(); const unsupported = statuses.find((item) => item.state === "unsupported"); const failed = statuses.find((item) => item.state === "error"); const listening = statuses.filter((item) => item.state === "listening").length; setMessage(unsupported?.message ?? failed?.message ?? text(language, `Восстановлено: ${listening}.`, `Відновлено: ${listening}.`, `Restored: ${listening}.`)); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }, [language, refresh]);
  const add = useCallback(async (hostValue = hostPort, targetValue = targetPort) => {
    const numericHostPort = Number(hostValue);
    const numericTargetPort = Number(targetValue);
    if (!Number.isInteger(numericHostPort) || !Number.isInteger(numericTargetPort)) { setMessage(text(language, "Оба порта должны быть целыми числами.", "Обидва порти мають бути цілими числами.", "Both ports must be whole numbers.")); return; }
    setBusy(true); setMessage(null);
    try {
      const status = await getRuntimeFacade().portForwards.add({ name: `Local ${numericHostPort} to ${numericTargetPort}`, protocol: "tcp", hostPort: numericHostPort, targetHost: "127.0.0.1", targetPort: numericTargetPort, source: "user" }, true);
      setMessage(status.state === "listening" ? `${getRuntimeFacade().portForwards.localUrl(numericHostPort)} → 127.0.0.1:${numericTargetPort}` : status.message ?? status.state);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); await refresh(); }
    finally { setBusy(false); }
  }, [hostPort, language, refresh, targetPort]);
  const remove = useCallback(async (id: string) => { setBusy(true); try { await getRuntimeFacade().portForwards.remove(id, true, "user"); await refresh(); setMessage(null); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }, [refresh]);
  const clear = useCallback(async () => { setBusy(true); try { await getRuntimeFacade().portForwards.clear(true, "user"); await refresh(); setMessage(text(language, "Правила удалены.", "Правила видалено.", "Rules cleared.")); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }, [language, refresh]);
  return <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 12, gap: 8, backgroundColor: colors.surface }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}><Ionicons name="git-branch-outline" size={18} color={colors.accent} /><Text style={{ color: colors.inkBright, fontWeight: "700", fontSize: 14 }}>{text(language, "Port forwards", "Port forwards", "Port forwards")}</Text><View style={{ flex: 1 }} />{busy ? <ActivityIndicator size="small" color={colors.accent} /> : null}</View>
    <Text style={{ color: colors.muted, fontSize: 11 }}>{text(language, "Локальный TCP relay: порт телефона → порт уже работающего сервиса в том же Termux/PRoot userspace. Порты должны отличаться; LAN/public bind не включён. Нужен установленный socat.", "Локальний TCP relay: порт телефона → порт сервісу в тому ж Termux/PRoot userspace. Порти мають відрізнятися; LAN bind вимкнено. Потрібен socat.", "Loopback TCP relay: phone-local port → an already-running service port in the same Termux/PRoot userspace. Ports must differ; LAN/public bind is disabled. Requires installed socat.")}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{[[8080, 3000], [8081, 5173], [9000, 8000]].map(([localPort, servicePort]) => <ActionButton key={`${localPort}-${servicePort}`} label={`${localPort} → ${servicePort}`} colors={colors} disabled={busy} onPress={() => { setHostPort(String(localPort)); setTargetPort(String(servicePort)); void add(String(localPort), String(servicePort)); }} />)}</View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><TextInput value={hostPort} onChangeText={setHostPort} keyboardType="number-pad" placeholder={text(language, "Порт телефона", "Порт телефона", "Phone port")} placeholderTextColor={colors.muted} style={{ flex: 1, minWidth: 85, color: colors.inkBright, borderColor: colors.line, borderWidth: 1, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 8 }} /><Text style={{ color: colors.muted }}>→</Text><TextInput value={targetPort} onChangeText={setTargetPort} keyboardType="number-pad" placeholder={text(language, "Порт сервиса", "Порт сервісу", "Service port")} placeholderTextColor={colors.muted} style={{ flex: 1, minWidth: 85, color: colors.inkBright, borderColor: colors.line, borderWidth: 1, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 8 }} /><ActionButton label={text(language, "Добавить", "Додати", "Add")} colors={colors} disabled={busy} onPress={() => void add()} /></View>
    <ActionButton label={text(language, "Восстановить сохранённые", "Відновити збережені", "Restore saved rules")} colors={colors} disabled={busy || rows.length === 0} onPress={() => void restore()} />
    {rows.length ? rows.map(({ rule, state, message: detail }) => <View key={rule.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 7 }}><Text style={{ flex: 1, color: colors.inkBright, fontSize: 11 }}>{rule.protocol.toUpperCase()} {rule.hostPort} → {rule.targetHost}:{rule.targetPort} · {state}{detail ? ` · ${detail}` : ""}</Text><ActionButton label={text(language, "Убрать", "Прибрати", "Remove")} colors={colors} disabled={busy} onPress={() => void remove(rule.id)} /></View>) : <Text style={{ color: colors.muted, fontSize: 11 }}>{text(language, "Сохранённых правил пока нет.", "Збережених правил поки немає.", "No saved rules.")}</Text>}
    {rows.length ? <ActionButton label={text(language, "Очистить все", "Очистити все", "Clear all")} colors={colors} disabled={busy} onPress={() => void clear()} /> : null}
    {message ? <Text selectable style={{ color: message.startsWith("http") ? colors.accent : colors.muted, fontSize: 11 }}>{message}</Text> : null}
  </View>;
}
