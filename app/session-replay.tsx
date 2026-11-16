import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, FlatList, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLoggerContext } from "../components/LoggerContext";
import { useLanguage } from "../components/LanguageContext";
import { useTheme } from "../components/ThemeContext";
import { getDesktopContentStyle, loadDesktopMode, isDesktopMode } from "../lib/appearance-prefs";
import type { LogEntry } from "../lib/persistent-logger";
import {
  buildTrajectorySteps,
  splitIntoRuns,
  getBlameForFile,
  type TrajectoryRun,
  type TrajectoryStep,
  type BlameHit,
} from "../lib/trajectory";
import {
  loadRecentTraces,
  formatTraceSummary,
  promoteTraceToFixture,
  loadPromotedFixtures,
  removePromotedFixture,
  summarizeTraceStats,
  type AgentTrace,
  type PromotedFixture,
} from "../lib/agent-trace";
import { useDialog } from "../components/DialogContext";
import { loadRecentAgentTrajectories, trajectoryUsageSummary, type AgentTrajectory } from "../lib/agent-trajectory";
import { buildRetryPlanFromFixture, formatRetryPlanBlock } from "../lib/failure-fixture-retry";
import type { AgentFailureFixture } from "../lib/agent-failure-fixture";
import { useRouter } from "expo-router";

const LEVEL_COLOR_KEY = { info: "info", warn: "warning", error: "danger", debug: "muted" } as const;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0") +
    ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${formatTime(ts)}`;
}

export default function SessionReplayScreen() {
  const { logs } = useLoggerContext();
  const { t, language } = useLanguage();
  const [desktopLayout, setDesktopLayout] = useState(isDesktopMode());
  useEffect(() => { void loadDesktopMode().then(setDesktopLayout); }, []);
  const { showDialog } = useDialog();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [query, setQuery] = useState("");
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [agentTraces, setAgentTraces] = useState<AgentTrace[]>([]);
  const [agentTrajectories, setAgentTrajectories] = useState<AgentTrajectory[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [promoted, setPromoted] = useState<PromotedFixture[]>([]);
   const reloadTraces = () => {
    loadRecentTraces(12).then(setAgentTraces).catch(() => setAgentTraces([]));
    loadPromotedFixtures().then(setPromoted).catch(() => setPromoted([]));
  };

  useEffect(() => {
    reloadTraces();
  }, [logs.length]);

  useEffect(() => {
    loadRecentAgentTrajectories(12).then(setAgentTrajectories).catch(() => setAgentTrajectories([]));
  }, []);

  const runs = useMemo<TrajectoryRun[]>(() => splitIntoRuns(buildTrajectorySteps(logs)), [logs]);
  const blameHits = useMemo<BlameHit[]>(() => getBlameForFile(runs, query), [runs, query]);
  const selectedRun = useMemo(() => runs.find((r) => r.key === selectedRunKey) || null, [runs, selectedRunKey]);

  useEffect(() => {
    if (!playing || !selectedRun) return;
    timerRef.current = setInterval(() => {
      setStepIndex((i) => {
        if (i >= selectedRun.steps.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 1200);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, selectedRun]);

  const openRun = (run: TrajectoryRun, atStep = 0) => {
    setSelectedRunKey(run.key);
    setStepIndex(Math.max(0, Math.min(atStep, run.steps.length - 1)));
    setPlaying(false);
  };

  const closeRun = () => {
    setSelectedRunKey(null);
    setPlaying(false);
  };

  const openBlameHit = (hit: BlameHit) => {
    const run = runs.find((r) => r.key === hit.runKey);
    if (!run) return;
    const idx = run.steps.findIndex((s) => s.id === hit.step.id);
    openRun(run, idx >= 0 ? idx : 0);
  };

  // ---- Player view ----
  if (selectedRun) {
    const step: TrajectoryStep = selectedRun.steps[stepIndex];
    const levelColorKey = LEVEL_COLOR_KEY[step.level as keyof typeof LEVEL_COLOR_KEY] || "muted";
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.line }]}>
          <TouchableOpacity onPress={closeRun} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={20} color={colors.accent} />
            <Text style={[styles.backText, { color: colors.accent }]}>{t("sessionReplay")}</Text>
          </TouchableOpacity>
          <Text style={[styles.runTitle, { color: colors.inkBright }]} numberOfLines={1}>
            {selectedRun.title}
          </Text>
          <Text style={[styles.stepOf, { color: colors.muted }]}>
            {t("trajectoryStepOf", { current: stepIndex + 1, total: selectedRun.steps.length })}
          </Text>
        </View>

        <View
          style={[styles.playerBox, { backgroundColor: colors.surface, borderColor: colors.line }]}
        >
          <View style={styles.playerRowHeader}>
            <Text style={[styles.stepLevel, { color: (colors[levelColorKey] || colors.ink) }]}>
              {String(step.level).toUpperCase()}
            </Text>
            <Text style={[styles.stepTag, { color: colors.muted }]}>[{step.tag}]</Text>
            <Text style={[styles.stepTime, { color: colors.footerMuted }]}>{formatDate(step.timestamp)}</Text>
          </View>
          <ScrollView contentContainerStyle={{ padding: 14 }}>
            <Text style={[styles.stepMessage, { color: colors.inkBright }]} selectable>
              {step.raw}
            </Text>
          </ScrollView>
          {step.files.length > 0 && (
            <View style={[styles.filesBar, { borderTopColor: colors.line }]}>
              <Text style={[styles.filesLabel, { color: colors.muted }]}>{t("trajectoryFilesTouched")}</Text>
              <View style={styles.filesWrap}>
                {step.files.map((f) => (
                  <View key={f} style={[styles.fileChip, { backgroundColor: colors.accentDim, borderColor: colors.accent }]}>
                    <Text style={{ color: colors.accent, fontSize: 11 }} numberOfLines={1}>
                      {f}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>

        <View style={[styles.controls, { borderTopColor: colors.line, paddingBottom: Math.max(insets.bottom, 12) }]}>
          <TouchableOpacity
            style={[styles.ctrlBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}
            onPress={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={stepIndex === 0}
          >
            <Ionicons name="play-skip-back" size={18} color={stepIndex === 0 ? colors.muted : colors.inkBright} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.ctrlBtnMain, { backgroundColor: colors.accentDim, borderColor: colors.accent }]}
            onPress={() => setPlaying((p) => !p)}
          >
            <Ionicons name={playing ? "pause" : "play"} size={22} color={colors.accent} />
            <Text style={{ color: colors.accent, fontWeight: "700", marginLeft: 6 }}>
              {playing ? t("trajectoryPause") : t("trajectoryPlay")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.ctrlBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}
            onPress={() => setStepIndex((i) => Math.min(selectedRun.steps.length - 1, i + 1))}
            disabled={stepIndex === selectedRun.steps.length - 1}
          >
            <Ionicons
              name="play-skip-forward"
              size={18}
              color={stepIndex === selectedRun.steps.length - 1 ? colors.muted : colors.inkBright}
            />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ---- List / search view ----
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.line }]}>
        <Text style={[styles.title, { color: colors.inkBright }]}>{t("sessionReplay")}</Text>
        <Text style={[styles.hint, { color: colors.muted }]}>{t("sessionReplayHint")}</Text>
      </View>

      <View style={styles.searchBlock}>
        <Text style={[styles.blockLabel, { color: colors.muted }]}>{t("blameSearchLabel")}</Text>
        <View style={[styles.searchBox, { backgroundColor: colors.inputBg, borderColor: colors.line }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.inkBright }]}
            placeholder={t("blameSearchPlaceholder")}
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        {query.trim().length > 0 && (
          <>
            <Text style={[styles.matchesCount, { color: colors.muted }]}>
              {t("blameResultsCount", { count: blameHits.length })}
            </Text>
            <FlatList
              data={blameHits.slice(0, 30)}
              keyExtractor={(h) => h.step.id}
              style={{ maxHeight: 220 }}
              ListEmptyComponent={
                <Text style={{ color: colors.footerMuted, fontSize: 13, paddingVertical: 10 }}>
                  {t("blameEmpty")}
                </Text>
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.blameRow, { borderColor: colors.line, backgroundColor: colors.surface }]}
                  onPress={() => openBlameHit(item)}
                >
                  <Text style={{ color: colors.accent, fontWeight: "700", fontSize: 13 }} numberOfLines={1}>
                    {item.file}
                  </Text>
                  <Text style={{ color: colors.inkBright, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                    {item.step.summary}
                  </Text>
                  <Text style={{ color: colors.footerMuted, fontSize: 11, marginTop: 2 }}>
                    {item.runTitle} · {formatDate(item.step.timestamp)}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </>
        )}
      </View>

      {agentTrajectories.length > 0 && (
        <View style={{ paddingHorizontal: 16, marginTop: 10 }}>
          <Text style={[styles.blockLabel, { color: colors.muted }]}>Saved Run Trajectories</Text>
          {agentTrajectories.slice(0, 10).map((run) => (
            <View key={run.id} style={[styles.runCard, { backgroundColor: colors.surface, borderColor: colors.line, marginBottom: 8 }]}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: run.outcome === "pass" ? (colors.success || "#8FD69A") : run.outcome === "fail" ? colors.danger : colors.warning, fontWeight: "800", fontSize: 12 }}>{run.outcome.toUpperCase()}</Text>
                <Text style={{ color: colors.muted, fontSize: 11 }}>{run.backend} · {run.usage.steps} steps · {Math.round(run.usage.durationMs / 1000)}s{run.usage.tokens == null ? " · tokens n/a" : ` · ${run.usage.tokens} tokens`}</Text>
              </View>
              <Text style={{ color: colors.footerMuted, fontSize: 11, marginTop: 3 }}>
                {trajectoryUsageSummary(run, (language === "uk" || language === "en" ? language : "ru") as "ru" | "uk" | "en")}
                {(run.usage.hostCommands || run.usage.prootCommands)
                  ? ` · host ${run.usage.hostCommands || 0}/${run.usage.prootCommands || 0} proot`
                  : ""}
              </Text>
              <Text style={{ color: colors.inkBright, fontSize: 12, marginTop: 5 }}>goal={run.goalKind} · {run.steps.length} recorded events</Text>
              {run.steps.slice(-6).map((step, index) => (
                <Text key={`${run.id}-${index}`} style={{ color: step.status === "fail" ? colors.danger : colors.footerMuted, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
                  {step.kind} · {step.operationClass || step.resultMarker || step.action || "step"} · {step.backend} · {step.status}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}

      {agentTraces.length > 0 && (
        <View style={{ paddingHorizontal: 16, marginTop: 10 }}>
          <Text style={[styles.blockLabel, { color: colors.muted }]}>Agent Traces</Text>
          {(() => {
            const st = summarizeTraceStats(agentTraces);
            return (
              <Text style={{ color: colors.muted, fontSize: 11, marginBottom: 8 }}>
                {st.total} total · {st.pass} pass · {st.fail} fail · {st.abort} abort
              </Text>
            );
          })()}
          {agentTraces.slice(0, 8).map((tr) => {
            const open = selectedTraceId === tr.id;
            const statusColor =
              tr.status === "pass" ? colors.success || "#8FD69A" :
              tr.status === "fail" ? colors.danger :
              tr.status === "abort" ? colors.warning : colors.muted;
            return (
              <TouchableOpacity
                key={tr.id}
                style={[styles.runCard, { backgroundColor: colors.surface, borderColor: colors.line, marginBottom: 8 }]}
                onPress={() => setSelectedTraceId(open ? null : tr.id)}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ color: statusColor, fontWeight: "800", fontSize: 12, textTransform: "uppercase" }}>
                    {tr.status}
                  </Text>
                  <Text style={{ color: colors.muted, fontSize: 11 }}>
                    {tr.steps.length} steps
                  </Text>
                </View>
                <Text style={{ color: colors.inkBright, fontSize: 13, fontWeight: "600", marginTop: 4 }} numberOfLines={2}>
                  {tr.task}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }} numberOfLines={2}>
                  {formatTraceSummary(tr)}
                </Text>
                {tr.failureCluster ? (
                  <Text style={{ color: colors.warning, fontSize: 11, marginTop: 3 }}>
                    cluster: {tr.failureCluster}
                    {tr.recipeId ? ` → ${tr.recipeId}` : ""}
                  </Text>
                ) : null}
                {open && (
                  <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 }}>
                    {tr.steps.slice(-40).map((s) => (
                      <View key={s.id} style={{ marginBottom: 6 }}>
                        <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "700" }}>
                          {s.kind}
                          {s.ok === false ? " ✗" : s.ok ? " ✓" : ""}
                          {s.exitCode !== undefined ? ` exit=${s.exitCode}` : ""}
                        </Text>
                        <Text style={{ color: colors.inkBright, fontSize: 12 }} numberOfLines={3}>
                          {s.summary}
                        </Text>
                        {s.command ? (
                          <Text style={{ color: colors.footerMuted, fontSize: 11, fontFamily: "monospace" }} numberOfLines={2}>
                            $ {s.command}
                          </Text>
                        ) : null}
                      </View>
                    ))}
                    {tr.gates && tr.gates.length > 0 ? (
                      <View style={{ marginTop: 6 }}>
                        <Text style={{ color: colors.muted, fontSize: 11, fontWeight: "700" }}>GATES</Text>
                        {tr.gates.map((g) => (
                          <Text
                            key={g.id}
                            style={{ color: g.pass ? (colors.success || "#8FD69A") : colors.danger, fontSize: 11 }}
                          >
                            {g.pass ? "✓" : "✗"} {g.id}: {g.detail}
                          </Text>
                        ))}
                      </View>
                    ) : null}
                    {tr.apkPath ? (
                      <Text style={{ color: colors.accent, fontSize: 11, marginTop: 6 }} numberOfLines={2}>
                        APK: {tr.apkPath}
                      </Text>
                    ) : null}
                    {(tr.status === "fail" || tr.status === "abort") && (
                      <TouchableOpacity
                        style={{
                          marginTop: 10,
                          paddingVertical: 8,
                          paddingHorizontal: 12,
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: colors.accent,
                          backgroundColor: colors.accentDim || "rgba(61,214,140,0.12)",
                          alignSelf: "flex-start",
                        }}
                        onPress={async () => {
                          try {
                            const f = await promoteTraceToFixture(tr);
                            reloadTraces();
                            showDialog(
                              "Fixture",
                              `Saved regression fixture\n${f.cluster || f.id}`,
                            );
                          } catch (e) {
                            showDialog(
                              "Error",
                              e instanceof Error ? e.message : String(e),
                            );
                          }
                        }}
                      >
                        <Text style={{ color: colors.accent, fontWeight: "700", fontSize: 12 }}>
                          ★ Promote → fixture
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {promoted.length > 0 && (
        <View style={{ paddingHorizontal: 16, marginTop: 8, marginBottom: 4 }}>
          <Text style={[styles.blockLabel, { color: colors.muted }]}>Promoted fixtures</Text>
          {promoted.slice(0, 10).map((f) => (
            <View
              key={f.id}
              style={[styles.runCard, { backgroundColor: colors.surface, borderColor: colors.line, marginBottom: 6 }]}
            >
              <Text style={{ color: colors.inkBright, fontSize: 12, fontWeight: "600" }} numberOfLines={2}>
                {f.task}
              </Text>
              <Text style={{ color: colors.warning, fontSize: 11, marginTop: 3 }}>
                {f.cluster || "unknown"}
                {f.recipeId ? ` → ${f.recipeId}` : ""}
              </Text>
              <View style={{ flexDirection: "row", gap: 12, marginTop: 6 }}>
                <TouchableOpacity
                  onPress={() => {
                    const plan = buildRetryPlanFromFixture({
                      schemaVersion: 1,
                      id: f.id,
                      fingerprint: f.cluster || f.id,
                      createdAt: Date.now(),
                      task: f.task,
                      backend: "unknown",
                      goal: { kind: f.cluster || "unknown", mustExist: [] },
                      steps: [],
                      stdout: "",
                      stderr: "",
                      expected: { mustContain: "" },
                    } as AgentFailureFixture);
                    showDialog(
                      language === "ru" ? "Повтор из fixture" : language === "uk" ? "Повтор з fixture" : "Retry from fixture",
                      formatRetryPlanBlock(plan) + "\n\n" + (language === "ru" ? "Скопируйте задачу в чат вручную или откройте главный экран." : language === "uk" ? "Скопіюйте задачу в чат вручну або відкрийте головний екран." : "Copy the task into chat or open the main screen."),
                      [
                        { text: language === "ru" ? "Закрыть" : language === "uk" ? "Закрити" : "Close", style: "cancel" },
                        {
                          text: language === "ru" ? "В чат" : language === "uk" ? "У чат" : "Open chat",
                          onPress: () => {
                            try {
                              router.push({ pathname: "/", params: { retryTask: plan.task } });
                            } catch {
                              router.push("/");
                            }
                          },
                        },
                      ],
                    );
                  }}
                  style={{ alignSelf: "flex-start" }}
                >
                  <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "700" }}>
                    {language === "ru" ? "Повторить" : language === "uk" ? "Повторити" : "Retry"}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={async () => {
                    await removePromotedFixture(f.id);
                    reloadTraces();
                  }}
                  style={{ alignSelf: "flex-start" }}
                >
                  <Text style={{ color: colors.danger, fontSize: 11, fontWeight: "700" }}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}

      <Text style={[styles.blockLabel, { color: colors.muted, marginTop: 6, marginHorizontal: 16 }]}>{t("trajectoryRunsTitle")}</Text>
      <FlatList
        data={runs}
        keyExtractor={(r) => r.key}
        contentContainerStyle={getDesktopContentStyle(undefined, { padding: 16, gap: 10 })}
        ListEmptyComponent={
          <Text style={{ color: colors.footerMuted, textAlign: "center", marginTop: 30, fontSize: 13 }}>
            {t("trajectoryEmpty")}
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.runCard, { backgroundColor: colors.surface, borderColor: colors.line }]}
            onPress={() => openRun(item, 0)}
          >
            <Text style={[styles.runCardTitle, { color: colors.inkBright }]} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>
              {item.steps.length} · {formatDate(item.startedAt)} → {formatDate(item.endedAt)}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: "700" },
  hint: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  searchBlock: { paddingHorizontal: 16, paddingTop: 12 },
  blockLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },
  matchesCount: { fontSize: 11, marginTop: 8, marginBottom: 4 },
  blameRow: { borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 6 },
  runCard: { borderWidth: 1, borderRadius: 14, padding: 14 },
  runCardTitle: { fontSize: 14, fontWeight: "700" },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontSize: 14, fontWeight: "700" },
  runTitle: { fontSize: 15, fontWeight: "700", marginTop: 8 },
  stepOf: { fontSize: 12, marginTop: 2 },
  playerBox: { flex: 1, margin: 12, borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  playerRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  stepLevel: { fontSize: 10, fontWeight: "700" },
  stepTag: { fontSize: 11, fontWeight: "600" },
  stepTime: { fontSize: 10, marginLeft: "auto" },
  stepMessage: { fontSize: 13, lineHeight: 19 },
  filesBar: { borderTopWidth: 1, padding: 12 },
  filesLabel: { fontSize: 11, fontWeight: "700", marginBottom: 6 },
  filesWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  fileChip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, maxWidth: 260 },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
  },
  ctrlBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  ctrlBtnMain: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
  },
});
