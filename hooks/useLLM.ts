import { useState, useCallback, useEffect, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistAsyncStorageItem } from "../lib/persistence";
import { withAbortableTimeout } from "../lib/abortable-timeout";
import { File } from "expo-file-system";
import * as FileSystemLegacy from "expo-file-system/legacy";
import { localModelEngine, type ChatTurn } from "../lib/local-model";
import { onlineModelEngine, checkOpenRouterModels, FREE_OPENROUTER_MODELS } from "../lib/online-model";
import { customProviderEngine, DEFAULT_CUSTOM_PARAMS } from "../lib/custom-provider";
import { translateEngineError } from "../lib/engine-errors";
import { runTermuxAgentTask, type AgentTranscriptTurn } from "../lib/termux-agent";
import { isExplicitAgentToolRequest } from "../lib/explicit-agent-tool-request";
import { isStrongCreateAppTask } from "../lib/agent-engine";
import type { BuildStage, TermuxActivity, TermuxTaskKind, TermuxTaskStatus } from "../components/TermuxContext";
import { applyObservedBuildStageUpdate, classifyTermuxTaskKind, createObservedAssembleStages, redactTaskActivityText, taskKindTitle } from "../lib/task-activity";
import {
  notifyAgentStarted,
  notifyAgentDone,
  notifyAgentFailed,
} from "../lib/app-notifications";
import { persistentLogger } from "../lib/persistent-logger";
import { ensureRuntimeSession, killRuntimeSession } from "../lib/runtime-session";
import { buildRelevantSessionLogContext } from "../lib/session-log-context";
import { buildSystemPrompt, buildAgentSystemPrompt, type ModelTier, type PromptLang } from "../lib/ide-core-prompt";
import { uiLangToPromptLang, detectReplyLang } from "../lib/reply-lang";
import { agentShellBackendPromptHint } from "../lib/agent-shell-backend";
import { AGENT_DEFAULT_MAX_STEPS } from "../lib/agent-autonomy-policy";
import { buildSessionDigest } from "../lib/session-digest";
import { loadCrossSessionMemory, saveCrossSessionMemory } from "../lib/session-memory";
import { buildPreflightContext, runPostReview, startMemoryLifecycle, finishMemoryLifecycle } from "../lib/agent-orchestrator";
import {
  runAssembleDebug,
  buildFixPrompt,
  buildSuccessMessage,
} from "../lib/build-loop";
import { buildRecoveryContext, classifyRecoveryFailure } from "../lib/agent-recovery";
import { useTermuxContext } from "../components/TermuxContext";
import { useProjectContext } from "../components/ProjectContext";
import { useAppSettingsContext } from "../components/AppSettingsContext";
import { useLoggerContext } from "../components/LoggerContext";
import { useLanguage } from "../components/LanguageContext";
import { useDialog } from "../components/DialogContext";
import type { MessageAttachment } from "../components/ChatBubble";
import { isClearChatCommand } from "../lib/chat-commands";
import {
  formatProviderUserError,
  getProviderRateLimitRemainingSec,
  isProviderHardFailure,
  isSmallTalkMessage,
  isInfoOnlyQuery,
  isChatOnlyMessage,
  looksLikeImageModel,
  getUnsupportedModelChatMessage,
  formatModelIdForLog,
  formatSecondsHuman,
  clearProviderRateLimit,
} from "../lib/provider-utils";
import { detectTermuxIntent } from "../lib/termux-intent";
import { isSharedStorageOnlyUserTask } from "../lib/agent-shell-backend";
import { getRuntimeFacade } from "../lib/runtime-facade";
import type { RuntimeOfflineAgentOptions } from "../core/RuntimeFacade";
import { runAutonomousDeviceDevelopmentLoop, type AutonomousDeviceLoopEvent, type AutonomousDeviceLoopResult } from "../lib/autonomous-device-loop";
import { runSelfHealingDeviceSuite, type SelfHealingDeviceSuiteEvent, type SelfHealingDeviceSuiteResult } from "../lib/self-healing-device-suite";
import { runReleaseGate, type ReleaseGateResult } from "../lib/release-gate";
import { createReleaseArtifact, type ReleaseArtifactResult } from "../lib/release-artifact-manager";
import { publishReleaseChannel, rollbackReleaseChannel, type ReleaseChannel, type PublishReleaseChannelResult, type RollbackReleaseChannelResult } from "../lib/release-channel-manager";
import { deployReleaseChannel, type ProductionDeploymentResult } from "../lib/production-deployment-manager";
import { deployReleaseFleet, type DeviceFleetResult } from "../lib/device-fleet-manager";
import { runFleetCanary, type FleetCanaryResult, type CanaryStage } from "../lib/fleet-canary-manager";
import { getFleetObservability, listFleetIncidents, acknowledgeFleetIncident, type FleetObservabilitySnapshot, type FleetIncident } from "../lib/fleet-observability";
import { getFleetCommandSnapshot, deployFleetDevice, rollbackFleetDevice, acknowledgeCommandCenterIncident, type FleetCommandSnapshot } from "../lib/fleet-command-center";
import { getFleetPolicy, setFleetPolicy, authorizeFleetAction, recordFleetExecution, listFleetAudit, type FleetPolicy, type FleetRole, type FleetAuditEntry } from "../lib/fleet-policy-manager";
import { verifyFleetAuditChain, listSecureFleetAudit, createFleetRecoverySnapshot, restoreFleetRecoverySnapshot, exportFleetAuditBundle, type AuditFilter, type AuditVerification, type SecureAuditEntry, type FleetRecoverySnapshot } from "../lib/fleet-audit-recovery";
import { createFleetEncryptedBackup, verifyFleetEncryptedBackup, restoreFleetEncryptedBackup, listFleetBackups, type FleetBackupRecord } from "../lib/fleet-backup-recovery";
import { runFleetRecoveryDrill, type FleetRecoveryDrillResult } from "../lib/fleet-disaster-recovery-drill";
import { getFleetRecoverySchedule, setFleetRecoverySchedule, evaluateFleetRecoverySlo, runFleetScheduledRecoveryCheck, type FleetRecoverySchedule, type FleetSloStatus, type FleetScheduledRecoveryResult } from "../lib/fleet-recovery-scheduler";
import { getFleetSloDashboard, acknowledgeFleetDashboardAlert, acknowledgeFleetDashboardIncident, type FleetSloDashboardSnapshot } from "../lib/fleet-slo-dashboard";
import { getFleetUnifiedControlSnapshot, type FleetUnifiedControlSnapshot } from "../lib/fleet-unified-control-center";
import { escalateFleetAlerts, acknowledgeFleetEscalatedAlert, resolveFleetEscalatedAlert, getFleetEscalationPolicy, setFleetEscalationPolicy, getFleetNotificationOutbox, type FleetEscalationSnapshot, type FleetEscalationPolicy } from "../lib/fleet-alert-escalation";

export type ModelMode = "local" | "online" | "custom" | "opencode" | "manus";

import { runManusTask } from "../lib/manus-api";
import { manusErrorMessage } from "../lib/manus-error-messages";
import { manusTaskStorageKey, loadManusTask, saveManusTask } from "../lib/manus-task-store";

export interface ChatSession {
  /** Clearing a chat starts a fresh cloud task without deleting the remote task. */
  manusEpoch?: string;
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attachment?: MessageAttachment;
}

const SESSIONS_STORAGE_KEY = "aibuilder.chat.sessions.v1";
const CURRENT_SESSION_KEY = "aibuilder.chat.currentSessionId.v1";

function makeWelcomeSession(welcomeText: string, title: string): ChatSession {
  return {
    id: "default",
    title,
    messages: [
      {
        id: "welcome",
        role: "system" as const,
        content: welcomeText,
        timestamp: Date.now(),
      },
    ],
    createdAt: Date.now(),
  };
}

// Максимальная длина автоматического названия чата в Истории чатов (см.
// deriveChatTitle ниже) — достаточно, чтобы понять контекст запроса, не
// растягивая карточку чата на несколько строк.
const CHAT_TITLE_MAX_LENGTH = 40;

// ВАЖНО (по просьбе пользователя): раньше новый чат сразу получал название
// вида "Чат 1", "Чат 2" и т.д. (см. t("chatNumber", ...) ниже, которое
// использовалось при создании) — по такому названию в Истории чатов
// невозможно было понять, о чём вообще шла речь. Теперь новый чат создаётся
// с нейтральным плейсхолдером (t("newChatTitle"), см. createNewChat), а как
// только приходит ПЕРВОЕ сообщение пользователя в этом чате — заголовок
// автоматически переименовывается в короткую выжимку из текста этого
// сообщения (см. addMessageToCurrentSession, где вызывается эта функция).
function deriveChatTitle(content: string, attachment: MessageAttachment | undefined, fallback: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (cleaned) {
    return cleaned.length > CHAT_TITLE_MAX_LENGTH
      ? `${cleaned.slice(0, CHAT_TITLE_MAX_LENGTH).trimEnd()}…`
      : cleaned;
  }
  // Сообщение без текста (например, отправлено только изображение/файл) —
  // используем имя вложения, оно тоже даёт понятный контекст в Истории чатов.
  if (attachment?.name) return attachment.name;
  return fallback;
}

// Держим длинную историю: при разработке приложения в чате легко
// набрать десятки реплик, и обрезка до 16 ломала контекст («удали тот
// файл», «продолжи с того же экрана»). Лимит высокий, но не бесконечный —
// онлайн-модели всё равно имеют своё context window.
// Недавняя история целиком в промпт; более ранние факты — через лог
// (buildRelevantSessionLogContext), чтобы экономить токены.
const CHAT_HISTORY_LIMIT = 40;

function isBuildIntent(message: string): boolean {
  return /\b(assemble|gradle|build\s*apk|скомпіл|компіл|собери|збер\w*|собрать|сборка|build\s*project|збірк)\b/i.test(
    message
  );
}

/** User asks to create/generate a new app or project (not only build existing). */
function isCreateAppIntent(message: string): boolean {
  return isStrongCreateAppTask(message);
}

/** User asks to inspect, analyze, or decompile an APK / reverse engineer. */
function isReverseEngineeringIntent(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(реверс|декомпил|декомпиляц|decompile|decompil|smali|baksmali|jadx|androguard|apkid|dex2jar|анализ\s+(?:apk|приложен|ресурс)|проанализир\w*\s+.*apk|распакуй\s+apk)\b/i.test(m);
}

const CREATE_APP_PIPELINE_HINT =
  "[CREATE_APP_PIPELINE] Автономный цикл: проект на диск → Gradle → .apk.\n" +
  "Каталог: /storage/emulated/0/AIBuilderTermux/<ShortName> (без плейсхолдеров <Name>).\n" +
  "ОБЯЗАТЕЛЬНО Gradle (НЕ ручной aapt2/d8 без Gradle, если есть wrapper).\n" +
  "Пути SDK/JDK: ТОЛЬКО $PREFIX и $HOME встроенной среды AI Builder; чужие app-private каталоги запрещены.\n" +
  "ЭКОНОМИЯ ШАГОВ:\n" +
  "1) probe: command -v java; ls $PREFIX/opt/android-sdk/platforms; ls $PREFIX/opt/android-sdk/build-tools\n" +
  "2) ОДИН скрипт cat > $HOME/aib-mkapp.sh <<'SCRIPT' ... SCRIPT затем bash $HOME/aib-mkapp.sh\n" +
  "3) В скрипте: mkdir, settings.gradle, build.gradle, app/build.gradle, Manifest, Activity, res, gradle wrapper.\n" +
  "4) Wrapper JAR: скопируй из $PREFIX/opt/.../gradle-wrapper.jar или gradle wrapper; properties НЕ ломай.\n" +
  "5) cd project && export ANDROID_HOME=$PREFIX/opt/android-sdk JAVA_HOME=$(dirname $(dirname $(command -v java))) && bash gradlew assembleDebug --no-daemon --stacktrace\n" +
  "6) TERMUX_DONE только с абсолютным путём к app-debug.apk\n" +
  "Debug keystore при необходимости: keytool в $HOME/.aibuilder/keys/aib-debug.keystore\n" +
  "FORBIDDEN: base64-чанки; 15+ отдельных cat; TERMUX_DONE после ls/pkg; выдуманный BUILD SUCCESSFUL.\n" +
  "Минимальный Android (Kotlin или Java) + AGP совместимый с установленным JDK.\n";

const REVERSE_ENGINEERING_PIPELINE_HINT =
  "[REVERSE_ENGINEERING_PIPELINE] Автономный цикл анализа и декомпиляции APK:\n" +
  "1) Проверка инструментов: Проверь jadx, aapt/aapt2, apksigner, strings, readelf. Если не установлены — установи (pkg install -y jadx aapt binutils ...). При ошибках скачивания переключай зеркала.\n" +
  "2) Идентификация APK: Вызови 'aapt dump badging <путь_к_apk>' для извлечения package, versionCode, versionName, permissions, компонентов. Проверь подпись через 'apksigner verify -v --print-certs <apk>'.\n" +
  "3) Декомпиляция ресурсов: Выполни 'jadx -d <каталог_вывода> <apk>' для извлечения AndroidManifest.xml, layouts, strings, drawables.\n" +
  "4) Декомпиляция кода: Запусти 'jadx -d <каталог_кода> <apk>' для получения читаемого Java/Kotlin кода или baksmali для байткода DEX.\n" +
  "5) Анализ безопасности: Проверь exported компоненты без permissions, usesCleartextTraffic, debuggable, hardcoded API ключи/токены, небезопасные библиотеки, нативные .so библиотеки.\n" +
  "6) Финал: Выдай в TERMUX_DONE: структурированный детальный отчёт с метаданными, найденными уязвимостями и путями к распакованным ресурсам и коду.\n";

function toChatHistory(messages: Message[]): ChatTurn[] {
  return (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-CHAT_HISTORY_LIMIT)
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Служебный контекст (дайджест, память проекта, сведения о проекте и
 * релевантный лог) не является отдельными репликами пользователя.
 * Chat-template локальных instruct-моделей, в частности Gemma, требует
 * строгого чередования user/assistant, поэтому такой контекст передаём
 * через единственное system-сообщение.
 */
function appendSystemContext(systemPrompt: string, contextParts: string[]): string {
  const parts = contextParts.map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return systemPrompt;
  return `${systemPrompt.trim()}\n\n[BACKGROUND_CONTEXT]\n${parts.join("\n\n")}\n[/BACKGROUND_CONTEXT]`;
}

function guessImageMime(uri: string): string {
  const ext = (uri.split(".").pop() || "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/jpeg";
}


export function useLLM() {
  const settings = useAppSettingsContext();
  const { logWarn, logError } = useLoggerContext();
  const { t, language } = useLanguage();
  const { confirmDialog } = useDialog();
  const agentBusyRef = useRef(false);
  /** Session that owns the running Termux agent (other chats stay interactive). */
  const agentSessionIdRef = useRef<string | null>(null);
  const abortAgentRef = useRef(false);
  const activeGenerationAbortRef = useRef<AbortController | null>(null);
  const activeCompletionAbortRef = useRef<AbortController | null>(null);
  const activityGenerationRef = useRef(0);
  const activityClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    enabled: termuxEnabled,
    setEnabled: setTermuxEnabled,
    setActivity: setTermuxActivity,
  } = useTermuxContext();
  const beginActivityRun = useCallback(() => {
    if (activityClearTimerRef.current) clearTimeout(activityClearTimerRef.current);
    activityClearTimerRef.current = null;
    activityGenerationRef.current += 1;
    return activityGenerationRef.current;
  }, []);
  const finishActivityRun = useCallback((
    runId: number,
    last: TermuxActivity,
    status: TermuxTaskStatus,
    message?: string,
  ) => {
    if (activityGenerationRef.current !== runId) return;
    const safeMessage = redactTaskActivityText(message || last.errorMessage || last.detail || last.stage || last.command || "");
    setTermuxActivity({
      ...last,
      command: "",
      taskStatus: status,
      detail: safeMessage || last.detail,
      errorMessage: status === "failed" ? (safeMessage || "Task failed") : undefined,
    });
    if (activityClearTimerRef.current) clearTimeout(activityClearTimerRef.current);
    activityClearTimerRef.current = setTimeout(() => {
      if (activityGenerationRef.current === runId) setTermuxActivity(null);
      activityClearTimerRef.current = null;
    }, 10_000);
  }, [setTermuxActivity]);
  useEffect(() => () => {
    if (activityClearTimerRef.current) clearTimeout(activityClearTimerRef.current);
    activityGenerationRef.current += 1;
  }, []);
  const { project: activeProject } = useProjectContext();
  // Накопленная память Termux-агента в рамках текущей сессии чата:
  // команды + результаты предыдущих задач. Без этого модель «забывает»
  // файлы/пути, созданные в прошлых шагах той же сессии.
  const termuxSessionMemory = useRef<AgentTranscriptTurn[]>([]);
  const termuxMemorySessionId = useRef<string | null>(null);

  const activeCloudBindingRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeCloudBindingRef.current && (activeCloudBindingRef.current !== settings.manus.binding || !settings.manus.loaded || !settings.manus.hasApiKey)) activeGenerationAbortRef.current?.abort();
  }, [settings.manus.binding, settings.manus.loaded, settings.manus.hasApiKey]);
  const mode: ModelMode = settings.mode;
  const isOfflineTier = mode === "local";
  const isFreeTier =
    isOfflineTier ||
    (mode === "online" && (settings.onlineModel?.id === "openrouter/free" || String(settings.onlineModel?.id || "").endsWith(":free"))) ||
    (mode === "custom" && /:free$/i.test(String(settings.customProvider?.modelId || "")));
  // offline > free > paid: local GGUF gets the strictest tier prompt
  const modelTier: ModelTier = isOfflineTier ? "offline" : isFreeTier ? "free" : "paid";
  const [isLoading, setIsLoading] = useState(false);
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>(() => [
    makeWelcomeSession(t("welcomeText"), t("newChatTitle")),
  ]);
  const [currentSessionId, setCurrentSessionIdState] = useState("default");
  const hydrated = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rawSessions, rawCurrent] = await Promise.all([
          AsyncStorage.getItem(SESSIONS_STORAGE_KEY),
          AsyncStorage.getItem(CURRENT_SESSION_KEY),
        ]);
        if (cancelled) return;
        if (rawSessions) {
          const parsed = JSON.parse(rawSessions) as ChatSession[];
          if (Array.isArray(parsed) && parsed.length > 0) {
          const cleaned = parsed
            .filter((s): s is ChatSession => Boolean(s && typeof s === "object" && typeof (s as ChatSession).id === "string" && Array.isArray((s as ChatSession).messages)))
            .map((s) => ({
              ...s,
              id: String(s.id),
              title: typeof s.title === "string" ? s.title : "Chat",
              messages: (s.messages || []).filter(
                (m): m is Message => Boolean(m && typeof m === "object" && typeof (m as Message).id === "string" && typeof (m as Message).role === "string"),
              ),
              createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
            }))
            .filter((s) => s.id);
          if (cleaned.length === 0) return;
          setSessions(cleaned);
          if (rawCurrent && cleaned.some((s) => s.id === rawCurrent)) {
            setCurrentSessionIdState(rawCurrent);
          } else {
            setCurrentSessionIdState(cleaned[0]?.id || "default");
          }
          }
        }
      } catch {
        // keep defaults
      } finally {
        if (!cancelled) hydrated.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    persistAsyncStorageItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    if (!hydrated.current) return;
    persistAsyncStorageItem(CURRENT_SESSION_KEY, currentSessionId);
  }, [currentSessionId]);

  const setCurrentSessionId = useCallback((id: string) => {
    setCurrentSessionIdState(id);
    // Isolate runtime session for the active chat (best-effort tmux).
    void ensureRuntimeSession(id).catch(() => {});
  }, []);

  const currentSession =
    sessions.find((s) => s && s.id === currentSessionId) ||
    sessions.find((s) => s && s.id) ||
    makeWelcomeSession(t("welcomeText"), t("newChatTitle"));

  const clearCurrentChat = useCallback(() => {
    abortAgentRef.current = true;
    activeGenerationAbortRef.current?.abort();
    agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
    setTermuxActivity(null);
    termuxSessionMemory.current = [];
    termuxMemorySessionId.current = currentSessionId;
    setIsLoading(false);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentSessionId
          ? {
              ...s,
              title: t("newChatTitle"),
              manusEpoch: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              messages: [
                {
                  id: "welcome",
                  role: "system" as const,
                  content: t("welcomeShort"),
                  timestamp: Date.now(),
                },
              ],
            }
          : s
      )
    );
    persistentLogger.add("info", "Chat", "Чат очищен локальной командой пользователя");
  }, [currentSessionId, setTermuxActivity, t]);

  const recoverOnlineModel = useCallback(async (failedId: string, signal?: AbortSignal): Promise<string | null> => {
    if (signal?.aborted) return null;
    if (!settings.onlineModel.hasApiKey) return null;
    try {
      // Здесь важна скорость, а не идеальная точность (пользователь уже
      // ждёт ответ в чате) — без повторов при 429/503 и с короткой паузой
      // между моделями, в отличие от фоновой/ручной проверки в Настройках.
      const results = await checkOpenRouterModels(
        FREE_OPENROUTER_MODELS,
        undefined,
        { maxRetries: 0, staggerMs: 250, signal }
      );
      if (signal?.aborted) return null;
      const fallback = FREE_OPENROUTER_MODELS.find((candidate) =>
        candidate.id !== failedId && results[candidate.id]?.status === "working"
      );
      if (!fallback) return null;
      settings.setOpenRouterModel(fallback.id);
      logWarn("OnlineModel", `Автоматическая замена модели на ${fallback.id}`);
      return fallback.id;
    } catch {
      return null;
    }
  }, [settings.onlineModel.hasApiKey, settings.setOpenRouterModel, logWarn]);

  // Одна "сырая" реплика модели внутри Termux-агента: та же логика
  // движка local/online, что и в обычном чате, но с добавленным поверх
  // системного промта протоколом TERMUX_RUN:/TERMUX_DONE: (см.
  // t("termuxAgentSystemPrompt") и lib/termux-agent.ts). Полная история —
  // это история конкретной задачи агента, а НЕ история чата целиком: она
  // включает синтетические [TERMUX_RESULT] "реплики" с выводом команд.
  const askModelForAgent = useCallback(async (agentHistory: AgentTranscriptTurn[]): Promise<string> => {
    if (abortAgentRef.current || activeGenerationAbortRef.current?.signal.aborted) {
      throw new Error("ABORTED");
    }
    if (mode === "manus") {
      throw new Error(language === "en" ? "Cloud tasks are not a local Termux model. Select another provider for local build/repair operations." : language === "uk" ? "Хмарні завдання — не локальна модель Termux. Виберіть іншого провайдера для локального збирання й ремонту." : "Облачные задачи — не локальная модель Termux. Выберите другого провайдера для локальной сборки и ремонта.");
    }
    const generationSignal = activeGenerationAbortRef.current?.signal;
    // Protocol is fixed English; user-facing TERMUX_DONE summary follows reply lang.
    const lastUser = [...agentHistory].reverse().find((m) => m.role === "user")?.content || "";
    const langKey = detectReplyLang(lastUser, uiLangToPromptLang(language));
    const combinedSystemPrompt = buildAgentSystemPrompt(
      langKey,
      settings.systemPrompt,
      [settings.termuxAgentPrompt?.trim() || "", agentShellBackendPromptHint()].filter(Boolean).join("\n\n"),
      modelTier,
    );
    const history: ChatTurn[] = agentHistory.map((m) => ({ role: m.role, content: m.content }));

    const withTimeout = (operation: (signal: AbortSignal) => Promise<string>, ms: number): Promise<string> =>
      withAbortableTimeout(operation, ms, new AbortController(), generationSignal);


    if (mode === "custom") {
      const cfg = settings.customProvider;
      if (!cfg?.hasApiKey || !cfg?.baseUrl?.trim() || !cfg?.modelId?.trim()) {
        throw new Error("Custom provider: нужны Base URL, API-ключ и Model ID");
      }
      customProviderEngine.setConfig({
        name: cfg.name,
        baseUrl: cfg.baseUrl,
        modelId: cfg.modelId,
        providerId: cfg.providerId,
        hasApiKey: cfg.hasApiKey,
        extraHeadersJson: cfg.extraHeadersJson,
      });
      try {
        const text = await withTimeout(
          (signal) => customProviderEngine.chat([
            { role: "system", content: combinedSystemPrompt },
            ...history,
          ], {
            ...DEFAULT_CUSTOM_PARAMS,
            maxTokens: Math.min(Math.max(settings.onlineGenParams.maxTokens || 0, 512), 8192),
            temperature: settings.onlineGenParams.temperature ?? 0.7,
            topP: settings.onlineGenParams.topP ?? DEFAULT_CUSTOM_PARAMS.topP,
          }, signal),
          180_000
        );
        clearProviderRateLimit(cfg.baseUrl, cfg.modelId);
        return text;
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        if (generationSignal?.aborted || raw === "ABORTED") throw new Error("ABORTED");
        throw new Error(
          formatProviderUserError(translateEngineError(t, raw), {
            baseUrl: cfg.baseUrl,
            modelId: cfg.modelId,
          })
        );
      }
    }

    if (mode === "opencode") {
      const oc = settings.openCode;
      if (!oc?.hasApiKey) {
        throw new Error("OpenCode: API-ключ не установлен");
      }
      customProviderEngine.setConfig({
        name: "OpenCode",
        baseUrl: oc.baseUrl || "https://opencode.ai/zen/v1",
        modelId: oc.modelId || "",
        providerId: "opencode",
        hasApiKey: oc.hasApiKey,
      });
      try {
        return await withTimeout(
          (signal) => customProviderEngine.chat([
            { role: "system", content: combinedSystemPrompt },
            ...history,
          ], {
            ...DEFAULT_CUSTOM_PARAMS,
            maxTokens: Math.min(Math.max(settings.onlineGenParams.maxTokens || 0, 512), 8192),
            temperature: settings.onlineGenParams.temperature ?? 0.7,
            topP: settings.onlineGenParams.topP ?? DEFAULT_CUSTOM_PARAMS.topP,
          }, signal),
          180_000
        );
      } catch (err: unknown) {
        if (generationSignal?.aborted || (err instanceof Error && err.message === "ABORTED")) throw new Error("ABORTED");
        throw new Error(translateEngineError(t, err instanceof Error ? err.message : String(err)));
      }
    }



    if (mode === "online") {
      if (!settings.onlineModel.hasApiKey) {
        throw new Error(t("errorNoApiKey"));
      }
      // Free-модели: низкая temperature + короткий ответ; 429 → retry (в callOpenRouter)
      // и смена модели (recoverOnlineModel).
      const agentParams = {
        ...settings.onlineGenParams,
        maxTokens: Math.min(Math.max(settings.onlineGenParams.maxTokens || 0, 512), 1024),
        temperature: Math.min(settings.onlineGenParams.temperature ?? 0.4, 0.1),
      };
      const runChat = (modelId: string) =>
        withTimeout(
          (signal) => onlineModelEngine.chat(
            history,
            agentParams,
            language,
            combinedSystemPrompt,
            modelId,
            signal
          ),
          180_000
        );
      try {
        return await runChat(settings.onlineModel?.id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "ABORTED") throw err;
        if (msg === "MODEL_TIMEOUT") {
          throw new Error(translateEngineError(t, "EMPTY") || "MODEL_TIMEOUT");
        }
        // Общий дневной лимит OpenRouter распространяется на весь аккаунт,
        // поэтому смена одной :free модели на другую здесь бессмысленна.
        // Если локальная модель загружена, продолжаем автономный Termux-recovery
        // через неё — сборка не должна превращаться в ошибку чата из-за 429.
        if (/free-models-per-day|1000 free model requests|HTTP:429:DAILY_FREE_QUOTA/i.test(msg)) {
          if (!localModelEngine.isLoaded()) throw new Error("HTTP:429:DAILY_FREE_QUOTA");
          logWarn("Termux", "OpenRouter: дневной free-лимит исчерпан → recovery продолжен локальной моделью");
          try {
            return await withTimeout(
              (signal) => localModelEngine.chat(history, settings.localGenParams, language, combinedSystemPrompt, signal),
              180_000
            );
          } catch (localErr: unknown) {
            const lm = localErr instanceof Error ? localErr.message : String(localErr);
            if (lm === "MODEL_TIMEOUT" || /timeout/i.test(lm)) {
              logWarn("Termux", "Local model timeout — one retry with extended budget");
              return await withTimeout(
                (signal) => localModelEngine.chat(history, settings.localGenParams, language, combinedSystemPrompt, signal),
                240_000
              );
            }
            throw localErr;
          }
        }
        // 429/503 — сначала быстрая смена на следующую ★-модель (без полного probe)
        if (/HTTP:429|HTTP:503|unavailable|rate limit|Provider returned/i.test(msg)) {
          const preferred = [
            "poolside/laguna-s-2.1:free",
            "cohere/north-mini-code:free",
            "nex-agi/nex-n2.5-mini:free",
            "poolside/laguna-xs-2.1:free",
            "nvidia/nemotron-3-super-120b-a12b:free",
            "openrouter/free",
          ];
          const cur = settings.onlineModel?.id;
          const alt =
            preferred.find((id) => id !== cur) ||
            (await recoverOnlineModel(cur, generationSignal));
          if (generationSignal?.aborted) throw new Error("ABORTED");
          if (alt) {
            settings.setOpenRouterModel(alt);
            logWarn("Termux", `429/лимит → переключение на ${alt}`);
            try {
              return await runChat(alt);
            } catch (err2: unknown) {
              const msg2 = err2 instanceof Error ? err2.message : String(err2);
              if (msg2 === "ABORTED") throw err2;
              throw new Error(translateEngineError(t, msg2));
            }
          }
        }
        throw new Error(translateEngineError(t, msg));
      }
    }

    if (!localModelEngine.isLoaded()) {
      throw new Error(t("errorOfflineNotLoaded"));
    }
    try {
      return await withTimeout(
        (signal) => localModelEngine.chat(history, settings.localGenParams, language, combinedSystemPrompt, signal),
        120_000
      );
    } catch (err: unknown) {
      if (generationSignal?.aborted || (err instanceof Error && err.message === "ABORTED")) throw new Error("ABORTED");
      throw new Error(translateEngineError(t, err instanceof Error ? err.message : String(err)));
    }
  }, [
    mode,
    settings.systemPrompt,
    settings.termuxAgentPrompt,
    settings.onlineModel,
    settings.onlineGenParams,
    settings.localGenParams,
    settings.customProvider,
    language,
    t,
    recoverOnlineModel,
    logWarn,
    modelTier,
  ]);

  /**
   * Общий публичный вход для фоновых действий (например, кнопки "Скачать"
   * в Настройках). Он использует тот же AI/Termux recovery-loop, что и чат,
   * поэтому установка не заканчивается на первой ошибке.
   */
  const runTermuxTask = useCallback(async (task: string): Promise<string> => {
    if (!termuxEnabled) return t("termuxSetupHintMessage");
    if (agentBusyRef.current) return t("agentBusy");

    const taskAbortController = new AbortController();
    activeGenerationAbortRef.current = taskAbortController;
    const runId = beginActivityRun();
    const taskKind = classifyTermuxTaskKind(task, {
      createApp: isCreateAppIntent(task),
      build: isBuildIntent(task),
      reverse: isReverseEngineeringIntent(task),
    });
    const taskIsBuild = taskKind === "create_apk" || taskKind === "build_apk";
    let lastActivity: TermuxActivity = {
      command: "",
      step: 0,
      maxSteps: AGENT_DEFAULT_MAX_STEPS,
      taskKind,
      taskStatus: "running",
      title: taskKindTitle(taskKind, language),
      isBuild: taskIsBuild,
      stages: [],
    };
    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    abortAgentRef.current = false;
    notifyAgentStarted(task);
    try {
      const session = currentSession;
      if (!session?.id) return t("agentBusy");
      if (termuxMemorySessionId.current !== session.id) {
        termuxMemorySessionId.current = session.id;
        termuxSessionMemory.current = [];
      }
      const chatTurns = toChatHistory(session.messages || []).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      const logCtx = buildRelevantSessionLogContext(task);
      const priorChat: AgentTranscriptTurn[] = [
        ...chatTurns,
        ...termuxSessionMemory.current.slice(-40),
        ...(logCtx ? [{ role: "user" as const, content: logCtx }] : []),
      ];
      setTermuxActivity(lastActivity);
      const result = await runTermuxAgentTask(task, {
        maxSteps: AGENT_DEFAULT_MAX_STEPS,
        language,
        perCommandTimeoutMs: 600_000,
        askModel: askModelForAgent,
        priorChat,
        projectPath: activeProject?.path,
        confirmDangerous: async (cmd, reason) =>
          confirmDialog(
            t("dangerCmdTitle"),
            `${reason}\n\n$ ${cmd}`,
            t("dangerCmdAllow"),
            t("cancel")
          ),
        onActivity: (info) => {
          if (!info) return;
          lastActivity = {
            command: info.command || "",
            step: info.step,
            maxSteps: info.maxSteps,
            taskKind,
            taskStatus: info.taskStatus || "running",
            progressPercent: info.progressPercent,
            title: info.title || taskKindTitle(taskKind, language),
            detail: info.detail,
            stage: info.stage,
            stageIndex: info.stageIndex,
            stageCount: info.stageCount,
            stages: info.stages || [],
            buildStatus: info.buildStatus,
            recovery: info.recovery,
            maxRecovery: info.maxRecovery,
            diagnosis: info.diagnosis,
            action: info.action,
            result: info.result,
            isReverse: info.isReverse,
            reverseTools: info.reverseTools,
            isBuild: taskIsBuild || info.isBuild,
          };
          setTermuxActivity(lastActivity);
        },
        onSessionMemory: (turns) => {
          termuxSessionMemory.current = [...termuxSessionMemory.current, ...turns].slice(-60);
        },
        shouldAbort: () => abortAgentRef.current,
        strings: {
          stepLimitReached: t("termuxStepLimitReached"),
          setupHint: t("termuxSetupHintMessage"),
          genericError: (msg: string) => `${t("termuxGenericErrorPrefix")}${msg}`,
          quotaHint: t("termuxQuotaExhaustedHint"),
          aborted: t("agentStopped"),
        },
      });
      if (abortAgentRef.current || taskAbortController.signal.aborted) {
        notifyAgentFailed(t("agentStopped"));
        finishActivityRun(runId, lastActivity, "cancelled", t("agentStopped"));
        return t("agentStopped");
      }
      notifyAgentDone(result || "OK");
      finishActivityRun(runId, lastActivity, "completed", result || "OK");
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (abortAgentRef.current || taskAbortController.signal.aborted || msg === "ABORTED") {
        notifyAgentFailed(t("agentStopped"));
        finishActivityRun(runId, lastActivity, "cancelled", t("agentStopped"));
        return t("agentStopped");
      }
      notifyAgentFailed(msg);
      finishActivityRun(runId, lastActivity, "failed", msg);
      return `${t("termuxGenericErrorPrefix")}${msg}`;
    } finally {
      if (activeGenerationAbortRef.current === taskAbortController) {
        activeGenerationAbortRef.current = null;
      }
      agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
      setIsLoading(false);
    }
  }, [
    termuxEnabled,
    t,
    currentSession?.id,
    activeProject?.path,
    askModelForAgent,
    confirmDialog,
    setTermuxActivity,
    beginActivityRun,
    finishActivityRun,
  ]);

  const sendMessage = useCallback(async (message: string): Promise<string> => {
    if (isClearChatCommand(message)) {
      clearCurrentChat();
      return t("chatCleared");
    }
    const requestAbortController = new AbortController();
    activeGenerationAbortRef.current = requestAbortController;
    setIsLoading(true);
    persistentLogger.add(
      "info",
      "Chat",
      `Отправка запроса mode=${mode}${termuxEnabled ? "+Termux" : ""} chars=${message.length}`,
      "agent"
    );
    try {
      const replyLang = detectReplyLang(message, uiLangToPromptLang(language));
      const langKey = replyLang;
      const explicitAgentToolRequest = isExplicitAgentToolRequest(message);
      if (explicitAgentToolRequest && mode === "manus") {
        persistentLogger.add("warn", "Chat", "Explicit AIB_TOOL request blocked in cloud-only mode");
        return t("explicitToolCloudModeRequired");
      }
      if (explicitAgentToolRequest && !termuxEnabled) {
        persistentLogger.add("warn", "Chat", "Explicit AIB_TOOL request blocked: Termux Agent mode is off");
        return t("explicitToolAgentModeRequired");
      }
      // API v2 runs cloud agent tasks. Never route it through completions, model
      // recovery, or the local Termux protocol, and never silently switch providers.
      if (mode === "manus") {
        if (!settings.manus.loaded || !settings.manus.hasApiKey || !settings.manus.binding) {
          return language === "en" ? "Set and save your API key in Settings → Online models → Manus. No account is connected yet." : language === "uk" ? "Введіть і збережіть власний API-ключ у Налаштування → Онлайн-моделі → Manus. Обліковий запис ще не підключений." : "Введите и сохраните свой API-ключ в Настройки → Онлайн-модели → Manus. Аккаунт ещё не подключён.";
        }
        try {
          activeCloudBindingRef.current = settings.manus.binding;
          const storageKey = manusTaskStorageKey(settings.manus.binding, currentSessionId, currentSession.createdAt, currentSession.manusEpoch);
          const previous = await loadManusTask(storageKey);
          const prompt = [settings.systemPrompt?.trim(), `Reply language: ${langKey}. This is a cloud task, not access to the Android app's local Termux workspace.`, message].filter(Boolean).join("\n\n");
          return await runManusTask({
            prompt, profile: settings.manus.profile, previous,
            signal: requestAbortController.signal,
            onState: (state) => saveManusTask(storageKey, state),
          });
        } catch (error: unknown) {
          // No raw network/provider exceptions in logs. The API adapter emits only
          // safe messages; storage failures are deliberately replaced here.
          if (requestAbortController.signal.aborted) {
            return language === "en" ? "Local waiting stopped. The cloud task may still be running. Send another message to resume checking; that message will not be sent while the task is pending." : language === "uk" ? "Локальне очікування зупинено. Хмарне завдання може працювати далі. Наступне повідомлення відновить перевірку; поки завдання виконується, його текст не надсилається." : "Локальное ожидание остановлено. Облачная задача может продолжать работу. Следующее сообщение возобновит проверку; пока задача выполняется, его текст не отправляется.";
          }
          return manusErrorMessage(error, language);
        }
      }
      // Модель не для чата (image/embedding/…) — сразу понятный ответ в чат.
      if (mode === "custom" || mode === "opencode") {
        const mid =
          mode === "opencode"
            ? String(settings.openCode?.modelId || "")
            : String(settings.customProvider?.modelId || "");
        const unsupported = getUnsupportedModelChatMessage(mid, langKey);
        if (unsupported) {
          persistentLogger.add("warn", "Chat", `Unsupported model blocked: ${formatModelIdForLog(mid)}`);
          notifyAgentFailed(unsupported);
          return unsupported;
        }
      }

      // Termux ON = agent available, NOT "every message is a build".
      // Agent only when the message needs disk/build/install/file ops.
      // Intent (write-file / build / path) wins over chat-only heuristics so
      // «создай файл в Download» never becomes a passive "Termux inactive" essay
      // for Termux, Ubuntu, or Debian selected environments.
      let useTermuxAgent = false;
      const strongCreateEarly = isStrongCreateAppTask(message);
      const intentEarly = detectTermuxIntent(message);
      const chatOnly =
        !explicitAgentToolRequest &&
        !strongCreateEarly &&
        !intentEarly.needed &&
        (isSmallTalkMessage(message) ||
          isInfoOnlyQuery(message) ||
          isChatOnlyMessage(message));
      if (termuxEnabled && !chatOnly) {
        const intent = intentEarly;
        const strongCreate = strongCreateEarly;
        // Strong create-app / build / path / write-file ops → agent; pure chat stays chat
        if (intent.needed || strongCreate || isSharedStorageOnlyUserTask(message) || explicitAgentToolRequest) {
          useTermuxAgent = true;
          persistentLogger.add(
            "info",
            "Chat",
            `Termux agent for intent=[${intent.reasons.join(",") || (explicitAgentToolRequest ? "explicit-AIB_TOOL" : strongCreate ? "create-app" : "")}] backend-aware`,
            "agent",
          );
        }
      } else if (!termuxEnabled && !chatOnly) {
        const intent = intentEarly;
        if (intent.needed) {
          persistentLogger.add(
            "info",
            "Chat",
            `Termux bridge: intent=[${intent.reasons.join(",")}]`,
            "agent",
          );
          const allow = await confirmDialog(
            t("termuxBridgeTitle"),
            t("termuxBridgeBody"),
            t("termuxBridgeEnable"),
            t("termuxBridgeChatOnly"),
          );
          if (allow) {
            const ok = await setTermuxEnabled(true);
            if (ok) {
              useTermuxAgent = true;
              persistentLogger.add("info", "Chat", "Termux bridge: session enabled, running agent");
            } else {
              return t("termuxBridgeEnableFailed");
            }
          } else {
            persistentLogger.add("info", "Chat", "Termux bridge: user chose chat-only");
          }
        }
      }

      // Автономный агентный цикл только для реальных Termux-задач
      if (useTermuxAgent) {
        if (agentBusyRef.current && agentSessionIdRef.current === currentSessionId) {
          return t("agentBusy");
        }
        if (agentBusyRef.current && agentSessionIdRef.current && agentSessionIdRef.current !== currentSessionId) {
          if (explicitAgentToolRequest) return t("agentBusy");
          useTermuxAgent = false;
          persistentLogger.add(
            "info",
            "Chat",
            "Termux agent busy in another session — this chat uses model-only replies (Termux left ON)",
            "agent",
          );
        }

        // Safety net: chat-only never enters agent (even if intent mis-fired)
        if (!explicitAgentToolRequest && (chatOnly || isSmallTalkMessage(message) || isInfoOnlyQuery(message) || isChatOnlyMessage(message))) {
          persistentLogger.add(
            "info",
            "Agent",
            `Chat-only: skipping Termux agent loop — "${message.slice(0, 80).replace(/\n/g, " ")}"`,
          );
          const history = toChatHistory(currentSession.messages);
          history.push({ role: "user", content: message });
          // Fall through to non-Termux chat path below by temporarily
          // answering here with the plain chat engines.
          try {
            if (mode === "custom") {
              const cfg = settings.customProvider;
              if (!cfg?.hasApiKey || !cfg?.baseUrl?.trim() || !cfg?.modelId?.trim()) {
                return "Custom provider: нужны Base URL, API-ключ и Model ID";
              }
              if (looksLikeImageModel(cfg.modelId)) {
                return (
                  "⚠️ Выбрана image/NSFW-модель (" +
                  cfg.modelId +
                  "). Для чата и Termux-агента нужна текстовая chat/code-модель."
                );
              }
              const left = getProviderRateLimitRemainingSec(cfg.baseUrl, cfg.modelId);
              if (left > 0) {
                const msg =
                  `❌ Лимит запросов ещё активен (~${formatSecondsHuman(left)}). ` +
                  "Смените модель или подождите.";
                notifyAgentFailed(msg);
                return msg;
              }
              customProviderEngine.setConfig({
                name: cfg.name,
                baseUrl: cfg.baseUrl,
                modelId: cfg.modelId,
                providerId: cfg.providerId,
                hasApiKey: cfg.hasApiKey,
                extraHeadersJson: cfg.extraHeadersJson,
              });
              const text = await customProviderEngine.chat(
                [
                  { role: "system", content: buildSystemPrompt(langKey, settings.systemPrompt, null, modelTier) },
                  ...history,
                ],
                {
                  ...DEFAULT_CUSTOM_PARAMS,
                  maxTokens: Math.min(Math.max(settings.onlineGenParams.maxTokens || 0, 256), 2048),
                  temperature: settings.onlineGenParams.temperature ?? 0.7,
                  topP: settings.onlineGenParams.topP ?? DEFAULT_CUSTOM_PARAMS.topP,
                }
              );
              clearProviderRateLimit(cfg.baseUrl, cfg.modelId);
              return text;
            }
          } catch (err: unknown) {
            const raw = err instanceof Error ? err.message : String(err);
            const cfg = settings.customProvider;
            const msg = formatProviderUserError(raw, {
              baseUrl: cfg?.baseUrl,
              modelId: cfg?.modelId,
            });
            notifyAgentFailed(msg);
            return msg;
          }
          // Non-custom modes: continue without Termux agent (normal path).
        } else {
        agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
        abortAgentRef.current = false;
        notifyAgentStarted(message);
        const taskRunId = beginActivityRun();
        const taskKind = classifyTermuxTaskKind(message, {
          createApp: isCreateAppIntent(message),
          build: isBuildIntent(message),
          reverse: isReverseEngineeringIntent(message),
        });
        const taskIsBuild = taskKind === "create_apk" || taskKind === "build_apk";
        let taskOutcome: TermuxTaskStatus = "failed";
        let taskOutcomeMessage = "";
        let lastActivity: TermuxActivity = {
          command: "",
          step: 0,
          maxSteps: taskKind === "create_apk" ? 96 : taskKind === "reverse" ? 48 : 40,
          taskKind,
          taskStatus: "running",
          title: taskKindTitle(taskKind, language),
          isBuild: taskIsBuild,
          stages: [],
        };
        let memoryLifecycle: Awaited<ReturnType<typeof startMemoryLifecycle>> = null;
        let result = "";
        let memoryOutcome = "";
        // Keep these settings outside the inner try: the finally block must
        // always be able to close the memory lifecycle without a block-scope
        // ReferenceError/TypeScript scope error.
        const intelligenceSettings = { ...settings.agentIntelligence };
        const singleRequestCustomFree =
          mode === "custom" && /:free$/i.test(String(settings.customProvider?.modelId || ""));
        if (singleRequestCustomFree) {
          // Some custom free gateways enforce one request per 60 minutes.
          // Preflight/advisor/reviewer would spend that single request before
          // the actual task. Keep the main task as the only model call.
          intelligenceSettings.autoPreflight = false;
          intelligenceSettings.autoPostReview = false;
          intelligenceSettings.advisor = false;
          persistentLogger.add(
            "warn",
            "Agent",
            "Custom :free provider detected: preflight/advisor/post-review disabled to avoid consuming a one-request quota"
          );
        }

        // Preflight gates: rate limit + image model + hard provider lock.
        if (mode === "custom" || mode === "opencode") {
          const cfg =
            mode === "opencode"
              ? {
                  baseUrl: settings.openCode?.baseUrl || "https://opencode.ai/zen/v1",
                  modelId: settings.openCode?.modelId || "",
                }
              : {
                  baseUrl: settings.customProvider?.baseUrl || "",
                  modelId: settings.customProvider?.modelId || "",
                };
          if (looksLikeImageModel(cfg.modelId)) {
            const msg =
              `⚠️ Модель «${cfg.modelId}» похожа на image/NSFW, а не на текстовый чат.\n` +
              "Выберите chat/code-модель — иначе агент Termux не сможет выполнять задачи.";
            persistentLogger.add("warn", "Agent", msg);
            notifyAgentFailed(msg);
            agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
            return msg;
          }
          const left = getProviderRateLimitRemainingSec(cfg.baseUrl, cfg.modelId);
          if (left > 0) {
            const msg =
              `❌ Лимит запросов к «${cfg.modelId}» ещё активен (~${formatSecondsHuman(left)}).\n` +
              "Подождите или смените модель / тариф. Агент не запущен, чтобы не жечь квоту.";
            notifyAgentFailed(msg);
            agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
            return msg;
          }
        }
        try {
        // Смена чата — сбрасываем накопленную память Termux.
        if (currentSession?.id && termuxMemorySessionId.current !== currentSession.id) {
          termuxMemorySessionId.current = currentSession.id;
          termuxSessionMemory.current = [];
        }

        // Автоцикл збірки: якщо є активний проєкт і запит про build/assemble.
        if (activeProject && isBuildIntent(message) && !isCreateAppIntent(message)) {
          const maxAttempts = 8;
          let lastLog = "";
          const repairSummaries: string[] = [];
          const buildStageTemplate = createObservedAssembleStages(language);
          let buildStages: BuildStage[] = buildStageTemplate.map((x) => ({ ...x }));
          const publishBuildActivity = (attemptNumber: number, extra: Partial<{ command: string; step: number; maxSteps: number; title?: string; detail?: string; stage?: string; stageIndex?: number; stageCount?: number; stages?: BuildStage[]; isBuild?: boolean; recovery?: number; maxRecovery?: number; taskKind?: TermuxTaskKind; taskStatus?: TermuxTaskStatus; progressPercent?: number; errorMessage?: string; buildStatus?: "running" | "recovering" | "verified" }> = {}) => {
            // stages/isBuild не перезаписываем через ...extra (undefined затирал прогресс)
            lastActivity = {
              command: extra.command ?? "",
              step: extra.step ?? attemptNumber,
              maxSteps: extra.maxSteps ?? maxAttempts,
              title: extra.title ?? taskKindTitle(taskKind, language),
              taskKind: extra.taskKind ?? taskKind,
              taskStatus: extra.taskStatus ?? "running",
              progressPercent: extra.progressPercent,
              buildStatus: extra.buildStatus,
              errorMessage: extra.errorMessage,
              detail: extra.detail,
              stage: extra.stage,
              stageIndex: extra.stageIndex,
              stageCount: extra.stageCount ?? buildStages.length,
              recovery: attemptNumber > 1 ? attemptNumber : undefined,
              maxRecovery: maxAttempts,
              isBuild: true,
              stages: extra.stages && extra.stages.length > 0 ? extra.stages : buildStages,
            };
            setTermuxActivity(lastActivity);
          };
          const recoveryFingerprints: string[] = [];
          const recoveryStrategies: string[] = [];
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (abortAgentRef.current) {
              taskOutcome = "cancelled";
              taskOutcomeMessage = t("agentStopped");
              return t("agentStopped");
            }
            buildStages = buildStageTemplate.map((x) => ({ ...x }));
            buildStages[0].status = "active";
            publishBuildActivity(attempt, { command: "Проверка Android/Java/Gradle окружения", detail: "Проверяю подготовку к сборке…", stage: "Проверка окружения", stageIndex: 0, stageCount: buildStages.length });
            const build = await runAssembleDebug(activeProject.path, 600_000, (update) => {
              buildStages = applyObservedBuildStageUpdate(buildStages, update);
              const active = buildStages.find((item) => item.status === "active") || buildStages.find((item) => item.status === "error");
              publishBuildActivity(attempt, {
                command: update.detail || active?.label || "",
                detail: update.detail,
                stage: active?.label,
                stageIndex: Math.max(0, buildStages.findIndex((item) => item.id === active?.id)),
                stageCount: buildStages.length,
              });
            });
            lastLog = build.log;
            if (build.success) {
              publishBuildActivity(attempt, {
                command: "verified APK output",
                detail: language === "en" ? "APK was built and verified" : language === "uk" ? "APK зібрано та перевірено" : "APK собран и проверен",
                stage: language === "en" ? "Verified APK" : language === "uk" ? "APK перевірено" : "APK проверен",
                taskStatus: "completed",
                buildStatus: "verified",
              });
              const okMsg =
                buildSuccessMessage(activeProject.path, build) +
                (repairSummaries.length
                  ? `\n\nИсправлено агентом:\n${repairSummaries.slice(-8).join("\n")}`
                  : "");
              taskOutcome = "completed";
              taskOutcomeMessage = okMsg;
              notifyAgentDone(okMsg);
              return okMsg;
            }
            if (attempt === maxAttempts) break;

            // Промежуточная ошибка НИКОГДА не отправляется в чат. Она целиком
            // передаётся repair-agent вместе с реальным логом; после исправления
            // outer loop снова выполняет настоящую сборку.
            const recoveryState = classifyRecoveryFailure(build.log);
            buildStages = buildStages.map((item) => item.status === "active" ? { ...item, status: "error", detail: recoveryState.category } : item);
            buildStages = [
              ...buildStages.filter((item) => item.id !== "repair"),
              { id: "repair", label: language === "en" ? "Repair source" : language === "uk" ? "Виправлення вихідного коду" : "Исправление исходников", status: "active", detail: recoveryState.strategy },
            ];
            publishBuildActivity(attempt, {
              command: "Анализ ошибки и автоматическое исправление",
              detail: `${recoveryState.category}: ${recoveryState.strategy}`,
              stage: "Автоматическое исправление",
              stageIndex: buildStages.length - 1,
              stageCount: buildStages.length,
            });
            const recoveryContext = buildRecoveryContext(recoveryState, recoveryStrategies);
            if (!recoveryFingerprints.includes(recoveryState.fingerprint)) recoveryFingerprints.push(recoveryState.fingerprint);
            recoveryStrategies.push(`${recoveryState.phase}/${recoveryState.category}: ${recoveryState.strategy}`);
            const fixTask = buildFixPrompt(activeProject.path, attempt, maxAttempts, build, recoveryStrategies.slice(-6));
            try {
              const repairResult = await runTermuxAgentTask(fixTask, {
                maxSteps: 24,
                perCommandTimeoutMs: 900_000,
                askModel: askModelForAgent,
                priorChat: [
                  { role: "user" as const, content: recoveryContext },
                  ...toChatHistory(currentSession.messages).map((m) => ({
                    role: m.role as "user" | "assistant",
                    content: m.content,
                  })),
                  ...termuxSessionMemory.current.slice(-30),
                ],
                projectPath: activeProject.path,
                disableSpecialFastPaths: true,
                confirmDangerous: async (cmd, reason) =>
                  confirmDialog(t("dangerCmdTitle"), `${reason}\n\n$ ${cmd}`, t("dangerCmdAllow"), t("cancel")),
                onActivity: (info) =>
                  publishBuildActivity(attempt, {
                    command: info?.command || "Агент анализирует проект и исправляет ошибку…",
                    detail: info?.command ? "Выполняется repair-agent" : "Диагностика…",
                    stage: "Автоматическое исправление",
                    stageIndex: 1,
                    stageCount: buildStages.length,
                  }),
                onSessionMemory: (turns) => {
                  termuxSessionMemory.current = [...termuxSessionMemory.current, ...turns].slice(-60);
                },
                shouldAbort: () => abortAgentRef.current,
                strings: {
                  stepLimitReached: t("termuxStepLimitReached"),
                  setupHint: t("termuxSetupHintMessage"),
                  genericError: (msg: string) => `${t("termuxGenericErrorPrefix")}${msg}`,
                  quotaHint: t("termuxQuotaExhaustedHint"),
                  aborted: t("agentStopped"),
                },
              });
              const summary = String(repairResult || "")
                .replace(/\s+/g, " ")
                .trim();
              buildStages = buildStages.map((item) => item.id === "repair" ? { ...item, status: "done", detail: language === "en" ? "Repair agent returned" : language === "uk" ? "Repair-агент завершив" : "Repair-агент завершил" } : item);
              publishBuildActivity(attempt, {
                command: language === "en" ? "Repair complete; retrying build" : language === "uk" ? "Виправлення завершено; повторна збірка" : "Исправление завершено; повторная сборка",
                detail: summary.slice(0, 240),
                stage: language === "en" ? "Source repair complete" : language === "uk" ? "Вихідний код виправлено" : "Исходники исправлены",
                stageIndex: buildStages.length - 1,
                stageCount: buildStages.length,
              });
              if (
                summary &&
                !/generic error|step limit|timeout|не удалось автоматически|ошибка/i.test(summary)
              ) {
                repairSummaries.push(`• ${summary.slice(0, 280)}`);
              }
            } catch (repairErr: unknown) {
              // Ошибка repair-agent — тоже промежуточная: логируем и даём
              // следующей итерации самой попробовать снова.
              persistentLogger.add(
                "warn",
                "Build",
                `repair-agent exception: ${String(repairErr)}`
              );
            }
          }
          const failMsg =
            `❌ Не удалось завершить сборку после ${maxAttempts} циклов автоматического исправления.\n` +
            `Проект: ${activeProject.path}\n` +
            `Последняя причина сохранена в журнале.`;
          taskOutcome = "failed";
          taskOutcomeMessage = failMsg;
          notifyAgentFailed(failMsg);
          return failMsg;
        }

        // История чата (user/assistant) + память команд Termux из этой сессии.
        const chatTurns: AgentTranscriptTurn[] = toChatHistory(currentSession.messages)
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
        const memoryTurns = termuxSessionMemory.current.slice(-40);
        // Релевантные строки лога (ранние файлы/пути/команды) — вместо
        // протаскивания всей истории в токены.
        const logCtx = buildRelevantSessionLogContext(message);
        const priorChat: AgentTranscriptTurn[] = [
          ...chatTurns,
          ...memoryTurns,
          ...(logCtx
            ? [{ role: "user" as const, content: logCtx }]
            : []),
        ];
        // На бесплатном тарифе не запускаем тяжелые вторичные прогоны preflight и review,
        // чтобы экономить квоту токенов и избегать ошибок 429 от провайдеров
        // Local-first/P0 policy: subagents and preflight model calls never run
        // before the primary model has successfully completed the user's task.
        // This also prevents a provider outage from turning into a burst of
        // secondary requests. The legacy setting is retained for compatibility.
        let preflight = "";
        if (intelligenceSettings.autoPreflight || intelligenceSettings.subagents) {
          try {
            preflight = await buildPreflightContext(
              message,
              activeProject?.path,
              { askModel: askModelForAgent },
              intelligenceSettings,
            );
            if (preflight) {
              persistentLogger.add(
                "info",
                "Agent",
                `Preflight context ready chars=${preflight.length} subagents=${intelligenceSettings.subagents ? "on" : "off"} memory=${intelligenceSettings.memory ? "on" : "off"}`,
              );
            }
          } catch (e: unknown) {
            persistentLogger.add(
              "warn",
              "Agent",
              `Preflight failed: ${e instanceof Error ? e.message : String(e)}`,
            );
            preflight = "";
          }
        }
        const createApp = isCreateAppIntent(message);
        if (createApp) {
          persistentLogger.add("info", "Agent", "Create-app intent → engine first (toolchain+scaffold), then LLM only if needed");
        }
        const reverseEng = isReverseEngineeringIntent(message);
        let agentTask = preflight ? `${message}\n\n${preflight}` : message;
        const maxTaskSteps = createApp ? 96 : reverseEng ? 48 : 40;
        lastActivity = {
          command: "",
          step: 0,
          maxSteps: maxTaskSteps,
          taskKind,
          taskStatus: "running",
          title: taskKindTitle(taskKind, language),
          isBuild: taskIsBuild,
          stages: [],
        };
        setTermuxActivity(lastActivity);
        if (createApp) {
          agentTask = `${CREATE_APP_PIPELINE_HINT}\n[TASK]\n${agentTask}`;
          persistentLogger.add("info", "Agent", "Create-app intent: full code-on-disk + assembleDebug pipeline enabled");
        } else if (reverseEng) {
          agentTask = `${REVERSE_ENGINEERING_PIPELINE_HINT}\n[TASK]\n${agentTask}`;
          persistentLogger.add("info", "Agent", "Reverse engineering intent: decompilation + analysis pipeline enabled");
        }
        memoryLifecycle = await startMemoryLifecycle(message, activeProject?.path, intelligenceSettings);
        result = await runTermuxAgentTask(agentTask, {
          maxSteps: createApp ? 96 : reverseEng ? 48 : 40,
          language,
          // 10 минут на обычную команду; для gradle/npm/assemble
          // termux-bridge сам поднимет до BUILD_TIMEOUT (30 мин)
          perCommandTimeoutMs: 600_000,
          askModel: askModelForAgent,
          priorChat,
          projectPath: activeProject?.path,
          intelligence: intelligenceSettings,
          advisorTask: message,
          confirmDangerous: async (cmd, reason) => {
            return confirmDialog(
              t("dangerCmdTitle"),
              `${reason}\n\n$ ${cmd}`,
              t("dangerCmdAllow"),
              t("cancel")
            );
          },
          onActivity: (info) => {
            if (!info) return;
            lastActivity = {
              ...info,
              command: info.command || "",
              taskKind,
              taskStatus: info.taskStatus || "running",
              progressPercent: info.progressPercent,
              title: info.title || taskKindTitle(taskKind, language),
              stages: info.stages || [],
              isBuild: taskIsBuild || info.isBuild,
            };
            setTermuxActivity(lastActivity);
          },
          onSessionMemory: (turns) => {
            termuxSessionMemory.current = [
              ...termuxSessionMemory.current,
              ...turns,
            ].slice(-60);
          },
          shouldAbort: () => abortAgentRef.current,
          strings: {
            stepLimitReached: t("termuxStepLimitReached"),
            setupHint: t("termuxSetupHintMessage"),
            genericError: (msg: string) => `${t("termuxGenericErrorPrefix")}${msg}`,
            quotaHint: t("termuxQuotaExhaustedHint"),
            aborted: t("agentStopped"),
          },
        });
        const primaryProviderFailed = isProviderHardFailure(result || "") || String(result || "").startsWith(`${t("modelError")}:`);
        const review = (!isFreeTier && intelligenceSettings.autoPostReview && !primaryProviderFailed)
          ? await runPostReview(message, result, activeProject?.path, { askModel: askModelForAgent }, intelligenceSettings)
          : "";
        if (primaryProviderFailed && intelligenceSettings.autoPostReview) {
          persistentLogger.add("warn", "Agent", "Post-review skipped because the primary model stage failed");
        }
        const finalResult = review ? `${result}\n\n[FINAL REVIEW]\n${review}` : result;
        memoryOutcome = finalResult;
        await finishMemoryLifecycle(activeProject?.path, memoryLifecycle, finalResult, intelligenceSettings);
        const low = (finalResult || "").toLowerCase();
        const hardFail =
          isProviderHardFailure(finalResult || "") ||
          isProviderHardFailure(result || "") ||
          (/❌|failed|error|step limit|timeout|останов|aborted|не готов|probe_failed|SecurityException|лимит запросов/i.test(
            result || finalResult || ""
          ) &&
            !/apk собран|ndk готов|build successful|готово/i.test(result || ""));
        if (hardFail) {
          notifyAgentFailed(finalResult || result || "error");
          taskOutcome = abortAgentRef.current ? "cancelled" : "failed";
        } else {
          notifyAgentDone(finalResult || "OK");
          taskOutcome = "completed";
        }
        taskOutcomeMessage = finalResult || result || "";
        return finalResult;
        } finally {
          if (memoryLifecycle && !memoryOutcome) {
            await finishMemoryLifecycle(activeProject?.path, memoryLifecycle, result || "Task ended without a final result", intelligenceSettings);
          }
          agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
          finishActivityRun(
            taskRunId,
            lastActivity,
            abortAgentRef.current ? "cancelled" : taskOutcome,
            taskOutcomeMessage || (abortAgentRef.current ? t("agentStopped") : result),
          );
        }
        } // end non-small-talk agent branch
      }

      // В history должны находиться только реальные реплики диалога.
      // Служебный контекст нельзя добавлять как role=user: Gemma chat template
      // требует строгого user/assistant чередования и иначе падает до inference.
      const history = toChatHistory(currentSession.messages);
      const digest = buildSessionDigest(currentSession.messages);
      const systemContext: string[] = [];
      if (digest) {
        systemContext.push(digest);
      }
      if (activeProject) {
        const crossMemory = await loadCrossSessionMemory(activeProject.path);
        if (crossMemory) {
          systemContext.push(crossMemory);
        }
        systemContext.push(
          `[ACTIVE_PROJECT] name=${activeProject.name} path=${activeProject.path} package=${activeProject.packageName}`
        );
        if (digest) {
          saveCrossSessionMemory(activeProject.path, digest).catch(() => {});
        }
      }
      const logCtx = buildRelevantSessionLogContext(message);
      if (logCtx) {
        systemContext.push(logCtx);
      }
      history.push({ role: "user", content: message });

      // langKey already set at start of sendMessage (detectReplyLang)
      const combinedSystemPrompt = appendSystemContext(
        buildSystemPrompt(langKey, settings.systemPrompt, null, modelTier),
        systemContext
      );

      if (mode === "custom") {
        const cfg = settings.customProvider;
        if (!cfg?.hasApiKey || !cfg?.baseUrl?.trim() || !cfg?.modelId?.trim()) {
          throw new Error("Custom provider: нужны Base URL, API-ключ и Model ID");
        }
        customProviderEngine.setConfig({
          name: cfg.name, baseUrl: cfg.baseUrl, modelId: cfg.modelId,
          providerId: cfg.providerId, hasApiKey: cfg.hasApiKey, extraHeadersJson: cfg.extraHeadersJson,
          chatPath: cfg.chatPath || "/chat/completions",
        });
        return await customProviderEngine.chat([
          { role: "system", content: combinedSystemPrompt },
          ...history,
        ], {
          ...DEFAULT_CUSTOM_PARAMS,
          maxTokens: Math.min(Math.max(settings.onlineGenParams.maxTokens || 0, 512), 8192),
          temperature: settings.onlineGenParams.temperature ?? 0.7,
          topP: settings.onlineGenParams.topP ?? DEFAULT_CUSTOM_PARAMS.topP,
        }, requestAbortController.signal);
      }
      if (mode === "opencode") {
        const oc = settings.openCode;
        if (!oc?.hasApiKey) throw new Error("OpenCode: API-ключ не установлен");
        customProviderEngine.setConfig({
          name: "OpenCode",
          baseUrl: oc.baseUrl || "https://opencode.ai/zen/v1",
          modelId: oc.modelId || "",
          providerId: "opencode",
          hasApiKey: oc.hasApiKey,
          chatPath: "/chat/completions",
        });
        return await customProviderEngine.chat([
          { role: "system", content: combinedSystemPrompt },
          ...history,
        ], {
          ...DEFAULT_CUSTOM_PARAMS,
          maxTokens: Math.min(Math.max(settings.onlineGenParams.maxTokens || 0, 512), 8192),
          temperature: settings.onlineGenParams.temperature ?? 0.7,
          topP: settings.onlineGenParams.topP ?? DEFAULT_CUSTOM_PARAMS.topP,
        }, requestAbortController.signal);
      }

      
if (mode === "online") {
        if (!settings.onlineModel.hasApiKey) {
          logWarn("OnlineModel", t("errorNoApiKeyLog"));
          return t("errorNoApiKey");
        }
        try {
          return await onlineModelEngine.chat(
            history,
            settings.onlineGenParams,
            language,
            buildSystemPrompt(
              uiLangToPromptLang(language),
              settings.systemPrompt,
              null,
              modelTier
            ),
            settings.onlineModel?.id,
            requestAbortController.signal
          );
        } catch (err: unknown) {
          const rawErr = err instanceof Error ? err.message : String(err);
          if (requestAbortController.signal.aborted || rawErr === "ABORTED") return t("agentStopped");
          const networkFailure = /(ERR_NETWORK|Network Error|ECONNABORTED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EPIPE|socket hang up|^NETWORK:)/i.test(rawErr);
          const fallbackId = networkFailure ? null : await recoverOnlineModel(settings.onlineModel?.id, requestAbortController.signal);
          if (requestAbortController.signal.aborted) return t("agentStopped");
          if (networkFailure) {
            persistentLogger.add("warn", "OnlineModel", "Automatic model recovery skipped after transport/network failure");
          }
          if (fallbackId) {
            try {
              return await onlineModelEngine.chat(
                history, settings.onlineGenParams,
                language, buildSystemPrompt(uiLangToPromptLang(language), settings.systemPrompt, null, modelTier), fallbackId,
                requestAbortController.signal
              );
            } catch {
              // Показываем исходную локализованную ошибку, если повтор тоже не удался.
            }
          }
          const msg = translateEngineError(t, err instanceof Error ? err.message : String(err));
          logError("OnlineModel", `${t("errorChat")}${msg}`);
          return `${t("modelError")}: ${msg}`;
        }
      }

      if (!localModelEngine.isLoaded()) {
        logWarn("LocalModel", t("errorOfflineNotLoadedLog"));
        return t("errorOfflineNotLoaded");
      }
      try {
        return await localModelEngine.chat(
          history,
          settings.localGenParams,
          language,
          buildSystemPrompt(
            uiLangToPromptLang(language),
            settings.systemPrompt,
            null,
            modelTier
          ),
          requestAbortController.signal
        );
      } catch (err: unknown) {
        if (requestAbortController.signal.aborted || (err instanceof Error && err.message === "ABORTED")) return t("agentStopped");
        const msg = translateEngineError(t, err instanceof Error ? err.message : String(err));
        logError("LocalModel", `${t("errorChat")}${msg}`);
        return `${t("modelError")}: ${msg}`;
      }
    } catch (err: unknown) {
      if (requestAbortController.signal.aborted || (err instanceof Error && err.message === "ABORTED")) {
        return t("agentStopped");
      }
      const msg = translateEngineError(t, err instanceof Error ? err.message : String(err));
      logError("LLM", `${t("errorUnexpected")}${msg}`);
      return `${t("modelError")}: ${msg}`;
    } finally {
      if (activeGenerationAbortRef.current === requestAbortController) {
        activeCloudBindingRef.current = null;
        activeGenerationAbortRef.current = null;
      }
      // Keep loading indicator if Termux agent still owns a session (possibly another chat).
      if (agentBusyRef.current && agentSessionIdRef.current) {
        // Agent still running — loading stays tied to that session via isSessionAgentBusy
        if (agentSessionIdRef.current === currentSessionId) {
          setIsLoading(true);
        } else {
          setIsLoading(false);
        }
      } else {
        setIsLoading(false);
      }
    }
  }, [currentSession.messages, currentSession.createdAt, currentSession.manusEpoch, mode, settings.manus, settings.onlineModel, settings.onlineGenParams, settings.localGenParams, settings.systemPrompt, logWarn, logError, t, language, recoverOnlineModel, termuxEnabled, setTermuxEnabled, askModelForAgent, confirmDialog, activeProject, clearCurrentChat, currentSessionId]);

  const analyzeImage = useCallback(async (imageUri: string, prompt: string): Promise<string> => {
    const imageAbortController = new AbortController();
    activeGenerationAbortRef.current = imageAbortController;
    setIsLoading(true);
    try {
      if (mode === "manus") {
        return language === "en" ? "This cloud integration currently accepts text tasks only. The image was not uploaded. Select a vision provider to analyze it." : language === "uk" ? "Ця хмарна інтеграція поки приймає лише текстові завдання. Зображення не завантажено. Для аналізу виберіть провайдера з підтримкою зображень." : "Эта облачная интеграция пока принимает только текстовые задачи. Изображение не загружено. Для анализа выберите провайдера с поддержкой изображений.";
      }
      // Custom / OpenCode: OpenAI-compatible multimodal (image_url + text).
      // Работает с OpenRouter-совместимыми gateway, xAI, OpenAI и т.п.
      if (mode === "custom" || mode === "opencode") {
        const providerName =
          mode === "opencode"
            ? "OpenCode"
            : settings.customProvider?.name?.trim() || "Custom";
        try {
          if (mode === "opencode") {
            const oc = settings.openCode;
            customProviderEngine.setConfig({
              name: "OpenCode",
              baseUrl: oc?.baseUrl || "",
              providerId: "opencode",
              hasApiKey: oc?.hasApiKey || false,
              modelId: oc?.modelId || "",
              openAiCompatible: true,
            });
          } else {
            const cfg = settings.customProvider;
            customProviderEngine.setConfig({
              name: cfg?.name || "Custom",
              baseUrl: cfg?.baseUrl || "",
              providerId: cfg?.providerId || "custom.slot1",
              hasApiKey: cfg?.hasApiKey || false,
              modelId: cfg?.modelId || "",
              extraHeadersJson: cfg?.extraHeadersJson,
              openAiCompatible: true,
            });
          }
          if (!customProviderEngine.getReady()) {
            return t("errorNoApiKey");
          }
          const base64 = await new File(imageUri).base64();
          const dataUrl = `data:${guessImageMime(imageUri)};base64,${base64}`;
          const system = buildSystemPrompt(
            uiLangToPromptLang(language),
            settings.systemPrompt,
            null,
            modelTier
          );
          return await customProviderEngine.analyzeImage(
            dataUrl,
            prompt,
            {
              ...DEFAULT_CUSTOM_PARAMS,
              temperature: settings.onlineGenParams.temperature ?? DEFAULT_CUSTOM_PARAMS.temperature,
              maxTokens: settings.onlineGenParams.maxTokens ?? DEFAULT_CUSTOM_PARAMS.maxTokens,
              topP: settings.onlineGenParams.topP ?? DEFAULT_CUSTOM_PARAMS.topP,
            },
            system,
            imageAbortController.signal
          );
        } catch (err: unknown) {
          if (imageAbortController.signal.aborted || (err instanceof Error && err.message === "ABORTED")) return t("agentStopped");
          const msg = translateEngineError(
            t,
            err instanceof Error ? err.message : String(err)
          );
          logError(
            mode === "opencode" ? "OpenCode" : "CustomProvider",
            `${t("errorImageAnalysis")}${msg}`
          );
          // Если провайдер явно отверг vision — подсказка выбрать другую модель
          if (/vision|image|multimodal|does not support|not support|invalid.*content/i.test(msg)) {
            return (
              `${providerName}: ${msg}\n\n` +
              (language === "en"
                ? "This model may not support images. Choose a vision-capable model (e.g. gpt-4o, qwen-vl, gemini-flash) in Custom Provider settings."
                : language === "uk"
                  ? "Модель може не підтримувати зображення. Оберіть vision-модель (gpt-4o, qwen-vl, gemini-flash) у налаштуваннях кастомного провайдера."
                  : "Модель может не поддерживать изображения. Выберите vision-модель (gpt-4o, qwen-vl, gemini-flash) в настройках кастомного провайдера.")
            );
          }
          return `${t("errorImageAnalysis")}${msg}`;
        }
      }

      
if (mode === "online") {
        if (!settings.onlineModel.hasApiKey) {
          logWarn("OnlineModel", t("errorImageNoApiKeyLog"));
          return t("errorNoApiKey");
        }
        let dataUrl = "";
        try {
          const base64 = await new File(imageUri).base64();
          dataUrl = `data:${guessImageMime(imageUri)};base64,${base64}`;
          return await onlineModelEngine.analyzeImage(
            dataUrl,
            prompt,
            settings.onlineGenParams,
            language,
            buildSystemPrompt(
              uiLangToPromptLang(language),
              settings.systemPrompt,
              null,
              modelTier
            ),
            settings.onlineModel?.id,
            imageAbortController.signal
          );
        } catch (err: unknown) {
          const rawErr = err instanceof Error ? err.message : String(err);
          if (imageAbortController.signal.aborted || rawErr === "ABORTED") return t("agentStopped");
          const networkFailure = /(ERR_NETWORK|Network Error|ECONNABORTED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EPIPE|socket hang up|^NETWORK:)/i.test(rawErr);
          const fallbackId = networkFailure ? null : await recoverOnlineModel(settings.onlineModel?.id, imageAbortController.signal);
          if (imageAbortController.signal.aborted) return t("agentStopped");
          if (networkFailure) {
            persistentLogger.add("warn", "OnlineModel", "Automatic model recovery skipped after transport/network failure");
          }
          if (fallbackId) {
            try {
              return await onlineModelEngine.analyzeImage(
                dataUrl, prompt, settings.onlineGenParams,
                language, buildSystemPrompt(uiLangToPromptLang(language), settings.systemPrompt, null, modelTier), fallbackId,
                imageAbortController.signal
              );
            } catch {
              // Переходим к локализованному сообщению об исходной ошибке.
            }
          }
          const msg = translateEngineError(t, err instanceof Error ? err.message : String(err));
          logError("OnlineModel", `${t("errorImageAnalysis")}${msg}`);
          return `${t("errorImageAnalysis")}${msg}`;
        }
      }

      if (!localModelEngine.isLoaded()) {
        logWarn("LocalModel", t("errorImageOfflineNotLoadedLog"));
        return t("errorOfflineNotLoaded");
      }
      try {
        return await localModelEngine.analyzeImage(imageUri, prompt, settings.localGenParams, language, buildSystemPrompt(uiLangToPromptLang(language), settings.systemPrompt, null, modelTier), imageAbortController.signal);
      } catch (err: unknown) {
        if (imageAbortController.signal.aborted || (err instanceof Error && err.message === "ABORTED")) return t("agentStopped");
        const msg = translateEngineError(t, err instanceof Error ? err.message : String(err));
        logError("LocalModel", `${t("errorImageAnalysis")}${msg}`);
        return `${t("errorImageAnalysis")}${msg}`;
      }
    } catch (err: unknown) {
      if (imageAbortController.signal.aborted || (err instanceof Error && err.message === "ABORTED")) return t("agentStopped");
      const msg = translateEngineError(t, err instanceof Error ? err.message : String(err));
      logError(mode === "online" ? "OnlineModel" : "LocalModel", `${t("errorUnexpectedImage")}${msg}`);
      return `${t("errorImageAnalysis")}${msg}`;
    } finally {
      if (activeGenerationAbortRef.current === imageAbortController) {
        activeGenerationAbortRef.current = null;
      }
      setIsLoading(false);
    }
  }, [
    mode,
    settings.onlineModel,
    settings.onlineGenParams,
    settings.localGenParams,
    settings.systemPrompt,
    settings.customProvider,
    settings.openCode,
    logWarn,
    logError,
    t,
    language,
    recoverOnlineModel,
    setTermuxActivity,
    beginActivityRun,
    finishActivityRun,
  ]);

  /**
   * Full build → install → launch → Vision → interaction → repair loop.
   * Uses the same model/provider selection as the chat and the same Termux
   * recovery agent for code fixes. Device actions remain capability-gated by
   * RuntimeFacade/AgentManager.
   */
  const runDeviceDevelopmentLoop = useCallback(async (options: {
    packageName: string;
    goal: string;
    maxBuildAttempts?: number;
    maxDeviceSteps?: number;
    onEvent?: (event: AutonomousDeviceLoopEvent) => void;
  }): Promise<AutonomousDeviceLoopResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    if (!options.packageName.trim()) throw new Error("PACKAGE_NAME_REQUIRED");
    if (!options.goal.trim()) throw new Error("DEVICE_TEST_GOAL_REQUIRED");
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");

    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    abortAgentRef.current = false;
    notifyAgentStarted(`Device development loop: ${options.goal}`);
    let tempUri: string | null = null;
    try {
      const vision = async (imageDataUrl: string, prompt: string): Promise<string> => {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(imageDataUrl);
        if (!match) throw new Error("INVALID_DEVICE_SCREENSHOT_DATA_URL");
        const mime = match[1];
        const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
        const dir = FileSystemLegacy.cacheDirectory;
        if (!dir) throw new Error("CACHE_DIRECTORY_UNAVAILABLE");
        const uri = `${dir}aib-device-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        tempUri = uri;
        await FileSystemLegacy.writeAsStringAsync(uri, match[2], { encoding: FileSystemLegacy.EncodingType.Base64 });
        try {
          return await analyzeImage(uri, prompt);
        } finally {
          try { await FileSystemLegacy.deleteAsync(uri, { idempotent: true }); } catch { /* cache cleanup best-effort */ }
          tempUri = null;
        }
      };

      const repair = async (prompt: string): Promise<string> => {
        if (abortAgentRef.current) throw new Error("ABORTED");
        const result = await runTermuxAgentTask(prompt, {
          maxSteps: AGENT_DEFAULT_MAX_STEPS,
          perCommandTimeoutMs: 600_000,
          askModel: askModelForAgent,
          priorChat: termuxSessionMemory.current.slice(-40),
          projectPath: activeProject.path,
          confirmDangerous: async (cmd, reason) =>
            confirmDialog(
              t("dangerCmdTitle"),
              `${reason}\n\n$ ${cmd}`,
              t("dangerCmdAllow"),
              t("cancel")
            ),
          onSessionMemory: (turns) => {
            termuxSessionMemory.current = [...termuxSessionMemory.current, ...turns].slice(-60);
          },
          shouldAbort: () => abortAgentRef.current,
          strings: {
            stepLimitReached: t("termuxStepLimitReached"),
            setupHint: t("termuxSetupHintMessage"),
            genericError: (msg: string) => `${t("termuxGenericErrorPrefix")}${msg}`,
            quotaHint: t("termuxQuotaExhaustedHint"),
            aborted: t("agentStopped"),
          },
        });
        return result || "OK";
      };

      const result = await runAutonomousDeviceDevelopmentLoop({
        runtime: getRuntimeFacade(),
        projectPath: activeProject.path,
        projectId: activeProject.id,
        packageName: options.packageName.trim(),
        goal: options.goal.trim(),
        vision,
        repair,
        maxBuildAttempts: options.maxBuildAttempts,
        maxDeviceSteps: options.maxDeviceSteps,
        onEvent: options.onEvent,
      });
      notifyAgentDone(result.completed ? "Device development loop completed" : `Device development loop: ${result.device?.reason || "failed"}`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAgentFailed(msg);
      throw err;
    } finally {
      if (tempUri) { try { await FileSystemLegacy.deleteAsync(tempUri, { idempotent: true }); } catch {} }
      agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
      setTermuxActivity(null);
      setIsLoading(false);
    }
  }, [
    activeProject?.path,
    analyzeImage,
    askModelForAgent,
    confirmDialog,
    t,
    setTermuxActivity,
  ]);

  /**
   * Full AI self-healing QA: build -> generated regression suite -> evidence ->
   * minimal source repair -> rebuild -> rerun failed cases only.
   */
  /** Final deterministic release barrier: build/sign + on-device regression. */
  const runAIReleaseGate = useCallback(async (options: {
    packageName?: string;
    goal: string;
    requireDeviceRegression?: boolean;
    maxActionsPerCase?: number;
  }): Promise<ReleaseGateResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    if (!options.goal.trim()) throw new Error("RELEASE_TEST_GOAL_REQUIRED");
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");
    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    notifyAgentStarted(`Release Gate: ${options.goal}`);
    try {
      const result = await runReleaseGate({
        runtime: getRuntimeFacade(),
        projectPath: activeProject.path,
        projectId: activeProject.id,
        packageName: options.packageName?.trim() || undefined,
        goal: options.goal.trim(),
        requireDeviceRegression: options.requireDeviceRegression,
        maxActionsPerCase: options.maxActionsPerCase,
      });
      notifyAgentDone(result.releaseAllowed ? "Release gate passed" : "Release gate blocked release");
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAgentFailed(msg);
      throw err;
    } finally {
      agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
      setTermuxActivity(null);
      setIsLoading(false);
    }
  }, [activeProject?.id, activeProject?.path, setTermuxActivity]);

  const runAIReleaseChannel = useCallback(async (options: {
    packageName?: string;
    goal: string;
    channel: ReleaseChannel;
    versionCode?: number;
  }): Promise<PublishReleaseChannelResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    if (!options.goal.trim()) throw new Error("RELEASE_TEST_GOAL_REQUIRED");
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");
    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    notifyAgentStarted(`Release Channel: ${options.channel}`);
    try {
      const gate = await runReleaseGate({ runtime: getRuntimeFacade(), projectPath: activeProject.path, projectId: activeProject.id, packageName: options.packageName?.trim() || undefined, goal: options.goal.trim() });
      if (!gate.releaseAllowed) return { published: false, channel: options.channel, statePath: `${activeProject.path}/artifacts/channels/${options.channel}/channel.json`, message: "RELEASE_GATE_BLOCKED" };
      const artifact = await createReleaseArtifact({ runtime: getRuntimeFacade(), projectPath: activeProject.path, projectId: activeProject.id, version: getRuntimeFacade().runtimeIdentity.runtimeVersion, releaseName: `v${getRuntimeFacade().runtimeIdentity.runtimeVersion}-${options.channel}-${Date.now()}`, gate });
      if (!artifact.created) return { published: false, channel: options.channel, statePath: `${activeProject.path}/artifacts/channels/${options.channel}/channel.json`, message: artifact.message };
      const result = await publishReleaseChannel({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, versionName: getRuntimeFacade().runtimeIdentity.runtimeVersion, versionCode: options.versionCode, artifact });
      notifyAgentDone(result.published ? `Channel ${options.channel} published` : `Channel ${options.channel} blocked`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAgentFailed(msg);
      throw err;
    } finally { agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null); setTermuxActivity(null); setIsLoading(false); }
  }, [activeProject?.id, activeProject?.path, setTermuxActivity]);

  const runAIDeviceFleetDeployment = useCallback(async (options: { channel: ReleaseChannel; packageName?: string; serials?: string[]; concurrency?: number; autoRollback?: boolean; healthTimeoutMs?: number; confirmation?: string }): Promise<DeviceFleetResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    const runtime = getRuntimeFacade();
    const auth = await authorizeFleetAction({ runtime, projectPath: activeProject.path, action: "deploy", channel: options.channel, confirmation: options.confirmation });
    if (auth.allowed === false) throw new Error(auth.reason);
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");
    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    notifyAgentStarted(`Device Fleet Deployment: ${options.channel}`);
    try {
      const result = await deployReleaseFleet({ runtime, projectPath: activeProject.path, channel: options.channel, packageName: options.packageName?.trim() || undefined, serials: options.serials, concurrency: options.concurrency, autoRollback: options.autoRollback, healthTimeoutMs: options.healthTimeoutMs });
      await recordFleetExecution({ runtime, projectPath: activeProject.path, role: auth.policy.role, action: "deploy", channel: options.channel, success: result.failed === 0, reason: result.failed ? `${result.failed}_DEVICE_FAILURES` : undefined });
      notifyAgentDone(`Fleet ${options.channel}: ${result.healthy}/${result.total} healthy · ${result.rolledBack} rollback`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAgentFailed(msg);
      throw err;
    } finally { agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null); setTermuxActivity(null); setIsLoading(false); }
  }, [activeProject?.path, setTermuxActivity]);

  const runAIFleetCanary = useCallback(async (options: { channel: ReleaseChannel; packageName?: string; concurrency?: number; autoRollback?: boolean; healthTimeoutMs?: number; stages?: CanaryStage[]; confirmation?: string }): Promise<FleetCanaryResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    const runtime = getRuntimeFacade();
    const auth = await authorizeFleetAction({ runtime, projectPath: activeProject.path, action: "canary", channel: options.channel, confirmation: options.confirmation });
    if (auth.allowed === false) throw new Error(auth.reason);
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");
    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    notifyAgentStarted(`Fleet Canary: ${options.channel}`);
    try {
      const result = await runFleetCanary({ runtime, projectPath: activeProject.path, ...options });
      await recordFleetExecution({ runtime, projectPath: activeProject.path, role: auth.policy.role, action: "canary", channel: options.channel, success: !result.stopped, reason: result.stopReason });
      notifyAgentDone(result.stopped ? `Canary stopped: ${result.stopReason}` : `Canary complete: ${result.healthy}/${result.attempted} healthy`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAgentFailed(msg);
      throw err;
    } finally { agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null); setTermuxActivity(null); setIsLoading(false); }
  }, [activeProject?.path, setTermuxActivity]);

  const runAIFleetCommandCenter = useCallback(async (options: { channel: ReleaseChannel }): Promise<FleetCommandSnapshot> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return getFleetCommandSnapshot({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel });
  }, [activeProject?.path]);

  const runAIFleetUnifiedControlCenter = useCallback(async (options: { channel: ReleaseChannel }): Promise<FleetUnifiedControlSnapshot> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return getFleetUnifiedControlSnapshot({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel });
  }, [activeProject?.path]);

  const runAIFleetPolicy = useCallback(async (): Promise<FleetPolicy> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return getFleetPolicy({ runtime: getRuntimeFacade(), projectPath: activeProject.path });
  }, [activeProject?.path]);

  const setAIFleetPolicy = useCallback(async (options: { role: FleetRole; requireProductionConfirmation?: boolean; productionConfirmationPhrase?: string }): Promise<FleetPolicy> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return setFleetPolicy({ runtime: getRuntimeFacade(), projectPath: activeProject.path, ...options });
  }, [activeProject?.path]);

  const runAIFleetAudit = useCallback(async (options?: { limit?: number }): Promise<FleetAuditEntry[]> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return listFleetAudit({ runtime: getRuntimeFacade(), projectPath: activeProject.path, limit: options?.limit });
  }, [activeProject?.path]);

  const runAISecureFleetAudit = useCallback(async (options?: { limit?: number; filter?: AuditFilter }): Promise<SecureAuditEntry[]> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return listSecureFleetAudit({ runtime: getRuntimeFacade(), projectPath: activeProject.path, limit: options?.limit, filter: options?.filter });
  }, [activeProject?.path]);

  const runAIVerifyFleetAudit = useCallback(async (): Promise<AuditVerification> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return verifyFleetAuditChain({ runtime: getRuntimeFacade(), projectPath: activeProject.path });
  }, [activeProject?.path]);

  const runAICreateFleetSnapshot = useCallback(async (): Promise<FleetRecoverySnapshot> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return createFleetRecoverySnapshot({ runtime: getRuntimeFacade(), projectPath: activeProject.path });
  }, [activeProject?.path]);

  const runAIRestoreFleetSnapshot = useCallback(async (options?: { snapshotId?: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return restoreFleetRecoverySnapshot({ runtime: getRuntimeFacade(), projectPath: activeProject.path, snapshotId: options?.snapshotId });
  }, [activeProject?.path]);

  const runAICreateFleetBackup = useCallback(async (options: { secret: string; channel?: ReleaseChannel; retention?: number; reason?: string }): Promise<FleetBackupRecord> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return (await createFleetEncryptedBackup({ runtime: getRuntimeFacade(), projectPath: activeProject.path, ...options })).record;
  }, [activeProject?.path]);

  const runAIVerifyFleetBackup = useCallback(async (options: { backupId: string; secret: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return verifyFleetEncryptedBackup({ runtime: getRuntimeFacade(), projectPath: activeProject.path, ...options });
  }, [activeProject?.path]);

  const runAIRestoreFleetBackup = useCallback(async (options: { backupId: string; secret: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return restoreFleetEncryptedBackup({ runtime: getRuntimeFacade(), projectPath: activeProject.path, ...options });
  }, [activeProject?.path]);

  const runAIFleetRecoveryDrill = useCallback(async (options: { secret: string; backupId?: string }): Promise<FleetRecoveryDrillResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return runFleetRecoveryDrill({ runtime: getRuntimeFacade(), projectPath: activeProject.path, ...options });
  }, [activeProject?.path]);

  const runAIFleetRecoverySchedule = useCallback(async (channel?: ReleaseChannel): Promise<FleetRecoverySchedule> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return getFleetRecoverySchedule({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel });
  }, [activeProject?.path]);

  const setAIFleetRecoverySchedule = useCallback(async (schedule: Partial<FleetRecoverySchedule> & { channel: ReleaseChannel }): Promise<FleetRecoverySchedule> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return setFleetRecoverySchedule({ runtime: getRuntimeFacade(), projectPath: activeProject.path, schedule });
  }, [activeProject?.path]);

  const runAIFleetRecoverySlo = useCallback(async (channel?: ReleaseChannel): Promise<FleetSloStatus> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return evaluateFleetRecoverySlo({ runtime: getRuntimeFacade(), projectPath: activeProject.path, schedule: await getFleetRecoverySchedule({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel }) });
  }, [activeProject?.path]);

  const runAIScheduledFleetRecovery = useCallback(async (options: { secret: string; channel?: ReleaseChannel; force?: boolean; reason?: string }): Promise<FleetScheduledRecoveryResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return runFleetScheduledRecoveryCheck({ runtime: getRuntimeFacade(), projectPath: activeProject.path, ...options });
  }, [activeProject?.path]);

  const runAIListFleetBackups = useCallback(async (options?: { limit?: number }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return listFleetBackups({ runtime: getRuntimeFacade(), projectPath: activeProject.path, limit: options?.limit });
  }, [activeProject?.path]);

  const runAIExportFleetAuditBundle = useCallback(async (options?: { channel?: ReleaseChannel; incidentId?: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return exportFleetAuditBundle({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options?.channel, incidentId: options?.incidentId });
  }, [activeProject?.path]);

  const runAIFleetDeviceCommand = useCallback(async (options: { channel: ReleaseChannel; serial: string; packageName?: string; action: "deploy" | "rollback"; confirmation?: string }): Promise<any> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    const runtime = getRuntimeFacade();
    const action = options.action;
    const auth = await authorizeFleetAction({ runtime, projectPath: activeProject.path, action, channel: options.channel, serial: options.serial, confirmation: options.confirmation });
    if (auth.allowed === false) throw new Error(auth.reason);
    try {
      const result = action === "deploy"
        ? await deployFleetDevice({ runtime, projectPath: activeProject.path, channel: options.channel, serial: options.serial, packageName: options.packageName?.trim() || undefined })
        : await rollbackFleetDevice({ runtime, projectPath: activeProject.path, channel: options.channel, serial: options.serial, packageName: options.packageName?.trim() || undefined });
      await recordFleetExecution({ runtime, projectPath: activeProject.path, role: auth.policy.role, action, channel: options.channel, serial: options.serial, success: action === "deploy" ? ("healthy" in result ? Boolean(result.healthy) : false) : ("rolledBack" in result && "health" in result ? Boolean(result.rolledBack && result.health) : false), reason: "message" in result ? result.message : String(result) });
      return result;
    } catch (err) {
      await recordFleetExecution({ runtime, projectPath: activeProject.path, role: auth.policy.role, action, channel: options.channel, serial: options.serial, success: false, reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }, [activeProject?.path]);

  const acknowledgeAIFleetCommandCenterIncident = useCallback(async (options: { channel: ReleaseChannel; incidentId: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return acknowledgeCommandCenterIncident({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, incidentId: options.incidentId });
  }, [activeProject?.path]);

  const runAIFleetObservability = useCallback(async (options: { channel: ReleaseChannel }): Promise<FleetObservabilitySnapshot> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return getFleetObservability({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel });
  }, [activeProject?.path]);

  const runAIFleetSloDashboard = useCallback(async (options: { channel: ReleaseChannel }): Promise<FleetSloDashboardSnapshot> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return getFleetSloDashboard({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel });
  }, [activeProject?.path]);

  const acknowledgeAIFleetDashboardAlert = useCallback(async (options: { channel: ReleaseChannel; alertId: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return acknowledgeFleetDashboardAlert({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, alertId: options.alertId });
  }, [activeProject?.path]);

  const acknowledgeAIFleetDashboardIncident = useCallback(async (options: { channel: ReleaseChannel; incidentId: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return acknowledgeFleetDashboardIncident({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, incidentId: options.incidentId });
  }, [activeProject?.path]);

  const runAIFleetAlertEscalation = useCallback(async (options: { channel: ReleaseChannel }): Promise<FleetEscalationSnapshot> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return escalateFleetAlerts({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel });
  }, [activeProject?.path]);

  const getAIFleetEscalationPolicy = useCallback(async (options: { channel: ReleaseChannel }): Promise<FleetEscalationPolicy> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return getFleetEscalationPolicy({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel });
  }, [activeProject?.path]);

  const setAIFleetEscalationPolicy = useCallback(async (options: { channel: ReleaseChannel; policy: Partial<FleetEscalationPolicy> }): Promise<FleetEscalationPolicy> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return setFleetEscalationPolicy({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, policy: options.policy });
  }, [activeProject?.path]);

  const acknowledgeAIFleetEscalatedAlert = useCallback(async (options: { channel: ReleaseChannel; alertId: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return acknowledgeFleetEscalatedAlert({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, alertId: options.alertId });
  }, [activeProject?.path]);

  const resolveAIFleetEscalatedAlert = useCallback(async (options: { channel: ReleaseChannel; alertId: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return resolveFleetEscalatedAlert({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, alertId: options.alertId });
  }, [activeProject?.path]);

  const runAIFleetNotificationOutbox = useCallback(async (options: { channel: ReleaseChannel; limit?: number }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return getFleetNotificationOutbox({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, limit: options.limit });
  }, [activeProject?.path]);

  const runAIFleetIncidents = useCallback(async (options: { channel: ReleaseChannel }): Promise<FleetIncident[]> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return listFleetIncidents({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel });
  }, [activeProject?.path]);

  const acknowledgeAIFleetIncident = useCallback(async (options: { channel: ReleaseChannel; incidentId: string }) => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    return acknowledgeFleetIncident({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, incidentId: options.incidentId });
  }, [activeProject?.path]);

  const runAIProductionDeployment = useCallback(async (options: { channel: ReleaseChannel; packageName?: string; targetReleaseId?: string; autoRollback?: boolean; healthTimeoutMs?: number; confirmation?: string; backupSecret?: string; backupRetention?: number }): Promise<ProductionDeploymentResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    const runtime = getRuntimeFacade();
    const auth = await authorizeFleetAction({ runtime, projectPath: activeProject.path, action: "deploy", channel: options.channel, confirmation: options.confirmation });
    if (auth.allowed === false) throw new Error(auth.reason);
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");
    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    notifyAgentStarted(`Production Deployment: ${options.channel}`);
    try {
      if (options.channel === "production" && options.backupSecret) {
        await createFleetEncryptedBackup({ runtime, projectPath: activeProject.path, secret: options.backupSecret, channel: options.channel, retention: options.backupRetention ?? 5, reason: "pre-production-rollout" });
      }
      const result = await deployReleaseChannel({ runtime, projectPath: activeProject.path, channel: options.channel, packageName: options.packageName?.trim() || undefined, targetReleaseId: options.targetReleaseId, autoRollback: options.autoRollback, healthTimeoutMs: options.healthTimeoutMs });
      await recordFleetExecution({ runtime, projectPath: activeProject.path, role: auth.policy.role, action: "deploy", channel: options.channel, success: Boolean(result.deployed), reason: result.message });
      notifyAgentDone(result.rolledBack ? `Deployment rolled back: ${options.channel}` : result.deployed ? `Deployment healthy: ${options.channel}` : `Deployment failed: ${result.message}`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAgentFailed(msg);
      throw err;
    } finally { agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null); setTermuxActivity(null); setIsLoading(false); }
  }, [activeProject?.path, setTermuxActivity]);

  const runAIRollbackReleaseChannel = useCallback(async (options: { channel: ReleaseChannel; targetReleaseId?: string }): Promise<RollbackReleaseChannelResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");
    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    notifyAgentStarted(`Release Rollback: ${options.channel}`);
    try {
      const result = await rollbackReleaseChannel({ runtime: getRuntimeFacade(), projectPath: activeProject.path, channel: options.channel, targetReleaseId: options.targetReleaseId });
      notifyAgentDone(result.rolledBack ? `Channel ${options.channel} rolled back` : `Rollback unavailable: ${result.message}`);
      return result;
    } finally { agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null); setTermuxActivity(null); setIsLoading(false); }
  }, [activeProject?.path, setTermuxActivity]);

  const runAIReleaseArtifact = useCallback(async (options: {
    packageName?: string;
    goal: string;
    requireDeviceRegression?: boolean;
    maxActionsPerCase?: number;
    releaseName?: string;
  }): Promise<ReleaseArtifactResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    if (!options.goal.trim()) throw new Error("RELEASE_TEST_GOAL_REQUIRED");
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");
    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    notifyAgentStarted(`Release Artifact: ${options.goal}`);
    try {
      const gate = await runReleaseGate({
        runtime: getRuntimeFacade(),
        projectPath: activeProject.path,
        projectId: activeProject.id,
        packageName: options.packageName?.trim() || undefined,
        goal: options.goal.trim(),
        requireDeviceRegression: options.requireDeviceRegression,
        maxActionsPerCase: options.maxActionsPerCase,
      });
      if (!gate.releaseAllowed) {
        notifyAgentDone("Release bundle blocked by Release Gate");
        return { created: false, releaseId: options.releaseName || `blocked-${Date.now()}`, message: "RELEASE_GATE_BLOCKED", };
      }
      const result = await createReleaseArtifact({
        runtime: getRuntimeFacade(),
        projectPath: activeProject.path,
        projectId: activeProject.id,
        version: getRuntimeFacade().runtimeIdentity.runtimeVersion,
        releaseName: options.releaseName,
        gate,
      });
      notifyAgentDone(result.created ? "Release bundle created" : "Release bundle creation failed");
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAgentFailed(msg);
      throw err;
    } finally {
      agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
      setTermuxActivity(null);
      setIsLoading(false);
    }
  }, [activeProject?.id, activeProject?.path, setTermuxActivity]);

  const runSelfHealingDeviceQA = useCallback(async (options: {
    packageName?: string;
    goal: string;
    maxBuildAttempts?: number;
    maxActionsPerCase?: number;
    onEvent?: (event: SelfHealingDeviceSuiteEvent) => void;
  }): Promise<SelfHealingDeviceSuiteResult> => {
    if (!activeProject?.path) throw new Error("ACTIVE_PROJECT_REQUIRED");
    if (!options.goal.trim()) throw new Error("DEVICE_TEST_GOAL_REQUIRED");
    if (agentBusyRef.current) throw new Error("AGENT_BUSY");

    agentBusyRef.current = true; agentSessionIdRef.current = currentSessionId; setAgentSessionId(currentSessionId);
    abortAgentRef.current = false;
    notifyAgentStarted(`Self-healing QA: ${options.goal}`);
    try {
      const model = async (prompt: string): Promise<string> => {
        if (abortAgentRef.current) throw new Error("ABORTED");
        return askModelForAgent([{ role: "user", content: prompt }]);
      };
      const repair = async (prompt: string): Promise<string> => {
        if (abortAgentRef.current) throw new Error("ABORTED");
        const result = await runTermuxAgentTask(prompt, {
          maxSteps: AGENT_DEFAULT_MAX_STEPS,
          perCommandTimeoutMs: 600_000,
          askModel: askModelForAgent,
          priorChat: termuxSessionMemory.current.slice(-40),
          projectPath: activeProject.path,
          confirmDangerous: async (cmd, reason) =>
            confirmDialog(
              t("dangerCmdTitle"),
              `${reason}\n\n$ ${cmd}`,
              t("dangerCmdAllow"),
              t("cancel")
            ),
          onSessionMemory: (turns) => {
            termuxSessionMemory.current = [...termuxSessionMemory.current, ...turns].slice(-60);
          },
          shouldAbort: () => abortAgentRef.current,
          strings: {
            stepLimitReached: t("termuxStepLimitReached"),
            setupHint: t("termuxSetupHintMessage"),
            genericError: (msg: string) => `${t("termuxGenericErrorPrefix")}${msg}`,
            quotaHint: t("termuxQuotaExhaustedHint"),
            aborted: t("agentStopped"),
          },
        });
        return result || "OK";
      };

      const result = await runSelfHealingDeviceSuite({
        runtime: getRuntimeFacade(),
        projectPath: activeProject.path,
        projectId: activeProject.id,
        packageName: options.packageName?.trim() || undefined,
        goal: options.goal.trim(),
        model,
        repair,
        maxBuildAttempts: options.maxBuildAttempts,
        maxActionsPerCase: options.maxActionsPerCase,
        onEvent: options.onEvent,
      });
      notifyAgentDone(result.completed ? "Self-healing QA completed" : `Self-healing QA: ${result.finalRun?.report.status || "failed"}`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyAgentFailed(msg);
      throw err;
    } finally {
      agentBusyRef.current = false; agentSessionIdRef.current = null; setAgentSessionId(null);
      setTermuxActivity(null);
      setIsLoading(false);
    }
  }, [
    activeProject?.id,
    activeProject?.path,
    askModelForAgent,
    confirmDialog,
    t,
    setTermuxActivity,
  ]);

  const createNewChat = useCallback(() => {
    const newSession: ChatSession = {
      id: Math.random().toString(36).substring(7),
      // Плейсхолдер — переименовывается автоматически в addMessageToCurrentSession,
      // как только приходит первое сообщение пользователя (см. deriveChatTitle выше).
      title: t("newChatTitle"),
      messages: [
        {
          id: "welcome",
          role: "system" as const,
          content: t("welcomeShort"),
          timestamp: Date.now(),
        },
      ],
      createdAt: Date.now(),
    };
    termuxSessionMemory.current = [];
    termuxMemorySessionId.current = newSession.id;
    setSessions((prev) => [newSession, ...prev]);
    setCurrentSessionIdState(newSession.id);
  }, [t]);

  const deleteChat = useCallback((id: string) => {
    void killRuntimeSession(id).catch(() => {});
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== id);
      if (filtered.length === 0) {
        const newSession = makeWelcomeSession(t("welcomeText"), t("newChatTitle"));
        setCurrentSessionIdState(newSession.id);
        void ensureRuntimeSession(newSession.id).catch(() => {});
        return [newSession];
      }
      if (currentSessionId === id) {
        const nextId = filtered[0]?.id || "default";
        setCurrentSessionIdState(nextId);
        void ensureRuntimeSession(nextId).catch(() => {});
      }
      return filtered;
    });
  }, [currentSessionId, t]);

  const addMessageToCurrentSession = useCallback((message: Message) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== currentSessionId) return s;
        // Переименовываем чат по ПЕРВОМУ сообщению пользователя в нём — до
        // этого момента у чата ещё нет пользовательских сообщений (только
        // системное приветствие), после — заголовок уже не трогаем, даже
        // если пользователь потом удалит это первое сообщение (см.
        // deleteMessage ниже), чтобы название не "прыгало".
        const isFirstUserMessage = message.role === "user" && !s.messages.some((m) => m.role === "user");
        const title = isFirstUserMessage
          ? deriveChatTitle(message.content, message.attachment, s.title)
          : s.title;
        return { ...s, title, messages: [...s.messages, message] };
      })
    );
  }, [currentSessionId]);

  const restoreSessionMessages = useCallback((messages: Message[]) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentSessionId
          ? { ...s, messages: messages.map((m) => ({ ...m, role: m.role as Message["role"] })) }
          : s
      )
    );
  }, [currentSessionId]);

  const deleteMessage = useCallback((messageId: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === currentSessionId
          ? { ...s, messages: (s.messages || []).filter((m) => m && m.id !== messageId) }
          : s
      )
    );
  }, [currentSessionId]);

  /**
   * One-shot model completion WITHOUT Termux agent loop and WITHOUT TERMUX_RUN protocol.
   * Use for Script Runner recovery / script patch prompts.
   * sendMessage() nests a full agent when termuxEnabled; askModelForAgent injects
   * termuxAgentSystemPrompt and biases the model to TERMUX_RUN — both wrong here.
   */
  const completePrompt = useCallback(
    async (prompt: string): Promise<string> => {
      const text = String(prompt || "").trim();
      if (!text) return "";
      if (mode === "manus") throw new Error(language === "en" ? "Cloud task mode does not provide synchronous code completions. Select another model for Script Runner repair." : language === "uk" ? "Режим хмарних завдань не надає синхронних доповнень коду. Для ремонту Script Runner виберіть іншу модель." : "Режим облачных задач не предоставляет синхронные дополнения кода. Для ремонта Script Runner выберите другую модель.");
      const langKey = uiLangToPromptLang(language);
      // Neutral system: user systemPrompt only — no TERMUX_RUN / DONE protocol
      const sys = buildSystemPrompt(langKey, settings.systemPrompt, null, modelTier);
      const history: ChatTurn[] = [{ role: "user", content: text }];
      const controller = new AbortController();
      activeCompletionAbortRef.current = controller;
      const withTimeout = (operation: (signal: AbortSignal) => Promise<string>, ms: number) =>
        withAbortableTimeout(operation, ms, controller);
      try {
      if (mode === "custom" || mode === "opencode") {
        const cfg =
          mode === "opencode"
            ? {
                name: "OpenCode",
                baseUrl: settings.openCode?.baseUrl || "https://opencode.ai/zen/v1",
                modelId: settings.openCode?.modelId || "",
                providerId: "opencode",
                hasApiKey: settings.openCode?.hasApiKey || false,
              }
            : settings.customProvider;
        if (!cfg?.hasApiKey || !cfg?.baseUrl?.trim() || !cfg?.modelId?.trim()) {
          throw new Error("Custom provider: нужны Base URL, API-ключ и Model ID");
        }
        customProviderEngine.setConfig({
          name: (cfg as { name?: string }).name || "Custom",
          baseUrl: cfg.baseUrl,
          modelId: cfg.modelId,
          providerId: (cfg as { providerId?: string }).providerId || (mode === "opencode" ? "opencode" : "custom.slot1"),
          hasApiKey: cfg.hasApiKey,
          extraHeadersJson: (cfg as { extraHeadersJson?: string }).extraHeadersJson,
          chatPath: (cfg as { chatPath?: string }).chatPath || "/chat/completions",
        });
        return await withTimeout(
          (signal) => customProviderEngine.chat(
            [{ role: "system", content: sys }, ...history],
            {
              ...DEFAULT_CUSTOM_PARAMS,
              maxTokens: Math.min(Math.max(settings.onlineGenParams.maxTokens || 0, 512), 8192),
              temperature: settings.onlineGenParams.temperature ?? 0.7,
              topP: settings.onlineGenParams.topP ?? DEFAULT_CUSTOM_PARAMS.topP,
            },
            signal,
          ),
          180_000,
        );
      }
      if (mode === "online") {
        if (!settings.onlineModel.hasApiKey) {
          throw new Error("OpenRouter: API-ключ не установлен");
        }
        return await withTimeout(
          (signal) => onlineModelEngine.chat(
            history,
            settings.onlineGenParams,
            language,
            sys,
            settings.onlineModel?.id,
            signal,
          ),
          180_000,
        );
      }
      if (!localModelEngine.isLoaded()) {
        throw new Error(t("errorOfflineNotLoaded"));
      }
      return await withTimeout(
        (signal) => localModelEngine.chat(history, settings.localGenParams, language, sys, signal),
        120_000,
      );
      } finally {
        if (activeCompletionAbortRef.current === controller) activeCompletionAbortRef.current = null;
      }
    },
    [
      mode,
      language,
      t,
      modelTier,
      settings.systemPrompt,
      settings.onlineModel,
        settings.onlineGenParams,
      settings.localGenParams,
      settings.customProvider,
      settings.openCode,
    ],
  );

  const stopGeneration = useCallback(() => {
    const agentActive = agentBusyRef.current && agentSessionIdRef.current !== null;
    if (agentActive) abortAgentRef.current = true;
    const activeController = activeGenerationAbortRef.current;
    if (activeController && !activeController.signal.aborted) activeController.abort();
    const activeCompletion = activeCompletionAbortRef.current;
    if (activeCompletion && !activeCompletion.signal.aborted) activeCompletion.abort();
    // Stop sessions through the bundled private-runtime bridge.
    void import("../lib/termux-bridge").then((m) => m.cancelAllRunningTermuxCommands?.()).catch(() => {});
    if (agentActive) {
      // Private one-shot cancellation is handled by the embedded native process map;
      // retain ownership until it returns so a second agent cannot overlap it.
      void import("../lib/termux-bridge").then((m) => m.cancelAllRunningTermuxCommands?.()).catch(() => {});
      persistentLogger.add("warn", "Termux", "Stop requested; native waiters cancelled, pending queue drained, agent abort flag set");
      return;
    }
    setIsLoading(false);
    persistentLogger.add("warn", "LLM", "Generation cancelled by user");
  }, []);

  const runOfflineAgent = useCallback((projectId: string, prompt: string, options?: RuntimeOfflineAgentOptions) =>
    getRuntimeFacade().runOfflineAgent(projectId, prompt, options), []);

  return {
    mode,
    isLoading: isLoading || (!!agentSessionId && agentSessionId === currentSessionId),
    isSessionAgentBusy:
      (!!agentSessionId && agentSessionId === currentSessionId) ||
      (isLoading && (!agentSessionId || agentSessionId === currentSessionId)),
    isAgentRunningInOtherSession: !!(agentSessionId && agentSessionId !== currentSessionId),
    sessions,
    currentSession,
    currentSessionId,
    sendMessage,
    runOfflineAgent,
    completePrompt,
    runTermuxTask,
    stopGeneration,
    analyzeImage,
    runDeviceDevelopmentLoop,
    runSelfHealingDeviceQA,
    runAIReleaseGate,
    runAIReleaseArtifact,
    runAIReleaseChannel,
    runAIRollbackReleaseChannel,
    runAIProductionDeployment,
    runAIDeviceFleetDeployment,
    runAIFleetCanary,
    runAIFleetCommandCenter,
    runAIFleetUnifiedControlCenter,
    runAIFleetDeviceCommand,
    runAIFleetPolicy,
    setAIFleetPolicy,
    runAIFleetAudit,
    runAISecureFleetAudit,
    runAIVerifyFleetAudit,
    runAICreateFleetSnapshot,
    runAIRestoreFleetSnapshot,
    runAIExportFleetAuditBundle,
    runAICreateFleetBackup,
    runAIVerifyFleetBackup,
    runAIRestoreFleetBackup,
    runAIListFleetBackups,
    runAIFleetRecoveryDrill,
    runAIFleetRecoverySchedule,
    setAIFleetRecoverySchedule,
    runAIFleetRecoverySlo,
    runAIScheduledFleetRecovery,
    acknowledgeAIFleetCommandCenterIncident,
    runAIFleetObservability,
    runAIFleetSloDashboard,
    acknowledgeAIFleetDashboardAlert,
    acknowledgeAIFleetDashboardIncident,
    runAIFleetAlertEscalation,
    getAIFleetEscalationPolicy,
    setAIFleetEscalationPolicy,
    acknowledgeAIFleetEscalatedAlert,
    resolveAIFleetEscalatedAlert,
    runAIFleetNotificationOutbox,
    runAIFleetIncidents,
    acknowledgeAIFleetIncident,
    createNewChat,
    deleteChat,
    addMessageToCurrentSession,
    deleteMessage,
    restoreSessionMessages,
    clearCurrentChat,
    setCurrentSessionId,
  };
}
