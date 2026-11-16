import { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  Platform, Keyboard, Image, PermissionsAndroid, Linking, ScrollView, Dimensions,
} from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useLLMContext } from "../components/LLMContext";
import { useLoggerContext } from "../components/LoggerContext";
import { useAppSettingsContext } from "../components/AppSettingsContext";
import { useLanguage } from "../components/LanguageContext";
import { errorMessage } from "../lib/error-utils";
import { translateEngineError } from "../lib/engine-errors";
import { useDialog } from "../components/DialogContext";
import { useTheme } from "../components/ThemeContext";
import { useTermuxContext } from "../components/TermuxContext";
import { FREE_OPENROUTER_MODELS } from "../lib/online-model";
import { ChatBubble } from "../components/ChatBubble";
import { ModelModeSwitch } from "../components/ModelModeSwitch";
import { EnvironmentHeaderBadges } from "../components/EnvironmentHeaderBadges";
import { saveTextAsFile } from "../lib/text-file";
import { isClearChatCommand } from "../lib/chat-commands";
import { analyzeProjectText, formatSecurityReport } from "../lib/security-scanner";
import { createCheckpoint } from "../lib/checkpoints";
import { getRuntimeFacade } from "../lib/runtime-facade";
import { AgentThinkingPanel } from "../components/AgentThinkingPanel";
import { ReverseProgressPanel } from "../components/ReverseProgressPanel";
import { UniversalAttachmentMenu } from "../components/UniversalAttachmentMenu";
import { CameraCaptureModal } from "../components/CameraCaptureModal";
import {
  loadVoiceSettings,
  saveVoiceSettings,
  voicePlayback,
  DEFAULT_VOICE_SETTINGS,
  type VoiceSettings,
} from "../lib/voice-runtime";
import { classifyMultimodalTask } from "../lib/multimodal-router";
import { generateImageFromPrompt } from "../lib/media-generation";
import { parseAndExtractAttachmentContent, detectAttachmentType, AttachmentReadError } from "../lib/file-parser-registry";
import type { ChatAttachment } from "../lib/multimodal-types";
import { transcribeAudioFile, resolveSttEndpoint } from "../lib/audio-transcribe";
import { inspectAttachmentLocally, isBroadAttachmentIntent } from "../lib/file-intake";
import { materializeUriForTermux } from "../lib/materialize-uri";
import { useProjectContext } from "../components/ProjectContext";
import { allocateIndicatorBodyHeights } from "../lib/chat-indicator-layout";
import { redactTaskActivityText } from "../lib/task-activity";


// Speech is loaded lazily on first voice use — never during cold start.
const speechFallbackModule: any = {
  isRecognitionAvailable: () => false,
  getSpeechRecognitionServices: () => [],
  getDefaultRecognitionService: () => null,
  getMicrophonePermissionsAsync: async () => ({ granted: false, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: false, canAskAgain: true }),
  start: async () => {},
  stop: () => {},
};
let ExpoSpeechRecognitionModule: any = speechFallbackModule;
let speechLoadAttempted = false;
function ensureSpeechModule(): any {
  if (speechLoadAttempted) return ExpoSpeechRecognitionModule;
  speechLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const speech = require("expo-speech-recognition");
    if (speech?.ExpoSpeechRecognitionModule) {
      ExpoSpeechRecognitionModule = speech.ExpoSpeechRecognitionModule;
      // Bridge native events into our handler sets (avoids calling expo hook incorrectly).
      const mod = ExpoSpeechRecognitionModule;
      if (mod?.addListener) {
        ["start","end","result","error","audiostart","audioend","speechstart","speechend","soundstart","soundend"].forEach((ev) => {
          try { mod.addListener(ev, (payload: any) => emitSpeechEvent(ev, payload)); } catch { /* ignore */ }
        });
      }
    }
  } catch {
    ExpoSpeechRecognitionModule = speechFallbackModule;
  }
  return ExpoSpeechRecognitionModule;
}
// No-op event hook at module scope (must stay a stable function for Rules of Hooks).
// Real speech events attach inside ensureSpeechModule() when user starts voice input.
const speechHandlers: Record<string, Set<(...args: any[]) => void>> = {};
function useSpeechRecognitionEvent(event: string, handler: (...args: any[]) => void) {
  useEffect(() => {
    if (!speechHandlers[event]) speechHandlers[event] = new Set();
    speechHandlers[event].add(handler);
    return () => { speechHandlers[event]?.delete(handler); };
  }, [event, handler]);
}
function emitSpeechEvent(event: string, payload: any) {
  const set = speechHandlers[event];
  if (!set) return;
  set.forEach((h) => { try { h(payload); } catch { /* ignore */ } });
}

const PASTE_TO_FILE_THRESHOLD = 800;

function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

type PendingAttachment =
  | { kind: "file"; uri: string; name: string; size?: number; mimeType?: string }
  | { kind: "image"; uri: string; name: string; source?: "GALLERY" | "CAMERA" }
  | { kind: "audio"; uri: string; name: string }
  | { kind: "video"; uri: string; name: string };

export default function ChatScreen() {
  const [input, setInput] = useState("");
  const params = useLocalSearchParams<{ retryTask?: string | string[] }>();
  const retryAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    const raw = params?.retryTask;
    const task = Array.isArray(raw) ? raw[0] : raw;
    const normalized = task ? String(task).trim() : "";
    if (normalized && retryAppliedRef.current !== normalized) {
      retryAppliedRef.current = normalized;
      setInput(normalized);
    }
  }, [params?.retryTask]);
  const [isOfflineAgentRunning, setIsOfflineAgentRunning] = useState(false);
  const offlineAgentAbortRef = useRef<AbortController | null>(null);
  const largePasteSavingRef = useRef(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  const [cameraModalVisible, setCameraModalVisible] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const voiceBaseTextRef = useRef("");
  const voiceTranscriptRef = useRef("");
  const autoSendTriggeredRef = useRef(false);
  const { logInfo, logError } = useLoggerContext();
  const {
    isLoading,
    isAgentRunningInOtherSession = false,
    isSessionAgentBusy = false,
    sessions,
    currentSession,
    currentSessionId,
    setCurrentSessionId,
    sendMessage,
    runOfflineAgent,
    stopGeneration,
    analyzeImage,
    createNewChat,
    addMessageToCurrentSession,
    deleteMessage,
    clearCurrentChat,
  } = useLLMContext();
  const { project } = useProjectContext();
  const {
    mode,
    model,
    onlineModel,
    customProvider,
    openCode,
  } = useAppSettingsContext();
  const { t, language } = useLanguage();
  const { showDialog, confirmDialog } = useDialog();
  const { colors } = useTheme();
  const { enabled: termuxEnabled, checking: termuxChecking, setEnabled: setTermuxEnabled, activity: termuxActivity } = useTermuxContext();
  const flatListRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const [chatViewportHeight, setChatViewportHeight] = useState(0);
  const [buildProgressExpanded, setBuildProgressExpanded] = useState(false);
  const [thinkingPanelExpanded, setThinkingPanelExpanded] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadVoiceSettings().then(setVoiceSettings);
    }, [])
  );

  const voiceSettingsRef = useRef<VoiceSettings>(voiceSettings);
  useEffect(() => {
    voiceSettingsRef.current = voiceSettings;
  }, [voiceSettings]);

  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  const handleSendRef = useRef<((overrideText?: string) => Promise<void>) | null>(null);
  const sendInFlightRef = useRef(false);
  const attachmentActionRef = useRef<string | null>(null);

  const speechendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useSpeechRecognitionEvent("start", () => {
    setIsListening(true);
    autoSendTriggeredRef.current = false;
    logInfo("Voice", "Распознавание речи запущено.");
  });
  useSpeechRecognitionEvent("audiostart", () => {
    logInfo("Voice", "Аудиопоток микрофона запущен.");
  });
  useSpeechRecognitionEvent("speechstart", () => {
    logInfo("Voice", "Обнаружена речь.");
    if (speechendTimerRef.current) {
      clearTimeout(speechendTimerRef.current);
      speechendTimerRef.current = null;
    }
  });
  useSpeechRecognitionEvent("speechend", () => {
    logInfo("Voice", "Речь завершена, ожидаю финальный результат.");
    if (speechendTimerRef.current) clearTimeout(speechendTimerRef.current);
    // Через 600 мс после завершения речи, если система сама не закрыла сессию, форсируем stop()
    speechendTimerRef.current = setTimeout(() => {
      try {
        ExpoSpeechRecognitionModule.stop();
      } catch {}
    }, 600);
  });
  useSpeechRecognitionEvent("soundstart", () => {
    logInfo("Voice", "Обнаружен звук с микрофона.");
  });
  useSpeechRecognitionEvent("soundend", () => {
    logInfo("Voice", "Звук с микрофона завершён.");
  });
  useSpeechRecognitionEvent("end", () => {
    setIsListening(false);
    if (speechendTimerRef.current) {
      clearTimeout(speechendTimerRef.current);
      speechendTimerRef.current = null;
    }
    logInfo("Voice", "Распознавание речи завершено.");

    const settingsNow = voiceSettingsRef.current;
    const textToSend = voiceTranscriptRef.current.trim() || inputRef.current.trim();
    const shouldAutoSend = settingsNow.autoSend || settingsNow.voiceConversationMode;

    if (shouldAutoSend && textToSend && !autoSendTriggeredRef.current) {
      autoSendTriggeredRef.current = true;
      logInfo("Voice", `Автоотправка распознанной речи: "${textToSend}"`);
      setInput("");
      if (handleSendRef.current) {
        handleSendRef.current(textToSend).finally(() => {
          autoSendTriggeredRef.current = false;
        });
      } else {
        autoSendTriggeredRef.current = false;
      }
    }
  });
  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results?.[0]?.transcript?.trim() || "";
    if (!transcript) return;
    const base = voiceBaseTextRef.current.trim();
    const full = base ? `${base} ${transcript}` : transcript;
    voiceTranscriptRef.current = full;
    setInput(full);
    logInfo(
      "Voice",
      `${event.results?.[0]?.isFinal ? "Финал" : "Промежуточный"}: ${transcript}`
    );
  });
  useSpeechRecognitionEvent("error", (event) => {
    setIsListening(false);
    if (speechendTimerRef.current) {
      clearTimeout(speechendTimerRef.current);
      speechendTimerRef.current = null;
    }
    logError(
      "Voice",
      `Ошибка распознавания: ${event?.error || "unknown"}${event?.message ? ` — ${event.message}` : ""}`
    );
  });

  const keyboard = useAnimatedKeyboard();
  const inputWrapperAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(
      keyboard.height.value,
      Math.max(insets.bottom, Platform.OS === "android" ? 8 : 0)
    ),
  }));

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

  const handleLargeTextPaste = useCallback(async (text: string) => {
    if (largePasteSavingRef.current) return;
    largePasteSavingRef.current = true;
    try {
      const attachment = await saveTextAsFile(text, "paste");
      setInput((current) => current === text ? "" : current);
      logInfo("Chat", `${t("pasteSavedAsFile")} (${text.length} ${t("charsUnit")})`);
      addMessageToCurrentSession({
        id: makeId(),
        role: "user" as const,
        content: t("pasteSavedAsFile"),
        timestamp: Date.now(),
        attachment: { kind: "text-file", name: attachment.name, uri: attachment.uri, size: attachment.size },
      });
      const truncated = text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text;
      const response = await sendMessage(
        t("pasteAnalyzePrompt", { content: truncated })
      );
      addMessageToCurrentSession({
        id: makeId(),
        role: "assistant" as const,
        content: response,
        timestamp: Date.now(),
      });
      scrollToEnd();
    } catch (err: unknown) {
      const detail = `${t("errorPaste")} ${errorMessage(err)}`;
      logError("Chat", detail);
      showDialog(t("modelError"), detail);
    } finally {
      largePasteSavingRef.current = false;
    }
  }, [addMessageToCurrentSession, sendMessage, logInfo, logError, t, scrollToEnd, showDialog]);

  const handleChangeText = useCallback((text: string) => {
    const delta = text.length - input.length;
    if (delta > PASTE_TO_FILE_THRESHOLD) {
      handleLargeTextPaste(text);
      return;
    }
    setInput(text);
  }, [input, handleLargeTextPaste]);

  const handleRemoveAttachment = useCallback((index?: number) => {
    if (typeof index === "number") {
      setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
    } else {
      setPendingAttachments([]);
    }
  }, []);

  const toggleVoiceInput = useCallback(async () => {
    logInfo("Voice", `Нажата кнопка микрофона. Состояние: ${isListening ? "активно" : "неактивно"}.`);

    try {
      if (isListening) {
        ExpoSpeechRecognitionModule.stop();
        logInfo("Voice", "Отправлена команда остановки распознавания.");
        return;
      }

      ensureSpeechModule();
      const available = ExpoSpeechRecognitionModule.isRecognitionAvailable();
      const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices?.() || [];
      const defaultService = ExpoSpeechRecognitionModule.getDefaultRecognitionService?.()?.packageName || "";
      logInfo(
        "Voice",
        `Проверка распознавания: доступно=${available ? "да" : "нет"}; сервисы=${services.join(", ") || "нет"}; основной=${defaultService || "не определён"}.`
      );

      if (!available) {
        setIsListening(false);
        const msg =
          language === "en"
            ? "System speech recognition is unavailable. Install/enable Google Speech Services and grant microphone access."
            : language === "uk"
              ? "Системне розпізнавання мови недоступне. Встановіть/увімкніть Google Speech Services і дайте доступ до мікрофона."
              : "Системное распознавание речи недоступно. Установите/включите Google Speech Services (Speech Recognition & Synthesis) и дайте доступ к микрофону.";
        logError("Voice", msg);
        showDialog(t("voiceInput"), msg, [{ text: "OK" }]);
        return;
      }

      // Microphone access is feature-triggered, never requested at startup.
      let permission = await ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync();
      let androidMicGranted: boolean | null = null;
      logInfo(
        "Voice",
        `Текущее разрешение микрофона: ${permission.status}; granted=${permission.granted}; canAskAgain=${permission.canAskAgain}.`
      );

      if (Platform.OS === "android") {
        try {
          androidMicGranted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
          logInfo("Voice", `PermissionsAndroid.check(RECORD_AUDIO)=${androidMicGranted}`);
        } catch (e: unknown) {
          androidMicGranted = false;
          logInfo("Voice", `PermissionsAndroid.check failed: ${errorMessage(e)}`);
        }
        if (!androidMicGranted) {
          const proceed = await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
            showDialog(
              language === "en" ? "Microphone access" : language === "uk" ? "Доступ до мікрофона" : "Доступ к микрофону",
              language === "en"
                ? "AI Builder uses the microphone only when you start voice input, to convert your speech into text."
                : language === "uk"
                  ? "AI Builder використовує мікрофон лише після запуску голосового введення, щоб перетворити мовлення на текст."
                  : "AI Builder использует микрофон только после запуска голосового ввода, чтобы преобразовать речь в текст.",
              [
                { text: language === "en" ? "Not now" : language === "uk" ? "Не зараз" : "Не сейчас", onPress: () => finish(false) },
                { text: language === "en" ? "Continue" : language === "uk" ? "Продовжити" : "Продолжить", onPress: () => finish(true) },
              ],
            );
          });
          if (!proceed) { setIsListening(false); return; }
          try {
            logInfo("Voice", "Запрашиваю RECORD_AUDIO через PermissionsAndroid.request…");
            const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
              title: language === "en" ? "Microphone permission" : language === "uk" ? "Дозвіл на мікрофон" : "Разрешение на микрофон",
              message:
                language === "en"
                  ? "AI Builder needs the microphone for voice input."
                  : language === "uk"
                    ? "AI Builder потрібен мікрофон для голосового введення."
                    : "AI Builder нужен микрофон для голосового ввода.",
              buttonPositive: language === "en" ? "Allow" : language === "uk" ? "Дозволити" : "Разрешить",
              buttonNegative: language === "en" ? "Deny" : language === "uk" ? "Заборонити" : "Запретить",
              buttonNeutral: language === "en" ? "Ask later" : language === "uk" ? "Пізніше" : "Позже",
            });
            logInfo("Voice", `PermissionsAndroid.request result=${result}`);
          } catch (e: unknown) {
            logInfo("Voice", `PermissionsAndroid.request failed: ${errorMessage(e)}`);
          }
          try {
            androidMicGranted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
          } catch {
            androidMicGranted = false;
          }
        }
        try {
          permission = await ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync();
        } catch (e: unknown) {
          logInfo("Voice", `Microphone status recheck failed: ${errorMessage(e)}`);
        }
        logInfo(
          "Voice",
          `После запроса: ${permission.status}; granted=${permission.granted}; canAskAgain=${permission.canAskAgain}.`
        );
      } else if (!permission.granted) {
        // iOS / прочее
        permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      }

      const microphoneGranted = permission.granted && (Platform.OS !== "android" || androidMicGranted === true);
      if (!microphoneGranted) {
        setIsListening(false);
        const permanent = permission.canAskAgain === false;
        const msg = permanent
          ? language === "en"
            ? "Microphone access is blocked. Open Android Settings → Apps → AI Builder → Permissions → Microphone and enable it."
            : language === "uk"
              ? "Доступ до мікрофона заблоковано. Відкрийте Налаштування Android → Застосунки → AI Builder → Дозволи → Мікрофон і увімкніть."
              : "Доступ к микрофону запрещён. Откройте настройки Android → Приложения → AI Builder → Разрешения → Микрофон и включите."
          : language === "en"
            ? "Microphone access was not granted. Allow the microphone for AI Builder and press the button again."
            : language === "uk"
              ? "Доступ до мікрофона не видано. Дозвольте мікрофон для AI Builder і натисніть кнопку ще раз."
              : "Доступ к микрофону не выдан. Разрешите микрофон для AI Builder и нажмите кнопку ещё раз.";
        logError("Voice", msg);
        const buttons: { text: string; onPress?: () => void }[] = [{ text: "OK" }];
        if (permanent || Platform.OS === "android") {
          buttons.unshift({
            text: language === "en" ? "Open settings" : language === "uk" ? "Налаштування" : "Настройки",
            onPress: () => {
              Linking.openSettings().catch(() => {});
            },
          });
        }
        showDialog(t("voiceInput"), msg, buttons);
        return;
      }

      voiceBaseTextRef.current = input.trim();
      voiceTranscriptRef.current = "";
      const lang = language === "ru" ? "ru-RU" : language === "uk" ? "uk-UA" : "en-US";
      const startOptions: {
        lang: string;
        interimResults: boolean;
        maxAlternatives: number;
        continuous: boolean;
        requiresOnDeviceRecognition: boolean;
        addsPunctuation: boolean;
        androidRecognitionServicePackage?: string;
      } = {
        lang,
        interimResults: true,
        maxAlternatives: 1,
        continuous: false,
        requiresOnDeviceRecognition: false,
        addsPunctuation: true,
      };
      if (Platform.OS === "android" && defaultService) {
        startOptions.androidRecognitionServicePackage = defaultService;
      }

      logInfo("Voice", `Запускаю распознавание: ${lang}; service=${defaultService || "default"}.`);
      setIsListening(true);
      ExpoSpeechRecognitionModule.start(startOptions);
      logInfo("Voice", "Команда start() передана нативному SpeechRecognizer.");
    } catch (err: unknown) {
      setIsListening(false);
      const msg = `Сбой запуска голосового ввода: ${errorMessage(err)}`;
      logError("Voice", msg);
      showDialog(t("voiceInput"), msg, [
        { text: "OK" },
        {
          text: language === "en" ? "Open settings" : language === "uk" ? "Налаштування" : "Настройки",
          onPress: () => {
            Linking.openSettings().catch(() => {});
          },
        },
      ]);
    }
  }, [isListening, input, language, logInfo, logError, showDialog, t]);

  // Единая точка отправки: собирает то, что сейчас висит в поле ввода —
  // текст и/или прикреплённый файл/фото — в ОДНО сообщение пользователя,
  // добавляет его в чат и уже потом обращается к модели.

  const handleSend = useCallback(async (overrideText?: string) => {
    const rawText = typeof overrideText === "string" ? overrideText : input;
    const trimmed = rawText.trim();
    if (pendingAttachments.length > 1) {
      showDialog(t("oneAttachmentTitle"), t("oneAttachmentBody"), [{ text: "OK" }]);
      return;
    }
    const attachment = pendingAttachments[0] || null;
    const safeAttachmentExtension = (fileName: string): string => {
      const dot = fileName.lastIndexOf(".");
      if (dot <= 0 || dot === fileName.length - 1) return "other";
      return fileName.slice(dot + 1).toLowerCase().match(/^[a-z0-9]{1,10}$/)?.[0] || "other";
    };
    if (!trimmed && !attachment) return;
    if (mode === "manus" && attachment) {
      showDialog(language === "en" ? "Text tasks only" : language === "uk" ? "Лише текстові завдання" : "Только текстовые задачи", language === "en" ? "The cloud API integration currently accepts text only. No attachment was uploaded. Remove it or select another provider." : language === "uk" ? "Хмарна API-інтеграція поки приймає лише текст. Вкладення не завантажено. Видаліть його або виберіть іншого провайдера." : "Облачная API-интеграция пока принимает только текст. Вложение не загружено. Уберите его или выберите другого провайдера.", [{ text: "OK" }]);
      return;
    }
    // Only block this chat while ITS agent/request is busy — other chat may run Termux agent
    if (isSessionAgentBusy || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    Keyboard.dismiss();
    try {
    if (!attachment && isClearChatCommand(trimmed)) {
      setInput("");
      setPendingAttachments([]);
      voiceTranscriptRef.current = "";
      voiceBaseTextRef.current = "";
      clearCurrentChat();
      return;
    }

    // Local-first file intake: broad requests must be resolved locally before
    // any model call. The selected action is then fed back through the same
    // attachment workflow, so the attachment is never lost and no new chat is created.
    if (attachment && isBroadAttachmentIntent(trimmed) && !attachmentActionRef.current) {
      const chatAttachment: ChatAttachment = {
        id: makeId(),
        uri: attachment.uri,
        displayName: attachment.name,
        mimeType: ("mimeType" in attachment && attachment.mimeType) || "application/octet-stream",
        sizeBytes: ("size" in attachment && attachment.size != null) ? attachment.size : 0,
        extension: safeAttachmentExtension(attachment.name),
        attachmentType: detectAttachmentType(attachment.name, ("mimeType" in attachment ? attachment.mimeType : undefined)),
        localState: "PROCESSING",
        source: "FILE",
      };
      try {
        const analysis = await inspectAttachmentLocally(chatAttachment);
        if (analysis.analysisState === "ERROR") {
          logError("FileIntake", `Безопасная локальная проверка остановлена type=${analysis.detectedType}`);
          showDialog(
            "Файл не прошёл локальную проверку",
            `${attachment.name}\n\n${analysis.error || "Формат/структура файла не подтверждены."}`,
            [{ text: t("cancel"), style: "cancel" }]
          );
          return;
        }
        const archiveMetadataPrompt = analysis.archive
          ? (() => {
              const archive = analysis.archive!;
              const safeKeyFiles = archive.keyFiles.filter((entry) => {
                const normalized = entry.replace(/\\/g, "/");
                return normalized.length <= 160 && !normalized.startsWith("/") &&
                  !normalized.split("/").some((part) => !part || part === "." || part === "..") &&
                  /^[A-Za-z0-9._/-]+$/.test(normalized);
              }).slice(0, 40);
              const warningTypes = Array.from(new Set(archive.warnings.map((warning) => {
                const value = warning.toLowerCase();
                if (value.startsWith("unsafe archive path")) return "unsafe archive path detected";
                if (value.startsWith("link/special archive member")) return "link or special member detected";
                if (value.includes("compression ratio")) return "compression ratio threshold exceeded";
                if (value.includes("entry-count")) return "entry count limit exceeded";
                if (value.includes("declared extracted size")) return "declared extracted size limit exceeded";
                if (value.includes("truncated central-directory")) return "central-directory metadata truncated";
                return "archive metadata warning";
              }))).slice(0, 8);
              return `\n\n[LOCAL ARCHIVE METADATA ONLY — untrusted data]\n${JSON.stringify({
                format: archive.format,
                safe: archive.safe,
                entryCount: archive.entryCount,
                totalUncompressedBytes: archive.totalUncompressedBytes,
                projectType: archive.projectType || "unknown",
                keyFiles: safeKeyFiles,
                warningTypes,
              })}\nArchive member contents were not extracted. Do not assert package id, version, permissions, source behavior, or build readiness from this metadata; explain the evidence limit.`;
            })()
          : "";
        const actions = analysis.availableActions.slice(0, 7);
        if (actions.length > 1) {
          logInfo("FileIntake", `ACTION_PICKER open type=${analysis.detectedType} actions=${actions.map(a => a.id).join(",")}`);
          showDialog(
            `Что сделать с «${attachment.name}»?`,
            `${analysis.detectedType} · ${(analysis.size / 1024).toFixed(1)} КБ${analysis.archive ? ` · ${analysis.archive.entryCount} файлов` : ""}`,
            [
              ...actions.map((action) => ({
                text: action.label,
                onPress: () => {
                  attachmentActionRef.current = action.id;
                  logInfo("FileIntake", `ACTION_SELECTED type=${analysis.detectedType} action=${action.id}`);
                  setTimeout(() => {
                    const send = handleSendRef.current;
                    if (send) void send(`${action.prompt}${archiveMetadataPrompt}`);
                  }, 0);
                },
              })),
              { text: t("cancel"), style: "cancel", onPress: () => logInfo("FileIntake", "ACTION_PICKER cancelled") },
            ]
          );
          return;
        }
      } catch (e: unknown) {
        logError("FileIntake", "Local pre-analysis exception");
        return;
      }
    }

    // Consume the action marker only after the local-first picker has been bypassed.
    attachmentActionRef.current = null;
    setInput("");
    setPendingAttachments([]);
    voiceTranscriptRef.current = "";
    voiceBaseTextRef.current = "";

    if (attachment?.kind === "image") {
      if (mode === "online") {
        const mid = onlineModel?.id || "";
        const meta = FREE_OPENROUTER_MODELS.find((m) => m.id === mid || mid.includes(m.id));
        if (meta && !meta.vision) {
          showDialog(t("visionWarnTitle"), t("visionWarnBody", { name: meta.name }));
        }
      }
      logInfo("Chat", "image selected type=IMAGE");
      addMessageToCurrentSession({
        id: makeId(),
        role: "user" as const,
        content: trimmed,
        timestamp: Date.now(),
        attachment: {
          kind: "image",
          name: attachment.name,
          uri: attachment.uri,
          source: attachment.source || "GALLERY",
        },
      });
      scrollToEnd();
      try {
        const prompt = trimmed || t("imageAnalyzePrompt");
        // The URI is used only to load the binary image payload; prompt text contains no file metadata.
        const response = await analyzeImage(attachment.uri, prompt);
        const assistantMsg = {
          id: makeId(),
          role: "assistant" as const,
          content: response,
          timestamp: Date.now(),
        };
        addMessageToCurrentSession(assistantMsg);
        logInfo("Chat", t("imageAnalysisDone"));
        if (voiceSettings.autoSpeakResponses || voiceSettings.voiceConversationMode) {
          voicePlayback.speakText(assistantMsg.id, response, language, {
            speed: voiceSettings.ttsSpeed,
            readCodeBlocks: voiceSettings.readCodeBlocks,
          }).catch(() => {});
        }
        scrollToEnd();
      } catch (err: unknown) {
        logError("Chat", "Image analysis failed");
      }
      return;
    }

    if (attachment?.kind === "file" || attachment?.kind === "audio" || attachment?.kind === "video") {
      const attType = detectAttachmentType(attachment.name, ("mimeType" in attachment ? attachment.mimeType : undefined));
      const safeExtension = safeAttachmentExtension(attachment.name);
      logInfo("Chat", `file selected type=${attType} extension=${safeExtension}`);
      let resolvedUri = attachment.uri;
      // content:// and app-private file:// cannot be read by Termux unzip/gradle
      if (/^(content:|file:\/\/\/data\/)/i.test(resolvedUri)) {
        try {
          resolvedUri = await materializeUriForTermux(resolvedUri, attachment.name);
          logInfo("Chat", `attachment materialized type=${attType} extension=${safeExtension}`);
        } catch (matErr: unknown) {
          logError("Chat", `Materialize failed type=${attType}`);
          if (attType === "ARCHIVE" || /\.(zip|apk|aab)$/i.test(attachment.name)) {
            setPendingAttachments([attachment]);
            setInput(trimmed);
            showDialog(
              t("archiveTransferFailedTitle"),
              `${t("archiveTransferFailedBody")}\n\n${errorMessage(matErr)}`,
              [{ text: t("cancel") }],
            );
            return;
          }
        }
      }
      const chatAttachment: ChatAttachment = {
        id: makeId(),
        uri: resolvedUri,
        displayName: attachment.name,
        mimeType: ("mimeType" in attachment && attachment.mimeType) || "application/octet-stream",
        sizeBytes: ("size" in attachment && attachment.size != null) ? attachment.size : 0,
        extension: safeExtension === "other" ? "" : safeExtension,
        attachmentType: attType,
        localState: "READY",
        source: "FILE",
      };

      const messageKind =
        attType === "AUDIO"
          ? ("audio" as const)
          : attType === "VIDEO"
          ? ("video" as const)
          : attType === "ARCHIVE"
          ? ("archive" as const)
          : ("document" as const);

      const addAttachmentUserMessage = () => {
        addMessageToCurrentSession({
          id: makeId(),
          role: "user" as const,
          content: trimmed,
          timestamp: Date.now(),
          attachment: {
            kind: messageKind,
            name: attachment.name,
            uri: attachment.uri,
            size: ("size" in attachment && attachment.size) || 0,
          },
        });
        scrollToEnd();
      };
      // Documents are committed only after parsing so a retry does not create
      // a duplicate user message. Audio/video retain their existing flow.
      if (attType === "AUDIO" || attType === "VIDEO" || attachment.kind === "audio" || attachment.kind === "video") {
        addAttachmentUserMessage();
      }

      try {
        // --- АУДИО: расшифровка (STT) → текст в чат ---
        if (attType === "AUDIO" || attachment.kind === "audio") {
          if (mode === "local") {
            const msg =
              language === "en"
                ? "Offline mode cannot transcribe audio files. Switch to Online / Custom provider (with Whisper support) or use the microphone button for live speech recognition."
                : language === "uk"
                  ? "Офлайн-режим не розпізнає аудіофайли. Увімкніть Online / Custom (з підтримкою Whisper) або використовуйте мікрофон для живого розпізнавання."
                  : "Офлайн-режим не распознаёт аудиофайлы. Включите Online / Custom (с поддержкой Whisper) или используйте микрофон для живого распознавания.";
            addMessageToCurrentSession({
              id: makeId(),
              role: "assistant" as const,
              content: msg,
              timestamp: Date.now(),
            });
            scrollToEnd();
            return;
          }

          const stt = resolveSttEndpoint(mode, {
            onlineModel,
            customProvider,
            openCode,
                  });

          if (!stt) {
            const msg =
              language === "en"
                ? "No API key for speech-to-text. Set a key in Settings (OpenRouter / Custom / OpenCode)."
                : language === "uk"
                  ? "Немає API-ключа для розпізнавання мови. Вкажіть ключ у Налаштуваннях (OpenRouter / Custom / OpenCode)."
                  : "Нет API-ключа для распознавания речи. Укажите ключ в Настройках (OpenRouter / Custom / OpenCode).";
            addMessageToCurrentSession({
              id: makeId(),
              role: "assistant" as const,
              content: msg,
              timestamp: Date.now(),
            });
            scrollToEnd();
            return;
          }

          logInfo("Chat", "STT: audio transcription started");
          let transcript = "";
          try {
            transcript = await transcribeAudioFile({
              uri: attachment.uri,
              // Use a generic multipart name; the URI remains only a binary input locator.
              fileName: `audio.${safeExtension}`,
              providerId: stt.providerId,
              baseUrl: stt.baseUrl,
              language: language === "uk" ? "uk" : language === "en" ? "en" : "ru",
              extraHeaders: stt.extraHeaders,
            });
          } catch (sttErr: unknown) {
            const raw = sttErr instanceof Error ? sttErr.message : String(sttErr);
            const safeCode = raw.match(/^STT_[A-Z_]+/)?.[0] || "STT_UNKNOWN";
            const friendly = translateEngineError(t, raw);
            logError("Chat", `STT failed: ${safeCode}`);
            const hint =
              language === "en"
                ? `Could not transcribe audio: ${friendly}\n\nTips:\n• Free tier may not include Whisper — try Groq/OpenAI base URL in Custom Provider, or a paid key.\n• Use the microphone button for live speech (works offline with Google Speech).`
                : language === "uk"
                  ? `Не вдалося розпізнати аудіо: ${friendly}\n\nПоради:\n• Free-тариф може не мати Whisper — спробуйте Groq/OpenAI у Custom Provider або платний ключ.\n• Мікрофон (живе розпізнавання) працює через Google Speech.`
                  : `Не удалось распознать аудио: ${friendly}\n\nСоветы:\n• Free-тариф может не включать Whisper — попробуйте Groq/OpenAI в Custom Provider или платный ключ.\n• Кнопка микрофона (живое распознавание) работает через Google Speech.`;
            addMessageToCurrentSession({
              id: makeId(),
              role: "assistant" as const,
              content: hint,
              timestamp: Date.now(),
            });
            scrollToEnd();
            return;
          }

          const prompt = trimmed
            ? `${trimmed}\n\n[Расшифровка аудио]:\n${transcript}`
            : language === "en"
              ? `The user attached an audio file. Transcript:\n\n${transcript}\n\nRespond to the content of this audio.`
              : language === "uk"
                ? `Користувач прикріпив аудіо. Розшифровка:\n\n${transcript}\n\nВідповідай за змістом цього аудіо.`
                : `Пользователь прикрепил аудио. Расшифровка:\n\n${transcript}\n\nОтветь по содержанию этого аудио.`;

          const response = await sendMessage(prompt);
          const assistantMsg = {
            id: makeId(),
            role: "assistant" as const,
            content: response,
            timestamp: Date.now(),
          };
          addMessageToCurrentSession(assistantMsg);
          if (voiceSettings.autoSpeakResponses || voiceSettings.voiceConversationMode) {
            voicePlayback.speakText(assistantMsg.id, response, language, {
              speed: voiceSettings.ttsSpeed,
              readCodeBlocks: voiceSettings.readCodeBlocks,
            }).catch(() => {});
          }
          scrollToEnd();
          return;
        }

        // --- ВИДЕО: без нативного video-input у free — честное сообщение + текст пользователя ---
        if (attType === "VIDEO" || attachment.kind === "video") {
          const note =
            language === "en"
              ? `[Video file attached. Full video understanding is limited on free models — describe the issue in text or send a screenshot/frame for best results.]`
              : language === "uk"
                ? `[Відеофайл прикріплено. Повний розбір відео на free-моделях обмежений — опишіть проблему текстом або надішліть скрін/кадр.]`
                : `[Видеофайл прикреплён. Полный разбор видео на free-моделях ограничен — опишите проблему текстом или пришлите скрин/кадр.]`;
          const prompt = trimmed ? `${trimmed}\n\n${note}` : note;
          const response = await sendMessage(prompt);
          const assistantMsg = {
            id: makeId(),
            role: "assistant" as const,
            content: response,
            timestamp: Date.now(),
          };
          addMessageToCurrentSession(assistantMsg);
          if (voiceSettings.autoSpeakResponses || voiceSettings.voiceConversationMode) {
            voicePlayback.speakText(assistantMsg.id, response, language, {
              speed: voiceSettings.ttsSpeed,
              readCodeBlocks: voiceSettings.readCodeBlocks,
            }).catch(() => {});
          }
          scrollToEnd();
          return;
        }

        // --- ДОКУМЕНТЫ / АРХИВЫ / ПРОЧИЕ ФАЙЛЫ: извлечение текста (online + offline) ---
        let parsed: Awaited<ReturnType<typeof parseAndExtractAttachmentContent>>;
        try {
          parsed = await parseAndExtractAttachmentContent(chatAttachment);
        } catch (readErr: unknown) {
          if (!(readErr instanceof AttachmentReadError)) throw readErr;
          logError("Chat", `FILE_PARSE_FAILED type=${attType} extension=${safeExtension}`);
          setInput(rawText);
          setPendingAttachments([attachment]);
          addMessageToCurrentSession({ id: makeId(), role: "assistant" as const, content: t("attachmentReadRetry"), timestamp: Date.now() });
          scrollToEnd();
          return;
        }
        addAttachmentUserMessage();
        const scanIssues = analyzeProjectText(parsed.text);
        if (scanIssues.length > 0) {
          addMessageToCurrentSession({
            id: makeId(),
            role: "assistant" as const,
            content: formatSecurityReport(scanIssues),
            timestamp: Date.now(),
          });
          logInfo("Security", `Static scan: ${scanIssues.length} issue(s) in attached file`);
        }

        const prompt = trimmed
          ? `${trimmed}\n\n[Содержимое прикреплённого файла]:\n${parsed.text}`
          : `Проанализируй прикреплённый файл:\n\n${parsed.text}`;

        const response = await sendMessage(prompt);
        const assistantMsg = {
          id: makeId(),
          role: "assistant" as const,
          content: response,
          timestamp: Date.now(),
        };
        addMessageToCurrentSession(assistantMsg);
        if (voiceSettings.autoSpeakResponses || voiceSettings.voiceConversationMode) {
          voicePlayback.speakText(assistantMsg.id, response, language, {
            speed: voiceSettings.ttsSpeed,
            readCodeBlocks: voiceSettings.readCodeBlocks,
          }).catch(() => {});
        }
        scrollToEnd();
      } catch {
        logError("Chat", "Attachment processing failed");
      }
      return;
    }

    // Проверка генерации изображений без вложений: "нарисуй...", "создай картинку..."
    const taskClass = classifyMultimodalTask(trimmed, []);
    if (!attachment && taskClass.taskType === "IMAGE_GENERATION") {
      logInfo("Chat", `Мультимодальная генерация изображения: ${trimmed}`);
      const userMsg = {
        id: makeId(),
        role: "user" as const,
        content: trimmed,
        timestamp: Date.now(),
      };
      addMessageToCurrentSession(userMsg);
      scrollToEnd();
      try {
        const generated = await generateImageFromPrompt(trimmed);
        const assistantMsg = {
          id: makeId(),
          role: "assistant" as const,
          content:
            language === "en"
              ? "Here is the generated image:"
              : language === "uk"
              ? "Ось згенероване зображення:"
              : "Вот сгенерированное изображение:",
          timestamp: Date.now(),
          attachment: {
            kind: "media" as const,
            name: generated.displayName,
            uri: generated.uri,
            source: "GENERATED" as const,
          },
        };
        addMessageToCurrentSession(assistantMsg);
        scrollToEnd();
      } catch (genErr: unknown) {
        logError("Chat", `Ошибка генерации изображения: ${errorMessage(genErr)}`);
      }
      return;
    }

    // Обычное текстовое сообщение, без вложений.
    logInfo("Chat", `${t("logSendMessage")} ${trimmed.slice(0, 50)}...`);
    const userMsg = {
      id: makeId(),
      role: "user" as const,
      content: trimmed,
      timestamp: Date.now(),
    };
    addMessageToCurrentSession(userMsg);
    scrollToEnd();
    try {
      const response = await sendMessage(userMsg.content);
      const isModelError = response.startsWith(`${t("modelError")}:`);
      if (isModelError) {
        // Provider failures are diagnostics/status, not successful assistant replies.
        // Keep the chat state clean so a failed request cannot create a false checkpoint.
        logError("Chat", response);
        showDialog(t("modelError"), response, [{ text: "OK" }]);
        scrollToEnd();
        return;
      }
      const assistantMsg = {
        id: makeId(),
        role: "assistant" as const,
        content: response,
        timestamp: Date.now(),
      };
      addMessageToCurrentSession(assistantMsg);
      logInfo("Chat", t("logAiResponse"));
      if (voiceSettings.autoSpeakResponses || voiceSettings.voiceConversationMode) {
        voicePlayback.speakText(assistantMsg.id, response, language, {
          speed: voiceSettings.ttsSpeed,
          readCodeBlocks: voiceSettings.readCodeBlocks,
        }).catch(() => {});
      }
      // Не создаём успешный checkpoint после provider/model error.
      if (!isModelError) {
        createCheckpoint(
          currentSession?.id || "default",
          t("checkpointAfterReply"),
          [...currentSession.messages, userMsg, assistantMsg].map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          }))
        ).catch(() => {});
      } else {
        logError("Chat", "Checkpoint skipped because model call failed");
      }
      scrollToEnd();
    } catch (err: unknown) {
      logError("Chat", `${t("errorSend")} ${errorMessage(err)}`);
    }
    } finally {
      sendInFlightRef.current = false;
    }
  }, [input, pendingAttachments, isSessionAgentBusy, mode, onlineModel, customProvider, openCode, sendMessage, analyzeImage, addMessageToCurrentSession, currentSession, logInfo, logError, t, scrollToEnd, clearCurrentChat, voiceSettings, language, showDialog]);

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  // Универсальный выбор любого файла (PDF, DOCX, XLSX, код, APK, ZIP)
  const handleAttachFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
      });

      if (result.canceled === false && result.assets && result.assets.length > 0) {
        const file = result.assets[0];
        logInfo("Chat", `${t("fileSelected")} ${file.name}`);
        const attachment: PendingAttachment = {
          kind: "file",
          uri: file.uri,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
        };
        setPendingAttachments((prev) => [...prev, attachment].slice(0, 5));
      } else {
        logInfo("Chat", t("filePickCancelled"));
      }
    } catch (err: unknown) {
      logError("Chat", `${t("errorPickFile")} ${errorMessage(err)}`);
    }
  }, [logInfo, logError, t]);

  const handleAttachImage = useCallback(async () => {
    try {
      // SAF/system picker grants access only to the selected image URI;
      // gallery access does not need broad Android READ_MEDIA_* permissions.
      const result = await DocumentPicker.getDocumentAsync({
        type: "image/*",
        copyToCacheDirectory: true,
      });

      if (result.canceled === false && result.assets && result.assets.length > 0) {
        const image = result.assets[0];
        const fileName = image.name || image.uri.split("/").pop() || "image";
        logInfo("Chat", `${t("imageSelected")} ${fileName}`);
        const attachment: PendingAttachment = { kind: "image", uri: image.uri, name: fileName, source: "GALLERY" };
        setPendingAttachments((prev) => [...prev, attachment].slice(0, 5));
      } else {
        logInfo("Chat", t("imagePickCancelled"));
      }
    } catch (err: unknown) {
      logError("Chat", `${t("errorPickImage")} ${errorMessage(err)}`);
    }
  }, [logInfo, logError, t]);

  const handleAttachVideo = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "videos",
        allowsEditing: false,
      });

      if (result.canceled === false && result.assets && result.assets.length > 0) {
        const video = result.assets[0];
        const fileName = video.uri.split("/").pop() || "video.mp4";
        logInfo("Chat", `Видео выбрано: ${fileName}`);
        const attachment: PendingAttachment = { kind: "video", uri: video.uri, name: fileName };
        setPendingAttachments((prev) => [...prev, attachment].slice(0, 5));
      }
    } catch (err: unknown) {
      logError("Chat", `Ошибка выбора видео: ${errorMessage(err)}`);
    }
  }, [logInfo, logError]);

  const handleAttachAudio = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "audio/*",
        copyToCacheDirectory: true,
      });

      if (result.canceled === false && result.assets && result.assets.length > 0) {
        const audio = result.assets[0];
        logInfo("Chat", `Аудио выбрано: ${audio.name}`);
        const attachment: PendingAttachment = { kind: "audio", uri: audio.uri, name: audio.name };
        setPendingAttachments((prev) => [...prev, attachment].slice(0, 5));
      }
    } catch (err: unknown) {
      logError("Chat", `Ошибка выбора аудио: ${errorMessage(err)}`);
    }
  }, [logInfo, logError]);

  const confirmOfflineDeviceInstall = useCallback((details: Readonly<{ projectId: string; applicationId: string; variant: "debug" }>) => {
    const title = language === "en" ? "Install this debug APK?" : language === "uk" ? "Встановити цей debug APK?" : "Установить этот debug APK?";
    const message = language === "en"
      ? `Install ${details.applicationId} (debug) on the explicitly connected device? This does not grant ADB access.`
      : language === "uk"
        ? `Встановити ${details.applicationId} (debug) на явно підключений пристрій? Це не надає дозвіл ADB.`
        : `Установить ${details.applicationId} (debug) на явно подключённое устройство? Это не выдаёт разрешение ADB.`;
    const cancelText = language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена";
    const installText = language === "en" ? "Install debug APK" : language === "uk" ? "Встановити debug APK" : "Установить debug APK";
    return confirmDialog(title, message, installText, cancelText);
  }, [confirmDialog, language]);

  const runOfflineAgentTask = useCallback(async (allowFileWrites: boolean, allowAndroidToolchain = false, allowDeviceInstall = false) => {
    const prompt = input.trim();
    if (!project || !prompt || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0) return;
    const controller = new AbortController();
    offlineAgentAbortRef.current = controller;
    setIsOfflineAgentRunning(true);
    setInput("");
    const userMsg = { id: makeId(), role: "user" as const, content: prompt, timestamp: Date.now() };
    addMessageToCurrentSession(userMsg);
    logInfo("OfflineAgent", `Started ${allowFileWrites ? "write-enabled" : "read-only"} project task${allowAndroidToolchain ? " with local Android debug toolchain" : ""}${allowDeviceInstall ? " and per-install confirmation" : ""}`);
    const history = (currentSession?.messages || [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-12)
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
    try {
      const response = await runOfflineAgent(project?.id || "", prompt, {
        allowFileWrites,
        allowAndroidToolchain,
        allowDeviceInstall,
        ...(allowDeviceInstall ? { confirmDeviceInstall: confirmOfflineDeviceInstall } : {}),
        allowHybridFallback: false,
        language: language === "uk" || language === "ru" ? language : "en",
        history,
        signal: controller.signal,
      });
      addMessageToCurrentSession({ id: makeId(), role: "assistant", content: response, timestamp: Date.now() });
    } catch (error: unknown) {
      const rawCode = error instanceof Error ? error.message : "OFFLINE_AGENT_FAILED";
      const code = rawCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 80) || "OFFLINE_AGENT_FAILED";
      if (code === "OFFLINE_AGENT_ABORTED" || code === "ABORTED") {
        addMessageToCurrentSession({
          id: makeId(), role: "assistant",
          content: language === "en" ? "Offline agent run cancelled." : language === "uk" ? "Офлайн-запуск агента скасовано." : "Офлайн-запуск агента отменён.",
          timestamp: Date.now(),
        });
      } else {
        const advice = code.includes("MODEL") || code.includes("GGUF")
          ? (language === "en" ? " Select or download a local GGUF model in Settings." : language === "uk" ? " Виберіть або завантажте локальну GGUF-модель у налаштуваннях." : " Выберите или загрузите локальную GGUF-модель в настройках.")
          : "";
        const message = language === "en" ? `Offline agent failed (${code}).${advice}` : language === "uk" ? `Помилка офлайн-агента (${code}).${advice}` : `Ошибка офлайн-агента (${code}).${advice}`;
        addMessageToCurrentSession({ id: makeId(), role: "assistant", content: message, timestamp: Date.now() });
        logError("OfflineAgent", code);
      }
    } finally {
      if (offlineAgentAbortRef.current === controller) offlineAgentAbortRef.current = null;
      setIsOfflineAgentRunning(false);
      scrollToEnd();
    }
  }, [input, project, isOfflineAgentRunning, isSessionAgentBusy, pendingAttachments.length, addMessageToCurrentSession, currentSession, runOfflineAgent, confirmOfflineDeviceInstall, language, logInfo, logError, scrollToEnd]);

  const requestOfflineEditConsent = useCallback(() => {
    if (!project || !input.trim() || pendingAttachments.length > 0 || isOfflineAgentRunning || isSessionAgentBusy) return;
    const title = language === "en" ? "Allow project edits?" : language === "uk" ? "Дозволити зміни проєкту?" : "Разрешить изменения проекта?";
    const message = language === "en"
      ? "The offline agent may create directories and write files only inside the active project. Each file write requires a private checkpoint or snapshot."
      : language === "uk"
        ? "Офлайн-агент зможе створювати каталоги й змінювати файли лише в активному проєкті. Перед кожним записом створюється приватна контрольна точка або знімок."
        : "Офлайн-агент сможет создавать каталоги и менять файлы только в активном проекте. Перед каждой записью создаётся приватная контрольная точка или снимок.";
    showDialog(title, message, [
      { text: language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена", style: "cancel" },
      { text: language === "en" ? "Allow edits" : language === "uk" ? "Дозволити" : "Разрешить", onPress: () => { void runOfflineAgentTask(true); } },
    ]);
  }, [project, input, pendingAttachments.length, isOfflineAgentRunning, isSessionAgentBusy, language, runOfflineAgentTask]);

  const requestOfflineToolchainConsent = useCallback(() => {
    if (!project || !input.trim() || pendingAttachments.length > 0 || isOfflineAgentRunning || isSessionAgentBusy) return;
    const title = language === "en" ? "Allow local Android debug tools?" : language === "uk" ? "Дозволити локальні Android debug-інструменти?" : "Разрешить локальные Android debug-инструменты?";
    const message = language === "en"
      ? "This enables only local assembleDebug with Gradle --offline (cached dependencies) and host-owned debug signing. It grants no generic shell/network tool, release signing, or device install capability. Gradle/plugin code still runs with the app UID; --offline is not an OS network sandbox, so use only trusted project code. App identity, lockfiles, and Android build settings are protected. Choose whether this run may also edit other project files; each write is checkpointed."
      : language === "uk"
        ? "Доступна лише локальна assembleDebug з Gradle --offline (кешовані залежності) і host-owned debug-підпис. Generic shell/network tool, release-підпис і встановлення не надаються. Gradle/plugin code усе одно працює з UID застосунку; --offline не є системним network sandbox, тому використовуйте лише довірений проєкт. Identity, lockfile і Android build settings захищені. Оберіть, чи може запуск змінювати інші файли; кожен запис має checkpoint."
        : "Доступна только локальная assembleDebug с Gradle --offline (кешированные зависимости) и host-owned debug-подпись. Generic shell/network tool, release-подпись и установка не предоставляются. Gradle/plugin code всё равно выполняется с UID приложения; --offline не является системным network sandbox, поэтому используйте только доверенный проект. Identity, lockfile и Android build settings защищены. Выберите, может ли запуск менять остальные файлы; каждая запись проходит checkpoint.";
    showDialog(title, message, [
      { text: language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена", style: "cancel" },
      { text: language === "en" ? "Build only" : language === "uk" ? "Лише збірка" : "Только сборка", onPress: () => { void runOfflineAgentTask(false, true, false); } },
      { text: language === "en" ? "Allow edits + build" : language === "uk" ? "Зміни + збірка" : "Правки + сборка", onPress: () => { void runOfflineAgentTask(true, true, false); } },
    ]);
  }, [project, input, pendingAttachments.length, isOfflineAgentRunning, isSessionAgentBusy, language, runOfflineAgentTask]);

  const requestOfflineInstallConsent = useCallback(() => {
    if (!project || !input.trim() || pendingAttachments.length > 0 || isOfflineAgentRunning || isSessionAgentBusy) return;
    const title = language === "en" ? "Allow one-run debug install mode?" : language === "uk" ? "Дозволити встановлення debug у цьому запуску?" : "Разрешить debug-установку в этом запуске?";
    if (!getRuntimeFacade().devicePolicy.isGranted("device.adb")) {
      showDialog(title, language === "en" ? "First grant the separate ADB capability in Runtime → Device Bridge. This action does not grant it." : language === "uk" ? "Спочатку окремо надайте дозвіл ADB у Runtime → Device Bridge. Ця дія його не надає." : "Сначала отдельно предоставьте ADB capability в Runtime → Device Bridge. Эта кнопка не выдаёт её.", [{ text: language === "en" ? "OK" : language === "uk" ? "Гаразд" : "Понятно" }]);
      return;
    }
    const message = language === "en"
      ? "This run also permits project edits (checkpointed) and local debug build/sign. Installing remains a separate confirmation showing the exact package; no release signing or shell/network capability is enabled."
      : language === "uk"
        ? "Цей запуск також дозволяє зміни проєкту (з checkpoint) і локальну debug-збірку/підпис. Кожне встановлення потребує окремого підтвердження з точним package; release-підпис і shell/мережа не надаються."
        : "Этот запуск также разрешает правки проекта (с checkpoint) и локальную debug-сборку/подпись. Каждая установка отдельно подтверждается с точным package; release-подпись и shell/сеть не выдаются.";
    showDialog(title, message, [
      { text: language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена", style: "cancel" },
      { text: language === "en" ? "Allow this run" : language === "uk" ? "Дозволити запуск" : "Разрешить запуск", onPress: () => { void runOfflineAgentTask(true, true, true); } },
    ]);
  }, [project, input, pendingAttachments.length, isOfflineAgentRunning, isSessionAgentBusy, language, runOfflineAgentTask]);

  // Lock normal chat only in the session that owns a running agent.
  const canSend = !isSessionAgentBusy && !isOfflineAgentRunning && (!!input.trim() || pendingAttachments.length > 0);
  const canStop = isSessionAgentBusy || isOfflineAgentRunning;
  const activityStillRunning = !!termuxActivity && (termuxActivity.taskStatus ? termuxActivity.taskStatus === "running" : termuxActivity.buildStatus !== "verified");
  const thinkingIndicatorActive = !!isSessionAgentBusy || (!!activityStillRunning && !isAgentRunningInOtherSession);
  const thinkingIndicatorVisible = thinkingIndicatorActive;
  const indicatorAllocation = allocateIndicatorBodyHeights(
    chatViewportHeight || Math.max(0, Dimensions.get("window").height - insets.top - insets.bottom - 200),
    {
      buildVisible: false,
      thinkingVisible: thinkingIndicatorVisible,
      buildExpanded: buildProgressExpanded,
      thinkingExpanded: thinkingPanelExpanded,
    },
  );

  // ВАЖНО (фикс "бесконечно растягивающегося пустого поля" при длинных
  // ответах ИИ): раньше renderItem был инлайн-функцией, создаваемой заново
  // при КАЖДОМ рендере ChatScreen — а ChatScreen перерисовывался на каждое
  // нажатие клавиши в поле ввода (setInput). Новая ссылка на renderItem
  // заставляла FlatList перерисовывать ВСЕ сообщения в чате, включая
  // подсветку синтаксиса во всех блоках кода, при каждом нажатии клавиши.
  // Чем длиннее ответ (больше кода/текста) — тем тяжелее становился этот
  // пересчёт на каждый символ, и UI начинал "зависать": список визуально
  // дёргался/растягивался пустым пространством, а поле ввода переставало
  // успевать реагировать на ввод. useCallback с стабильными зависимостями
  // решает это — renderItem не пересоздаётся на каждое нажатие клавиши.
  const renderItem = useCallback(
    ({ item }: { item: (typeof currentSession.messages)[number] }) => (
      item ? <ChatBubble message={item} onDelete={deleteMessage} /> : null
    ),
    [deleteMessage]
  );

  return (
    <View style={[styles.outer, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { backgroundColor: colors.headerBg, borderBottomColor: colors.line }]}>
        <ModelModeSwitch
          enabled={termuxEnabled}
          checking={termuxChecking}
          onSetEnabled={setTermuxEnabled}
        />
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
          <EnvironmentHeaderBadges />
        </View>
        <TouchableOpacity
          style={{
            backgroundColor: "#2F4F4F",
            borderColor: "#2F4F4F",
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
          onPress={() => {
            logInfo("Chat", t("logNewChat"));
            createNewChat();
          }}
        >
          <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "700" }}>{t("newChat")}</Text>
        </TouchableOpacity>
      </View>

      {/* Быстрое переключение чатов на главном экране */}
      {sessions && sessions.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ maxHeight: 44, flexGrow: 0 }}
          contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 6, gap: 8, alignItems: "center" }}
        >
          {sessions.filter((sess) => sess && sess.id).slice(0, 12).map((sess) => {
            const active = sess.id === currentSessionId;
            const title = (sess.title || "Чат").slice(0, 22);
            return (
              <TouchableOpacity
                key={sess.id}
                onPress={() => setCurrentSessionId(sess.id)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: active ? "#2F4F4F" : "#3A4148",
                  backgroundColor: active ? "#2F4F4F" : "#1F242A",
                  maxWidth: 160,
                }}
              >
                <Text numberOfLines={1} style={{ color: active ? "#FFFFFF" : "#C5CDD4", fontSize: 12, fontWeight: active ? "700" : "500" }}>
                  {title}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      ) : null}

      {/* Unified workspace: chat with one lower task-progress indicator. */}
      <View
        style={[styles.chatArea, { flex: 1, minHeight: 0, overflow: "hidden" }]}
        onLayout={(event) => setChatViewportHeight(Math.round(event.nativeEvent.layout.height))}
      >
        {isAgentRunningInOtherSession ? (
          <View style={{ marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.warningDim }}>
            <Text style={{ color: colors.warning, fontSize: 11, fontWeight: "700" }}>
              {language === "en"
                ? "Termux agent is busy in another chat — replies here are model-only. Termux stays ON so that build is not stopped."
                : language === "uk"
                  ? "Termux-агент зайнятий в іншому чаті — тут відповіді лише від моделі. Termux лишається увімкненим, збірку не зупиняємо."
                  : "Termux-агент занят в другом чате — здесь ответы только от модели. Termux остаётся включённым, сборку не прерываем."}
            </Text>
          </View>
        ) : null}



        <View style={{ flex: 1, minHeight: 80 }}>
<FlatList
        ref={flatListRef}
        data={currentSession?.messages || []}
        keyExtractor={(item, index) => item?.id || `msg-${index}`}
        contentContainerStyle={styles.messagesList}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // ВАЖНО (фикс "бесконечно растягивающегося пустого поля" ПОСЛЕ
        // очень длинного ответа ИИ — жалоба пользователя со скриншотом):
        // на Android FlatList по умолчанию включает removeClippedSubviews,
        // который "отклеивает" (unmount) нативные view элементов списка,
        // как только они уходят за пределы окна рендера (windowSize), чтобы
        // экономить память. Для ОБЫЧНЫХ (невысоких) элементов это незаметно,
        // но один пузырёк чата с очень длинным ответом (много текста и/или
        // несколько блоков кода) может быть в разы выше экрана — и именно
        // на таких высоких элементах recycling на Android нередко неверно
        // пересчитывает высоту при повторном приклеивании, оставляя после
        // себя растущую пустую область внизу списка вместо реального
        // содержимого. removeClippedSubviews={false} отключает этот
        // recycling целиком: для чата с разумным количеством сообщений
        // (десятки-сотни, не тысячи) это не создаёт проблем с памятью, зато
        // полностью убирает первопричину бага. windowSize/initialNumToRender/
        // maxToRenderPerBatch увеличены, чтобы соседние с текущим экраном
        // сообщения тоже держались отрисованными и не "мигали" при скролле.
        removeClippedSubviews={false}
        windowSize={21}
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        updateCellsBatchingPeriod={50}
        // maintainVisibleContentPosition убран: он нужен спискам, у которых
        // контент добавляется СВЕРХУ (например, инвертированные чаты). Здесь
        // сообщения всегда добавляются СНИЗУ, а этот проп в паре с
        // onLayout=scrollToEnd (см. ниже, тоже убран) вызывал на Android
        // известный баг — список после длинного ответа "не мог" правильно
        // посчитать конец контента и оставлял снизу растущую пустую область.
        // onContentSizeChange (единственный источник автоскролла ниже)
        // срабатывает именно тогда, когда реально меняется контент, и этого
        // достаточно, чтобы прокручивать чат к последнему сообщению.
        onContentSizeChange={scrollToEnd}
        renderItem={renderItem}
        style={styles.list}
        scrollEnabled={true}
        nestedScrollEnabled
      />
        </View>

        {thinkingIndicatorVisible ? (
        <View style={{ flexShrink: 0 }}>
          <AgentThinkingPanel
            active={thinkingIndicatorActive}
            compact={!!isSessionAgentBusy || !!termuxActivity}
            expanded={thinkingPanelExpanded}
            onExpandedChange={setThinkingPanelExpanded}
            maxBodyHeight={indicatorAllocation.thinkingBodyHeight}
            equalShare={indicatorAllocation.equalShare}
          />
        </View>
        ) : null}
      </View>

      <Animated.View style={[styles.inputWrapper, inputWrapperAnimatedStyle, { backgroundColor: colors.background, borderTopColor: colors.line }]}>
        {/* Voice conversation mode banner */}
        {voiceSettings.voiceConversationMode && (
          <View style={[styles.voiceModeBanner, { backgroundColor: "rgba(159, 203, 255, 0.12)", borderColor: colors.accent }]}>
            <Ionicons name="mic-circle" size={16} color={colors.accent} />
            <Text style={[styles.voiceModeText, { color: colors.accent }]}>
              {language === "en" ? "Voice conversation mode active" : language === "uk" ? "Голосовий режим активний" : "Голосовой режим активен"}
            </Text>
          </View>
        )}

        {/* Listening banner */}
        {isListening && (
          <View style={styles.listeningBanner}>
            <View style={styles.listeningDot} />
            <Text style={styles.listeningText}>
              {language === "en" ? "Listening... Speak now" : language === "uk" ? "Слухаю... Говоріть" : "Слушаю... Говорите"}
            </Text>
          </View>
        )}

        {/* Horizontal scrollable pending attachments list */}
        {pendingAttachments.length > 0 && (
          <View style={styles.attachmentPreviewRow}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachmentPreviewScroll}>
              {pendingAttachments.map((att, idx) => (
                <View key={`${att.name}-${idx}`} style={[styles.attachmentPreviewChip, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}>
                  {att.kind === "image" ? (
                    <Image source={{ uri: att.uri }} style={styles.attachmentPreviewThumb} />
                  ) : (
                    <View style={styles.attachmentPreviewIconWrap}>
                      <Text style={styles.attachmentPreviewIcon}>
                        {att.kind === "audio" ? "🎵" : att.kind === "video" ? "🎥" : "📄"}
                      </Text>
                    </View>
                  )}
                  <Text style={[styles.attachmentPreviewName, { color: colors.inkBright }]} numberOfLines={1}>
                    {att.name}
                  </Text>
                  <TouchableOpacity
                    style={styles.attachmentPreviewRemove}
                    onPress={() => handleRemoveAttachment(idx)}
                    accessibilityLabel={t("removeAttachment")}
                  >
                    <Ionicons name="close-circle" size={18} color="#9AA3AC" />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {project ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 10, paddingBottom: 6 }}>
            <TouchableOpacity
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16, backgroundColor: colors.accentDim, opacity: !input.trim() || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0 ? 0.48 : 1 }}
              onPress={() => { void runOfflineAgentTask(false); }}
              disabled={!input.trim() || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0}
              accessibilityRole="button"
              accessibilityLabel={language === "en" ? "Run offline agent, read-only" : language === "uk" ? "Запустити офлайн-агента лише для читання" : "Запустить офлайн-агента только для чтения"}
              testID="offline-agent-readonly"
            >
              <Ionicons name="hardware-chip-outline" size={15} color={colors.accent} />
              <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "600" }}>{isOfflineAgentRunning ? (language === "en" ? "Offline agent running…" : language === "uk" ? "Офлайн-агент працює…" : "Офлайн-агент работает…") : (language === "en" ? "Offline · read-only" : language === "uk" ? "Офлайн · читання" : "Офлайн · чтение")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: colors.line, opacity: !input.trim() || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0 ? 0.48 : 1 }}
              onPress={requestOfflineEditConsent}
              disabled={!input.trim() || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0}
              accessibilityRole="button"
              accessibilityLabel={language === "en" ? "Run offline agent with file edits, asks first" : language === "uk" ? "Офлайн-агент зі змінами файлів, спочатку запитає" : "Офлайн-агент с изменением файлов, сначала спросит"}
              testID="offline-agent-edit"
            >
              <Ionicons name="create-outline" size={15} color={colors.inkBright} />
              <Text style={{ color: colors.inkBright, fontSize: 12 }}>{language === "en" ? "Allow edits…" : language === "uk" ? "Дозволити зміни…" : "Разрешить изменения…"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: colors.accent, opacity: !input.trim() || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0 ? 0.48 : 1 }}
              onPress={requestOfflineToolchainConsent}
              disabled={!input.trim() || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0}
              accessibilityRole="button"
              accessibilityLabel={language === "en" ? "Allow local Android debug build tools" : language === "uk" ? "Дозволити локальні Android debug-інструменти" : "Разрешить локальные Android debug-инструменты"}
              testID="offline-agent-toolchain"
            >
              <Ionicons name="construct-outline" size={15} color={colors.accent} />
              <Text style={{ color: colors.accent, fontSize: 12 }}>{language === "en" ? "Build tools…" : language === "uk" ? "Інструменти збірки…" : "Инструменты сборки…"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: colors.line, opacity: !input.trim() || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0 ? 0.48 : 1 }}
              onPress={requestOfflineInstallConsent}
              disabled={!input.trim() || isOfflineAgentRunning || isSessionAgentBusy || pendingAttachments.length > 0}
              accessibilityRole="button"
              accessibilityLabel={language === "en" ? "Allow local debug build and separately confirmed device install" : language === "uk" ? "Дозволити локальну debug-збірку та окремо підтверджене встановлення" : "Разрешить локальную debug-сборку и отдельно подтверждаемую установку"}
              testID="offline-agent-install"
            >
              <Ionicons name="phone-portrait-outline" size={15} color={colors.inkBright} />
              <Text style={{ color: colors.inkBright, fontSize: 12 }}>{language === "en" ? "Build + install…" : language === "uk" ? "Збірка + встановлення…" : "Сборка + установка…"}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={[styles.inputContainer, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}> 
          {/* Unified [ + ] Universal Attachment Menu */}
          <TouchableOpacity
            style={[styles.iconButton, styles.plusButton, { backgroundColor: colors.accentDim }]}
            onPress={() => setAttachmentMenuVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Universal attachment menu"
          >
            <Ionicons name="add" size={22} color={colors.accent} />
          </TouchableOpacity>

          <TextInput
            style={[styles.input, { color: colors.inkBright }]}
            value={input}
            onChangeText={handleChangeText}
            placeholder={t("writeRequest")}
            placeholderTextColor="#9AA3AC"
            multiline
            maxLength={20000}
          />

          <TouchableOpacity
            style={[styles.iconButton, styles.voiceButton, isListening && { backgroundColor: "rgba(239, 68, 68, 0.16)" }]}
            onPress={toggleVoiceInput}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityLabel={isListening ? t("stopGeneration") : t("voiceInput")}
            testID="chat-voice-button"
          >
            <Ionicons name={isListening ? "mic" : "mic-outline"} size={21} color={isListening ? "#FFB4AB" : colors.inkBright} />
          </TouchableOpacity>

          {canStop ? (
            <TouchableOpacity style={[styles.actionButton, styles.stopActionButton]} onPress={() => { if (isOfflineAgentRunning) offlineAgentAbortRef.current?.abort(); stopGeneration(); }} accessibilityLabel={t("stopGeneration")}>
              <Ionicons name="stop" size={17} color={colors.onDanger || "#690005"} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.actionButton, { backgroundColor: "#2F4F4F" }, !canSend && styles.actionButtonDisabled]} onPress={() => handleSend()} disabled={!canSend} accessibilityLabel={t("send")}>
              <Ionicons name="arrow-up" size={19} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>

      <UniversalAttachmentMenu
        visible={attachmentMenuVisible}
        onClose={() => setAttachmentMenuVisible(false)}
        onSelectCamera={() => setCameraModalVisible(true)}
        onSelectGallery={handleAttachImage}
        onSelectVideo={handleAttachVideo}
        onSelectAudio={handleAttachAudio}
        onSelectDocument={handleAttachFile}
      />

      <CameraCaptureModal
        visible={cameraModalVisible}
        onClose={() => setCameraModalVisible(false)}
        onPhotoAccepted={(attachment) => {
          const pending: PendingAttachment = {
            kind: "image",
            uri: attachment.uri,
            name: attachment.displayName || attachment.uri.split("/").pop() || "camera.jpg",
            source: "CAMERA",
          };
          setPendingAttachments((prev) => [...prev, pending].slice(0, 5));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1 },
  chatArea: { flex: 1 },
  chatSplitArea: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "transparent",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  list: { flex: 1 },
  listNested: { flexGrow: 0 },
  messagesList: { padding: 16, paddingBottom: 8 },
  typingIndicator: { paddingHorizontal: 16, paddingVertical: 6 },
  typingText: { color: "#9FCBFF", fontSize: 12 },
  newChatButtonTop: {
    backgroundColor: "#2F4F4F",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#2F4F4F",
  },
  newChatTextTop: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
  quickActionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  quickChip: {
    backgroundColor: "#1F242A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#3A4148",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  quickChipText: { color: "#9FCBFF", fontSize: 12, fontWeight: "600" },
  activityBar: {
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
  },
  inputWrapper: {
    backgroundColor: "#101418",
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#3A4148",
  },
  attachmentPreviewRow: { marginBottom: 6 },
  attachmentPreviewChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    backgroundColor: "#1F242A",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#3A4148",
    paddingVertical: 4,
    paddingHorizontal: 6,
    gap: 6,
  },
  attachmentPreviewThumb: { width: 28, height: 28, borderRadius: 8 },
  attachmentPreviewIconWrap: {
    width: 28, height: 28, borderRadius: 8,
    backgroundColor: "rgba(159, 203, 255, 0.12)",
    alignItems: "center", justifyContent: "center",
  },
  attachmentPreviewIcon: { fontSize: 15 },
  attachmentPreviewName: { color: "#E2E2E6", fontSize: 12.5, maxWidth: 160 },
  attachmentPreviewRemove: { padding: 2 },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1F242A",
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#3A4148",
    marginBottom: 4,
  },
  iconButton: {
    width: 36,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: 1,
  },
  voiceButton: {
    marginLeft: 2,
  },
  input: {
    flex: 1,
    color: "#F0F1F3",
    fontSize: 15,
    maxHeight: 100,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minHeight: 36,
  },
  actionButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 3,
    shadowOpacity: 0.18,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  stopActionButton: { backgroundColor: "#FFB4AB" },
  actionButtonDisabled: { opacity: 0.32, shadowOpacity: 0, elevation: 0 },
  plusButton: {
    marginRight: 4,
    borderRadius: 18,
  },
  attachmentPreviewScroll: {
    gap: 8,
    paddingVertical: 2,
  },
  listeningBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 180, 171, 0.14)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 6,
    gap: 6,
    alignSelf: "flex-start",
  },
  listeningDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#FFB4AB",
  },
  listeningText: {
    color: "#FFB4AB",
    fontSize: 12,
    fontWeight: "600",
  },
  voiceModeBanner: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 6,
    gap: 6,
    alignSelf: "flex-start",
  },
  voiceModeText: {
    fontSize: 12,
    fontWeight: "600",
  },
});
