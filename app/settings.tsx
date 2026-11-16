import { useCallback, useEffect, useState } from "react";
// ReactNode for SettingsGroup
import type { ReactNode } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, TextInput, Platform, PermissionsAndroid, Linking, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { applyAgentPreset, resetAgentPreset, AGENT_PRESETS, getActiveAgentPresetId, type AgentPresetId } from "../lib/agent-presets";
import { loadPluginState, setPluginSafeMode, listActivePluginSkills } from "../lib/aib-plugins";
import { describeBackupVsSecrets } from "../lib/backup-secrets-policy";
import { loadLanBridgeConfig, setLanBridgeEnabled } from "../lib/lan-status-bridge";
import { getSecurityPolicySummary } from "../lib/security-policy";
import {
  loadStatusOverlayEnabled,
  saveStatusOverlayEnabled,
} from "../components/RuntimeStatusOverlay";
import { useAppSettingsContext } from "../components/AppSettingsContext";
import { useLoggerContext } from "../components/LoggerContext";
import { useDialog } from "../components/DialogContext";
import { useLanguage } from "../components/LanguageContext";
import { errorMessage } from "../lib/error-utils";
import { redactSecrets } from "../lib/log-redaction";
import { checkTermuxReadiness, isNativeModuleAvailable } from "../lib/termux-bridge";
import { loadEnvironmentBackend } from "../lib/environment-manager";
import {
  getNativePriorityMode,
  loadNativePriorityMode,
  nativePriorityLabel,
  saveNativePriorityMode,
  type NativePriorityMode,
} from "../lib/native-priority";
import {
  isDesktopMode,
  loadDesktopMode,
  saveDesktopMode,
  getDesktopContentStyle,
} from "../lib/appearance-prefs";
// getDesktopContentStyle used for wide layout
import { getRuntimeFacade } from "../lib/runtime-facade";

import { useTheme } from "../components/ThemeContext";
import {
  expandedHeaderStyle,
  expandedTitleColor,
  expandedIconColors,
  expandedBodyStyle,
  expandedContentPaddingLeft,
  expandedIconChipStyle,
  expandedIconChipInnerStyle,
} from "../lib/ui-expanded-highlight";
import { ProgressBar } from "../components/ProgressBar";
import { Checkbox } from "../components/Checkbox";
import { NumberField } from "../components/NumberField";
import { SystemPromptDialog } from "../components/SystemPromptDialog";
import { OpenRouterModelsDialog } from "../components/OpenRouterModelsDialog";
import { CustomProviderDialog } from "../components/CustomProviderDialog";
import { OpenCodeModelsDialog } from "../components/OpenCodeModelsDialog";
import { ManusProviderCard } from "../components/ManusProviderCard";
import { validateOpenRouterApiKey } from "../lib/online-model";
import { classifyProviderTransportFailure, providerProbeMessageKey, providerProbeTone, type ProviderProbeStatus } from "../lib/provider-probe-status";
import { formatFileSize, formatSpeed } from "../lib/text-file";
import type { AppLanguage } from "../lib/i18n";
import type { AgentIntelligenceSettings } from "../lib/agent-intelligence";
import { ensureBackgroundSurvival, openAppDetailsSettings, requestUnrestrictedData } from "../lib/background-survival";
import {
  loadVoiceSettings,
  saveVoiceSettings,
  DEFAULT_VOICE_SETTINGS,
  type VoiceSettings,
} from "../lib/voice-runtime";

type AgentIntelOption = {
  key: keyof AgentIntelligenceSettings;
  icon: string;
  title: Record<AppLanguage, string>;
  desc: Record<AppLanguage, string>;
};

/** Справка «Интеллект агента»: имя + зачем нужно (понятным языком). */
const AGENT_INTELLIGENCE_OPTIONS: AgentIntelOption[] = [
  {
    key: "memory",
    icon: "🧠",
    title: { ru: "Память проекта", uk: "Памʼять проєкту", en: "Project memory" },
    desc: {
      ru: "Запоминает факты и уроки по текущему проекту между сообщениями, чтобы агент не начинал «с нуля» каждый раз.",
      uk: "Памʼятає факти й уроки поточної проєкту між повідомленнями, щоб агент не починав «з нуля» щоразу.",
      en: "Remembers facts and lessons about the current project across messages so the agent does not start from scratch every time.",
    },
  },
  {
    key: "hashline",
    icon: "🔐",
    title: { ru: "Безопасные правки файлов", uk: "Безпечні правки файлів", en: "Safe file edits" },
    desc: {
      ru: "Меняет код только через проверку версии строки. Снижает риск затереть чужие правки или испортить файл «вслепую».",
      uk: "Змінює код лише з перевіркою версії рядка. Зменшує ризик затерти чужі правки або зіпсувати файл «наосліп».",
      en: "Edits code only after verifying line versions. Lowers the risk of overwriting changes or corrupting a file blindly.",
    },
  },
  {
    key: "subagents",
    icon: "👥",
    title: { ru: "Помощники-субагенты", uk: "Помічники-субагенти", en: "Helper subagents" },
    desc: {
      ru: "Перед сложной задачей несколько «помощников» (архитектура, безопасность, сборка, UI) коротко осматривают проект. Тратит доп. запросы к модели.",
      uk: "Перед складною задачею кілька «помічників» (архітектура, безпека, збірка, UI) коротко оглядають проєкт. Витрачає додаткові запити до моделі.",
      en: "Before a hard task, helper roles (architecture, security, build, UI) briefly inspect the project. Uses extra model requests.",
    },
  },
  {
    key: "reviewer",
    icon: "🧪",
    title: { ru: "Ревьюер (проверка после)", uk: "Ревʼюер (перевірка після)", en: "Reviewer (after task)" },
    desc: {
      ru: "После задачи ещё раз просматривает результат и пишет замечания. Нужен вместе с «Автопроверкой после задачи». Тратит запросы.",
      uk: "Після задачі ще раз переглядає результат і пише зауваження. Потрібен разом із «Автоперевіркою після задачі». Витрачає запити.",
      en: "After a task, reviews the result and notes issues. Works with “Review after task”. Uses model requests.",
    },
  },
  {
    key: "advisor",
    icon: "👁️",
    title: { ru: "Советник (контроль по ходу)", uk: "Радник (контроль під час роботи)", en: "Advisor (watchdog)" },
    desc: {
      ru: "Периодически во время работы агента проверяет, нет ли риска или тупика. Доп. вызовы модели — на free-лимитах лучше выключить.",
      uk: "Періодично під час роботи агента перевіряє, чи немає ризику або тупика. Додаткові виклики моделі — на free-лімітах краще вимкнути.",
      en: "During the agent run, periodically checks for risks or dead ends. Extra model calls — better off on free-tier limits.",
    },
  },
  {
    key: "ast",
    icon: "🌳",
    title: { ru: "Умный разбор кода (AST)", uk: "Розумний розбір коду (AST)", en: "Smart code parse (AST)" },
    desc: {
      ru: "Позволяет агенту точнее искать и править структуру кода (функции, классы), а не только «текст как есть».",
      uk: "Допомагає агенту точніше шукати й правити структуру коду (функції, класи), а не лише «текст як є».",
      en: "Helps the agent find and edit code structure (functions, classes) more precisely than plain text search.",
    },
  },
  {
    key: "lsp",
    icon: "🔎",
    title: { ru: "Проверка TypeScript (LSP)", uk: "Перевірка TypeScript (LSP)", en: "TypeScript checks (LSP)" },
    desc: {
      ru: "Подтягивает ошибки типов и подсказки по TypeScript-проектам (если в Termux есть tsc / language server).",
      uk: "Підтягує помилки типів і підказки для TypeScript-проєктів (якщо в Termux є tsc / language server).",
      en: "Pulls type errors and hints for TypeScript projects (when tsc / a language server is available in Termux).",
    },
  },
  {
    key: "github",
    icon: "🐙",
    title: { ru: "Работа с GitHub", uk: "Робота з GitHub", en: "GitHub tools" },
    desc: {
      ru: "Читает файлы, дерево репозитория, PR и issues с GitHub, когда задача про удалённый код (нужен интернет).",
      uk: "Читає файли, дерево репозиторію, PR і issues з GitHub, коли задача про віддалений код (потрібен інтернет).",
      en: "Reads files, repo tree, PRs and issues from GitHub when the task is about remote code (needs internet).",
    },
  },
  {
    key: "streamRules",
    icon: "🛡️",
    title: { ru: "Фильтр ответов модели", uk: "Фільтр відповідей моделі", en: "Reply filter" },
    desc: {
      ru: "Отсекает мусорные или опасные ответы модели по правилам, чтобы агент меньше «галлюцинировал» успех.",
      uk: "Відсікає сміттєві або небезпечні відповіді моделі за правилами, щоб агент менше «галюцинував» успіх.",
      en: "Filters junk or unsafe model replies by rules so the agent claims success less often without evidence.",
    },
  },
  {
    key: "autoPreflight",
    icon: "🚦",
    title: { ru: "Автопроверка перед задачей", uk: "Автоперевірка перед задачею", en: "Check before task" },
    desc: {
      ru: "Перед стартом собирает контекст (память, субагенты). Улучшает качество, но тратит лишние запросы — на free выключайте.",
      uk: "Перед стартом збирає контекст (памʼять, субагенти). Покращує якість, але витрачає зайві запити — на free вимикайте.",
      en: "Before starting, gathers context (memory, subagents). Improves quality but uses extra requests — turn off on free tier.",
    },
  },
  {
    key: "autoPostReview",
    icon: "✅",
    title: { ru: "Автопроверка после задачи", uk: "Автоперевірка після задачі", en: "Check after task" },
    desc: {
      ru: "После выполнения запускает ревью результата. Полезно для сложных правок; на free-лимитах лучше выключить.",
      uk: "Після виконання запускає ревʼю результату. Корисно для складних правок; на free-лімітах краще вимкнути.",
      en: "After the task, runs a result review. Useful for complex edits; turn off on free-tier limits.",
    },
  },
];

/** Collapsible settings group (accordion header + body). */
function SettingsGroup({
  title,
  icon,
  expanded,
  onToggle,
  colors,
  children,
}: {
  title: string;
  /** Ionicons glyph name shown in the section header. */
  icon?: keyof typeof Ionicons.glyphMap;
  expanded: boolean;
  onToggle: () => void;
  colors: { inkBright: string; muted: string; line: string; surface: string; accent: string; accentDim: string };
  children: ReactNode;
}) {
  const head = expandedHeaderStyle(expanded, colors);
  const icons = expandedIconColors(expanded, colors);
  const bodyExtra = expandedBodyStyle(expanded);
  const padL = expandedContentPaddingLeft(expanded, 12);

  return (
    <View style={{ marginBottom: 6 }}>
      <TouchableOpacity
        onPress={onToggle}
        activeOpacity={0.72}
        accessibilityState={{ expanded }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: 12,
          paddingLeft: padL,
          paddingRight: 12,
          borderRadius: 14,
          ...(head as object),
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", flex: 1, paddingRight: 8, gap: 10 }}>
          {icon ? (
            <View style={expandedIconChipStyle(expanded, colors, 36) as object}>
              <View style={expandedIconChipInnerStyle(colors, 36) as object}>
                <Ionicons name={icon} size={20} color={icons.fg} />
              </View>
            </View>
          ) : null}
          <Text style={{ color: expandedTitleColor(expanded, colors.inkBright), fontSize: 15, fontWeight: "700", flex: 1 }} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={20}
          color={icons.chevron}
        />
      </TouchableOpacity>
      {expanded ? (
        <View
          style={{
            gap: 10,
            paddingTop: 10,
            paddingBottom: 4,
            ...(bodyExtra as object),
          }}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { logInfo, logError } = useLoggerContext();
  const { showDialog } = useDialog();
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const {
    model, downloadModel, cancelDownload, deleteModel, importModel, importMmproj, exportModel, exportMmproj, loadModel, unloadModel,
    mode, setMode, manus, saveManusKey, setManusProfile, removeManusKey,
    deviceProfile, recommended,
    localParams, localParamsAuto, setLocalParams, resetLocalParamsToAuto,
    localGenParams, setLocalGenParams,
    onlineModel, onlineApiKeyLoaded, setOnlineApiKey,
    customProvider1, customProvider2, activeCustomSlot, setActiveCustomSlot, setCustomProviderSlot,
    openCode, setOpenCode,
    openRouterModelId, setOpenRouterModel, onlineGenParams, setOnlineGenParams,
    openRouterModelStatus, openRouterModelsCheckedAt, checkingOpenRouterModels, checkOpenRouterModelsNow,
    openRouterModelOverrides, saveOpenRouterModelOverride,
    localModelOverride, setLocalModelOverride,
    systemPrompt, setSystemPrompt, clearSystemPrompt,
    agentIntelligence,
    agentShellBackend,
    agentShellExecutionTarget,
    setAgentShellBackend, setAgentIntelligence,
  } = useAppSettingsContext();

  const [systemPromptDialogVisible, setSystemPromptDialogVisible] = useState(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    void loadEnvironmentBackend().then((backend) => {
      if (active && typeof setAgentShellBackend === "function") setAgentShellBackend(backend);
    }).catch(() => {});
    return () => { active = false; };
  }, [setAgentShellBackend]));
  const [activeAgentPreset, setActiveAgentPreset] = useState<AgentPresetId | null>(null);
  useFocusEffect(useCallback(() => {
    let alive = true;
    void getActiveAgentPresetId().then((id) => { if (alive) setActiveAgentPreset(id); }).catch(() => {});
    return () => { alive = false; };
  }, []));

  const [openRouterDialogVisible, setOpenRouterDialogVisible] = useState(false);
  const [custom1DialogVisible, setCustom1DialogVisible] = useState(false);
  const [custom2DialogVisible, setCustom2DialogVisible] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [packsBridgeOk, setPacksBridgeOk] = useState(false);
  const [packsReady, setPacksReady] = useState(false);
  const [statusOverlayEnabled, setStatusOverlayEnabled] = useState(false);
  const [nativePriority, setNativePriority] = useState<NativePriorityMode>("auto");
  const [desktopMode, setDesktopModeState] = useState(false);
  const [lanBridgeEnabled, setLanBridgeEnabledState] = useState(false);
  const [pluginSafeMode, setPluginSafeModeState] = useState(true);
  const [deviceGrantedCapabilities, setDeviceGrantedCapabilities] = useState<string[]>([]);
  const [devicePolicyNotice, setDevicePolicyNotice] = useState("");
  const refreshDeviceGrants = useCallback(() => {
    try {
      const facade = getRuntimeFacade() as {
        getGrantedDeviceCapabilities?: () => readonly string[];
      };
      const list = typeof facade.getGrantedDeviceCapabilities === "function"
        ? facade.getGrantedDeviceCapabilities()
        : [];
      setDeviceGrantedCapabilities(Array.isArray(list) ? [...list] : []);
    } catch {
      setDeviceGrantedCapabilities([]);
    }
  }, []);
  useFocusEffect(useCallback(() => { refreshDeviceGrants(); }, [refreshDeviceGrants]));

  const changeDeviceGrant = useCallback(async (capability: "device.accessibility" | "device.adb" | "device.virtualdisplay" | "device.metadata.read" | "device.sensors.read", grant: boolean) => {
    try {
      const facade = getRuntimeFacade() as {
        grantDeviceCapabilityByUser?: (c: typeof capability) => void;
        revokeDeviceCapabilityByUser?: (c: typeof capability) => Promise<void>;
      };
      if (grant) {
        if (typeof facade.grantDeviceCapabilityByUser !== "function") {
          throw new Error("grantDeviceCapabilityByUser unavailable");
        }
        facade.grantDeviceCapabilityByUser(capability);
      } else {
        if (typeof facade.revokeDeviceCapabilityByUser !== "function") {
          throw new Error("revokeDeviceCapabilityByUser unavailable");
        }
        await facade.revokeDeviceCapabilityByUser(capability);
      }
      setDevicePolicyNotice(grant ? "Grant enabled for this app session." : "Grant revoked.");
      refreshDeviceGrants();
    } catch {
      setDevicePolicyNotice("Unable to change the device grant; access remains denied.");
      refreshDeviceGrants();
    }
  }, [refreshDeviceGrants]);

  useEffect(() => {
    void loadStatusOverlayEnabled().then(setStatusOverlayEnabled);
    void loadLanBridgeConfig().then((cfg) => setLanBridgeEnabledState(!!cfg.enabled));
    void loadPluginState().then((s) => setPluginSafeModeState(!!s.safeMode));
  }, []);

  const refreshPackReadinessState = useCallback(async () => {
    setPacksBridgeOk(isNativeModuleAvailable());
    try {
      const r = await checkTermuxReadiness({ deep: true, refreshPermission: true });
      setPacksReady(r.ready);
    } catch {
      setPacksReady(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshPackReadinessState();
    }, [refreshPackReadinessState])
  );


  useEffect(() => {
    loadVoiceSettings().then(setVoiceSettings);
  }, []);

  useEffect(() => {
    void loadNativePriorityMode().then(setNativePriority);
    void loadDesktopMode().then(setDesktopModeState);
  }, []);

  const updateVoiceSettings = (partial: Partial<VoiceSettings>) => {
    setVoiceSettings((prev) => {
      const next = { ...prev, ...partial };
      saveVoiceSettings(next);
      return next;
    });
  };
  const [custom1Draft, setCustom1Draft] = useState({
    name: "", baseUrl: "", modelId: "", extraHeadersJson: "", chatPath: "/chat/completions", apiKey: "",
  });
  const [custom2Draft, setCustom2Draft] = useState({
    name: "", baseUrl: "", modelId: "", extraHeadersJson: "", chatPath: "/chat/completions", apiKey: "",
  });
  const [openCodeDraft, setOpenCodeDraft] = useState({
    // ИСПРАВЛЕНО: api.opencode.ai не существует — реальный шлюз OpenCode Zen
    // находится на https://opencode.ai/zen/v1 (см. lib/custom-provider.ts).
    baseUrl: "https://opencode.ai/zen/v1",
    modelId: "",
    apiKey: "",
  });
  const [openCodeDialogVisible, setOpenCodeDialogVisible] = useState(false);
  useEffect(() => {
    setCustom1Draft({
      name: customProvider1.name || "", baseUrl: customProvider1.baseUrl || "", modelId: customProvider1.modelId || "",
      extraHeadersJson: customProvider1.extraHeadersJson || "", chatPath: customProvider1.chatPath || "/chat/completions", apiKey: "",
    });
  }, [customProvider1.name, customProvider1.baseUrl, customProvider1.modelId, customProvider1.extraHeadersJson, customProvider1.chatPath]);
  useEffect(() => {
    setCustom2Draft({
      name: customProvider2.name || "", baseUrl: customProvider2.baseUrl || "", modelId: customProvider2.modelId || "",
      extraHeadersJson: customProvider2.extraHeadersJson || "", chatPath: customProvider2.chatPath || "/chat/completions", apiKey: "",
    });
  }, [customProvider2.name, customProvider2.baseUrl, customProvider2.modelId, customProvider2.extraHeadersJson, customProvider2.chatPath]);
  useEffect(() => {
    if (openCode) {
      setOpenCodeDraft({
        baseUrl: openCode.baseUrl || "https://opencode.ai/zen/v1",
        modelId: openCode.modelId || "",
        apiKey: "",
      });
    }
  }, [openCode?.baseUrl, openCode?.modelId]);

  const [offlineEditOpen, setOfflineEditOpen] = useState(false);
  /** Accordion groups on Settings screen — only one "level" of structure. */
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    device: false,
    agent: false,
    offline: false,
    online: false,
    voice: false,
    security: false,
    background: false,
    network: false,
    interface: false,
    about: false,
  });
  const toggleSection = useCallback((key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const [offlineNameDraft, setOfflineNameDraft] = useState("");
  const [offlineUrlDraft, setOfflineUrlDraft] = useState("");

  const localModelSizeLabel = t("localModelSizeLabel", {
    total: formatFileSize(model.llmBytes + model.mmprojBytes, language),
    llm: formatFileSize(model.llmBytes, language),
    vision: formatFileSize(model.mmprojBytes, language),
  });
  const localModelDescription =
    /coder|0\.5b|1\.5b|imported|q3_k|q2_k/i.test(model.name) ||
    (model.llmBytes > 0 && model.llmBytes < 1_200_000_000)
      ? ({
          ru: `Импорт GGUF с диска: «${model.name}». Имя и квантизация определены по файлу. Загрузите в память перед чатом.`,
          uk: `Імпорт GGUF: «${model.name}». Ім'я/квантизація з файлу.`,
          en: `Imported GGUF: "${model.name}". Name/quant from filename. Load into memory before chat.`,
        } as const)[language]
      : t("localModelDescription");
  const onlineModelDescription = t("onlineModelDescription");
  const onlineModelContextLabel = t("onlineModelContextLabel", {
    tokens: onlineModel.contextLength.toLocaleString(
      language === "en" ? "en-US" : language === "ru" ? "ru-RU" : "uk-UA"
    ),
  });

  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyDraftDirty, setApiKeyDraftDirty] = useState(false);
  const [checkingApiKey, setCheckingApiKey] = useState(false);
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [apiKeyCheckResult, setApiKeyCheckResult] = useState<{ status: ProviderProbeStatus; valid: boolean | null; message: string } | null>(null);

  useEffect(() => {
    if (!apiKeyDraftDirty) setApiKeyDraft("");
  }, [onlineModel.hasApiKey, apiKeyDraftDirty]);

  const handleDownloadModel = async () => {
    // Загрузка выполняется в sandbox/cache приложения; широкое storage
    // permission для неё не требуется.
    if (model.downloading || model.loading) {
      logInfo("Settings", "Download already in progress — ignore extra taps");
      return;
    }
    logInfo("Settings", `${t("downloadModel")}: ${model.name}`);
    const ok = await downloadModel();
    if (ok) {
      logInfo("Settings", t("modelDownloadedOk") || "Модель скачана на диск. Нажмите «Загрузить в память».");
    } else {
      logInfo(
        "Settings",
        (t("modelDownloadFailedLog") || "Скачивание модели не удалось") +
          (model.error ? `: ${model.error}` : " — см. ошибку на экране / лог Settings")
      );
    }
  };

  const handleCancelDownload = () => {
    cancelDownload();
    logInfo("Settings", t("downloadCancelled"));
  };

  const handleDeleteModel = () => {
    showDialog(t("deleteModelTitle"), t("deleteModelConfirm", { name: model.name, size: localModelSizeLabel }), [
      { text: t("cancel"), style: "cancel" },
      { text: t("delete"), style: "destructive", onPress: () => {
        deleteModel();
        logInfo("Settings", t("modelDeleted"));
      }},
    ]);
  };

  const handleImportModel = async () => {
    if (model.downloading || model.importing) return;
    logInfo("Settings", t("importModel"));
    const ok = await importModel();
    if (ok) {
      logInfo("Settings", t("modelImportedOk"));
    } else if (!model.error) {
      logInfo("Settings", t("modelImportCancelled"));
    } else {
      logInfo("Settings", `${t("importModel")}: ${model.error}`);
    }
  };

  const handleImportMmproj = async () => {
    if (model.downloading || model.importing) return;
    logInfo("Settings", t("importMmproj"));
    const ok = await importMmproj();
    if (ok) {
      logInfo("Settings", t("modelMmprojImportedOk"));
    } else if (!model.error) {
      logInfo("Settings", t("modelImportCancelled"));
    } else {
      logInfo("Settings", `${t("importMmproj")}: ${model.error}`);
    }
  };

  const handleExportModel = async () => {
    if (model.exporting) return;
    logInfo("Settings", t("exportModel"));
    const ok = await exportModel();
    if (ok) {
      logInfo("Settings", t("modelExportedOk"));
    } else if (model.error) {
      logInfo("Settings", `${t("exportModel")}: ${model.error}`);
    }
  };

  const handleExportMmproj = async () => {
    if (model.exporting) return;
    logInfo("Settings", t("exportMmproj"));
    const ok = await exportMmproj();
    if (ok) {
      logInfo("Settings", t("modelMmprojExportedOk"));
    } else if (model.error) {
      logInfo("Settings", `${t("exportMmproj")}: ${model.error}`);
    }
  };

  const handleLoadModel = async () => {
    if (model.loading || model.downloading) {
      logInfo("Settings", "Load already in progress — ignore extra taps");
      return;
    }
    logInfo("Settings", t("loadToMemory"));
    const ok = await loadModel();
    if (ok) {
      logInfo("Settings", t("modelLoaded"));
    } else {
      logInfo("Settings", t("modelLoadFailedLog") || "Загрузка модели в память не удалась — см. ошибку на экране.");
    }
  };

  const handleUnloadModel = async () => {
    await unloadModel();
    logInfo("Settings", t("modelUnloaded"));
  };

  const handleSaveApiKey = async () => {
    if (!onlineApiKeyLoaded || savingApiKey || checkingApiKey) return;
    const key = apiKeyDraft.trim();
    if (!key) {
      setApiKeyCheckResult({ status: "empty_key", valid: null, message: t("apiKeyEmpty") });
      return;
    }
    setSavingApiKey(true);
    try {
      const persisted = await setOnlineApiKey(key);
      if (!persisted) {
        setApiKeyCheckResult({ status: "storage_error", valid: null, message: t("secureKeySaveFailed") });
        logError("Settings", "Secure API-key persistence/read-back failed; provider remains unchanged");
        return;
      }
      setApiKeyDraft("");
      setApiKeyDraftDirty(false);
      setApiKeyCheckResult(null);
      logInfo("Settings", t("saveKeySuccess"));
    } catch {
      setApiKeyCheckResult({ status: "storage_error", valid: null, message: t("secureKeySaveFailed") });
      logError("Settings", "Secure API-key persistence/read-back failed");
    } finally {
      setSavingApiKey(false);
    }
  };

  const handleCheckApiKey = async () => {
    if (savingApiKey || checkingApiKey) return;
    const key = apiKeyDraft.trim();
    if (!key && !onlineModel.hasApiKey) {
      setApiKeyCheckResult({ status: "empty_key", valid: null, message: t("apiKeyEmpty") });
      return;
    }
    setCheckingApiKey(true);
    setApiKeyCheckResult(null);
    try {
      try {
        const result = key ? await validateOpenRouterApiKey(key) : await validateOpenRouterApiKey();
        const baseMessage = t(providerProbeMessageKey(result.status));
        setApiKeyCheckResult({
          status: result.status,
          valid: result.valid,
          message: result.retryAfterMs ? `${baseMessage} · ${Math.ceil(result.retryAfterMs / 1000)}s` : baseMessage,
        });
        logInfo("Settings", `OpenRouter key check: ${result.status}`);
      } catch {
        const status = classifyProviderTransportFailure(false);
        setApiKeyCheckResult({ status, valid: null, message: t(providerProbeMessageKey(status)) });
        logError("Settings", "OpenRouter key check failed without a classified HTTP response");
      }
    } finally {
      setCheckingApiKey(false);
    }
  };

  const handleSaveSystemPrompt = (next: string) => {
    setSystemPrompt(next.trim());
    logInfo("Settings", t("logSystemPromptSaved"));
  };

  const handleClearSystemPrompt = () => {
    clearSystemPrompt();
    logInfo("Settings", t("logSystemPromptCleared"));
  };

  const handleSelectOpenRouterModel = (id: string) => {
    setOpenRouterModel(id);
    logInfo("Settings", `${t("logOpenRouterModelChanged")} ${id}`);
  };

  const progressSublabel = model.downloading
    ? `${formatFileSize(model.bytesWrittenOverall, language)} / ${formatFileSize(model.totalBytesOverall, language)}` +
      (model.speedBytesPerSec > 0 ? ` · ${formatSpeed(model.speedBytesPerSec, language)}` : "") +
      (model.stage === "llm" ? ` · ${t("modelFile")}` : ` · ${t("visionModule")}`)
    : undefined;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView key={desktopMode ? "desktop" : "mobile"} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, getDesktopContentStyle({ paddingBottom: 32 + insets.bottom })]}>

        <SettingsGroup
          title={t("phoneParams")}
          icon="phone-portrait-outline"
          expanded={!!openSections.device}
          onToggle={() => toggleSection("device")}
          colors={colors}
        >
        <View style={[styles.deviceCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="hardware-chip-outline" size={21} color={colors.accent} />
            </View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>{t("phoneParams")}</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]}>{t("determiningPhone")}</Text>
            </View>
          </View>
          {deviceProfile ? (
            <>
              <Text style={[styles.deviceLine, { color: colors.inkBright }]}>
                {deviceProfile.modelName || t("unknownModel")}
                {deviceProfile.manufacturer ? ` (${deviceProfile.manufacturer})` : ""}
              </Text>
              <Text style={[styles.deviceLine, { color: colors.inkBright }]}>
                {t("ram")}: {deviceProfile.totalMemoryGB ? `≈${deviceProfile.totalMemoryGB.toFixed(1)} ${t("gb")}` : t("notDetermined")}
                {deviceProfile.osVersion ? ` · ${t("os")} ${deviceProfile.osVersion}` : ""}
              </Text>
              {!deviceProfile.isArm64Compatible && (
                <Text style={[styles.warnText, { color: colors.warning }]}>{t("arm64Warning")}</Text>
              )}
              {recommended && <Text style={styles.deviceNote}>{t(recommended.noteKey, recommended.noteParams)}</Text>}
            </>
          ) : (
            <Text style={[styles.deviceLine, { color: colors.inkBright }]}>{t("determiningPhone")}</Text>
          )}
        </View>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={[styles.modelName, { color: colors.inkBright }]}>
            {{ ru: "Доступ к устройству", uk: "Доступ до пристрою", en: "Device access grants" }[language]}
          </Text>
          <Text style={[styles.modelMeta, { color: colors.muted, marginBottom: 8 }]}>
            {{ ru: "Каждое разрешение выдаётся отдельно только на текущий сеанс приложения. Агент всё равно проходит проверку этой политики перед каждым действием.", uk: "Кожен дозвіл надається окремо лише на поточний сеанс застосунку. Агент проходить перевірку цієї політики перед кожною дією.", en: "Each capability is granted separately for this app session only. The agent is still checked against this policy before every action." }[language]}
          </Text>
          {devicePolicyNotice ? <Text style={[styles.modelMeta, { color: colors.accent, marginBottom: 8 }]}>{devicePolicyNotice}</Text> : null}
          {([
            { capability: "device.accessibility", title: { ru: "Доступность и действия на экране", uk: "Спеціальні можливості та дії на екрані", en: "Accessibility and screen actions" } },
            { capability: "device.adb", title: { ru: "Беспроводной ADB", uk: "Бездротовий ADB", en: "Wireless ADB" } },
            { capability: "device.virtualdisplay", title: { ru: "Виртуальный дисплей", uk: "Віртуальний дисплей", en: "Virtual display" } },
            { capability: "device.metadata.read", title: { ru: "Только модель и версия Android", uk: "Лише модель і версія Android", en: "Model and Android-version metadata only" } },
            { capability: "device.sensors.read", title: { ru: "Только данные батареи", uk: "Лише дані батареї", en: "Battery sensor only" } },
          ] as const).map((row) => {
            const granted = deviceGrantedCapabilities.includes(row.capability);
            return (
              <View key={row.capability} style={{ marginTop: 8 }}>
                <Text style={[styles.modelDesc, { color: colors.inkBright, marginBottom: 5 }]}>{row.title[language]} — {granted ? (language === "ru" ? "разрешено" : language === "uk" ? "дозволено" : "granted") : (language === "ru" ? "запрещено" : language === "uk" ? "заборонено" : "denied")}</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: colors.accentDim, flex: 1 }]} onPress={() => void changeDeviceGrant(row.capability, true)}>
                    <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{language === "ru" ? "Разрешить" : language === "uk" ? "Дозволити" : "Grant"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: colors.accentDim, flex: 1 }]} onPress={() => void changeDeviceGrant(row.capability, false)}>
                    <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{language === "ru" ? "Отозвать" : language === "uk" ? "Відкликати" : "Revoke"}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </View>
        </SettingsGroup>

        <SettingsGroup
          title={{ ru: "Настройки агента", uk: "Налаштування агента", en: "Agent settings" }[language]}
          icon="hardware-chip-outline"
          expanded={!!openSections.agent}
          onToggle={() => toggleSection("agent")}
          colors={colors}
        >
        <Text style={[styles.section, { color: colors.muted, marginTop: 0 }]}>{t("systemPromptSection")}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="chatbox-ellipses-outline" size={21} color={colors.accent} />
            </View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>{t("systemPromptSection")}</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]}>{t("systemPromptSectionDesc")}</Text>
            </View>
          </View>
          <Text style={[styles.statusLine, { color: colors.muted }]}>
            {systemPrompt.trim()
              ? t("systemPromptSet", { count: systemPrompt.trim().length })
              : t("systemPromptNotSet")}
          </Text>
          <TouchableOpacity
            style={[styles.secondaryButton, { marginTop: 4, backgroundColor: colors.accentDim }]}
            onPress={() => setSystemPromptDialogVisible(true)}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("systemPromptButton")}</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{{ru:"Среда выполнения",uk:"Середовище виконання",en:"Runtime environment"}[language]}</Text>
        <View style={[styles.card, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}>
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="layers-outline" size={21} color={colors.accent} />
            </View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>{{ru:"Среда сборки и агента",uk:"Середовище збірки та агента",en:"Build and agent environment"}[language]}</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]}>{{
                ru: "Выбранная среда управляет сборкой, экраном пакетов и автоустановкой зависимостей, а также legacy-путями агента. Только команды TERMUX_RUN можно отдельно направить во встроенный private runtime на экране «Среда».",
                uk: "Вибране середовище керує збіркою, екраном пакетів, автоінсталяцією залежностей та legacy-шляхами агента. Лише команди TERMUX_RUN можна окремо спрямувати у вбудований private runtime на екрані «Середовище».",
                en: "The selected environment controls builds, the package screen, dependency auto-install and legacy agent paths. Only TERMUX_RUN commands can be separately routed to the embedded private runtime from the Environment screen.",
              }[language]}</Text>
            </View>
          </View>
          <View style={{ marginTop: 12, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
            <Text style={{ color: colors.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{{ru:"Активно",uk:"Активно",en:"Active"}[language]}</Text>
            <Text style={{ color: colors.inkBright, fontSize: 17, fontWeight: "800", marginTop: 3 }}>
              {agentShellBackend === "ubuntu-proot" ? "Ubuntu proot" : "Termux"}
            </Text>
          </View>
          <View style={{ marginTop: 10, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
            <Text style={{ color: colors.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>{{ru:"Цель TERMUX_RUN",uk:"Ціль TERMUX_RUN",en:"TERMUX_RUN target"}[language]}</Text>
            <Text style={{ color: colors.inkBright, fontSize: 15, fontWeight: "800", marginTop: 3 }}>
              {agentShellExecutionTarget === "embedded-private"
                ? (language === "ru" ? "Встроенная private (экспериментально)" : language === "uk" ? "Вбудована private (експериментально)" : "Embedded private (experimental)")
                : (language === "ru" ? "Выбранная среда" : language === "uk" ? "Вибране середовище" : "Selected environment")}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.secondaryButton, { marginTop: 10, backgroundColor: colors.accentDim }]}
            onPress={() => router.push("/runtime")}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{{ru:"Открыть управление средой",uk:"Відкрити керування середовищем",en:"Open Environment manager"}[language]}</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{t("nativePriorityTitle")}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={[styles.modelMeta, { color: colors.muted, marginBottom: 8 }]}>{t("nativePriorityHint")}</Text>
          {([
            { id: "auto" as const },
            { id: "prefer-termux" as const },
            { id: "force-proot" as const },
          ]).map((opt) => (
            <Checkbox
              key={opt.id}
              checked={nativePriority === opt.id}
              onPress={() => {
                setNativePriority(opt.id);
                void saveNativePriorityMode(opt.id);
              }}
              label={nativePriorityLabel(opt.id, language as "ru" | "uk" | "en")}
            />
          ))}
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{{ru:"Внешний вид",uk:"Зовнішній вигляд",en:"Appearance"}[language]}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Checkbox
            checked={desktopMode}
            onPress={() => {
              const next = !desktopMode;
              setDesktopModeState(next);
              void saveDesktopMode(next);
            }}
            label={t("desktopModeLabel")}
            description={t("desktopModeHint")}
          />
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{{ru:"Интеллект агента",uk:"Інтелект агента",en:"Agent intelligence"}[language]}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="sparkles-outline" size={21} color={colors.accent} />
            </View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>{{ru:"Интеллект агента",uk:"Інтелект агента",en:"Agent intelligence"}[language]}</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]}>{{
                ru: "Дополнительные «умения» агента во встроенной среде. Включайте по необходимости: часть пунктов тратит лишние запросы к модели (на free лучше выключить).",
                uk: "Додаткові «вміння» агента у вбудованому середовищі. Вмикайте за потреби: частина пунктів витрачає зайві запити до моделі (на free краще вимкнути).",
                en: "Extra embedded-runtime agent abilities. Enable as needed: some options use extra model requests (better off on free tier).",
              }[language]}</Text>
            </View>
          </View>
          {AGENT_INTELLIGENCE_OPTIONS.map((opt) => (
            <Checkbox
              key={opt.key}
              checked={!!agentIntelligence[opt.key]}
              onPress={() => setAgentIntelligence({ [opt.key]: !agentIntelligence[opt.key] })}
              label={`${opt.icon} ${opt.title[language]}`}
              description={opt.desc[language]}
            />
          ))}
        </View>

        </SettingsGroup>

        <SettingsGroup
          title={{ ru: "Офлайн-модель", uk: "Офлайн-модель", en: "Offline model" }[language]}
          icon="cube-outline"
          expanded={!!openSections.offline}
          onToggle={() => toggleSection("offline")}
          colors={colors}
        >
        <Text style={[styles.section, { color: colors.muted, marginTop: 0 }]}>{t("offlineModel")}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Checkbox
            checked={mode === "local"}
            onPress={() => setMode("local")}
            label={t("useAsActive")}
          />
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="phone-portrait-outline" size={21} color={colors.accent} />
            </View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>{model.name}</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]}>{localModelSizeLabel}</Text>
              <Text style={[styles.modelDesc, { color: colors.muted }]}>{localModelDescription}</Text>
            </View>
            <TouchableOpacity
              style={styles.editModelBtn}
              onPress={() => {
                setOfflineEditOpen((v) => !v);
                setOfflineNameDraft(localModelOverride?.name || model.name);
                setOfflineUrlDraft(localModelOverride?.llmUrl || "");
              }}
            >
              <Text style={styles.editModelBtnText}>{t("modelEdit")}</Text>
            </TouchableOpacity>
          </View>
          {offlineEditOpen && (
            <View style={styles.editModelPanel}>
              <Text style={styles.urlLabel}>{t("modelEditNameLabel")}</Text>
              <TextInput
                style={[styles.urlInput, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]}
                value={offlineNameDraft}
                onChangeText={setOfflineNameDraft}
                placeholder={model.name}
                placeholderTextColor="#9AA3AC"
              />
              <Text style={styles.urlLabel}>{t("modelEditUrlLabel")}</Text>
              <TextInput
                style={[styles.urlInput, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]}
                value={offlineUrlDraft}
                onChangeText={setOfflineUrlDraft}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://…/model.gguf"
                placeholderTextColor="#9AA3AC"
              />
              <TouchableOpacity
                style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]}
                onPress={() => {
                  setLocalModelOverride({
                    name: offlineNameDraft.trim() || model.name,
                    llmUrl: offlineUrlDraft.trim(),
                  });
                  setOfflineEditOpen(false);
                  logInfo("Settings", t("modelEditSavedLog"));
                }}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("modelEditSave")}</Text>
              </TouchableOpacity>
            </View>
          )}

          {model.error && <Text style={styles.errorText}>⚠ {model.error}</Text>}

          {model.downloading && (
            <ProgressBar
              progress={model.progress}
              label={`${t("downloadModel")} — ${model.progress}%`}
              sublabel={progressSublabel}
            />
          )}

          <View style={styles.modelActions}>
            {!model.downloaded && !model.downloading && (
              <TouchableOpacity style={[styles.primaryButton, { backgroundColor: "#2F4F4F" }]} onPress={handleDownloadModel}>
                <Text style={[styles.primaryButtonText, { color: "#FFFFFF" }]}>{t("downloadModel")}</Text>
              </TouchableOpacity>
            )}
            {model.downloading && (
              <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]} onPress={handleCancelDownload}>
                <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("cancelDownload")}</Text>
              </TouchableOpacity>
            )}
            {model.downloaded && !model.loaded && (
              <TouchableOpacity style={[styles.primaryButton, { backgroundColor: "#2F4F4F" }]} onPress={handleLoadModel} disabled={model.loading}>
                <Text style={[styles.primaryButtonText, { color: "#FFFFFF" }]}>{model.loading ? t("loadingToMemory") : t("loadToMemory")}</Text>
              </TouchableOpacity>
            )}
            {model.loaded && (
              <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]} onPress={handleUnloadModel}>
                <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("unloadFromMemory")}</Text>
              </TouchableOpacity>
            )}
            {/* Импорт / экспорт: две пары кнопок — основной GGUF и второй
                файл (mmproj/vision). Любая модель; второй файл лучше брать
                совместимым с первой. */}
            {!model.downloading && (
              <View style={styles.transferBlock}>
                <Text style={[styles.transferTitle, { color: colors.muted }]}>
                  {t("modelTransferTitle")}
                </Text>

                <TouchableOpacity
                  style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]}
                  onPress={handleImportModel}
                  disabled={model.importing}
                >
                  {model.importing && model.importingTarget === "llm" ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("importModel")}</Text>
                  )}
                </TouchableOpacity>
                <Text style={[styles.transferHint, { color: colors.muted }]}>
                  {t("importModelHint")}
                </Text>

                <TouchableOpacity
                  style={[styles.secondaryButton, { backgroundColor: colors.accentDim, marginTop: 8 }]}
                  onPress={handleImportMmproj}
                  disabled={model.importing}
                >
                  {model.importing && model.importingTarget === "mmproj" ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("importMmproj")}</Text>
                  )}
                </TouchableOpacity>
                <Text style={[styles.transferHint, { color: colors.muted }]}>
                  {t("importMmprojHint")}
                </Text>

                {model.downloaded && (
                  <>
                    <TouchableOpacity
                      style={[styles.secondaryButton, { backgroundColor: colors.accentDim, marginTop: 12 }]}
                      onPress={handleExportModel}
                      disabled={model.exporting}
                    >
                      {model.exporting && model.exportingTarget === "llm" ? (
                        <ActivityIndicator size="small" color={colors.accent} />
                      ) : (
                        <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("exportModel")}</Text>
                      )}
                    </TouchableOpacity>
                    <Text style={[styles.transferHint, { color: colors.muted }]}>
                      {t("exportModelHint")}
                    </Text>

                    <TouchableOpacity
                      style={[
                        styles.secondaryButton,
                        {
                          backgroundColor: colors.accentDim,
                          marginTop: 8,
                          opacity: model.mmprojBytes > 0 ? 1 : 0.55,
                        },
                      ]}
                      onPress={handleExportMmproj}
                      disabled={model.exporting || model.mmprojBytes <= 0}
                    >
                      {model.exporting && model.exportingTarget === "mmproj" ? (
                        <ActivityIndicator size="small" color={colors.accent} />
                      ) : (
                        <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("exportMmproj")}</Text>
                      )}
                    </TouchableOpacity>
                    <Text style={[styles.transferHint, { color: colors.muted }]}>
                      {t("exportMmprojHint")}
                    </Text>
                  </>
                )}
              </View>
            )}
            {model.downloaded && !model.downloading && (
              <TouchableOpacity
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: colors.dangerDim,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                  },
                ]}
                onPress={handleDeleteModel}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.danger }]}>
                  {t("deleteFromDisk")}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          <Text style={[styles.statusLine, { color: colors.muted }]}>
            {model.downloaded ? t("downloaded") : t("notDownloaded")}
            {" · "}
            {model.loaded ? t("inMemory") : t("notInMemory")}
          </Text>

          <View style={[styles.divider, { backgroundColor: colors.line }]} />
          <View style={styles.paramsHeader}>
            <Text style={styles.paramsTitle}>{t("modelParams")}</Text>
            <View style={styles.autoRow}>
              <Text style={styles.autoLabel}>{localParamsAuto ? t("autoByPhone") : t("manualMode")}</Text>
              {!localParamsAuto && (
                <TouchableOpacity onPress={resetLocalParamsToAuto}>
                  <Text style={styles.autoResetText}>{t("resetToAuto")}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <NumberField
            label={t("nCtx")}
            value={localParams.nCtx}
            step={512}
            min={512}
            max={8192}
            onChange={(v) => setLocalParams({ nCtx: v })}
          />
          <NumberField
            label={t("nThreads")}
            value={localParams.nThreads}
            step={1}
            min={1}
            max={12}
            onChange={(v) => setLocalParams({ nThreads: v })}
          />
          <NumberField
            label={t("nGpuLayers")}
            value={localParams.nGpuLayers}
            step={1}
            min={0}
            max={40}
            onChange={(v) => setLocalParams({ nGpuLayers: v })}
          />
          {localParams.nGpuLayers > 0 && (
            <Text style={[styles.warnText, { color: colors.warning }]}>{t("gpuWarning")}</Text>
          )}
          <NumberField
            label={t("temperature")}
            value={localGenParams.temperature}
            step={0.1}
            min={0}
            max={1.5}
            format={(v) => v.toFixed(1)}
            onChange={(v) => setLocalGenParams({ temperature: v })}
          />
          <NumberField
            label={t("maxTokens")}
            value={localGenParams.maxTokens}
            step={128}
            min={128}
            max={2048}
            onChange={(v) => setLocalGenParams({ maxTokens: v })}
          />
          <NumberField
            label={t("topP")}
            value={localGenParams.topP}
            step={0.05}
            min={0.1}
            max={1}
            format={(v) => v.toFixed(2)}
            onChange={(v) => setLocalGenParams({ topP: v })}
          />
          {model.loaded && !localParamsAuto && (
            <Text style={styles.hintText}>{t("paramsHint")}</Text>
          )}
        </View>

        </SettingsGroup>

        <SettingsGroup
          title={{ ru: "Настройки модели (онлайн)", uk: "Налаштування моделі (онлайн)", en: "Online model settings" }[language]}
          icon="cloud-outline"
          expanded={!!openSections.online}
          onToggle={() => toggleSection("online")}
          colors={colors}
        >
        <Text style={[styles.section, { color: colors.muted, marginTop: 0 }]}>{t("openRouterSectionTitle")}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Checkbox
            checked={mode === "online"}
            onPress={() => setMode("online")}
            label={t("useAsActive")}
          />
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="cloud-outline" size={21} color={colors.accent} />
            </View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>{onlineModel.name}</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]}>{onlineModel.provider} · {onlineModelContextLabel}</Text>
              <Text style={[styles.modelDesc, { color: colors.muted }]}>{onlineModelDescription}</Text>
            </View>
          </View>

          <Text style={styles.urlLabel}>{t("apiKeyLabel")}</Text>
          <View style={styles.apiKeyRow}>
            <TextInput
              style={[styles.apiKeyInput, { backgroundColor: colors.inputBg, color: colors.inkBright, borderColor: colors.line }]}
              placeholder={onlineModel.hasApiKey ? t("apiKeySavedPlaceholder") : t("apiKeyPlaceholder")}
              placeholderTextColor="#9AA3AC"
              value={apiKeyDraft}
              onChangeText={(v) => { setApiKeyDraft(v); setApiKeyDraftDirty(true); setApiKeyCheckResult(null); }}
              secureTextEntry={!showApiKey}
              editable={!savingApiKey && !checkingApiKey}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowApiKey((v) => !v)} disabled={savingApiKey || checkingApiKey}>
              <Text style={styles.eyeBtnText}>{showApiKey ? "🙈" : "👁"}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.modelActions}>
            <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: colors.accentDim, flexDirection: "row", alignItems: "center", gap: 6, opacity: onlineApiKeyLoaded && !!apiKeyDraft.trim() && !savingApiKey && !checkingApiKey ? 1 : 0.5 }]} onPress={handleSaveApiKey} disabled={!onlineApiKeyLoaded || !apiKeyDraft.trim() || savingApiKey || checkingApiKey}>
              {savingApiKey && <ActivityIndicator size="small" color={colors.accent} />}
              <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("saveKey")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryButton, { backgroundColor: colors.accentDim, flexDirection: "row", alignItems: "center", gap: 6, opacity: checkingApiKey || savingApiKey || !onlineApiKeyLoaded || (!apiKeyDraft.trim() && !onlineModel.hasApiKey) ? 0.5 : 1 }]}
              onPress={handleCheckApiKey}
              disabled={checkingApiKey || savingApiKey || !onlineApiKeyLoaded || (!apiKeyDraft.trim() && !onlineModel.hasApiKey)}
            >
              {checkingApiKey && <ActivityIndicator size="small" color={colors.accent} />}
              <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>
                {checkingApiKey ? t("checkingApiKey") : t("checkApiKey")}
              </Text>
            </TouchableOpacity>
          </View>
          {apiKeyDraftDirty && !!apiKeyDraft.trim() && (
            <Text style={[styles.statusLine, { color: colors.warning }]}>{t("apiKeyDraftNotSaved")}</Text>
          )}

          <Text style={[styles.statusLine, { color: colors.muted }]}>
            {onlineModel.hasApiKey ? t("keySet") : t("keyNotSet")}
          </Text>
          {apiKeyCheckResult && (
            <Text style={[styles.statusLine, { color: providerProbeTone(apiKeyCheckResult.status) === "success" ? colors.accent : providerProbeTone(apiKeyCheckResult.status) === "danger" ? colors.danger : colors.warning }]}> 
              {apiKeyCheckResult.message}
            </Text>
          )}

          <View style={[styles.divider, { backgroundColor: colors.line }]} />

          <Text style={[styles.paramsTitle, { color: colors.inkBright }]}>{t("openRouterModelsSection")}</Text>
          <Text style={[styles.modelDesc, { color: colors.muted }]}>{t("openRouterModelsSectionDesc")}</Text>
          <Text style={[styles.statusLine, { color: colors.muted }]}>
            {t("openRouterCurrentModelLabel")} {onlineModel.name}
          </Text>
          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: colors.accentDim, alignSelf: "flex-start" }]}
            onPress={() => setOpenRouterDialogVisible(true)}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("openRouterChooseModelButton")}</Text>
          </TouchableOpacity>
        </View>

        <ManusProviderCard settings={{manus, saveManusKey, setManusProfile, removeManusKey}} mode={mode} setMode={setMode} language={language} colors={colors} />
        <Text style={[styles.section, { color: colors.muted }]}>{t("customProvider1Section")}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Checkbox checked={mode === "custom" && activeCustomSlot === 1} onPress={() => setActiveCustomSlot(1)} label={t("useAsActiveAgent")} />
          <TouchableOpacity activeOpacity={0.75} onPress={() => setCustom1DialogVisible(true)} style={styles.providerRow}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}><Ionicons name="options-outline" size={21} color={colors.accent} /></View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>{t("customProvider1Title")}</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]} numberOfLines={1}>{customProvider1.name || t("customProviderHint")}</Text>
              <Text style={[styles.modelDesc, { color: colors.muted }]} numberOfLines={2}>{customProvider1.baseUrl || t("customProvider1Empty")}</Text>
            </View>
            <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]} onPress={() => setCustom1DialogVisible(true)}>
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("customConfigure")}</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{t("customProvider2Section")}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Checkbox checked={mode === "custom" && activeCustomSlot === 2} onPress={() => setActiveCustomSlot(2)} label={t("useAsActiveAgent")} />
          <TouchableOpacity activeOpacity={0.75} onPress={() => setCustom2DialogVisible(true)} style={styles.providerRow}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}><Ionicons name="flash-outline" size={21} color={colors.accent} /></View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>{t("customProvider2Title")}</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]} numberOfLines={1}>{customProvider2.name || t("customProviderHint")}</Text>
              <Text style={[styles.modelDesc, { color: colors.muted }]} numberOfLines={2}>
                {customProvider2.baseUrl || t("customProvider1Empty")}
              </Text>
            </View>
            <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]} onPress={() => setCustom2DialogVisible(true)}>
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("customConfigure")}</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{t("openCodeSection")}</Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Checkbox checked={mode === "opencode"} onPress={() => setMode("opencode")} label={t("useAsActive")} />
          <TouchableOpacity activeOpacity={0.75} onPress={() => setOpenCodeDialogVisible(true)} style={styles.providerRow}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}><Ionicons name="code-slash-outline" size={21} color={colors.accent} /></View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>OpenCode</Text>
              <Text style={[styles.modelMeta, { color: colors.muted }]} numberOfLines={1}>{openCodeDraft.baseUrl}</Text>
              <Text style={[styles.modelDesc, { color: colors.muted }]}>{openCode?.hasApiKey ? t("keySet") : t("keyNotSet")}</Text>
            </View>
            <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]} onPress={() => setOpenCodeDialogVisible(true)}>
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>{t("saveKey")}</Text>
          </TouchableOpacity>
        </View>

        </SettingsGroup>

        <SettingsGroup
          title={language === "en" ? "Voice & Speech" : language === "uk" ? "Голос і мовлення" : "Голос и речь"}
          icon="mic-outline"
          expanded={!!openSections.voice}
          onToggle={() => toggleSection("voice")}
          colors={colors}
        >
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="mic-outline" size={21} color={colors.accent} />
            </View>
            <View style={styles.modelInfo}>
              <Text style={[styles.modelName, { color: colors.inkBright }]}>
                {language === "en" ? "Voice Assistant & TTS" : language === "uk" ? "Голосовий асистент і озвучка" : "Голосовой ассистент и озвучка"}
              </Text>
              <Text style={[styles.modelDesc, { color: colors.muted }]}>
                {language === "en" ? "Real-time STT, continuous voice mode, and TTS speech synthesis" : language === "uk" ? "Розпізнавання голосу, голосовий режим і синтез мови" : "Распознавание речи, голосовой диалог и синтез речи"}
              </Text>
            </View>
          </View>

          <Checkbox
            checked={voiceSettings.autoSend}
            onPress={() => updateVoiceSettings({ autoSend: !voiceSettings.autoSend })}
            label={language === "en" ? "Auto-send after speech pauses" : language === "uk" ? "Автонадсилання після паузи в мові" : "Автоотправка после завершения речи"}
          />

          <Checkbox
            checked={voiceSettings.autoSpeakResponses}
            onPress={() => updateVoiceSettings({ autoSpeakResponses: !voiceSettings.autoSpeakResponses })}
            label={language === "en" ? "Read AI replies aloud (TTS)" : language === "uk" ? "Озвучувати відповіді ШІ (TTS)" : "Озвучивать ответы ИИ (TTS)"}
          />

          <Checkbox
            checked={voiceSettings.voiceConversationMode}
            onPress={() => updateVoiceSettings({ voiceConversationMode: !voiceSettings.voiceConversationMode })}
            label={language === "en" ? "Continuous voice conversation mode" : language === "uk" ? "Неперервний голосовий діалог" : "Непрерывный голосовой диалог"}
          />

          <Checkbox
            checked={voiceSettings.readCodeBlocks}
            onPress={() => updateVoiceSettings({ readCodeBlocks: !voiceSettings.readCodeBlocks })}
            label={language === "en" ? "Read code blocks aloud (by default filtered for brevity)" : language === "uk" ? "Озвучувати блоки коду (за замовчуванням скорочуються)" : "Озвучивать блоки кода (по умолчанию скрываются для краткости речи)"}
          />

          <Text style={[styles.urlLabel, { marginTop: 6 }]}>
            {language === "en" ? "Speech rate:" : language === "uk" ? "Швидкість мовлення:" : "Скорость речи:"}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {[0.75, 1.0, 1.25, 1.5].map((rate) => (
              <TouchableOpacity
                key={rate}
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: voiceSettings.ttsSpeed === rate ? colors.accent : colors.accentDim,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                  },
                ]}
                onPress={() => updateVoiceSettings({ ttsSpeed: rate })}
              >
                <Text
                  style={[
                    styles.secondaryButtonText,
                    { color: voiceSettings.ttsSpeed === rate ? colors.background : colors.accent },
                  ]}
                >
                  {rate}x
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        </SettingsGroup>

        <SettingsGroup
          title={t("securitySection")}
          icon="shield-checkmark-outline"
          expanded={!!openSections.security}
          onToggle={() => toggleSection("security")}
          colors={colors}
        >
        <TouchableOpacity
          activeOpacity={0.78}
          onPress={() => router.push("/signing-keys")}
          style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.line }]}
        >
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="key-outline" size={21} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.infoText, { color: colors.inkBright }]}>{t("signingKeys")}</Text>
              <Text style={[styles.infoSub, { color: colors.muted }]}>{t("signingKeysDescription")}</Text>
            </View>
            <Ionicons name="chevron-forward" size={21} color={colors.muted} />
          </View>
        </TouchableOpacity>

        </SettingsGroup>

        <TouchableOpacity
          activeOpacity={0.78}
          onPress={() => router.push("/permissions-onboarding")}
          style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.line }]}
        >
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="shield-checkmark-outline" size={21} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.infoText, { color: colors.inkBright }]}>{({ ru: "Разрешения и доступ", uk: "Дозволи й доступ", en: "Permissions & access" } as const)[language]}</Text>
              <Text style={[styles.infoSub, { color: colors.muted }]}>{({ ru: "Необязательный обзор, без автоматических запросов", uk: "Необов'язковий огляд, без автоматичних запитів", en: "Optional review, no automatic requests" } as const)[language]}</Text>
            </View>
            <Ionicons name="chevron-forward" size={21} color={colors.muted} />
          </View>
        </TouchableOpacity>

        <SettingsGroup
          title={{ ru: "Фон и батарея", uk: "Фон і батарея", en: "Background & battery" }[language]}
          icon="battery-charging-outline"
          expanded={!!openSections.background}
          onToggle={() => toggleSection("background")}
          colors={colors}
        >
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={[styles.modelName, { color: colors.inkBright }]}>
            {{ ru: "Выживание в фоне", uk: "Виживання у фоні", en: "Background survival" }[language]}
          </Text>
          <Text style={[styles.modelMeta, { color: colors.muted, marginBottom: 10 }]}>
            {{
              ru: "Опционально: откройте настройки батареи, только если долгие задачи часто прерываются. Факт разрешения проверяется отдельно; при старте системные экраны не открываются.",
              uk: "Необов'язково: відкрийте налаштування батареї, лише якщо тривалі завдання часто перериваються. Дозвіл перевіряється окремо; під час запуску системні екрани не відкриваються.",
              en: "Optional: review battery settings only if long tasks are repeatedly interrupted. Grant state is checked separately; no system screen opens at startup.",
            }[language]}
          </Text>
          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]}
            onPress={() => void ensureBackgroundSurvival({ force: true })}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>
              {{ ru: "Настройки батареи", uk: "Налаштування батареї", en: "Battery settings" }[language]}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: colors.accentDim, marginTop: 6 }]}
            onPress={() => void requestUnrestrictedData()}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>
              {{ ru: "Настройки фоновых данных", uk: "Налаштування фонових даних", en: "Background data settings" }[language]}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: colors.accentDim, marginTop: 6 }]}
            onPress={() => void openAppDetailsSettings()}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>
              {{ ru: "Сведения о приложении", uk: "Відомості про застосунок", en: "App details settings" }[language]}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.modelDesc, { color: colors.muted, marginTop: 6, fontSize: 11 }]}>
            {{
              ru: "Каждая кнопка открывает только соответствующие системные настройки. Открытие экрана не означает выдачу разрешения.",
              uk: "Кожна кнопка відкриває лише відповідні системні налаштування. Відкриття екрана не означає надання дозволу.",
              en: "Each button opens only its corresponding system settings. Opening a screen does not mean access was granted.",
            }[language]}
          </Text>
        </View>

        
        <Text style={[styles.section, { color: colors.muted }]}>
          {{ ru: "Пресеты агента", uk: "Пресети агента", en: "Agent presets" }[language]}
        </Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={[styles.modelDesc, { color: colors.muted }]}>
            {{ ru: "Готовые профили интеллекта агента (поверх тумблеров).", uk: "Готові профілі інтелекту агента.", en: "Ready-made agent intelligence profiles." }[language]}
          </Text>
          <Text style={[styles.modelDesc, { color: colors.muted, marginBottom: 4 }]}>
            {(() => {
              const langKey = language === "uk" || language === "en" ? language : "ru";
              if (activeAgentPreset) {
                const title = AGENT_PRESETS.find((x) => x.id === activeAgentPreset)?.title[langKey] || activeAgentPreset;
                return { ru: `Сейчас выбран: ${title}`, uk: `Зараз обрано: ${title}`, en: `Active: ${title}` }[langKey];
              }
              return { ru: "Пресет ещё не выбирали (по умолчанию — Сбалансированный).", uk: "Пресет ще не вибирали (за замовчуванням — Збалансований).", en: "No preset chosen yet (default: Balanced)." }[langKey];
            })()}
          </Text>
          {AGENT_PRESETS.map((p) => {
            const isActive = activeAgentPreset === p.id;
            const langKey = language === "uk" || language === "en" ? language : "ru";
            return (
              <TouchableOpacity
                key={p.id}
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: isActive ? colors.accent : colors.accentDim,
                    marginTop: 6,
                    borderWidth: isActive ? 1 : 0,
                    borderColor: isActive ? colors.accent : "transparent",
                  },
                ]}
                onPress={() => {
                  void applyAgentPreset(p.id).then(() => {
                    setActiveAgentPreset(p.id);
                    logInfo("Settings", `agent preset ${p.id}`);
                  });
                }}
              >
                <Text style={[styles.secondaryButtonText, { color: isActive ? colors.surface : colors.accent }]}>
                  {isActive ? "\u2713 " : ""}{p.title[langKey]}
                </Text>
                <Text style={{ color: isActive ? colors.surface : colors.muted, fontSize: 11, opacity: isActive ? 0.9 : 1 }}>
                  {p.description[langKey]}
                </Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: colors.surface, marginTop: 10, borderWidth: 1, borderColor: colors.line }]}
            onPress={() => {
              void resetAgentPreset().then(() => {
                setActiveAgentPreset("balanced");
                logInfo("Settings", "agent preset reset to balanced");
              });
            }}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.inkBright }]}>
              {{ ru: "Сбросить пресет (Сбалансированный)", uk: "Скинути пресет (Збалансований)", en: "Reset preset (Balanced)" }[language === "uk" || language === "en" ? language : "ru"]}
            </Text>
            <Text style={{ color: colors.muted, fontSize: 11 }}>
              {{ ru: "Вернуть стандартные тумблеры интеллекта.", uk: "Повернути стандартні тумблери інтелекту.", en: "Restore default intelligence toggles." }[language === "uk" || language === "en" ? language : "ru"]}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>
          {{ ru: "Плагины / safe mode", uk: "Плагіни / safe mode", en: "Plugins / safe mode" }[language]}
        </Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]}
            onPress={() => {
              void (async () => {
                const st = await loadPluginState();
                const next = !st.safeMode;
                await setPluginSafeMode(next);
                setPluginSafeModeState(next);
                logInfo("Settings", `plugins safeMode=${next}`);
              })();
            }}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>
              {{ ru: pluginSafeMode ? "Safe mode плагинов: ВКЛ" : "Safe mode плагинов: выкл", uk: pluginSafeMode ? "Safe mode: УВІМК" : "Safe mode: вимк", en: pluginSafeMode ? "Plugin safe mode: ON" : "Plugin safe mode: off" }[language]}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.modelDesc, { color: colors.muted, marginTop: 6 }]}>
            {{ ru: "В safe mode активны только встроенные skills. Политика shell: allowlist для Shizuku/plugin.", uk: "У safe mode лише вбудовані skills.", en: "Safe mode keeps builtin skills only. Shell policy allowlists Shizuku/plugin." }[language]}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>
            policy cmds: {(typeof getSecurityPolicySummary === "function" ? getSecurityPolicySummary().elevatedAllowCount : 0)}
          </Text>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>
          {{ ru: "Backup vs секреты", uk: "Backup vs секрети", en: "Backup vs secrets" }[language]}
        </Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={[styles.modelDesc, { color: colors.muted }]}>
            {describeBackupVsSecrets(language === "uk" || language === "en" ? language : "ru").note}
          </Text>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>
          {{ ru: "LAN status (opt-in)", uk: "LAN status (opt-in)", en: "LAN status (opt-in)" }[language]}
        </Text>
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <TouchableOpacity
            style={[styles.secondaryButton, { backgroundColor: colors.accentDim }]}
            onPress={() => {
              void (async () => {
                const cfg = await loadLanBridgeConfig();
                const next = await setLanBridgeEnabled(!cfg.enabled);
                setLanBridgeEnabledState(!!next.enabled);
                logInfo("Settings", `lanBridge enabled=${next.enabled}`);
              })();
            }}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>
              {{ ru: lanBridgeEnabled ? "LAN snapshot: ВКЛ" : "LAN snapshot: выкл", uk: lanBridgeEnabled ? "LAN snapshot: УВІМК" : "LAN snapshot: вимк", en: lanBridgeEnabled ? "LAN snapshot: ON" : "LAN snapshot: off" }[language]}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.modelDesc, { color: colors.muted, marginTop: 6 }]}>
            {{ ru: "По умолчанию выкл. Публикует JSON-снимок + token; встроенный HTTP-сервер доступен только при подтверждённой поддержке среды.", uk: "За замовчуванням вимк. JSON-знімок + token; вбудований HTTP-сервер доступний лише за підтвердженої підтримки середовища.", en: "Off by default. Publishes a JSON snapshot + token; the embedded HTTP server is available only when runtime support is confirmed." }[language]}
          </Text>
        </View>

        </SettingsGroup>

        <SettingsGroup
          title={{ ru: "Интерфейс", uk: "Інтерфейс", en: "Interface" }[language]}
          icon="color-palette-outline"
          expanded={!!openSections.interface}
          onToggle={() => toggleSection("interface")}
          colors={colors}
        >
        <View style={[styles.modelCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Checkbox
            checked={statusOverlayEnabled}
            onPress={() => {
              const next = !statusOverlayEnabled;
              setStatusOverlayEnabled(next);
              void saveStatusOverlayEnabled(next);
              logInfo("Settings", `statusOverlay enabled=${next}`);
            }}
            label={{ ru: "Плавающий статус в чате", uk: "Плаваючий статус у чаті", en: "Floating status in chat" }[language]}
            description={{
              ru: "Кнопка/карточка поверх чата. Выключите, если мешает полю ввода.",
              uk: "Кнопка/картка поверх чату. Вимкніть, якщо заважає полю вводу.",
              en: "Floating card over chat. Turn off if it covers the input field.",
            }[language]}
          />
        </View>

        </SettingsGroup>

        <SettingsGroup
          title={t("aboutApp")}
          icon="information-circle-outline"
          expanded={!!openSections.about}
          onToggle={() => toggleSection("about")}
          colors={colors}
        >
        <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.settingsCardHeader}>
            <View style={[styles.providerIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="information-circle-outline" size={21} color={colors.accent} />
            </View>
            <View>
              <Text style={[styles.infoText, { color: colors.inkBright }]}>{t("version")}</Text>
              <Text style={[styles.infoSub, { color: colors.muted }]}>{t("expoVersion")}</Text>
            </View>
          </View>
        </View>
        </SettingsGroup>
      </ScrollView>

      <SystemPromptDialog
        visible={systemPromptDialogVisible}
        value={systemPrompt}
        onSave={handleSaveSystemPrompt}
        onClear={handleClearSystemPrompt}
        onRequestClose={() => setSystemPromptDialogVisible(false)}
      />

      <OpenRouterModelsDialog
        visible={openRouterDialogVisible}
        selectedId={openRouterModelId}
        onSelect={handleSelectOpenRouterModel}
        modelOverrides={openRouterModelOverrides}
        onSaveModelOverride={saveOpenRouterModelOverride}
        genParams={onlineGenParams}
        onChangeGenParams={setOnlineGenParams}
        onRequestClose={() => setOpenRouterDialogVisible(false)}
        modelStatus={openRouterModelStatus}
        checking={checkingOpenRouterModels}
        lastCheckedAt={openRouterModelsCheckedAt}
        onCheckModels={checkOpenRouterModelsNow}
      />
      <OpenCodeModelsDialog
        visible={openCodeDialogVisible}
        providerId="opencode"
        hasApiKey={!!openCode?.hasApiKey}
        config={openCodeDraft}
        onConfigChange={(partial) => setOpenCodeDraft((d) => ({ ...d, ...partial }))}
        onSave={async (config) => {
          const saved = await setOpenCode({
            baseUrl: config.baseUrl.trim(),
            modelId: config.modelId.trim(),
            apiKey: config.apiKey.trim(),
          });
          if (!saved) return false;
          setMode("opencode");
          logInfo("Settings", "OpenCode settings saved");
          return true;
        }}
        onClose={() => { setOpenCodeDraft((d) => ({ ...d, apiKey: "" })); setOpenCodeDialogVisible(false); }}
      />
      <CustomProviderDialog
        visible={custom1DialogVisible}
        providerId="custom.slot1"
        hasApiKey={!!customProvider1.hasApiKey}
        config={custom1Draft}
        onConfigChange={(partial) => setCustom1Draft((d) => ({ ...d, ...partial }))}
        onSave={async (config) => {
          const saved = await setCustomProviderSlot(1, { ...config, name: config.name.trim() || "Custom #1", baseUrl: config.baseUrl.trim(), modelId: config.modelId.trim(), extraHeadersJson: config.extraHeadersJson.trim(), chatPath: (config.chatPath || "/chat/completions").trim(), apiKey: config.apiKey.trim() }, true);
          if (!saved) return false;
          logInfo("Settings", t("customSavedLog", { slot: "1" }));
          return true;
        }}
        onClose={() => { setCustom1Draft((d) => ({ ...d, apiKey: "" })); setCustom1DialogVisible(false); }}
      />
      <CustomProviderDialog
        visible={custom2DialogVisible}
        providerId="custom.slot2"
        hasApiKey={!!customProvider2.hasApiKey}
        config={custom2Draft}
        onConfigChange={(partial) => setCustom2Draft((d) => ({ ...d, ...partial }))}
        onSave={async (config) => {
          const saved = await setCustomProviderSlot(2, { ...config, name: config.name.trim() || "Custom #2", baseUrl: config.baseUrl.trim(), modelId: config.modelId.trim(), extraHeadersJson: config.extraHeadersJson.trim(), chatPath: (config.chatPath || "/chat/completions").trim(), apiKey: config.apiKey.trim() }, true);
          if (!saved) return false;
          logInfo("Settings", t("customSavedLog", { slot: "2" }));
          return true;
        }}
        onClose={() => { setCustom2Draft((d) => ({ ...d, apiKey: "" })); setCustom2DialogVisible(false); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  section: { color: "#9AA3AC", fontSize: 13, fontWeight: "600", marginTop: 8, marginBottom: 4 },
  deviceCard: { borderRadius: 16, padding: 16, borderWidth: 1, gap: 4 },
  deviceLine: { color: "#F0F1F3", fontSize: 12.5 },
  deviceNote: { color: "#9AA3AC", fontSize: 12, marginTop: 4, lineHeight: 17 },
  modelCard: { borderRadius: 16, padding: 16, borderWidth: 1, gap: 8 },
  modelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  settingsCardHeader: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 42 },
  modelInfo: { flex: 1 },
  modelName: { color: "#F0F1F3", fontSize: 15, fontWeight: "600" },
  modelMeta: { color: "#9AA3AC", fontSize: 12, marginTop: 2 },
  modelDesc: { color: "#9AA3AC", fontSize: 12, marginTop: 6, lineHeight: 17 },
  errorText: { color: "#FFB4AB", fontSize: 12 },
  warnText: { fontSize: 11.5, marginTop: 2, lineHeight: 16 },
  hintText: { color: "#9FCBFF", fontSize: 11.5, marginTop: 4, lineHeight: 16 },
  statusLine: { color: "#9AA3AC", fontSize: 12, marginTop: 4 },
  modelActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  primaryButton: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  transferBlock: { width: "100%", flexBasis: "100%", marginTop: 8, marginBottom: 4 },
  transferTitle: { fontSize: 12, fontWeight: "600", marginBottom: 8, letterSpacing: 0.2 },
  transferHint: { fontSize: 11, lineHeight: 15, marginTop: 4, marginBottom: 2, maxWidth: 340 },
  secondaryButton: { backgroundColor: "rgba(159, 203, 255, 0.14)", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, alignSelf: "flex-start" },
  secondaryButtonText: { color: "#9FCBFF", fontSize: 13, fontWeight: "600" },
  divider: { height: 1, marginVertical: 6 },
  paramsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  paramsTitle: { color: "#F0F1F3", fontSize: 13, fontWeight: "700" },
  autoRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  autoLabel: { color: "#9AA3AC", fontSize: 11.5 },
  autoResetText: { color: "#9FCBFF", fontSize: 11.5, fontWeight: "600" },
  apiKeyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  apiKeyInput: { color: "#F0F1F3", backgroundColor: "#1F242A",
    flex: 1, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: "#3A4148", fontSize: 13,
  },
  eyeBtn: { padding: 8 },
  eyeBtnText: { fontSize: 16 },
  providerRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  providerIcon: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  chevron: { fontSize: 28, fontWeight: "300", paddingHorizontal: 4 },
  expandContent: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#3A4148", gap: 8 },
  urlLabel: { color: "#9AA3AC", fontSize: 12 },
  urlValue: { color: "#9AA3AC", fontSize: 12 },
  urlInput: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, fontSize: 13 },
  infoCard: { borderRadius: 16, padding: 16, borderWidth: 1 },
  infoText: { color: "#F0F1F3", fontSize: 16, fontWeight: "700" },
  infoSub: { color: "#9AA3AC", fontSize: 13, marginTop: 4 },

  editModelBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: "rgba(159, 203, 255, 0.12)",
    alignSelf: "flex-start",
  },
  editModelBtnText: { color: "#9FCBFF", fontSize: 12, fontWeight: "700" },
  editModelPanel: { gap: 6, marginTop: 4 },
  modeChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  hint: { fontSize: 12, lineHeight: 17 },
  card: { borderRadius: 16, padding: 16, borderWidth: 1, gap: 4 },
});
