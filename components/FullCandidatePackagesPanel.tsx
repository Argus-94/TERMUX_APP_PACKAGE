import React, { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { CANDIDATE_PACKAGES, runFullCandidateAction, type FullCandidateAction, type FullCandidateDiagnostics, CANDIDATE_PROTECTED_PACKAGES, CANDIDATE_BOOTSTRAP_COMPATIBLE, CANDIDATE_INSTALL_BLOCKER, CANDIDATE_RELEASE_VALID_UNTIL, CANDIDATE_REQUIRED_PRIVATE_FREE_BYTES } from "../lib/candidate-full-feed";
import { persistentLogger } from "../lib/persistent-logger";
import { classifyCandidateDiagnostic, type CandidateDiagnosticStage } from "../lib/full-candidate-diagnostic";
import { buildCandidateFailureLogEntry, candidateTransactionIdFromEvidencePath, redactCandidateLog } from "../lib/candidate-transaction-log";

const labels: Record<FullCandidateAction, string> = { verify: "Проверить feed", install: "Установить", reinstall: "Переустановить", remove: "Удалить", check: "Проверить состояние" };
const BATCH_WARNING = "Важно: установка или переустановка намеренно затрагивает весь согласованный набор из 82 пакетов, а не только выбранное имя. Изменяется только приватный runtime приложения; HOME, проекты и хранилище не меняются. Обновляется весь согласованный набор; автоматического отката нет. Только отдельная тестовая установка Android; тестирование на устройстве НЕ ВЫПОЛНЕНО.";

export function FullCandidatePackagesPanel({ colors, language = "ru", sessionEnabled }: { colors: any; language?: string; sessionEnabled: boolean }) {
  const sessionEnabledRef = useRef(sessionEnabled);
  sessionEnabledRef.current = sessionEnabled;
  const busyRef = useRef(false);
  const attemptSequence = useRef(0);
  const makeAttempt = () => { attemptSequence.current += 1; return { id: `fc-${Date.now().toString(36)}-${attemptSequence.current.toString(36)}`, startedAt: Date.now() }; };
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [known, setKnown] = useState<Record<string, { installed: boolean; version: string; stale?: boolean }>>({});
  const [message, setMessage] = useState("");
  const ru = language !== "en" && language !== "uk";
  const diagnostic = (attempt: { id: string; startedAt: number }, stage: CandidateDiagnosticStage, action: FullCandidateAction, selectionCount: number, outcome: "pending" | "ok" | "error" | "cancelled", code = "none", durationMs?: number, details?: FullCandidateDiagnostics) => {
    const safe = classifyCandidateDiagnostic({ action, stage, code, durationMs, attemptId: attempt.id,
      diagnosticPhase: details?.phase, diagnosticReasonCode: details?.reasonCode, exitCode: details?.exitCode,
      timedOut: details?.timedOut, outputTruncated: details?.outputTruncated, stdoutChars: details?.stdoutChars,
      stderrChars: details?.stderrChars, stdoutBytes: details?.stdoutBytes, stderrBytes: details?.stderrBytes });
    persistentLogger.add("info", "FullCandidateUI", JSON.stringify({ ...safe, selectionCount: Math.max(0, Math.min(82, selectionCount)), outcome }));
  };
  const filtered = useMemo(() => CANDIDATE_PACKAGES.filter(p => `${p.name} ${p.version}`.toLowerCase().includes(query.trim().toLowerCase())), [query]);
  const record = async (r: Awaited<ReturnType<typeof runFullCandidateAction>>, action: FullCandidateAction, attempt: { id: string; startedAt: number }) => {
    if (r.ok && r.states) setKnown(prev => {
      const next = { ...prev };
      for (const p of CANDIDATE_PACKAGES) {
        const s = r.states?.[p.name];
        if (s?.status === "installed" && s.version === p.version) next[p.name] = { installed: true, version: s.version };
        else if (s?.status === "installed") next[p.name] = { installed: false, version: s.version };
        else if (s?.status === "absent") next[p.name] = { installed: false, version: "" };
      }
      return next;
    });
    else setKnown(prev => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, stale: true }])));
    const transactionId = candidateTransactionIdFromEvidencePath(r.evidencePath);
    const evidenceLabel = transactionId ? `\n${ru ? "ID транзакции" : "Transaction ID"}: ${transactionId}` : "";
    setMessage(`${r.ok ? "OK" : "ERROR"} · ${r.code}${evidenceLabel}\n${redactCandidateLog(r.log.slice(-1200))}`);
    if (!r.ok) {
      const failureEntry = await buildCandidateFailureLogEntry({
        action, attemptId: attempt.id, resultCode: r.code, evidencePath: r.evidencePath,
        output: r.log, diagnostics: r.diagnostics,
      });
      persistentLogger.add("error", "FullCandidateFailure", failureEntry, "app");
      persistentLogger.flush();
    }
  };
  const run = async (action: FullCandidateAction, names?: readonly string[], attempt = makeAttempt()) => {
    if (busyRef.current) return;
    if (!sessionEnabledRef.current) {
      const message = ru ? "Действия заблокированы: включите сессию встроенного Termux." : "Actions are blocked: enable the embedded Termux session.";
      setMessage(message);
      diagnostic(attempt, "result", action, names?.length ?? 0, "error", "AIB_FULL_CANDIDATE_SESSION_DISABLED", Date.now() - attempt.startedAt);
      return;
    }
    busyRef.current = true; setBusy(action);

    setKnown(prev => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, stale: true }])));
    diagnostic(attempt, "dispatch", action, names?.length ?? 0, "pending");
    try { const result = await runFullCandidateAction(action, names, { sessionEnabled: sessionEnabledRef.current, isSessionEnabled: () => sessionEnabledRef.current }); await record(result, action, attempt); diagnostic(attempt, "result", action, names?.length ?? 0, result.ok ? "ok" : "error", result.code, Date.now() - attempt.startedAt, result.diagnostics); }
    catch { setMessage(`ERROR · ${ru ? "Операция не завершена" : "Operation did not complete"}\n${ru ? "Состояние неизвестно; нужна повторная проверка." : "State unknown; check again."}`); diagnostic(attempt, "result", action, names?.length ?? 0, "error", "AIB_FULL_CANDIDATE_UNCONFIRMED", Date.now() - attempt.startedAt); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const runFullCohortAction = (action: "install" | "reinstall") => {
    const selected = CANDIDATE_PACKAGES.map(p => p.name);
    const attempt = makeAttempt();
    diagnostic(attempt, "press", action, selected.length, "pending");
    setMessage(ru ? `${labels[action]} всего набора: ожидается подтверждение.` : `${labels[action]} full cohort: awaiting confirmation.`);
    diagnostic(attempt, "confirmation-open", action, selected.length, "pending");
    Alert.alert(labels[action], BATCH_WARNING, [
      { text: ru ? "Отмена" : "Cancel", onPress: () => { diagnostic(attempt, "cancel", action, selected.length, "cancelled"); setMessage(ru ? "Операция отменена; запрос не отправлен." : "Cancelled; no request sent."); } },
      { text: action === "install" ? (ru ? "Установить весь набор (82)" : "Install full set (82)") : (ru ? "Переустановить весь набор (82)" : "Reinstall full set (82)"), style: "destructive", onPress: () => { diagnostic(attempt, "confirm", action, selected.length, "pending"); void run(action, selected, attempt); } },
    ]);
  };
  const rowAction = (action: FullCandidateAction, name: string) => {
    const selected = action === "check" ? [] : [name];
    return <TouchableOpacity key={`${name}-${action}`} disabled={!sessionEnabled || !!busy || (action !== "check" && !CANDIDATE_BOOTSTRAP_COMPATIBLE) || (action === "remove" && CANDIDATE_PROTECTED_PACKAGES.includes(name))}
      onPress={() => {
        const attempt = makeAttempt();
        diagnostic(attempt, "press", action, selected.length, "pending");
        setMessage(`${labels[action]} · ${ru ? "запрос принят; ожидается подтверждение/результат" : "requested; awaiting confirmation/result"}`);
        if (action === "check") { void run(action, undefined, attempt); return; }
        diagnostic(attempt, "confirmation-open", action, selected.length, "pending");
        Alert.alert(labels[action], action === "remove" ? "Удаляется только выбранный пакет. Если APT требует удалить другие пакеты, операция будет отклонена. Защищённые bootstrap/essential пакеты не удаляются; проекты и HOME не меняются." : BATCH_WARNING, [
          { text: ru ? "Отмена" : "Cancel", onPress: () => { diagnostic(attempt, "cancel", action, selected.length, "cancelled"); setMessage(ru ? "Операция отменена; запрос не отправлен." : "Cancelled; no request sent."); } },
          { text: labels[action], style: "destructive", onPress: () => { diagnostic(attempt, "confirm", action, selected.length, "pending"); void run(action, selected, attempt); } },
        ]);
      }} style={{ paddingVertical: 5, paddingHorizontal: 7, borderWidth: 1, borderColor: colors.line, borderRadius: 6, marginRight: 4, marginTop: 4 }}><Text style={{ color: colors.inkBright, fontSize: 11 }}>{action === "remove" && CANDIDATE_PROTECTED_PACKAGES.includes(name) ? "Защита bootstrap" : labels[action]}</Text></TouchableOpacity>;
  };
  return <View style={{ marginVertical: 10, padding: 10, borderWidth: 1, borderColor: colors.accent, borderRadius: 12, backgroundColor: colors.surface }}>
    <Text style={{ color: colors.inkBright, fontWeight: "700", fontSize: 16 }}>{ru ? "Полный подписанный тестовый feed" : "Full signed test feed"} · {CANDIDATE_PACKAGES.length} пакетов</Text>
    <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>{ru ? "Кандидат, не production. Эти 82 пакета не покрывают весь Builder: отсутствуют Clang, Android SDK/NDK и другие компоненты." : "Candidate, not production · ordinary catalog is incomplete (no clang/SDK/NDK and other components)."}</Text>
    <Text style={{ color: colors.muted, fontSize: 11, marginVertical: 5 }}>{ru ? "Точные версии и SHA-256. Только приватный prefix этого приложения; HOME, проекты и хранилище не затрагиваются. Production выключен." : "Pinned versions and SHA-256; production disabled."}</Text>
    {!sessionEnabled && <Text style={{ color: colors.danger, fontSize: 12, marginVertical: 5 }}>{ru ? "Пакетные действия отключены. Сначала включите сессию встроенного Termux." : "Package actions are disabled. Enable the embedded Termux session first."}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>{(["verify", "check"] as FullCandidateAction[]).map(a => <TouchableOpacity key={a} disabled={!sessionEnabled || !!busy} onPress={() => { const attempt = makeAttempt(); diagnostic(attempt, "press", a, 0, "pending"); void run(a, undefined, attempt); }} style={{ padding: 8, margin: 3, backgroundColor: colors.accentDim, borderRadius: 7 }}><Text style={{ color: colors.inkBright }}>{labels[a]} {a === "check" ? `(${CANDIDATE_PACKAGES.length})` : ""}</Text></TouchableOpacity>)}</View>
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
      <TouchableOpacity disabled={!sessionEnabled || !!busy || !CANDIDATE_BOOTSTRAP_COMPATIBLE} onPress={() => runFullCohortAction("install")} style={{ padding: 9, margin: 3, backgroundColor: colors.dangerDim, borderRadius: 7 }}><Text style={{ color: colors.danger, fontWeight: "700" }}>{ru ? "Установить весь набор (82)" : "Install full cohort (82)"}</Text></TouchableOpacity>
      <TouchableOpacity disabled={!sessionEnabled || !!busy || !CANDIDATE_BOOTSTRAP_COMPATIBLE} onPress={() => runFullCohortAction("reinstall")} style={{ padding: 9, margin: 3, backgroundColor: colors.dangerDim, borderRadius: 7 }}><Text style={{ color: colors.danger, fontWeight: "700" }}>{ru ? "Переустановить весь набор (82)" : "Reinstall full cohort (82)"}</Text></TouchableOpacity>
    </View>
    {busy ? <View style={{ flexDirection: "row", alignItems: "center", padding: 7 }}><ActivityIndicator color={colors.accent} /><Text style={{ color: colors.muted, marginLeft: 7 }}>{busy}…</Text></View> : null}
    {!!message && <Text selectable style={{ color: colors.muted, fontSize: 10, marginTop: 7 }}>{message}</Text>}
    <Text style={{ color: colors.muted, fontSize: 11 }}>Срок подписанного релиза: {new Date(CANDIDATE_RELEASE_VALID_UNTIL).toISOString()} · проверка срока и подписи не заменяет проверку APT.</Text>
    <Text style={{ color: colors.muted, fontSize: 11 }}>Для транзакции нужно не менее {Math.ceil(CANDIDATE_REQUIRED_PRIVATE_FREE_BYTES / (1024 * 1024))} MiB свободного внутреннего хранилища после подготовки кеша. Оставьте приложение на экране; установка может занять несколько минут.</Text>
    <Text style={{ color: colors.danger, fontSize: 12 }}>{CANDIDATE_INSTALL_BLOCKER}</Text>
    <Text style={{ color: colors.muted, fontSize: 11 }}>Состояние ниже — только реестр dpkg, не подтверждение работоспособности бинарников на Android.</Text>
    <TextInput editable={sessionEnabled} value={query} onChangeText={setQuery} placeholder={ru ? "Поиск пакетов" : "Search packages"} placeholderTextColor={colors.muted} style={{ color: colors.inkBright, borderWidth: 1, borderColor: colors.line, padding: 7, marginTop: 7, borderRadius: 7 }} />
    <TextInput editable={sessionEnabled} value={manual} onChangeText={setManual} autoCapitalize="none" placeholder={ru ? "Точное имя пакета (только из набора)" : "Exact package name (only these 82)"} placeholderTextColor={colors.muted} style={{ color: colors.inkBright, borderWidth: 1, borderColor: colors.line, padding: 7, marginTop: 6, borderRadius: 7 }} />
    <TouchableOpacity disabled={!sessionEnabled || !!busy} onPress={() => { const p = CANDIDATE_PACKAGES.find(x => x.name === manual.trim()); const attempt = makeAttempt(); diagnostic(attempt, "press", "check", 0, "pending"); if (!p) { setMessage(ru ? "Отклонено локально: имени нет в подписанном наборе из 82 пакетов. Запрос не отправлен." : "Rejected locally: name is not in the signed set; no request sent."); diagnostic(attempt, "result", "check", 0, "error", "INVALID_SELECTION"); return; } setMessage(ru ? "Проверка полного реестра; имя используется только для фильтрации отображения." : "Checking full inventory; name is only a display filter."); setQuery(p.name); void run("check", undefined, attempt); }} style={{ padding: 8 }}><Text style={{ color: colors.accent }}>{ru ? "Проверить введённое имя" : "Check typed name"}</Text></TouchableOpacity>
    {CANDIDATE_PACKAGES.some(p => p.name === manual.trim()) && <View style={{ flexDirection: "row", flexWrap: "wrap" }}>{rowAction("remove", manual.trim())}</View>}
    <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled>{filtered.map(p => { const st = known[p.name]; const status = st?.stale ? `stale · last known ${st.installed ? `installed ${st.version}` : "absent"}` : st?.installed && st.version === p.version ? `✓ installed ${st.version}` : st && !st.installed ? st.version ? `other installed version ${st.version}; not this candidate` : "absent (last successful check)" : "unknown"; return <View key={p.name} style={{ paddingVertical: 7, borderTopWidth: 1, borderColor: colors.line }}><Text style={{ color: colors.inkBright, fontWeight: "600" }}>{p.name} {p.version} · {p.architecture}</Text><Text selectable style={{ color: colors.muted, fontSize: 10 }}>SHA-256 {p.sha256}</Text><Text style={{ color: !st?.stale && st?.installed && st.version === p.version ? "#3a9d5d" : colors.muted, fontSize: 11 }}>{status}</Text><View style={{ flexDirection: "row", flexWrap: "wrap" }}>{(["remove", "check"] as FullCandidateAction[]).map(a => rowAction(a, p.name))}</View></View>; })}</ScrollView>
  </View>;
}
