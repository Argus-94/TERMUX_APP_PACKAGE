import { useState, useCallback, useRef, useEffect } from "react";
import { Platform } from "react-native";
import { File } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistAsyncStorageItem } from "../lib/persistence";
import { mirrorDurableRecord, readDurableRecord } from "../lib/durable-persistence";
import {
  AGENT_SHELL_BACKEND_STORAGE_KEY,
  LEGACY_AGENT_SHELL_BACKEND_STORAGE_KEY,
  parseAgentShellBackend,
  setBuildBackend as applyBuildBackend,
  type AgentShellBackend,
} from "../lib/agent-shell-backend";
import {
  loadAgentShellExecutionTarget,
  setAgentShellExecutionTarget as persistAgentShellExecutionTarget,
  type AgentShellExecutionTarget,
} from "../lib/agent-shell-target";
import { migrateInlineProviderCredential, migrateProviderCredential, saveProviderCredential } from "../core/enhancements/auth/productionProviderTransport";
import {
  LOCAL_MODEL,
  getEffectiveModel,
  refreshActiveMetaFromDisk,
  localModelEngine,
  DEFAULT_LOCAL_PARAMS,
  DEFAULT_GENERATION_PARAMS,
  type LocalModelParams,
  type GenerationParams,
} from "../lib/local-model";
import {
  ONLINE_MODEL,
  DEFAULT_ONLINE_PARAMS,
  FREE_OPENROUTER_MODELS,
  checkOpenRouterModels,
  selectOpenRouterFallbackModelId,
  type OnlineGenerationParams,
  type OpenRouterModelStatus,
} from "../lib/online-model";
import {
  ALL_TOOL_PACKS,
  getToolPack,
  runPackSteps,
  checkTermuxFreeSpace,
  PACK_MIN_FREE_BYTES,
  getPackEstimate,
  checkToolPackInstalled,
  checkToolStepInstalled,
  getToolStepRemoveCommand,
  type PackStepProgress,
  type InstallStep,
} from "../lib/termux-packs";
import { checkTermuxReadiness,
  probeTermuxCommand,
  classifyTermuxFailure,
  getTermuxNative} from "../lib/termux-bridge";
import { executeGuardedTermuxCommand } from "../lib/termux-executor";
import { notifyPackDone, notifyModelDownloaded, notifyModelFailed } from "../lib/app-notifications";
import { persistentLogger } from "../lib/persistent-logger";
import {
  getDeviceProfile,
  recommendModelSettings,
  analyzeGgufModel,
  type ModelAnalysis,
  type DeviceProfile,
  type RecommendedModelSettings,
} from "../lib/device-profile";
import { translateEngineError } from "../lib/engine-errors";
import { modelKeepAlive } from "../lib/keep-alive";
import { useLanguage } from "../components/LanguageContext";
import { useLoggerContext } from "../components/LoggerContext";
import { normalizePersistedModelMode } from "../lib/model-mode";
import { useManusSettings } from "./useManusSettings";
import { stripPersistedCredentialFields } from "../lib/persisted-settings-scrub";
import { loadAgentIntelligenceSettings, saveAgentIntelligenceSettings, DEFAULT_AGENT_INTELLIGENCE, type AgentIntelligenceSettings } from "../lib/agent-intelligence";
import {
  customProviderEngine,
  DEFAULT_CUSTOM_CONFIG,
  DEFAULT_CUSTOM_PARAMS,
  type CustomProviderConfig,
  type CustomGenerationParams,
  isLikelyChatModel,
  sanitizeProviderExtraHeadersJson,
} from "../lib/custom-provider";

export type ModelMode = "local" | "online" | "custom" | "opencode" | "manus";

export interface LocalModelState {
  id: string;
  name: string;
  /** Байти файлів — сирі числа; текстовий підпис розміру та опис
   *  збираються на екрані через t("localModelSizeLabel"/"localModelDescription"),
   *  щоб реагувати на зміну мови інтерфейсу (див. app/settings.tsx). */
  llmBytes: number;
  mmprojBytes: number;
  downloaded: boolean;
  downloading: boolean;
  progress: number; // 0-100, объединённый прогресс обоих файлов модели
  bytesWrittenOverall: number;
  totalBytesOverall: number;
  speedBytesPerSec: number;
  stage: "llm" | "mmproj" | null;
  loaded: boolean; // модель поднята в память (готова отвечать)
  loading: boolean;
  error: string | null;
  importing: boolean;
  /** Which import button is busy — so only one spinner is shown */
  importingTarget: null | "llm" | "mmproj";
  exporting: boolean;
  /** Which export button is busy */
  exportingTarget: null | "llm" | "mmproj";
}

export interface OnlineModelState {
  id: string;
  name: string;
  provider: string;
  /** Довжина контексту (у токенах) — текстова підпис збирається на екрані
   *  через t("onlineModelContextLabel"). */
  contextLength: number;
  hasApiKey: boolean;
}

export interface DownloadablePack {
  id: string;
  /** Локализованное имя подставляется в UI через packDefs */
  name: string;
  size: string;
  description?: string;
  installed: boolean;
  downloading: boolean;
  /** true пока идёт удаление пакета */
  removing?: boolean;
  /** true пока AI восстанавливает неудачную установку */
  recovering?: boolean;
  progress: number;
  /** Детальный прогресс по шагам (pkg/pip) */
  stepProgress?: PackStepProgress[];
  lastError?: string | null;
}

const SETTINGS_STORAGE_KEY = "aibuilder.settings.v1";
const API_KEY_SECURE_STORAGE_KEY = "aibuilder.openrouter.apikey";
const CUSTOM_PROVIDER_STORAGE_KEY = "aibuilder.custom.provider.v1";
const CUSTOM2_PROVIDER_STORAGE_KEY = "aibuilder.custom.provider2.v1";
const CUSTOM2_API_KEY_SECURE_STORAGE_KEY = "aibuilder.custom.provider2.apikey";
const OPENCODE_KEY_SECURE_STORAGE_KEY = "aibuilder.opencode.apikey";
// Результаты последней проверки работоспособности моделей OpenRouter (см.
// checkOpenRouterModelsNow ниже) — хранятся отдельным ключом, чтобы не
// затрагивать PersistedSettings при каждой ручной/автоматической проверке.
const OPENROUTER_MODEL_STATUS_STORAGE_KEY = "aibuilder.openrouter.modelStatus.v1";
// Глобальный системный промт хранится отдельным ключом (а не внутри
// PersistedSettings) — это простой текст, который логично держать
// независимо от остальных технических параметров, и который может стать
// довольно длинным.
const SYSTEM_PROMPT_STORAGE_KEY = "aibuilder.systemPrompt.v1";
// Пользовательский промпт именно для Termux-агента (Настройки Termux).
// Подмешивается только в agent path; ядро IDE + protocol всегда выше.
const TERMUX_AGENT_PROMPT_STORAGE_KEY = "aibuilder.termuxAgentPrompt.v1";

interface PersistedSettings {
  mode: ModelMode;
  localParamsAuto: boolean;
  localParams: LocalModelParams;
  localGenParams: GenerationParams;
  onlineGenParams: OnlineGenerationParams;
  /** id выбранной вручную модели OpenRouter (Настройки → "Модели OpenRouter").
   *  Раньше отсутствовал — старые сохранённые настройки просто не будут
   *  иметь этого поля, и ниже подставится ONLINE_MODEL.id по умолчанию. */
  openRouterModelId?: string;
  /** Пользовательские id/имена поверх каталога FREE_OPENROUTER_MODELS
   *  (ключ — исходный id из каталога). */
  openRouterModelOverrides?: Record<string, { id: string; name: string }>;
  /** Кастомная ссылка/имя офлайн-модели (GGUF). */
  localModelOverride?: { name?: string; llmUrl?: string };
  /** Кастомный слот №1 (base URL, model id, headers) — без API-ключа. */
  customProvider?: {
    name?: string;
    baseUrl?: string;
    modelId?: string;
    extraHeadersJson?: string;
    chatPath?: string;
  };
  /** Кастомный слот №2 — отдельная конфигурация (пустые defaults, как №1). */
  customProvider2?: {
    name?: string;
    baseUrl?: string;
    modelId?: string;
    extraHeadersJson?: string;
    chatPath?: string;
  };
  /** Активный кастомный слот для чата и Termux-агента. */
  activeCustomSlot?: 1 | 2;
  /** OpenCode base URL / model (ключ отдельно в SecureStore). */
  openCode?: {
    baseUrl?: string;
    modelId?: string;
  };
  agentIntelligence?: Partial<AgentIntelligenceSettings>;
}

function legacyHeaderCredential(rawHeaders: unknown): string {
  if (typeof rawHeaders !== "string") return "";
  try {
    const headers = JSON.parse(rawHeaders);
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "";
    const entry = Object.entries(headers).find(([name]) => /^(authorization|x-api-key)$/i.test(name));
    if (!entry || typeof entry[1] !== "string") return "";
    return entry[0].toLowerCase() === "authorization" ? entry[1].replace(/^Bearer\s+/i, "").trim() : entry[1].trim();
  } catch { return ""; }
}

async function sanitizeLegacySettingsPayload(raw: string): Promise<{ value: PersistedSettings; serialized: string; migrated: boolean }> {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("SETTINGS_SHAPE_INVALID");
  const value = parsed as Record<string, any>;
  const candidates: Array<[string, unknown]> = [
    ["openrouter", value.onlineApiKey], ["openrouter", value.openRouterApiKey], ["openrouter", value.onlineModel?.apiKey], ["openrouter", value.apiKey],
    ["custom.slot1", value.customProvider?.apiKey], ["custom.slot1", value.customProvider1?.apiKey], ["custom.slot1", legacyHeaderCredential(value.customProvider?.extraHeadersJson)],
    ["custom.slot2", value.customProvider2?.apiKey], ["custom.slot2", legacyHeaderCredential(value.customProvider2?.extraHeadersJson)],
    ["opencode", value.openCode?.apiKey],
  ];
  let migrated = true;
  for (const [provider, secret] of candidates) {
    if (typeof secret === "string" && secret.trim()) {
      if (!await migrateInlineProviderCredential(provider, secret)) migrated = false;
    }
  }
  for (const key of ["onlineApiKey", "openRouterApiKey"]) delete value[key];
  stripPersistedCredentialFields(value, sanitizeProviderExtraHeadersJson);
  const safe = JSON.stringify(value);
  return { value: value as PersistedSettings, serialized: safe, migrated };
}

function initialModelState(): LocalModelState {
  return {
    id: LOCAL_MODEL.id,
    name: LOCAL_MODEL.name,
    llmBytes: LOCAL_MODEL.llmBytes,
    mmprojBytes: LOCAL_MODEL.mmprojBytes,
    downloaded: localModelEngine.isDownloaded(),
    downloading: false,
    progress: 0,
    bytesWrittenOverall: 0,
    totalBytesOverall: LOCAL_MODEL.llmBytes + LOCAL_MODEL.mmprojBytes,
    speedBytesPerSec: 0,
    stage: null,
    loaded: false,
    loading: false,
    error: null,
    importing: false,
    importingTarget: null,
    exporting: false,
    exportingTarget: null,
  };
}

export function useAppSettings() {
  const manusSettings = useManusSettings();
  const { t } = useLanguage();
  const { logInfo, logWarn } = useLoggerContext();
  const [model, setModel] = useState<LocalModelState>(initialModelState);

  const [mode, setModeState] = useState<ModelMode>("local");
  const [deviceProfile, setDeviceProfile] = useState<DeviceProfile | null>(null);
  const [recommended, setRecommended] = useState<RecommendedModelSettings | null>(null);

  const [localParamsAuto, setLocalParamsAuto] = useState(true);
  const [localParams, setLocalParamsState] = useState<LocalModelParams>(DEFAULT_LOCAL_PARAMS);
  const [localGenParams, setLocalGenParamsState] = useState<GenerationParams>(DEFAULT_GENERATION_PARAMS);
  const [onlineGenParams, setOnlineGenParamsState] = useState<OnlineGenerationParams>(DEFAULT_ONLINE_PARAMS);
  const [onlineHasApiKey, setOnlineHasApiKey] = useState(false);
  const [onlineApiKeyLoaded, setOnlineApiKeyLoaded] = useState(false);
  // Два независимых пользовательских слота. Активный слот подаётся в useLLM
  // как `customProvider`, поэтому оба слота работают одинаково и для чата, и для Termux-агента.
  const [activeCustomSlot, setActiveCustomSlotState] = useState<1 | 2>(1);
  const [customProvider1, setCustomProvider1State] = useState<{
    name: string; baseUrl: string; modelId: string; extraHeadersJson: string; chatPath: string; providerId: string; hasApiKey: boolean;
  }>({
    name: DEFAULT_CUSTOM_CONFIG.name, baseUrl: DEFAULT_CUSTOM_CONFIG.baseUrl, modelId: DEFAULT_CUSTOM_CONFIG.modelId,
    extraHeadersJson: "", chatPath: DEFAULT_CUSTOM_CONFIG.chatPath || "/chat/completions", providerId: "custom.slot1", hasApiKey: false,
  });
  const [customProvider2, setCustomProvider2State] = useState<{
    name: string; baseUrl: string; modelId: string; extraHeadersJson: string; chatPath: string; providerId: string; hasApiKey: boolean;
  }>({
    // Empty defaults — same as Custom #1 (no provider preset).
    name: "", baseUrl: "", modelId: "",
    extraHeadersJson: "", chatPath: "/chat/completions", providerId: "custom.slot2", hasApiKey: false,
  });
  const customProvider = activeCustomSlot === 2 ? customProvider2 : customProvider1;

  const [openCode, setOpenCodeState] = useState<{
    baseUrl: string;
    modelId: string;
    hasApiKey: boolean;
  }>({
    // ИСПРАВЛЕНО: api.opencode.ai не существует (см. lib/custom-provider.ts).
    // Настоящий шлюз — OpenCode Zen: https://opencode.ai/zen/v1.
    baseUrl: "https://opencode.ai/zen/v1",
    // Раньше был захардкожен несуществующий id модели "opencode" — теперь
    // модель выбирается из списка, полученного через "Получить список
    // моделей" в OpenCodeModelsDialog.
    modelId: "",
    hasApiKey: false,
  });
  const [openRouterModelId, setOpenRouterModelIdState] = useState<string>(ONLINE_MODEL?.id || "openrouter/free");
  const [openRouterModelOverrides, setOpenRouterModelOverrides] = useState<Record<string, { id: string; name: string }>>({});
  const [localModelOverride, setLocalModelOverrideState] = useState<{ name?: string; llmUrl?: string }>({});

  const [systemPrompt, setSystemPromptState] = useState<string>("");
  const [termuxAgentPrompt, setTermuxAgentPromptState] = useState<string>("");
  const [agentShellBackend, setAgentShellBackendState] = useState<AgentShellBackend>("termux");
  const [agentShellExecutionTarget, setAgentShellExecutionTargetState] = useState<AgentShellExecutionTarget>("selected-backend");
  const [agentIntelligence, setAgentIntelligenceState] = useState<AgentIntelligenceSettings>(DEFAULT_AGENT_INTELLIGENCE);

  // Статусы моделей OpenRouter из последней проверки ("работает"/"не
  // работает"/неизвестно — если ещё ни разу не проверялись) + время этой
  // проверки. См. checkOpenRouterModelsNow ниже и компонент
  // OpenRouterModelsDialog, который их отображает.
  const [openRouterModelStatus, setOpenRouterModelStatus] = useState<Record<string, OpenRouterModelStatus>>({});
  const [openRouterModelsCheckedAt, setOpenRouterModelsCheckedAt] = useState<number | null>(null);
  const [checkingOpenRouterModels, setCheckingOpenRouterModels] = useState(false);

  // Пока не завершилась начальная загрузка сохранённых настроек, не пишем
  // ничего обратно в хранилище — иначе значения по умолчанию затирают то,
  // что пользователь сохранил в прошлый раз, пока асинхронная загрузка ещё
  // не подставила настоящие значения.
  const hydrated = useRef(false);
  const credentialMigrationBlocked = useRef(false);
  const providerEditRevision = useRef({ custom1: 0, custom2: 0, openCode: 0, activeSlot: 0, mode: 0 });

  const [packs, setPacks] = useState<DownloadablePack[]>(() =>
    ALL_TOOL_PACKS.map((p) => ({
      id: p.id,
      name: p.name.ru,
      size: p.sizeLabel.ru,
      description: p.description.ru,
      installed: false,
      downloading: false,
      removing: false,
      recovering: false,
      progress: 0,
      stepProgress: [],
      lastError: null,
    }))
  );

  const packAbortRef = useRef<Record<string, boolean>>({});
  /** Per-pack fine-grained health (label → ToolHealthStatus) */
  const [toolHealthByPack, setToolHealthByPack] = useState<Record<string, Record<string, string>>>({});
  const [toolDiagByPack, setToolDiagByPack] = useState<Record<string, Record<string, string>>>({});
  const [packDiagnostics, setPackDiagnostics] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem("aibuilder.termuxPacks.v1");
        if (!raw) return;
        const flags = JSON.parse(raw) as Record<string, boolean>;
        setPacks((prev) =>
          prev.map((p) => ({
            ...p,
            installed: !!flags[p.id],
            progress: flags[p.id] ? 100 : 0,
          }))
        );
      } catch {
        // ignore
      }
    })();
  }, []);

  // При первом монтировании проверяем, не скачана ли модель ещё с
  // прошлого запуска приложения.
  useEffect(() => {
    setModel((m) => ({ ...m, downloaded: localModelEngine.isDownloaded() }));
  }, []);

  // Автоопределение параметров телефона (ОЗУ/CPU) + подгрузка сохранённых
  // настроек (режим local/online, ручные параметры модели, API-ключ).
  useEffect(() => {
    let cancelled = false;
    const editRevisionAtStart = { ...providerEditRevision.current };

    (async () => {
      const profile = await getDeviceProfile();
      const rec = recommendModelSettings(profile);
      if (cancelled) return;
      setDeviceProfile(profile);
      setRecommended(rec);

      let persisted: PersistedSettings | null = null;
      try {
        let raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) raw = await readDurableRecord(SETTINGS_STORAGE_KEY);
        if (raw) {
          // Guard corrupt/huge payloads (async storage abuse / migration noise)
          if (raw.length > 500_000) {
            persistentLogger.add("warn", "Settings", "SETTINGS payload too large — ignoring");
            persisted = null;
          } else {
            const sanitized = await sanitizeLegacySettingsPayload(raw);
            persisted = sanitized.value;
            if (!sanitized.migrated) {
              credentialMigrationBlocked.current = true;
              persistentLogger.add("error", "CredentialMigration", "Inline credential could not be moved to SecureStore; legacy settings preserved and provider use remains disabled");
            } else if (sanitized.serialized !== raw) {
              await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, sanitized.serialized);
              void mirrorDurableRecord(SETTINGS_STORAGE_KEY, sanitized.serialized).catch(() => undefined);
            } else {
              void mirrorDurableRecord(SETTINGS_STORAGE_KEY, sanitized.serialized).catch(() => undefined);
            }
          }
        }
      } catch {
        persisted = null;
      }

      // Canonicalize historical credential aliases into AgentAuthStore/SecureStore.
      // No provider secret enters this hook state, AsyncStorage config, or engine config.
      let onlineConfigured = await migrateProviderCredential("openrouter", [API_KEY_SECURE_STORAGE_KEY], []);
      let custom1Configured = await migrateProviderCredential("custom.slot1", ["aibuilder.custom.apikey"], ["aibuilder.custom.apikey.fallback"]);
      let custom2Configured = await migrateProviderCredential("custom.slot2", [CUSTOM2_API_KEY_SECURE_STORAGE_KEY], ["aibuilder.custom.provider2.apikey.fallback"]);
      let openCodeConfigured = await migrateProviderCredential("opencode", [OPENCODE_KEY_SECURE_STORAGE_KEY], []);
      if (cancelled) return;
      setOnlineHasApiKey(onlineConfigured);
      setOnlineApiKeyLoaded(true);
      setCustomProvider1State((prev) => ({ ...prev, providerId: "custom.slot1", hasApiKey: custom1Configured }));
      setCustomProvider2State((prev) => ({ ...prev, providerId: "custom.slot2", hasApiKey: custom2Configured }));
      setOpenCodeState((prev) => ({ ...prev, hasApiKey: openCodeConfigured }));

      // Custom provider settings are non-secret only; custom headers are restricted to harmless metadata.
      try {
        const rawCustom = await AsyncStorage.getItem(CUSTOM_PROVIDER_STORAGE_KEY);
        if (rawCustom) {
          const parsed = JSON.parse(rawCustom) as { name?: string; baseUrl?: string; modelId?: string; extraHeadersJson?: string; chatPath?: string; apiKey?: string };
          const legacyKeys = [parsed.apiKey?.trim(), legacyHeaderCredential(parsed.extraHeadersJson)].filter((key): key is string => Boolean(key));
          let legacyMigrated = true;
          for (const key of legacyKeys) if (!await migrateInlineProviderCredential("custom.slot1", key)) legacyMigrated = false;
          if (legacyMigrated && legacyKeys.length) custom1Configured = await migrateProviderCredential("custom.slot1");
          if (!legacyMigrated) {
            credentialMigrationBlocked.current = true;
            persistentLogger.add("error", "CredentialMigration", "Custom slot 1 inline key migration failed; legacy data preserved and provider disabled");
          } else {
            const cleanRaw = JSON.stringify({ ...parsed, apiKey: undefined, extraHeadersJson: sanitizeProviderExtraHeadersJson(parsed.extraHeadersJson || "") });
            await AsyncStorage.setItem(CUSTOM_PROVIDER_STORAGE_KEY, cleanRaw);
          }
          const config = {
            name: parsed.name || DEFAULT_CUSTOM_CONFIG.name,
            baseUrl: parsed.baseUrl || "",
            modelId: parsed.modelId || "",
            extraHeadersJson: sanitizeProviderExtraHeadersJson(parsed.extraHeadersJson || ""),
            chatPath: parsed.chatPath || "/chat/completions",
          };
          if (providerEditRevision.current.custom1 === editRevisionAtStart.custom1) {
            setCustomProvider1State((prev) => ({ ...prev, ...config, providerId: "custom.slot1", hasApiKey: custom1Configured }));
            customProviderEngine.setConfig({ ...config, providerId: "custom.slot1", hasApiKey: custom1Configured });
          }
        }
      } catch { /* ignore invalid non-secret config */ }

      try {
        const rawCustom2 = await AsyncStorage.getItem(CUSTOM2_PROVIDER_STORAGE_KEY);
        if (rawCustom2) {
          const parsed = JSON.parse(rawCustom2) as { name?: string; baseUrl?: string; modelId?: string; extraHeadersJson?: string; chatPath?: string; apiKey?: string };
          const legacyKeys = [parsed.apiKey?.trim(), legacyHeaderCredential(parsed.extraHeadersJson)].filter((key): key is string => Boolean(key));
          let legacyMigrated = true;
          for (const key of legacyKeys) if (!await migrateInlineProviderCredential("custom.slot2", key)) legacyMigrated = false;
          if (legacyMigrated && legacyKeys.length) custom2Configured = await migrateProviderCredential("custom.slot2");
          if (!legacyMigrated) {
            credentialMigrationBlocked.current = true;
            persistentLogger.add("error", "CredentialMigration", "Custom slot 2 inline key migration failed; legacy data preserved and provider disabled");
          } else {
            const cleanRaw = JSON.stringify({ ...parsed, apiKey: undefined, extraHeadersJson: sanitizeProviderExtraHeadersJson(parsed.extraHeadersJson || "") });
            await AsyncStorage.setItem(CUSTOM2_PROVIDER_STORAGE_KEY, cleanRaw);
          }
          if (providerEditRevision.current.custom2 === editRevisionAtStart.custom2) {
            setCustomProvider2State((prev) => ({
              ...prev, name: parsed.name || prev.name, baseUrl: parsed.baseUrl || prev.baseUrl,
              modelId: parsed.modelId || prev.modelId,
              extraHeadersJson: sanitizeProviderExtraHeadersJson(parsed.extraHeadersJson || ""),
              chatPath: parsed.chatPath || prev.chatPath, providerId: "custom.slot2", hasApiKey: custom2Configured,
            }));
          }
        }
      } catch { /* ignore invalid non-secret slot config */ }

      try {
        const rawOc = await AsyncStorage.getItem("aibuilder.opencode.config.v1");
        if (rawOc) {
          const parsed = JSON.parse(rawOc) as { baseUrl?: string; modelId?: string; apiKey?: string };
          const legacyMigrated = !parsed.apiKey?.trim() || await migrateInlineProviderCredential("opencode", parsed.apiKey);
          if (legacyMigrated && parsed.apiKey?.trim()) openCodeConfigured = await migrateProviderCredential("opencode");
          if (!legacyMigrated) {
            credentialMigrationBlocked.current = true;
            persistentLogger.add("error", "CredentialMigration", "OpenCode inline key migration failed; legacy data preserved and provider disabled");
          } else {
            await AsyncStorage.setItem("aibuilder.opencode.config.v1", JSON.stringify({ baseUrl: parsed.baseUrl, modelId: parsed.modelId }));
          }
          const savedBaseUrl = parsed.baseUrl?.trim();
          const isStaleBaseUrl = !savedBaseUrl || /^https?:\/\/api\.opencode\.ai\/?/i.test(savedBaseUrl);
          const savedModelId = parsed.modelId?.trim();
          const migratedModelId = !savedModelId || savedModelId === "opencode" ? "" : savedModelId;
          if (providerEditRevision.current.openCode === editRevisionAtStart.openCode) {
            setOpenCodeState({ baseUrl: isStaleBaseUrl ? "https://opencode.ai/zen/v1" : savedBaseUrl!, modelId: migratedModelId, hasApiKey: openCodeConfigured });
          }
        }
      } catch { /* ignore invalid non-secret config */ }

      try {
        const intelligence = await loadAgentIntelligenceSettings();
        if (!cancelled) setAgentIntelligenceState(intelligence);
      } catch { /* optional */ }

      // Глобальный системный промт — читаем независимо от остальных настроек.
      try {
        const rawPrompt = await AsyncStorage.getItem(SYSTEM_PROMPT_STORAGE_KEY);
        if (!cancelled && typeof rawPrompt === "string" && !rawPrompt.includes("\0") && rawPrompt.length < 100_000) {
          setSystemPromptState(rawPrompt);
        }
      } catch {
        // не критично — останется пустым
      }

      try {
        const rawTermuxPrompt = await AsyncStorage.getItem(TERMUX_AGENT_PROMPT_STORAGE_KEY);
        const rawShellBackend = await AsyncStorage.getItem(AGENT_SHELL_BACKEND_STORAGE_KEY);
        const legacyShellBackend = rawShellBackend == null
          ? await AsyncStorage.getItem(LEGACY_AGENT_SHELL_BACKEND_STORAGE_KEY)
          : null;
        const persistedBackend = rawShellBackend ?? legacyShellBackend;
        if (persistedBackend) {
          const b = parseAgentShellBackend(persistedBackend);
          setAgentShellBackendState(b);
          applyBuildBackend(b);
          if (legacyShellBackend != null) {
            void AsyncStorage.setItem(AGENT_SHELL_BACKEND_STORAGE_KEY, b);
          }
        }

        if (!cancelled && typeof rawTermuxPrompt === "string") {
          setTermuxAgentPromptState(rawTermuxPrompt);
        }
      } catch {
        // не критично — останется пустым
      }

      try {
        const target = await loadAgentShellExecutionTarget();
        if (!cancelled) setAgentShellExecutionTargetState(target);
      } catch {
        // The agent dispatcher also loads this value and fails closed on storage errors.
      }

      // Результат последней проверки моделей OpenRouter — читаем независимо
      // от остальных настроек (см. OPENROUTER_MODEL_STATUS_STORAGE_KEY выше).
      try {
        const rawStatus = await AsyncStorage.getItem(OPENROUTER_MODEL_STATUS_STORAGE_KEY);
        if (!cancelled && rawStatus) {
          const parsed = JSON.parse(rawStatus) as {
            status?: Record<string, OpenRouterModelStatus>;
            checkedAt?: number;
          };
          if (parsed?.status) setOpenRouterModelStatus(parsed.status);
          if (parsed?.checkedAt) setOpenRouterModelsCheckedAt(parsed.checkedAt);
        }
      } catch {
        // не критично — просто выполнится проверка заново
      }

      if (persisted) {
        if (providerEditRevision.current.mode === editRevisionAtStart.mode) setModeState(normalizePersistedModelMode(persisted.mode));
        setLocalParamsAuto(persisted.localParamsAuto !== false);
        if (persisted.localParamsAuto !== false) {
          const disk = localModelEngine.getOnDiskModelInfo();
          const model = disk
            ? analyzeGgufModel(disk.fileName, disk.fileBytes, { hasMmproj: disk.hasMmproj })
            : null;
          const rec2 = recommendModelSettings(profile, model);
          setRecommended(rec2);
          setLocalParamsState({ nCtx: rec2.nCtx, nThreads: rec2.nThreads, nGpuLayers: rec2.nGpuLayers });
          setLocalGenParamsState({
            temperature: rec2.temperature ?? 0.3,
            maxTokens: rec2.maxTokens ?? 768,
            topP: rec2.topP ?? 0.9,
          });
          persistentLogger.add("info", "Settings", `auto params on boot: ${rec2.reason || ""}`);
        } else if (persisted.localParams) {
          setLocalParamsState(persisted.localParams);
          if (persisted.localGenParams) {
            setLocalGenParamsState(persisted.localGenParams);
          }
        } else if (persisted.localGenParams) {
          setLocalGenParamsState(persisted.localGenParams);
        }
        setOnlineGenParamsState(persisted.onlineGenParams);
        setOpenRouterModelIdState(persisted.openRouterModelId || ONLINE_MODEL.id);
        if (persisted.openRouterModelOverrides && typeof persisted.openRouterModelOverrides === "object") {
          const cleanOverrides: Record<string, { id: string; name: string }> = {};
          for (const [k, v] of Object.entries(persisted.openRouterModelOverrides)) {
            if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
              const o = v as { id: string; name?: unknown };
              cleanOverrides[k] = { id: o.id, name: typeof o.name === "string" ? o.name : o.id };
            }
          }
          setOpenRouterModelOverrides(cleanOverrides);
        }
        if (persisted.localModelOverride) {
          setLocalModelOverrideState(persisted.localModelOverride);
        }
        // Prefer on-disk import meta over stale catalog override name
        try {
          const diskMeta = await refreshActiveMetaFromDisk();
          const eff = getEffectiveModel();
          if (diskMeta || eff.source === "import") {
            setModel((m) => ({
              ...m,
              name: eff.displayName || m.name,
              llmBytes: eff.llmBytes || m.llmBytes,
              mmprojBytes: eff.mmprojBytes || m.mmprojBytes,
              downloaded: localModelEngine.isDownloaded(),
            }));
          } else if (persisted.localModelOverride?.name) {
            setModel((m) => ({ ...m, name: persisted.localModelOverride!.name! }));
          }
        } catch {
          if (persisted.localModelOverride?.name) {
            setModel((m) => ({ ...m, name: persisted.localModelOverride!.name! }));
          }
        }
        if (persisted.customProvider && providerEditRevision.current.custom1 === editRevisionAtStart.custom1) {
          const savedCustomModelId = persisted.customProvider!.modelId?.trim() || "";
          const isStaleCustomModel = !!savedCustomModelId && !isLikelyChatModel({ id: savedCustomModelId });
          setCustomProvider1State((prev) => ({
            ...prev,
            name: persisted.customProvider!.name || prev.name,
            baseUrl: persisted.customProvider!.baseUrl || prev.baseUrl,
            modelId: isStaleCustomModel ? prev.modelId : (savedCustomModelId || prev.modelId),
            extraHeadersJson: persisted.customProvider!.extraHeadersJson || prev.extraHeadersJson,
            chatPath: persisted.customProvider!.chatPath || prev.chatPath || "/chat/completions",
          }));
        }
        if (persisted.customProvider2 && providerEditRevision.current.custom2 === editRevisionAtStart.custom2) {
          setCustomProvider2State((prev) => ({
            ...prev,
            name: persisted.customProvider2!.name || prev.name,
            baseUrl: persisted.customProvider2!.baseUrl || prev.baseUrl,
            modelId: persisted.customProvider2!.modelId || prev.modelId,
            extraHeadersJson: persisted.customProvider2!.extraHeadersJson || prev.extraHeadersJson,
            chatPath: persisted.customProvider2!.chatPath || prev.chatPath || "/chat/completions",
          }));
        }
        if (providerEditRevision.current.activeSlot === editRevisionAtStart.activeSlot && (persisted.activeCustomSlot === 2 || persisted.activeCustomSlot === 1)) {
          setActiveCustomSlotState(persisted.activeCustomSlot);
        }
        if (persisted.openCode && providerEditRevision.current.openCode === editRevisionAtStart.openCode) {
          // Та же автомиграция, что и выше при чтении "aibuilder.opencode.config.v1" —
          // этот блок читает независимо сохранённую копию тех же полей из
          // общего SETTINGS_STORAGE_KEY и мог бы затереть уже исправленные
          // значения старым несуществующим доменом/id модели.
          const savedBaseUrl = persisted.openCode!.baseUrl?.trim();
          const isStaleBaseUrl = !savedBaseUrl || /^https?:\/\/api\.opencode\.ai\/?/i.test(savedBaseUrl);
          const savedModelId = persisted.openCode!.modelId?.trim();
          const isLegacyModelId = !savedModelId || savedModelId === "opencode";
          // Persist free and paid OpenCode model ids; only drop legacy placeholder "opencode".
          if (isLegacyModelId) {
            setOpenCodeState((prev) => ({
              ...prev,
              baseUrl: isStaleBaseUrl ? prev.baseUrl : savedBaseUrl!,
            }));
          } else {
            setOpenCodeState((prev) => ({
              ...prev,
              baseUrl: isStaleBaseUrl ? prev.baseUrl : savedBaseUrl!,
              modelId: savedModelId!,
            }));
          }
        }
      } else {
        // Первый запуск: по умолчанию выбираем режим "онлайн", если ключ
        // уже настроен (см. apiKeyWasSeeded выше) — так пользователю не
        // нужно сначала качать ~3 ГБ офлайн-модель, чтобы увидеть ответ.
        // Автонастройка офлайн-параметров — под конкретный телефон.
        if (providerEditRevision.current.mode === editRevisionAtStart.mode) setModeState(onlineConfigured ? "online" : "local");
        setLocalParamsAuto(true);
        setLocalParams(rec);
      }

      hydrated.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Persist non-secret provider configuration only; credentials remain in SecureStore.
  useEffect(() => {
    if (!hydrated.current || credentialMigrationBlocked.current) return;
    const toSave: PersistedSettings = {
      mode,
      localParamsAuto,
      localParams,
      localGenParams,
      onlineGenParams,
      openRouterModelId,
      openRouterModelOverrides,
      localModelOverride,
      customProvider: { name: customProvider1.name, baseUrl: customProvider1.baseUrl, modelId: customProvider1.modelId, extraHeadersJson: sanitizeProviderExtraHeadersJson(customProvider1.extraHeadersJson), chatPath: customProvider1.chatPath },
      customProvider2: { name: customProvider2.name, baseUrl: customProvider2.baseUrl, modelId: customProvider2.modelId, extraHeadersJson: sanitizeProviderExtraHeadersJson(customProvider2.extraHeadersJson), chatPath: customProvider2.chatPath },
      activeCustomSlot,
      openCode: {
        baseUrl: openCode.baseUrl,
        modelId: openCode.modelId,
      },
    };
    persistAsyncStorageItem(SETTINGS_STORAGE_KEY, JSON.stringify(toSave));
    // Dedicated route records are keyed by provider identity, never by the
    // currently active UI slot. AgentProviderRoutes treats these as canonical.
    persistAsyncStorageItem(CUSTOM_PROVIDER_STORAGE_KEY, JSON.stringify({
      name: customProvider1.name,
      baseUrl: customProvider1.baseUrl,
      modelId: customProvider1.modelId,
      extraHeadersJson: sanitizeProviderExtraHeadersJson(customProvider1.extraHeadersJson),
      chatPath: customProvider1.chatPath,
    }));
    persistAsyncStorageItem(CUSTOM2_PROVIDER_STORAGE_KEY, JSON.stringify({
      name: customProvider2.name,
      baseUrl: customProvider2.baseUrl,
      modelId: customProvider2.modelId,
      extraHeadersJson: sanitizeProviderExtraHeadersJson(customProvider2.extraHeadersJson),
      chatPath: customProvider2.chatPath,
    }));
    persistAsyncStorageItem("aibuilder.opencode.config.v1", JSON.stringify({
      baseUrl: openCode.baseUrl,
      modelId: openCode.modelId,
    }));
  }, [mode, localParamsAuto, localParams, localGenParams, onlineGenParams, openRouterModelId, openRouterModelOverrides, localModelOverride, activeCustomSlot, customProvider1.name, customProvider1.baseUrl, customProvider1.modelId, customProvider1.extraHeadersJson, customProvider1.chatPath, customProvider2.name, customProvider2.baseUrl, customProvider2.modelId, customProvider2.extraHeadersJson, customProvider2.chatPath, openCode.baseUrl, openCode.modelId]);

  const setMode = useCallback((next: ModelMode) => {
    providerEditRevision.current.mode++;
    setModeState(next);
  }, []);

  const setLocalParams = useCallback((next: Partial<LocalModelParams>) => {
    setLocalParamsAuto(false);
    setLocalParamsState((prev) => ({ ...prev, ...next }));
  }, []);

  /** Device + on-disk GGUF → best local params (and gen defaults). */
  const computeOptimalSettings = useCallback(() => {
    const disk = localModelEngine.getOnDiskModelInfo();
    let model: ModelAnalysis | null = null;
    if (disk) {
      model = analyzeGgufModel(disk.fileName, disk.fileBytes, { hasMmproj: disk.hasMmproj });
    }
    const profile = deviceProfile;
    if (!profile) {
      return recommendModelSettings({ totalMemoryBytes: null, totalMemoryGB: null, modelName: null, manufacturer: null, osVersion: null, isPhysicalDevice: true, supportedCpuArchitectures: null, isArm64Compatible: true }, model);
    }
    return recommendModelSettings(profile, model);
  }, [deviceProfile]);

  const applyOptimalLocalSettings = useCallback(
    (opts?: { silent?: boolean }) => {
      const rec = computeOptimalSettings();
      setRecommended(rec);
      setLocalParamsAuto(true);
      setLocalParamsState({
        nCtx: rec.nCtx,
        nThreads: rec.nThreads,
        nGpuLayers: rec.nGpuLayers,
      });
      setLocalGenParamsState({
        temperature: rec.temperature,
        maxTokens: rec.maxTokens,
        topP: rec.topP,
      });
      if (!opts?.silent) {
        persistentLogger.add(
          "info",
          "Settings",
          `auto model params: ${rec.reason || `n_ctx=${rec.nCtx} threads=${rec.nThreads}`}`,
        );
      }
      return rec;
    },
    [computeOptimalSettings],
  );

  const resetLocalParamsToAuto = useCallback(() => {
    applyOptimalLocalSettings();
  }, [applyOptimalLocalSettings]);

  const setLocalGenParams = useCallback((next: Partial<GenerationParams>) => {
    setLocalGenParamsState((prev) => ({ ...prev, ...next }));
  }, []);

  const setOnlineGenParams = useCallback((next: Partial<OnlineGenerationParams>) => {
    setOnlineGenParamsState((prev) => ({ ...prev, ...next }));
  }, []);

  const setOnlineApiKey = useCallback(async (key: string): Promise<boolean> => {
    const saved = await saveProviderCredential("openrouter", key);
    if (saved) setOnlineHasApiKey(Boolean(key.trim()));
    return saved;
  }, []);

  const setActiveCustomSlot = useCallback((slot: 1 | 2) => {
    providerEditRevision.current.activeSlot++;
    providerEditRevision.current.mode++;
    setActiveCustomSlotState(slot);
    setModeState("custom");
    const cfg = slot === 2 ? customProvider2 : customProvider1;
    customProviderEngine.setConfig({ name: cfg.name, baseUrl: cfg.baseUrl, modelId: cfg.modelId, providerId: cfg.providerId, hasApiKey: cfg.hasApiKey, extraHeadersJson: cfg.extraHeadersJson, chatPath: cfg.chatPath || "/chat/completions" });
  }, [customProvider1, customProvider2]);

  const setCustomProviderSlot = useCallback(async (slot: 1 | 2, next: Partial<{
    name: string; baseUrl: string; modelId: string; extraHeadersJson: string; chatPath: string; apiKey: string;
  }>, activate = false): Promise<boolean> => {
    const base = slot === 2 ? customProvider2 : customProvider1;
    const providerId = slot === 2 ? "custom.slot2" : "custom.slot1";
    const candidateKey = next.apiKey?.trim() || "";
    if (candidateKey && !await saveProviderCredential(providerId, candidateKey)) return false;
    const { apiKey: _uiOnlyKey, ...safeNext } = next;
    const cfg = {
      ...base,
      ...safeNext,
      providerId,
      hasApiKey: candidateKey ? true : base.hasApiKey,
      extraHeadersJson: sanitizeProviderExtraHeadersJson(safeNext.extraHeadersJson ?? base.extraHeadersJson),
    };
    providerEditRevision.current[slot === 2 ? "custom2" : "custom1"]++;
    if (slot === 2) setCustomProvider2State(cfg);
    else setCustomProvider1State(cfg);
    if (activate) {
      providerEditRevision.current.activeSlot++;
      providerEditRevision.current.mode++;
      setActiveCustomSlotState(slot);
      setModeState("custom");
      customProviderEngine.setConfig({ name: cfg.name, baseUrl: cfg.baseUrl, modelId: cfg.modelId, providerId: cfg.providerId, hasApiKey: cfg.hasApiKey, extraHeadersJson: cfg.extraHeadersJson, chatPath: cfg.chatPath || "/chat/completions" });
    }
    return true;
  }, [customProvider1, customProvider2]);

  const setCustomProvider = useCallback(async (next: Partial<{
    name: string; baseUrl: string; modelId: string; extraHeadersJson: string; chatPath: string; apiKey: string;
  }>): Promise<boolean> => {
    return setCustomProviderSlot(activeCustomSlot, next, false);
  }, [activeCustomSlot, setCustomProviderSlot]);

  const setOpenCode = useCallback(async (next: Partial<{
    baseUrl: string;
    modelId: string;
    apiKey: string;
  }>): Promise<boolean> => {
    const candidateKey = next.apiKey?.trim() || "";
    if (candidateKey && !await saveProviderCredential("opencode", candidateKey)) return false;
    const { apiKey: _uiOnlyKey, ...safeNext } = next;
    providerEditRevision.current.openCode++;
    setOpenCodeState((prev) => ({ ...prev, ...safeNext, hasApiKey: candidateKey ? true : prev.hasApiKey }));
    return true;
  }, []);

  const setOpenRouterModel = useCallback((id: string) => {
    setOpenRouterModelIdState(id);
  }, []);

  const saveOpenRouterModelOverride = useCallback((baseId: string, customId: string, customName: string) => {
    setOpenRouterModelOverrides((prev) => ({
      ...prev,
      [baseId]: { id: customId.trim() || baseId, name: customName.trim() || customId.trim() || baseId },
    }));
  }, []);

  const setLocalModelOverride = useCallback((next: { name?: string; llmUrl?: string }) => {
    setLocalModelOverrideState((prev) => {
      const merged = { ...prev, ...next };
      if (merged.name) {
        setModel((m) => ({ ...m, name: merged.name! }));
      }
      return merged;
    });
  }, []);

  // Проверяет все модели из FREE_OPENROUTER_MODELS реальным тестовым
  // запросом (см. lib/online-model.ts → checkOpenRouterModels) и сохраняет
  // результат. Если модель, выбранная пользователем СЕЙЧАС, оказалась
  // нерабочей — автоматически переключаемся на первую рабочую модель из
  // списка (первым в списке всегда идёт "openrouter/free", авто-роутер,
  // который считается рабочим по определению — см. checkOpenRouterModels).
  // Вызывается как вручную (кнопка "Проверить модели" в
  // OpenRouterModelsDialog), так и автоматически при запуске приложения
  // (см. эффект ниже), если результатов ещё нет или они устарели.
  const checkOpenRouterModelsNow = useCallback(async () => {
    if (checkingOpenRouterModels) return;
    if (!onlineHasApiKey) {
      logWarn("Settings", t("errorNoApiKeyLog"));
      return;
    }
    setCheckingOpenRouterModels(true);
    logInfo("Settings", t("logOpenRouterCheckStarted"));
    try {
      const resultsMap = await checkOpenRouterModels(FREE_OPENROUTER_MODELS, (result) => {
        setOpenRouterModelStatus((prev) => ({ ...prev, [result.id]: result.status }));
      });

      // roundStatus содержит только модели, реально проверенные В ЭТОМ
      // раунде — если проверка была прервана досрочно из-за дневного
      // лимита (см. checkOpenRouterModels в lib/online-model.ts), тут
      // будет меньше записей, чем в FREE_OPENROUTER_MODELS.
      const roundStatus: Record<string, OpenRouterModelStatus> = {};
      let dailyLimitHit = false;
      Object.values(resultsMap).forEach((r) => {
        roundStatus[r.id] = r.status;
        if (r.status === "limited") dailyLimitHit = true;
      });
      const checkedAt = Date.now();

      // ВАЖНО (v25): объединяем результаты этого раунда с уже известными
      // статусами, а НЕ заменяем состояние целиком. Раньше полная замена
      // означала, что при досрочном прерывании проверки (дневной лимит)
      // непроверенные модели теряли свой прошлый статус "работает" —
      // сейчас он сохраняется, пока модель не будет проверена заново.
      let mergedStatus: Record<string, OpenRouterModelStatus> = {};
      setOpenRouterModelStatus((prev) => {
        mergedStatus = { ...prev, ...roundStatus };
        return mergedStatus;
      });
      setOpenRouterModelsCheckedAt(checkedAt);
      AsyncStorage.setItem(
        OPENROUTER_MODEL_STATUS_STORAGE_KEY,
        JSON.stringify({ status: mergedStatus, checkedAt })
      ).catch(() => {});

      const workingCount = Object.values(roundStatus).filter((s) => s === "working").length;
      if (dailyLimitHit) {
        // Дневной лимит бесплатных запросов OpenRouter исчерпан для всего
        // аккаунта — явно сообщаем об этом отдельным сообщением, а не
        // "работает 0 из N" (именно эта фраза вводила пользователя в
        // заблуждение, будто модели сломаны — см. скриншот/лог).
        logWarn("Settings", t("logOpenRouterDailyLimitHit"));
      } else {
        logInfo("Settings", t("logOpenRouterCheckDone", { working: workingCount, total: Object.keys(roundStatus).length }));
      }

      // Autoselect fallback only when a model-specific check proves the
      // selected model is broken or returns 404/unavailable. Key-only checks,
      // quota/rate limits, network failures and upstream 5xx never change it.
      setOpenRouterModelIdState((currentId) => {
        const fallbackId = selectOpenRouterFallbackModelId(currentId, roundStatus, FREE_OPENROUTER_MODELS);
        if (!fallbackId) return currentId;
        const fallbackModel = FREE_OPENROUTER_MODELS.find((model) => model.id === fallbackId);
        if (fallbackModel) logWarn("Settings", t("logOpenRouterAutoSwitched", { name: fallbackModel.name }));
        return fallbackId;
      });
    } finally {
      setCheckingOpenRouterModels(false);
    }
  }, [checkingOpenRouterModels, onlineHasApiKey, logInfo, logWarn, t]);

  // Автопроверка моделей OpenRouter при запуске приложения НАМЕРЕННО не
  // выполняется — только вручную, по кнопке "Проверить модели" в
  // Настройках (см. checkOpenRouterModelsNow выше и
  // components/OpenRouterModelsDialog.tsx). Статус последней проверки
  // всё равно подгружается при старте из AsyncStorage (см. выше) — она
  // просто не запускается заново сама по себе.

  // Глобальный системный промт — применяется как к офлайн-, так и к
  // онлайн-модели (см. lib/local-model.ts / lib/online-model.ts,
  // hooks/useLLM.ts). Сохраняется сразу же, отдельным ключом хранилища.
  const setSystemPrompt = useCallback((prompt: string) => {
    setSystemPromptState(prompt);
    persistAsyncStorageItem(SYSTEM_PROMPT_STORAGE_KEY, prompt);
  }, []);

  const clearSystemPrompt = useCallback(() => {
    setSystemPromptState("");
    void AsyncStorage.removeItem(SYSTEM_PROMPT_STORAGE_KEY).catch((error: unknown) => console.warn(`[AIB][storage] AsyncStorage remove failed for ${SYSTEM_PROMPT_STORAGE_KEY}: ${error instanceof Error ? error.message : String(error)}`));
  }, []);

  const setAgentShellBackend = useCallback(async (backend: AgentShellBackend) => {
    const b = backend === "ubuntu-proot" ? backend : "termux";
    setAgentShellBackendState(b);
    applyBuildBackend(b);
    try {
      await AsyncStorage.setItem(AGENT_SHELL_BACKEND_STORAGE_KEY, b);
    } catch (error: unknown) {
      console.warn(
        `[AIB][storage] AsyncStorage set failed for ${AGENT_SHELL_BACKEND_STORAGE_KEY}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, []);

  const setAgentShellExecutionTarget = useCallback(async (target: AgentShellExecutionTarget) => {
    const next: AgentShellExecutionTarget = target === "embedded-private" ? "embedded-private" : "selected-backend";
    setAgentShellExecutionTargetState(next);
    try {
      await persistAgentShellExecutionTarget(next);
    } catch (error: unknown) {
      console.warn(`[AIB][storage] Agent shell target could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const setTermuxAgentPrompt = useCallback((prompt: string) => {
    setTermuxAgentPromptState(prompt);
    persistAsyncStorageItem(TERMUX_AGENT_PROMPT_STORAGE_KEY, prompt);
  }, []);

  const clearTermuxAgentPrompt = useCallback(() => {
    setTermuxAgentPromptState("");
    void AsyncStorage.removeItem(TERMUX_AGENT_PROMPT_STORAGE_KEY).catch((error: unknown) => console.warn(`[AIB][storage] AsyncStorage remove failed for ${TERMUX_AGENT_PROMPT_STORAGE_KEY}: ${error instanceof Error ? error.message : String(error)}`));
  }, []);

  const setAgentIntelligence = useCallback((patch: Partial<AgentIntelligenceSettings>) => {
    setAgentIntelligenceState(prev => {
      const next = { ...prev, ...patch };
      saveAgentIntelligenceSettings(next).catch(() => {});
      return next;
    });
  }, []);

  const downloadModel = useCallback(async (): Promise<boolean> => {
    setModel((m) => ({ ...m, downloading: true, progress: 0, error: null }));
    try {
      await localModelEngine.download((p) => {
        setModel((m) => ({
          ...m,
          progress: p.percent,
          bytesWrittenOverall: p.bytesWrittenOverall,
          totalBytesOverall: p.totalBytesOverall,
          speedBytesPerSec: p.speedBytesPerSec,
          stage: p.stage,
        }));
      }, localModelOverride?.llmUrl ? { llmUrl: localModelOverride.llmUrl } : undefined);
      const verifiedFiles = localModelEngine.validateDownloadedFiles();
      if (!verifiedFiles.ok) {
        const reason = verifiedFiles.reason || "VERIFY_FAILED";
        const msg =
          `Файлы модели повреждены или неполные (${reason}). ` +
          `llm=${verifiedFiles.llmBytes}B mmproj=${verifiedFiles.mmprojBytes}B. ` +
          `Удалите модель и скачайте снова на стабильном Wi‑Fi; не сворачивайте приложение надолго.`;
        persistentLogger.add("error", "Settings", `Model verify failed: ${msg}`);
        setModel((m) => ({
          ...m,
          downloading: false,
          downloaded: false,
          progress: 0,
          error: msg,
        }));
        notifyModelFailed(localModelOverride?.name || "offline model", msg);
        return false;
      }
      setModel((m) => ({
        ...m,
        downloading: false,
        downloaded: true,
        progress: 100,
        error: null,
      }));
      const name = localModelOverride?.name || "offline model";
      const totalBytes = verifiedFiles.llmBytes + verifiedFiles.mmprojBytes;
      const gb = totalBytes > 0 ? totalBytes / (1024 ** 3) : 0;
      persistentLogger.add(
        "info",
        "Settings",
        `Model download OK: ${name}, ${gb.toFixed(2)} GB on disk`
      );
      notifyModelDownloaded(name, gb);
      // Auto-tune n_ctx / threads / gen from phone + GGUF
      if (localParamsAuto) {
        applyOptimalLocalSettings({ silent: false });
      }
      return true;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      let friendly = translateEngineError(t, raw);
      if (/MODEL_DOWNLOAD_INCOMPLETE|LLM_FILE_SIZE|MMPROJ_FILE_SIZE|SHA256|NOT_GGUF/i.test(raw)) {
        friendly =
          "Скачивание оборвалось или файл неполный (сеть / HuggingFace / сворачивание приложения). " +
          "Удалите модель и скачайте один раз на стабильном Wi‑Fi, держите AI Builder на экране. " +
          `Код: ${raw.slice(0, 220)}`;
      } else if (/abort|AbortError|canceled|cancelled/i.test(raw)) {
        friendly = "Скачивание отменено.";
      } else if (/network|timeout|ECONN|ENOTFOUND|502|503|524/i.test(raw)) {
        friendly =
          "Сеть оборвала загрузку (~3 ГБ с HuggingFace). Проверьте Wi‑Fi и повторите. " +
          `Детали: ${raw.slice(0, 160)}`;
      }
      persistentLogger.add("error", "Settings", `Model download failed: ${raw}`);
      setModel((m) => ({
        ...m,
        downloading: false,
        progress: 0,
        error: friendly,
      }));
      notifyModelFailed(localModelOverride?.name || "offline model", friendly);
      return false;
    }
  }, [t, localModelOverride, localParamsAuto, applyOptimalLocalSettings]);

  const cancelDownload = useCallback(() => {
    localModelEngine.cancelDownload();
    setModel((m) => ({ ...m, downloading: false, progress: 0 }));
  }, []);

  const deleteModel = useCallback(async () => {
    // localModelEngine.deleteFiles() сам вызывает unload() перед удалением
    // файлов — модель точно больше не загружена, останавливаем и
    // foreground-сервис, который держал процесс "живым" ради неё.
    await localModelEngine.deleteFiles();
    await modelKeepAlive.stop();
    setModel((m) => ({
      ...m,
      downloaded: false,
      loaded: false,
      progress: 0,
    }));
  }, []);

  /**
   * Импорт основного LLM GGUF с телефона (любая модель).
   * Один файл за раз — без multi-select, чтобы Android не зависал на больших GGUF.
   */
  const importModel = useCallback(async (): Promise<boolean> => {
    if (model.downloading || model.importing) return false;
    setModel((m) => ({ ...m, importing: true, importingTarget: "llm", error: null }));
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        multiple: false,
        copyToCacheDirectory: false,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) {
        setModel((m) => ({ ...m, importing: false, importingTarget: null }));
        return false;
      }
      const a = result.assets[0];
      const picked = { uri: a.uri, size: a.size ?? null, name: a.name ?? null };
      const res = await localModelEngine.importLlmFile(picked);
      if (!res.ok) {
        const msg =
          `Импорт LLM не удался (${res.reason || "VERIFY_FAILED"}). Выберите файл .gguf основной модели.`;
        setModel((m) => ({ ...m, importing: false, importingTarget: null, error: msg }));
        persistentLogger.add("error", "Settings", msg);
        return false;
      }
      await refreshActiveMetaFromDisk();
      const verified = localModelEngine.validateDownloadedFiles();
      const eff = getEffectiveModel();
      setModel((m) => ({
        ...m,
        importing: false,
        importingTarget: null,
        error: null,
        downloaded: verified.ok,
        name: eff.displayName || m.name,
        llmBytes: verified.llmBytes || eff.llmBytes || m.llmBytes,
        mmprojBytes: verified.mmprojBytes || m.mmprojBytes,
      }));
      // Clear stale catalog override name so UI does not keep "Qwen2.5 3B"
      setLocalModelOverrideState((prev) =>
        prev ? { ...prev, name: eff.displayName || prev.name } : { name: eff.displayName },
      );
      persistentLogger.add(
        "info",
        "Settings",
        `LLM imported (${res.reason || "ok"}) name=${eff.displayName} bytes=${eff.llmBytes}`,
      );
      if (localParamsAuto) {
        applyOptimalLocalSettings({ silent: false });
      }
      return true;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      persistentLogger.add("error", "Settings", `Model import failed: ${raw}`);
      setModel((m) => ({ ...m, importing: false, importingTarget: null, error: raw }));
      return false;
    }
  }, [model.downloading, model.importing, localParamsAuto, applyOptimalLocalSettings]);

  /**
   * Импорт второго файла (mmproj / vision / companion) — любой GGUF.
   * Лучше брать mmproj от той же семьи, что и основная модель.
   */
  const importMmproj = useCallback(async (): Promise<boolean> => {
    if (model.downloading || model.importing) return false;
    setModel((m) => ({ ...m, importing: true, importingTarget: "mmproj", error: null }));
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        multiple: false,
        copyToCacheDirectory: false,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) {
        setModel((m) => ({ ...m, importing: false, importingTarget: null }));
        return false;
      }
      const a = result.assets[0];
      const picked = { uri: a.uri, size: a.size ?? null, name: a.name ?? null };
      const res = await localModelEngine.importMmprojFile(picked);
      if (!res.ok) {
        const msg =
          `Импорт второго файла не удался (${res.reason || "VERIFY_FAILED"}). Выберите mmproj/vision .gguf.`;
        setModel((m) => ({ ...m, importing: false, importingTarget: null, error: msg }));
        persistentLogger.add("error", "Settings", msg);
        return false;
      }
      const verified = localModelEngine.validateDownloadedFiles();
      const eff = getEffectiveModel();
      setModel((m) => ({
        ...m,
        importing: false,
        importingTarget: null,
        error: null,
        downloaded: verified.ok || m.downloaded,
        name: eff.displayName || m.name,
        llmBytes: verified.llmBytes || m.llmBytes,
        mmprojBytes: verified.mmprojBytes || m.mmprojBytes,
      }));
      persistentLogger.add("info", "Settings", `Mmproj imported (${res.reason || "ok"})`);
      return true;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      persistentLogger.add("error", "Settings", `Mmproj import failed: ${raw}`);
      setModel((m) => ({ ...m, importing: false, importingTarget: null, error: raw }));
      return false;
    }
  }, [model.downloading, model.importing]);

  /**
   * Экспорт основного LLM GGUF (любая установленная модель).
   * На Android — системный выбор папки и нативное потоковое копирование.
   */
  const exportModel = useCallback(async (): Promise<boolean> => {
    if (model.exporting) return false;
    setModel((m) => ({ ...m, exporting: true, exportingTarget: "llm", error: null }));
    try {
      const files = localModelEngine.getExportFiles();
      if (!files) {
        setModel((m) => ({
          ...m,
          exporting: false,
          exportingTarget: null,
          error: "Файлы модели не найдены на диске — сначала скачайте или импортируйте модель.",
        }));
        return false;
      }
      if (Platform.OS === "android") {
        const native = getTermuxNative();
        if (!native?.exportModelToDirectory) {
          throw new Error("MODEL_EXPORT_NATIVE_UNAVAILABLE");
        }
        const eff = getEffectiveModel();
        const exported = await native.exportModelToDirectory(
          files.llm.uri,
          eff.llmFileName || LOCAL_MODEL.llmFileName,
          "",
          "",
        );
        if (!exported) {
          setModel((m) => ({ ...m, exporting: false, exportingTarget: null }));
          return false;
        }
      } else {
        const available = await Sharing.isAvailableAsync();
        if (!available) {
          setModel((m) => ({
            ...m,
            exporting: false,
            exportingTarget: null,
            error: "Системное меню «Поделиться» недоступно на этом устройстве.",
          }));
          return false;
        }
        const eff = getEffectiveModel();
        await Sharing.shareAsync(files.llm.uri, {
          dialogTitle: eff.llmFileName || LOCAL_MODEL.llmFileName,
          mimeType: "application/octet-stream",
        });
      }
      persistentLogger.add("info", "Settings", "LLM model exported to user-selected folder");
      setModel((m) => ({ ...m, exporting: false, exportingTarget: null }));
      return true;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      persistentLogger.add("error", "Settings", `Model export failed: ${raw}`);
      setModel((m) => ({ ...m, exporting: false, exportingTarget: null, error: raw }));
      return false;
    }
  }, [model.exporting]);

  /**
   * Экспорт второго файла (mmproj / vision), если он есть на диске.
   */
  const exportMmproj = useCallback(async (): Promise<boolean> => {
    if (model.exporting) return false;
    setModel((m) => ({ ...m, exporting: true, exportingTarget: "mmproj", error: null }));
    try {
      const files = localModelEngine.getExportFiles();
      if (!files?.mmproj) {
        setModel((m) => ({
          ...m,
          exporting: false,
          exportingTarget: null,
          error: "Второй файл (mmproj/vision) не найден на диске — сначала импортируйте его.",
        }));
        return false;
      }
      const eff = getEffectiveModel();
      const mmName = eff.mmprojFileName || "mmproj.gguf";
      if (Platform.OS === "android") {
        const native = getTermuxNative();
        if (!native?.exportModelToDirectory) {
          throw new Error("MODEL_EXPORT_NATIVE_UNAVAILABLE");
        }
        // Передаём mmproj как «llm»-слот натива (один файл), второй слот пустой.
        const exported = await native.exportModelToDirectory(
          files.mmproj.uri,
          mmName,
          "",
          "",
        );
        if (!exported) {
          setModel((m) => ({ ...m, exporting: false, exportingTarget: null }));
          return false;
        }
      } else {
        const available = await Sharing.isAvailableAsync();
        if (!available) {
          setModel((m) => ({
            ...m,
            exporting: false,
            exportingTarget: null,
            error: "Системное меню «Поделиться» недоступно на этом устройстве.",
          }));
          return false;
        }
        await Sharing.shareAsync(files.mmproj.uri, {
          dialogTitle: mmName,
          mimeType: "application/octet-stream",
        });
      }
      persistentLogger.add("info", "Settings", "Mmproj exported to user-selected folder");
      setModel((m) => ({ ...m, exporting: false, exportingTarget: null }));
      return true;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      persistentLogger.add("error", "Settings", `Mmproj export failed: ${raw}`);
      setModel((m) => ({ ...m, exporting: false, exportingTarget: null, error: raw }));
      return false;
    }
  }, [model.exporting]);

  const loadModel = useCallback(async (): Promise<boolean> => {
    setModel((m) => ({ ...m, loading: true, error: null }));
    try {
      if (!localModelEngine.isDownloaded()) {
        const msg =
          "Файлы офлайн-модели не найдены. Сначала нажмите «Скачать», дождитесь 100%, затем «Загрузить в память».";
        setModel((m) => ({ ...m, loading: false, error: msg }));
        notifyModelFailed(localModelOverride?.name || "offline model", msg);
        return false;
      }
      let paramsToLoad = localParams;
      if (localParamsAuto) {
        const rec = applyOptimalLocalSettings({ silent: true });
        paramsToLoad = {
          nCtx: rec.nCtx,
          nThreads: rec.nThreads,
          nGpuLayers: rec.nGpuLayers,
        };
      }
      await localModelEngine.load(paramsToLoad);
      // Sticky-уведомление в шторке (одно) + кнопка «Закрыть» → выгрузка модели.
      // Снижает шанс kill при уходе в другое приложение (см. lib/keep-alive.ts).
      await modelKeepAlive.start({
        onDismissUnload: async () => {
          try {
            persistentLogger.add("info", "Settings", "offline model unload (notification button)");
            await localModelEngine.unload();
          } catch (e: unknown) {
            persistentLogger.add(
              "warn",
              "Settings",
              `offline model unload failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          setModel((m) => ({ ...m, loaded: false }));
        },
      });
      persistentLogger.add(
        "info",
        "Settings",
        "offline model loaded — pinned by session notification until unload",
      );
      setModel((m) => ({ ...m, loading: false, loaded: true, error: null }));
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = translateEngineError(t, msg);
      persistentLogger.add("error", "Settings", `Model load failed: ${msg}`);
      setModel((m) => ({
        ...m,
        loading: false,
        loaded: false,
        error: friendly,
      }));
      notifyModelFailed(localModelOverride?.name || model.name || "offline model", friendly);
      return false;
    }
  }, [localParams, t, localModelOverride, model.name, localParamsAuto, applyOptimalLocalSettings]);

  const unloadModel = useCallback(async () => {
    persistentLogger.add("info", "Settings", "offline model unload (settings UI)");
    await localModelEngine.unload();
    // Модель выгружена пользователем вручную — снимаем sticky-сессию.
    await modelKeepAlive.stop();
    setModel((m) => ({ ...m, loaded: false }));
  }, []);

  const downloadPack = useCallback(async (id: string): Promise<boolean> => {
    const def = getToolPack(id);
    if (!def) return false;

    // Readiness checks only the bundled private runtime; no external app permission exists.
    const readiness = await checkTermuxReadiness({ deep: true, refreshPermission: true });
    if (!readiness.ready) {
      setPacks((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, lastError: t("packTermuxNotReady"), downloading: false, recovering: false, stepProgress: [] }
            : p
        )
      );
      persistentLogger.add("warn", "Packs", `Install ${id}: Termux not ready (${readiness.reasons.join(",")})`);
      return false;
    }

    // Probe execution in this app's own runtime; filesystem presence alone is not execution proof.
    const probeErr = await probeTermuxCommand();
    if (probeErr) {
      const cls = classifyTermuxFailure(probeErr);
      const message =
        cls.code === "permission"
          ? t("termuxReasonPermissionMissing")
          : t("termuxSetupHintMessage");
      setPacks((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                downloading: false,
                recovering: false,
                lastError: message,
                stepProgress: [
                  {
                    label: "Termux probe",
                    status: "fail" as const,
                    detail: probeErr.slice(0, 300),
                  },
                ],
              }
            : p
        )
      );
      persistentLogger.add("error", "Packs", `Install ${id}: probe failed: ${probeErr}`);
      return false;
    }

    // Свободное место перед тяжёлыми SDK/NDK
    const minFree = PACK_MIN_FREE_BYTES[id] || 0;
    if (minFree > 0) {
      try {
        const space = await checkTermuxFreeSpace(async (cmd, timeoutMs) => {
          const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
          return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
        });
        if (space && space.freeBytes < minFree) {
          const needGb = (minFree / (1024 ** 3)).toFixed(1);
          const haveGb = (space.freeBytes / (1024 ** 3)).toFixed(1);
          const msg = t("packLowSpace", { need: needGb, have: haveGb });
          setPacks((prev) =>
            prev.map((p) =>
              p.id === id
                ? { ...p, downloading: false, recovering: false, lastError: msg, stepProgress: [] }
                : p
            )
          );
          persistentLogger.add("warn", "Packs", `Install ${id}: low space ${space.detail}, need ${needGb}G`);
          return false;
        }
        if (space) persistentLogger.add("info", "Packs", `Free space OK for ${id}: ${space.detail}`);
      } catch (e: unknown) {
        persistentLogger.add("debug", "Packs", `df check skipped: ${String(e)}`);
      }
    }

    packAbortRef.current[id] = false;
    // Continue: не сбрасываем stepProgress — идемпотентные checkCmd пропустят готовое
    setPacks((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              downloading: true,
              removing: false,
              recovering: false,
              lastError: null,
              // progress/stepProgress сохраняем если уже были (resume)
            }
          : p
      )
    );
    persistentLogger.add("info", "Packs", `Install start/resume: ${id}`);

    let result: Awaited<ReturnType<typeof runPackSteps>>;
    try {
      result = await runPackSteps(
        def.installSteps,
        "install",
        async (cmd, timeoutMs) => {
        if (packAbortRef.current[id]) {
          return { exitCode: 1, stdout: "", stderr: "aborted" };
        }
        const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
        return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
      },
      (percent, stepsState) => {
        setPacks((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, progress: percent, stepProgress: stepsState } : p
          )
        );
        // Persist partial progress for resume after kill
        AsyncStorage.setItem(
          `aibuilder.packProgress.${id}`,
          JSON.stringify({ percent, stepsState, ts: Date.now() })
        ).catch(() => {});
      },
        { shouldAbort: () => !!packAbortRef.current[id] }
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      persistentLogger.add("error", "Packs", `Install exception ${id}: ${message}`);
      setPacks((prev) => prev.map((p) => p.id === id
        ? { ...p, downloading: false, recovering: false, lastError: message.slice(0, 300) }
        : p));
      return false;
    }

    if (result.aborted || packAbortRef.current[id]) {
      setPacks((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                downloading: false,
                recovering: false,
                // НЕ обнуляем progress — можно нажать «Скачать» снова (Continue)
                lastError: t("packCancelled"),
                stepProgress: result.stepsState?.length ? result.stepsState : p.stepProgress,
              }
            : p
        )
      );
      persistentLogger.add("warn", "Packs", `Install paused (continue available): ${id}`);
      // НЕ удаляем уже скачанное — иначе Continue бессмысленен
      return false;
    }

    let installed = result.ok;
    // Последняя проверка — защита от ложного «Установлено» после exit 0.
    if (installed) {
      installed = await checkToolPackInstalled(def, async (cmd, timeoutMs) => {
        const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
        return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
      });
      if (!installed) {
        persistentLogger.add("warn", "Packs", `Final verification failed: ${id}`);
      }
    }
    const completedPercent = Math.min(
      99,
      Math.max(
        0,
        (result.stepsState.reduce(
          (sum, step) => sum + (step.status === "ok" || step.status === "skip" ? 1 : 0),
          0
        ) / Math.max(1, result.stepsState.length)) * 100
      )
    );
    setPacks((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              downloading: false,
              recovering: false,
              progress: installed ? 100 : completedPercent,
              installed,
              stepProgress: result.stepsState,
              lastError: installed ? null : t("packInstallPartial"),
            }
          : p
      )
    );
    persistentLogger.add(
      installed ? "info" : "warn",
      "Packs",
      `Install done: ${id} ok=${installed}`
    );
    if (!installed) {
      const diag = JSON.stringify({
        packId: id,
        phase: "verify",
        message: "pack not fully ready after install",
        steps: result.stepsState?.map((s) => ({ label: s.label, status: s.status, detail: s.detail })),
        timestamp: new Date().toISOString(),
      });
      setPackDiagnostics((prev) => ({ ...prev, [id]: diag }));
    }
    notifyPackDone(id, installed);
    if (installed) {
      void AsyncStorage.removeItem(`aibuilder.packProgress.${id}`).catch((error: unknown) => console.warn(`[AIB][storage] AsyncStorage remove failed for aibuilder.packProgress.${id}: ${error instanceof Error ? error.message : String(error)}`));
    }
    // Persist installed flags
    setPacks((prev) => {
      const flags: Record<string, boolean> = {};
      prev.forEach((p) => {
        flags[p.id] = p.id === id ? installed : p.installed;
      });
      persistAsyncStorageItem("aibuilder.termuxPacks.v1", JSON.stringify(flags));
      return prev;
    });
    return installed;
  }, [t]);

  const setPackRecovering = useCallback((id: string, recovering: boolean) => {
    setPacks((prev) => prev.map((p) => p.id === id
      ? {
          ...p,
          recovering,
          downloading: recovering ? false : p.downloading,
          lastError: recovering ? t("packAiRepairStarted") : p.lastError,
        }
      : p));
  }, [t]);

  const downloadAllPacks = useCallback(async (): Promise<boolean> => {
    const ids = ALL_TOOL_PACKS.map((p) => p.id);
    if (ids.length === 0) {
      persistentLogger.add("info", "Packs", "Install all Termux tools: nothing to install (packs removed from Settings)");
      return true;
    }
    persistentLogger.add("info", "Packs", "Install all Termux tools: start");
    let allOk = true;
    for (const id of ids) {
      if (packAbortRef.current[id]) packAbortRef.current[id] = false;
      const ok = await downloadPack(id);
      if (!ok) {
        allOk = false;
        persistentLogger.add("error", "Packs", `Install all Termux tools: ${id} failed`);
        break;
      }
    }
    persistentLogger.add(allOk ? "info" : "warn", "Packs", `Install all Termux tools: ${allOk ? "complete" : "stopped on failure"}`);
    return allOk;
  }, [downloadPack]);

  const refreshPackInstallation = useCallback(async (id: string): Promise<boolean> => {
    const def = getToolPack(id);
    if (!def) return false;
    try {
      const installed = await checkToolPackInstalled(def, async (cmd, timeoutMs) => {
        const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
        return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
      });
      setPacks((prev) => prev.map((p) => p.id === id
        ? { ...p, installed, recovering: false, downloading: false, progress: installed ? 100 : p.progress }
        : p));
      if (installed) {
        setPacks((prev) => {
          const flags: Record<string, boolean> = {};
          prev.forEach((p) => { flags[p.id] = p.id === id ? true : p.installed; });
          persistAsyncStorageItem("aibuilder.termuxPacks.v1", JSON.stringify(flags));
          return prev;
        });
      }
      return installed;
    } catch (error: unknown) {
      persistentLogger.add("warn", "Packs", `Verification failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, []);

  const cancelPackDownload = useCallback((id: string) => {
    packAbortRef.current[id] = true;
    setPacks((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              downloading: false,
              // progress сохраняем — повторное «Скачать» = Continue
              lastError: t("packCancelled"),
            }
          : p
      )
    );
    persistentLogger.add("warn", "Packs", `Install pause requested: ${id}`);
    // PACK-010: best-effort kill of long-running installer children
    void executeGuardedTermuxCommand(
      // Cancellation must not kill unrelated Termux package/build processes.
      // Only terminate the downloader children that can safely be restarted.
      "pkill -f 'curl|wget' 2>/dev/null || true; sleep 0.3; pkill -9 -f 'curl|wget' 2>/dev/null || true",
      { timeoutMs: 12_000 }
    ).catch(() => {});
  }, [t]);

  const refreshPackTools = useCallback(async (id: string): Promise<Record<string, boolean>> => {
    const def = getToolPack(id);
    if (!def) return {};
    const result: Record<string, boolean> = {};
    const healthMap: Record<string, string> = {};
    const diagMap: Record<string, string> = {};
    for (const step of def.installSteps) {
      try {
        const ok = await checkToolStepInstalled(step, async (cmd, timeoutMs) => {
          const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
          return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
        });
        result[step.label] = ok;
        if (ok) {
          healthMap[step.label] = "READY";
        } else {
          // Distinguish missing vs broken: presence-only probe.
          // CRITICAL: kind:"shell" steps have multi-line scripts as primary —
          // never feed them to `command -v` (produces `command -v set -e\nARCH=...`).
          if (step.kind === "shell") {
            healthMap[step.label] = "MISSING";
            diagMap[step.label] = "shell step not verified via command -v";
          } else {
            const binName = String(step.primary || "")
              .trim()
              .split(/\s+/)[0]
              .replace(/[^a-zA-Z0-9_+\-./]/g, "");
            if (!binName || binName.length > 64) {
              healthMap[step.label] = "MISSING";
            } else {
              const presence = await executeGuardedTermuxCommand(
                `command -v ${binName} >/dev/null 2>&1; echo EC=$?`,
                { timeoutMs: 8000 }
              ).catch(() => null);
              const present = presence && /EC=0/.test(presence.stdout || "");
              healthMap[step.label] = present ? "BROKEN_RUNTIME" : "MISSING";
              if (present) diagMap[step.label] = "present but health/version failed";
            }
          }
        }
        // REV-002: split Frida CLI vs server/root capability
        if (step.label === "frida-tools") {
          if (ok) {
            healthMap[step.label] = "READY";
            healthMap["frida_cli"] = "READY";
            diagMap[step.label] = "frida CLI OK";
            diagMap["frida_cli"] = "frida --version OK";
          } else {
            healthMap["frida_cli"] = "MISSING";
          }
          // server/root separate probe
          try {
            const srv = await executeGuardedTermuxCommand(
              "command -v frida-server >/dev/null 2>&1 && echo HAS_SERVER || echo NO_SERVER; uname -m",
              { timeoutMs: 8000 }
            );
            const hasServer = /HAS_SERVER/.test(srv.stdout || "");
            healthMap["frida_server_cap"] = hasServer ? "READY" : "DEGRADED";
            diagMap["frida_server_cap"] = hasServer
              ? "frida-server binary present"
              : "no frida-server on PATH (typical on non-root) · host=" + (srv.stdout || "").trim().split("\n").pop();
          } catch {
            healthMap["frida_server_cap"] = "DEGRADED";
            diagMap["frida_server_cap"] = "server capability unknown";
          }
        }
        // PACK-016: on broken runtime try arch/file hint for android tools
        if (!ok && /aapt|apksigner|zipalign|platform-tools|build-tools|adb/i.test(step.label)) {
          try {
            const d = await executeGuardedTermuxCommand(
              'echo DIAG_HOST=$(uname -m); ' +
                'for B in "$PREFIX/opt/android-sdk/platform-tools/adb" ' +
                '"$(ls "$PREFIX/opt/android-sdk/build-tools"/*/aapt2 2>/dev/null | head -1)" ' +
                '"$(command -v aapt2 2>/dev/null)" "$(command -v zipalign 2>/dev/null)"; do ' +
                '[ -n "$B" ] && [ -e "$B" ] && echo "DIAG_FILE=$(file -b \"$B\" 2>/dev/null)" && break; done',
              { timeoutMs: 10000 }
            );
            const tail = (d.stdout || "").trim().replace(/\n/g, " · ");
            if (tail) diagMap[step.label] = (diagMap[step.label] ? diagMap[step.label] + " · " : "") + tail;
            if (/x86-64|x86_64|Intel/i.test(d.stdout || "")) healthMap[step.label] = "BROKEN_ARCH";
          } catch { /* ignore */ }
        }
      } catch {
        result[step.label] = false;
        healthMap[step.label] = "MISSING";
      }
    }
    setToolHealthByPack((prev) => ({ ...prev, [id]: healthMap }));
    setToolDiagByPack((prev) => ({ ...prev, [id]: diagMap }));
    const allRequired = def.installSteps.filter((s) => !s.optional);
    const installed = allRequired.length > 0 && allRequired.every((s) => result[s.label]);
    setPacks((prev) => prev.map((p) => p.id === id ? { ...p, installed, progress: installed ? 100 : p.progress } : p));
    return result;
  }, []);

  const installTool = useCallback(async (id: string, label: string): Promise<boolean> => {
    const def = getToolPack(id);
    const step = def?.installSteps.find((s) => s.label === label);
    if (!def || !step) return false;
    try {
      const readiness = await checkTermuxReadiness({ deep: true, refreshPermission: true });
      if (!readiness.ready) {
        const blocked = readiness.reasons.some((reason) => reason === "run_command_permission_missing" || reason === "run_command_permission_check_failed");
        setPacks((prev) => prev.map((p) => p.id === id ? { ...p, lastError: blocked ? t("termuxRunCommandManualStep") : t("packTermuxNotReady"), downloading: false, recovering: false } : p));
        return false;
      }
      packAbortRef.current[id] = false;
      setPacks((prev) => prev.map((p) => p.id === id ? { ...p, downloading: true, removing: false, recovering: false, lastError: null } : p));
      const result = await runPackSteps([step], "install", async (cmd, timeoutMs) => {
        if (packAbortRef.current[id]) return { exitCode: 1, stdout: "", stderr: "aborted" };
        const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
        return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
      }, (percent, stepProgress) => {
        setPacks((prev) => prev.map((p) => p.id === id ? { ...p, progress: percent, stepProgress } : p));
      }, { shouldAbort: () => !!packAbortRef.current[id] });
      const installed = result.ok && await checkToolStepInstalled(step, async (cmd, timeoutMs) => {
        const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
        return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
      });
      setPacks((prev) => prev.map((p) => p.id === id ? { ...p, downloading: false, installed: installed || p.installed, progress: installed ? 100 : p.progress, lastError: installed ? null : t("packInstallPartial") } : p));
      await refreshPackTools(id);
      return installed;
    } catch (error: unknown) {
      setPacks((prev) => prev.map((p) => p.id === id ? { ...p, downloading: false, lastError: error instanceof Error ? error.message : String(error) } : p));
      return false;
    }
  }, [refreshPackTools, t]);

  const removeTool = useCallback(async (id: string, label: string): Promise<boolean> => {
    const def = getToolPack(id);
    const step = def?.installSteps.find((s) => s.label === label);
    if (!def || !step) return false;
    const removeCommand = getToolStepRemoveCommand(step);
    const removeStep: InstallStep = { ...step, primary: removeCommand, download: undefined, checkCmd: undefined };
    try {
      const readiness = await checkTermuxReadiness({ deep: true, refreshPermission: true });
      if (!readiness.ready) {
        const blocked = readiness.reasons.some((reason) => reason === "run_command_permission_missing" || reason === "run_command_permission_check_failed");
        setPacks((prev) => prev.map((p) => p.id === id ? { ...p, lastError: blocked ? t("termuxRunCommandManualStep") : t("packTermuxNotReady"), removing: false } : p));
        return false;
      }
      setPacks((prev) => prev.map((p) => p.id === id ? { ...p, removing: true, downloading: false, lastError: null } : p));
      const result = await runPackSteps([removeStep], "remove", async (cmd, timeoutMs) => {
        const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
        return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
      }, (percent, stepProgress) => {
        setPacks((prev) => prev.map((p) => p.id === id ? { ...p, progress: percent, stepProgress } : p));
      });
      await refreshPackTools(id);
      setPacks((prev) => prev.map((p) => p.id === id ? { ...p, removing: false, lastError: result.ok ? null : t("packInstallPartial") } : p));
      return result.ok;
    } catch (error: unknown) {
      setPacks((prev) => prev.map((p) => p.id === id ? { ...p, removing: false, lastError: error instanceof Error ? error.message : String(error) } : p));
      return false;
    }
  }, [refreshPackTools, t]);

  const deletePack = useCallback(async (id: string) => {

    const def = getToolPack(id);
    if (!def) return;

    const readiness = await checkTermuxReadiness({ deep: true, refreshPermission: true });
    if (!readiness.ready) {
      const blocked = readiness.reasons.some((reason) => reason === "run_command_permission_missing" || reason === "run_command_permission_check_failed");
      setPacks((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, lastError: blocked ? t("termuxRunCommandManualStep") : t("packTermuxNotReady"), installed: false } : p
        )
      );
      return;
    }

    setPacks((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, removing: true, downloading: false, progress: 0, stepProgress: [], lastError: null }
          : p
      )
    );
    persistentLogger.add("info", "Packs", `Remove start: ${id}`);

    const result = await runPackSteps(
      def.removeSteps,
      "remove",
      async (cmd, timeoutMs) => {
        const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
        return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
      },
      (percent, stepsState) => {
        setPacks((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, progress: percent, stepProgress: stepsState } : p
          )
        );
      }
    );

    setPacks((prev) => {
      const next = prev.map((p) =>
        p.id === id
          ? {
              ...p,
              removing: false,
              installed: false,
              progress: 100,
              stepProgress: result.stepsState,
            }
          : p
      );
      const flags: Record<string, boolean> = {};
      next.forEach((x) => {
        flags[x.id] = x.installed;
      });
      persistAsyncStorageItem("aibuilder.termuxPacks.v1", JSON.stringify(flags));
      return next;
    });
    persistentLogger.add("info", "Packs", `Remove done: ${id}`);
  }, [t]);


  // Если пользователь вручную выбрал модель в "Моделях OpenRouter" —
  // онлайн-модель приложения (имя/контекст в UI, id, отправляемый в API)
  // отражает этот выбор. Иначе — модель по умолчанию (ONLINE_MODEL).
  // Кастомный override: если пользователь правил id/имя слота каталога,
  // ищем по исходному id или по кастомному id.
  const overrideEntries = (Object.entries(openRouterModelOverrides || {}) as Array<[string, { id: string; name: string } | null | undefined]>)
    .filter((e): e is [string, { id: string; name: string }] =>
      Boolean(e[1] && typeof e[1] === "object" && typeof (e[1] as { id?: unknown }).id === "string")
    );
  const overrideEntry = overrideEntries.find(
    ([baseId, o]) => baseId === openRouterModelId || o?.id === openRouterModelId
  );
  const selectedOpenRouterModel =
    FREE_OPENROUTER_MODELS.find((m) => m.id === openRouterModelId) ||
    (overrideEntry
      ? FREE_OPENROUTER_MODELS.find((m) => m.id === overrideEntry[0]) || null
      : null);

  const onlineModel: OnlineModelState = {
    id: overrideEntry?.[1]?.id || selectedOpenRouterModel?.id || openRouterModelId || ONLINE_MODEL.id,
    name: overrideEntry?.[1]?.name || selectedOpenRouterModel?.name || ONLINE_MODEL.name,
    provider: ONLINE_MODEL.provider,
    contextLength: selectedOpenRouterModel?.contextLength || ONLINE_MODEL.contextLength,
    hasApiKey: onlineHasApiKey,
  };

  return {
    model,
    downloadModel,
    cancelDownload,
    deleteModel,
    importModel,
    importMmproj,
    exportModel,
    exportMmproj,
    loadModel,
    unloadModel,
    packs,
    downloadPack,
    downloadAllPacks,
    refreshPackInstallation,
    refreshPackTools,
    installTool,
    removeTool,
    toolHealthByPack,
    toolDiagByPack,
    packDiagnostics,
    setPackRecovering,
    cancelPackDownload,
    deletePack,

    // Режим local/online
    mode,
    setMode,
    ...manusSettings,

    // Автоопределение параметров телефона
    deviceProfile,
    recommended,

    // Ручные/авто параметры офлайн-модели
    localParams,
    localParamsAuto,
    setLocalParams,
    resetLocalParamsToAuto,
    applyOptimalLocalSettings,
    localGenParams,
    setLocalGenParams,

    // Онлайн-модель (OpenRouter)
    onlineModel,
    onlineApiKeyLoaded,
    setOnlineApiKey,
    customProvider,
    customProvider1,
    customProvider2,
    activeCustomSlot,
    setActiveCustomSlot,
    setCustomProviderSlot,
    setCustomProvider,
    openCode,
    setOpenCode,
    onlineGenParams,
    setOnlineGenParams,

    // Список бесплатных моделей OpenRouter + выбор конкретной модели
    // (Настройки → "Модели OpenRouter")
    openRouterModelId,
    setOpenRouterModel,
    openRouterModelOverrides,
    saveOpenRouterModelOverride,
    localModelOverride,
    setLocalModelOverride,
    openRouterModelStatus,
    openRouterModelsCheckedAt,
    checkingOpenRouterModels,
    checkOpenRouterModelsNow,

    // Глобальный системный промт (Настройки → "Системный промт")
    systemPrompt,
    setSystemPrompt,
    clearSystemPrompt,
    // Промпт Termux-агента (Настройки Termux) — только agent path
    termuxAgentPrompt,
    setTermuxAgentPrompt,
    clearTermuxAgentPrompt,
    agentShellBackend,
    setAgentShellBackend,
    agentShellExecutionTarget,
    setAgentShellExecutionTarget,
    agentIntelligence,
    setAgentIntelligence,
  };
}
