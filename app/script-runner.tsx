import { isWithinSharedAppRoot } from "../lib/writable-path-policy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useTheme } from "../components/ThemeContext";
import { useTermuxContext, type TermuxActivity } from "../components/TermuxContext";
import { useLanguage } from "../components/LanguageContext";
import { Checkbox } from "../components/Checkbox";
import { useLLMContext } from "../components/LLMContext";
import { useLoggerContext } from "../components/LoggerContext";
import { useDialog } from "../components/DialogContext";
import { executeGuardedTermuxCommand } from "../lib/termux-executor";
import { buildStopCommand } from "../lib/builtin-build-script";
import { runScriptWithAgent, type ScriptAgentEvent } from "../lib/script-runner-agent";
import {
  notifyAgentStarted,
  notifyAgentDone,
  notifyAgentFailed,
  notifyBuildProgress,
} from "../lib/app-notifications";
import { highlightCode, TOKEN_COLORS, type HighlightToken } from "../lib/code-highlight";
import {
  STORAGE_RUN_HISTORY,
  MAX_RUN_HISTORY,
  extractApkPathFromLog,
  isValidApkCandidatePath,
  sanitizeRunHistory,
  tailLog,
  type RunHistoryEntry,
} from "../lib/script-templates";
import { summarizeFailure } from "../lib/scripted-task-engine";
import { getTermuxNative } from "../lib/termux-bridge";
import { getDesktopContentStyle, loadDesktopMode, isDesktopMode } from "../lib/appearance-prefs";

const STORAGE_SCRIPTS = "aibuilder.script_runner.saved_scripts.v2";
const STORAGE_SELECTED = "aibuilder.script_runner.selected_id.v2";
const STORAGE_USE_AGENT = "aibuilder.script_runner.use_agent.v1";

type IconName =
  | "code-slash-outline"
  | "terminal-outline"
  | "rocket-outline"
  | "construct-outline"
  | "flash-outline"
  | "bug-outline"
  | "server-outline"
  | "cloud-upload-outline"
  | "build-outline"
  | "hardware-chip-outline"
  | "git-branch-outline"
  | "shield-checkmark-outline";

interface SavedScript {
  id: string;
  name: string;
  icon: IconName;
  body: string;
  updatedAt: number;
}

const ICON_OPTIONS: IconName[] = [
  "code-slash-outline",
  "terminal-outline",
  "rocket-outline",
  "construct-outline",
  "flash-outline",
  "bug-outline",
  "server-outline",
  "cloud-upload-outline",
  "build-outline",
  "hardware-chip-outline",
  "git-branch-outline",
  "shield-checkmark-outline",
];

function uid(): string {
  return `scr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function HighlightedBash({ code, style }: { code: string; style?: object }) {
  const tokens = useMemo(() => highlightCode(code, "python"), [code]);
  return (
    <Text style={[{ fontFamily: Platform.OS === "android" ? "monospace" : "Menlo", fontSize: 12, lineHeight: 18 }, style]}>
      {tokens.map((tok: HighlightToken, i: number) => (
        <Text key={i} style={{ color: TOKEN_COLORS[tok.kind] || TOKEN_COLORS.plain }}>
          {tok.text}
        </Text>
      ))}
    </Text>
  );
}

export default function ScriptRunnerScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { language, t } = useLanguage();
  const [desktopLayout, setDesktopLayout] = useState(isDesktopMode());
  const pageScrollRef = useRef<ScrollView>(null);
  useEffect(() => { void loadDesktopMode().then(setDesktopLayout); }, []);
  const { addMessageToCurrentSession, completePrompt } = useLLMContext();
  const { logInfo, logError } = useLoggerContext();
  const { showDialog, confirmDialog } = useDialog();
  const { setActivity } = useTermuxContext();

  const ru = language === "ru";
  const uk = language === "uk";

  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [useAgent, setUseAgent] = useState(true);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [statusLine, setStatusLine] = useState("");
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [lastApkPath, setLastApkPath] = useState<string | null>(null);
  const abortRef = useRef(false);
  const loadedRef = useRef(false);
  const scriptsRef = useRef<SavedScript[]>([]);
  const scriptsPersistingRef = useRef(false);
  const selectedPersistingRef = useRef(false);
  const agentPersistingRef = useRef(false);
  const scriptsHydratedRef = useRef(false);
  const scriptsLoadFailedRef = useRef(false);
  const scriptsHydratedPromiseRef = useRef<Promise<void> | null>(null);
  const resolveScriptsHydratedRef = useRef<(() => void) | null>(null);
  if (!scriptsHydratedPromiseRef.current) {
    scriptsHydratedPromiseRef.current = new Promise<void>((resolve) => {
      resolveScriptsHydratedRef.current = resolve;
    });
  }

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_RUN_HISTORY);
        if (raw) {
          const parsed = JSON.parse(raw) as RunHistoryEntry[];
          if (Array.isArray(parsed)) {
            const safe = sanitizeRunHistory(parsed);
            setRunHistory(safe);
            setLastApkPath(safe.find((entry) => entry.ok && entry.apkPath)?.apkPath ?? null);
            void AsyncStorage.setItem(STORAGE_RUN_HISTORY, JSON.stringify(safe));
          }
        }
      } catch { /* ignore */ }
    })();
  }, []);

  const pushHistory = useCallback(async (entry: Omit<RunHistoryEntry, "id" | "at">) => {
    const full: RunHistoryEntry = {
      ...entry,
      id: `run-${Date.now().toString(36)}`,
      at: Date.now(),
    };
    setRunHistory((prev) => {
      const next = [full, ...prev].slice(0, MAX_RUN_HISTORY);
      void AsyncStorage.setItem(STORAGE_RUN_HISTORY, JSON.stringify(next));
      return next;
    });
    if (entry.ok && isValidApkCandidatePath(entry.apkPath)) setLastApkPath(entry.apkPath);
  }, []);

  const installLastApk = useCallback(async () => {
    if (!lastApkPath) return;
    try {
      const native = getTermuxNative();
      if (!native?.installApk) {
        showDialog("APK", lastApkPath);
        return;
      }
      // Never copy artifacts from another app's private data area. The embedded
      // runtime must provide an artifact in its own qualified workspace.
      const path = lastApkPath.replace(/^file:\/\//, "");
      if (!isWithinSharedAppRoot(path)) {
        showDialog("APK", language === "en"
          ? "This APK is outside the embedded runtime workspace; importing it from another app's private data is blocked."
          : language === "uk"
            ? "Цей APK поза робочим простором вбудованого runtime; імпорт із приватних даних іншого застосунку заблоковано."
            : "Этот APK находится вне рабочего пространства встроенного runtime; импорт из приватных данных другого приложения заблокирован.");
        return;
      }
      const uri = path.startsWith("file:") ? path : `file://${path}`;
      const started = await native.installApk(uri);
      showDialog("APK", started
        ? (ru ? "Запрос установки передан Android; результат установки не подтверждён." : "Install request handed to Android; installation is not confirmed.")
        : (ru ? "Android не запустил запрос установки." : "Android did not start the install request."));
    } catch (e: unknown) {
      showDialog("APK", String(e));
    }
  }, [lastApkPath, language, ru, showDialog]);

  // Draft for new script
  const [draftName, setDraftName] = useState("");
  const [draftIcon, setDraftIcon] = useState<IconName>("code-slash-outline");
  const [draftBody, setDraftBody] = useState("");

  // Editor modal
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState<IconName>("code-slash-outline");
  const [editBody, setEditBody] = useState("");
  const [editPreview, setEditPreview] = useState(false);

  const L = {
    title: t("scriptRunner"),
    hero: ru
      ? "Сохраните свои .sh-сценарии, выберите нужный и запустите в Termux. Прогресс — в чате и консоли Termux."
      : uk
        ? "Збережіть свої .sh-сценарії, оберіть потрібний і запустіть у Termux. Прогрес — у чаті та консолі Termux."
        : "Save your .sh scripts, pick one and run it in Termux. Progress appears in chat and the Termux console.",
    useAgent: ru ? "ИИ-агент (авто-исправление)" : uk ? "ІІ-агент (авто-виправлення)" : "AI agent (auto-fix)",
    useAgentDesc: ru
      ? "Если включён и модель подключена: следит за логом, при OOM / Broken pipe / ошибках Gradle снижает память, чистит процессы, правит параметры и повторяет сборку. Без модели — только детерминированные патчи."
      : uk
        ? "Якщо увімкнено і модель підключена: стежить за логом, при OOM / Broken pipe / помилках Gradle зменшує пам'ять, чистить процеси, править параметри і повторює збірку. Без моделі — лише детерміновані патчі."
        : "When on and a model is available: watches the log; on OOM / Broken pipe / Gradle errors lowers memory, cleans processes, patches settings and retries. Without a model — deterministic patches only.",
    agentPatch: ru ? "Агент применил патч" : uk ? "Агент застосував патч" : "Agent applied patch",
    agentRetry: ru ? "Повторная попытка" : uk ? "Повторна спроба" : "Retry attempt",
    agentExhausted: ru ? "Агент исчерпал попытки" : uk ? "Агент вичерпав спроби" : "Agent exhausted attempts",
    savedList: ru ? "Сохранённые сценарии" : uk ? "Збережені сценарії" : "Saved scripts",
    savedEmpty: ru
      ? "Пока нет сохранённых сценариев. Вставьте или загрузите .sh ниже и нажмите «Сохранить»."
      : uk
        ? "Поки немає збережених сценаріїв. Вставте або завантажте .sh нижче і натисніть «Зберегти»."
        : "No saved scripts yet. Paste or load a .sh below and tap Save.",
    select: ru ? "Выбрать" : uk ? "Обрати" : "Select",
    selected: ru ? "Выбран" : uk ? "Обрано" : "Selected",
    edit: ru ? "Изменить" : uk ? "Змінити" : "Edit",
    delete: ru ? "Удалить" : uk ? "Видалити" : "Delete",
    newScript: ru ? "Новый сценарий" : uk ? "Новий сценарій" : "New script",
    nameLabel: ru ? "Название" : uk ? "Назва" : "Name",
    namePh: ru ? "Например: Сборка APK" : uk ? "Наприклад: Збірка APK" : "e.g. Build APK",
    iconLabel: ru ? "Значок" : uk ? "Значок" : "Icon",
    scriptLabel: ru ? "Скрипт (.sh)" : uk ? "Скрипт (.sh)" : "Script (.sh)",
    scriptHint: ru
      ? "Вставьте bash-скрипт или загрузите файл с телефона, укажите название и значок, затем сохраните."
      : uk
        ? "Вставте bash-скрипт або завантажте файл з телефона, вкажіть назву та значок, потім збережіть."
        : "Paste a bash script or load a file, set a name and icon, then save.",
    saveScript: ru ? "Сохранить скрипт" : uk ? "Зберегти скрипт" : "Save script",
    loadScript: ru ? "Загрузить .sh" : uk ? "Завантажити .sh" : "Load .sh",
    clearDraft: ru ? "Очистить" : uk ? "Очистити" : "Clear",
    run: ru ? "Запуск" : uk ? "Запуск" : "Run",
    stop: ru ? "Стоп" : uk ? "Стоп" : "Stop",
    running: ru ? "Выполняется…" : uk ? "Виконується…" : "Running…",
    needScript: ru
      ? "Выберите сохранённый сценарий или сохраните новый."
      : uk
        ? "Оберіть збережений сценарій або збережіть новий."
        : "Select a saved script or save a new one.",
    needName: ru ? "Укажите название сценария." : uk ? "Вкажіть назву сценарію." : "Enter a script name.",
    needBody: ru ? "Скрипт пуст." : uk ? "Скрипт порожній." : "Script body is empty.",
    termuxNotReady: ru
      ? "Встроенная private runtime-среда не готова; запуск скрипта заблокирован до проверки окружения."
      : uk
        ? "Вбудоване private runtime-середовище не готове; запуск скрипту заблоковано до перевірки середовища."
        : "The embedded private runtime is not ready. Use the Runtime bootstrap/check controls.",
    saved: ru ? "Скрипт сохранён" : uk ? "Скрипт збережено" : "Script saved",
    persistFailed: ru ? "Не удалось сохранить изменения. Черновик и список оставлены без изменений." : uk ? "Не вдалося зберегти зміни. Чернетку та список не змінено." : "Could not save changes. The draft and list were left unchanged.",
    storageLoadFailed: ru ? "Не удалось прочитать сохранённые сценарии. Они не изменены; повторите попытку после перезапуска." : uk ? "Не вдалося прочитати збережені сценарії. Їх не змінено; повторіть спробу після перезапуску." : "Saved scripts could not be read. They were left untouched; try again after restarting.",
    selectionFailed: ru ? "Сценарий сохранён, но не удалось сохранить его выбор." : uk ? "Сценарій збережено, але не вдалося зберегти його вибір." : "The script was saved, but its selection could not be saved.",
    preferenceFailed: ru ? "Не удалось сохранить настройку агента." : uk ? "Не вдалося зберегти налаштування агента." : "Could not save the agent preference.",
    loaded: ru ? "Скрипт загружен" : uk ? "Скрипт завантажено" : "Script loaded",
    deleted: ru ? "Удалено" : uk ? "Видалено" : "Deleted",
    startedChat: `▶ ${t("scriptRunner")}`,
    finishedChat: ru ? "✓ Сценарий завершён" : uk ? "✓ Сценарій завершено" : "✓ Script finished",
    failedChat: ru ? "✗ Сценарий завершился с ошибкой" : uk ? "✗ Сценарій завершився з помилкою" : "✗ Script failed",
    stoppedChat: ru ? "■ Сценарий остановлен" : uk ? "■ Сценарій зупинено" : "■ Script stopped",
    stopHint: ru ? "Отправка сигнала остановки в Termux…" : uk ? "Надсилання сигналу зупинки в Termux…" : "Sending stop signal to Termux…",
    editorTitle: ru ? "Редактор сценария" : uk ? "Редактор сценарію" : "Script editor",
    preview: ru ? "Подсветка" : uk ? "Підсвітка" : "Highlight",
    editor: ru ? "Редактор" : uk ? "Редактор" : "Editor",
    cancel: ru ? "Отмена" : uk ? "Скасувати" : "Cancel",
    apply: ru ? "Сохранить" : uk ? "Зберегти" : "Save",
    confirmDelete: ru ? "Удалить сценарий?" : uk ? "Видалити сценарій?" : "Delete script?",
    confirmDeleteBody: ru ? "Действие необратимо." : uk ? "Дію неможливо скасувати." : "This cannot be undone.",
    export: ru ? "Экспорт" : uk ? "Експорт" : "Export",
    exported: ru ? "Скрипт экспортирован" : uk ? "Скрипт експортовано" : "Script exported",
    exportUnavailable: ru
      ? "Обмен файлами недоступен на этом устройстве."
      : uk
        ? "Обмін файлами недоступний на цьому пристрої."
        : "File sharing is not available on this device.",
    exportTitle: ru ? "Сохранить .sh" : uk ? "Зберегти .sh" : "Save .sh",
  };






  const persistScripts = useCallback(async (list: SavedScript[]) => {
    if (!scriptsHydratedRef.current) await scriptsHydratedPromiseRef.current;
    if (scriptsLoadFailedRef.current || scriptsPersistingRef.current) return false;
    scriptsPersistingRef.current = true;
    try {
      await AsyncStorage.setItem(STORAGE_SCRIPTS, JSON.stringify(list));
      scriptsRef.current = list;
      setScripts(list);
      return true;
    } catch {
      logError("ScriptRunner", "Failed to persist saved scripts");
      return false;
    } finally {
      scriptsPersistingRef.current = false;
    }
  }, [logError]);

  const persistSelected = useCallback(async (id: string | null) => {
    if (!scriptsHydratedRef.current) await scriptsHydratedPromiseRef.current;
    if (scriptsLoadFailedRef.current || selectedPersistingRef.current) return false;
    selectedPersistingRef.current = true;
    try {
      if (id) await AsyncStorage.setItem(STORAGE_SELECTED, id);
      else await AsyncStorage.removeItem(STORAGE_SELECTED);
      setSelectedId(id);
      return true;
    } catch {
      logError("ScriptRunner", "Failed to persist selected script");
      return false;
    } finally {
      selectedPersistingRef.current = false;
    }
  }, [logError]);

  const persistAgent = useCallback(async (v: boolean) => {
    if (!scriptsHydratedRef.current) await scriptsHydratedPromiseRef.current;
    if (agentPersistingRef.current) return false;
    agentPersistingRef.current = true;
    try {
      await AsyncStorage.setItem(STORAGE_USE_AGENT, v ? "1" : "0");
      setUseAgent(v);
      return true;
    } catch {
      logError("ScriptRunner", "Failed to persist agent preference");
      showDialog(L.title, L.preferenceFailed);
      return false;
    } finally {
      agentPersistingRef.current = false;
    }
  }, [logError, showDialog, L.title, L.preferenceFailed]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        const [rawResult, selResult, agentResult] = await Promise.allSettled([
          AsyncStorage.getItem(STORAGE_SCRIPTS),
          AsyncStorage.getItem(STORAGE_SELECTED),
          AsyncStorage.getItem(STORAGE_USE_AGENT),
        ]);
        let scriptsReadFailed = rawResult.status !== "fulfilled";
        let scriptsReadError: unknown = rawResult.status === "rejected" ? rawResult.reason : undefined;
        if (rawResult.status === "fulfilled") {
          try {
            if (rawResult.value) {
              const parsed = JSON.parse(rawResult.value) as SavedScript[];
              if (!Array.isArray(parsed)) throw new Error("Saved scripts are not an array");
              scriptsRef.current = parsed;
              setScripts(parsed);
            } else {
              scriptsRef.current = [];
              setScripts([]);
            }
          } catch (error) {
            scriptsReadFailed = true;
            scriptsReadError = error;
          }
        }
        if (selResult.status === "fulfilled" && selResult.value) setSelectedId(selResult.value);
        if (agentResult.status === "fulfilled" && agentResult.value != null) setUseAgent(agentResult.value === "1");
        if (scriptsReadFailed) {
          scriptsLoadFailedRef.current = true;
          logError("ScriptRunner", `Failed to load saved scripts: ${scriptsReadError instanceof Error ? scriptsReadError.message : String(scriptsReadError || "storage read failed")}`);
          showDialog(L.title, L.storageLoadFailed);
        }
      } catch (error) {
        scriptsLoadFailedRef.current = true;
        logError("ScriptRunner", `Failed to load saved scripts: ${error instanceof Error ? error.message : String(error)}`);
        showDialog(L.title, L.storageLoadFailed);
      } finally {
        scriptsHydratedRef.current = true;
        resolveScriptsHydratedRef.current?.();
        resolveScriptsHydratedRef.current = null;
      }
    })();
  }, [logError, showDialog, L.title, L.storageLoadFailed]);

  const selectedScript = useMemo(
    () => scripts.find((s) => s.id === selectedId) || null,
    [scripts, selectedId],
  );

  const handleLoadScript = useCallback(async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["text/x-shellscript", "application/x-sh", "text/plain", "*/*"],
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const asset = picked.assets[0];
      let body = "";
      try {
        const f = new File(asset.uri);
        body = await f.text();
      } catch {
        const res = await fetch(asset.uri);
        body = await res.text();
      }
      if (!body) {
        showDialog(t("modelError") || "Error", "Empty file");
        return;
      }
      setDraftBody(body);
      // After importing a script, bring the save/clear actions into view so the
      // user does not have to manually scroll past a long script body.
      requestAnimationFrame(() => pageScrollRef.current?.scrollToEnd({ animated: true }));
      const base = (asset.name || "script.sh").replace(/\.(sh|bash|zsh)$/i, "").trim();
      if (!draftName.trim() && base) setDraftName(base);
      showDialog(L.loaded, asset.name || L.loaded);
      logInfo("ScriptRunner", `loaded script ${asset.name || "?"} (${body.length} chars)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("ScriptRunner", msg);
      showDialog(t("modelError") || "Error", msg);
    }
  }, [draftName, showDialog, logInfo, logError, t, L.loaded]);

  const handleSaveDraft = useCallback(async () => {
    const name = draftName.trim();
    const body = draftBody;
    if (!name) {
      showDialog(L.title, L.needName);
      return;
    }
    if (!body.trim()) {
      showDialog(L.title, L.needBody);
      return;
    }
    if (!scriptsHydratedRef.current) await scriptsHydratedPromiseRef.current;
    if (scriptsLoadFailedRef.current) {
      showDialog(L.title, L.storageLoadFailed);
      return;
    }
    const item: SavedScript = {
      id: uid(),
      name,
      icon: draftIcon,
      body,
      updatedAt: Date.now(),
    };
    const next = [item, ...scriptsRef.current];
    if (!(await persistScripts(next))) {
      showDialog(L.title, scriptsLoadFailedRef.current ? L.storageLoadFailed : L.persistFailed);
      return;
    }
    const selectionSaved = await persistSelected(item.id);
    setDraftName("");
    setDraftBody("");
    setDraftIcon("code-slash-outline");
    showDialog(L.saved, selectionSaved ? name : `${name}\n\n${L.selectionFailed}`);
    logInfo("ScriptRunner", `saved script id=${item.id} name=${name} len=${body.length}`);
  }, [draftName, draftBody, draftIcon, persistScripts, persistSelected, showDialog, logInfo, L]);

  const handleClearDraft = useCallback(() => {
    setDraftName("");
    setDraftBody("");
    setDraftIcon("code-slash-outline");
  }, []);

  const openEdit = useCallback((s: SavedScript) => {
    setEditId(s.id);
    setEditName(s.name);
    setEditIcon(s.icon);
    setEditBody(s.body);
    setEditPreview(false);
    setEditOpen(true);
  }, []);

  const handleApplyEdit = useCallback(async () => {
    if (!editId) return;
    const name = editName.trim();
    if (!name) {
      showDialog(L.title, L.needName);
      return;
    }
    if (!editBody.trim()) {
      showDialog(L.title, L.needBody);
      return;
    }
    const next = scriptsRef.current.map((s) =>
      s.id === editId
        ? { ...s, name, icon: editIcon, body: editBody, updatedAt: Date.now() }
        : s,
    );
    if (!(await persistScripts(next))) {
      showDialog(L.title, scriptsLoadFailedRef.current ? L.storageLoadFailed : L.persistFailed);
      return;
    }
    setEditOpen(false);
    showDialog(L.saved, name);
  }, [editId, editName, editIcon, editBody, persistScripts, showDialog, L]);

  const handleDelete = useCallback(
    async (s: SavedScript) => {
      const ok = await confirmDialog(
        L.confirmDelete,
        `${s.name}\n\n${L.confirmDeleteBody}`,
        L.delete,
        L.cancel,
      );
      if (!ok) return;
      if (!scriptsHydratedRef.current) await scriptsHydratedPromiseRef.current;
      if (scriptsLoadFailedRef.current) {
        showDialog(L.title, L.storageLoadFailed);
        return;
      }
      const next = scriptsRef.current.filter((x) => x.id !== s.id);
      if (!(await persistScripts(next))) {
        showDialog(L.title, scriptsLoadFailedRef.current ? L.storageLoadFailed : L.persistFailed);
        return;
      }
      if (selectedId === s.id && !(await persistSelected(next[0]?.id ?? null))) {
        showDialog(L.title, L.selectionFailed);
      }
      logInfo("ScriptRunner", `deleted script id=${s.id}`);
    },
    [selectedId, persistScripts, persistSelected, confirmDialog, logInfo, showDialog, L],
  );

  const handleExport = useCallback(
    async (s: SavedScript) => {
      try {
        const safe = (s.name || "script")
          .replace(/[^\wа-яА-ЯёЁіІїЇєЄґҐ.\- ]+/gi, "_")
          .trim()
          .replace(/\s+/g, "_")
          .slice(0, 64) || "script";
        const fileName = safe.toLowerCase().endsWith(".sh") ? safe : `${safe}.sh`;
        const file = new File(Paths.cache, fileName);
        await file.write(s.body);
        const available = await Sharing.isAvailableAsync();
        if (!available) {
          showDialog(L.title, L.exportUnavailable);
          return;
        }
        await Sharing.shareAsync(file.uri, {
          mimeType: "text/x-shellscript",
          dialogTitle: L.exportTitle,
          UTI: "public.shell-script",
        });
        logInfo("ScriptRunner", `exported script id=${s.id} file=${fileName}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError("ScriptRunner", msg);
        showDialog(t("modelError") || "Error", msg);
      }
    },
    [showDialog, logInfo, logError, t, L],
  );

  const publishScenarioActivity = useCallback((patch: Partial<TermuxActivity>) => {
    setActivity({
      command: "",
      step: 1,
      maxSteps: 4,
      taskKind: "generic",
      taskStatus: "running",
      title: ru ? "Пользовательский сценарий" : uk ? "Користувацький сценарій" : "User scenario",
      stage: ru ? "Подготовка запуска…" : uk ? "Підготовка запуску…" : "Preparing run…",
      detail: ru ? "Проверяется окружение Termux" : uk ? "Перевіряється середовище Termux" : "Checking Termux environment",
      progressPercent: 5,
      ...patch,
    });
  }, [setActivity, ru, uk]);

  const postChat = useCallback(
    (role: "user" | "assistant" | "system", content: string) => {
      addMessageToCurrentSession({
        id: `script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role,
        content,
        timestamp: Date.now(),
      });
    },
    [addMessageToCurrentSession],
  );

  const handleRun = useCallback(async () => {
    if (!selectedScript) {
      showDialog(L.title, L.needScript);
      return;
    }
    if (runningRef.current) return;
    runningRef.current = true;
    const body = selectedScript.body;
    if (!body.trim()) {
      runningRef.current = false;
      showDialog(L.title, L.needBody);
      return;
    }

    publishScenarioActivity({
      step: 1,
      stage: ru ? "Подготовка встроенного runtime…" : uk ? "Підготовка вбудованого runtime…" : "Preparing embedded runtime…",
      detail: "Private runtime",
      progressPercent: 5,
    });
    abortRef.current = false;
    setRunning(true);
    setStatusLine(L.running);

    postChat(
      "user",
      `${L.startedChat}\n${ru ? "Сценарий" : uk ? "Сценарій" : "Script"}: ${selectedScript.name}${
        useAgent ? (ru ? "\nИИ-агент: включён" : uk ? "\nІІ-агент: увімкнено" : "\nAI agent: on") : ""
      }`,
    );
    logInfo("ScriptRunner", `start name=${selectedScript.name} agent=${useAgent} scriptLen=${body.length}`);
    notifyAgentStarted(selectedScript.name);

    const publishRunEvent = (ev: ScriptAgentEvent) => {
      if (ev.type === "attempt") {
        publishScenarioActivity({
          step: 2, maxSteps: 4,
          stage: ru ? `Выполнение сценария · попытка ${ev.attempt}/${ev.maxAttempts}` : uk ? `Виконання сценарію · спроба ${ev.attempt}/${ev.maxAttempts}` : `Running scenario · attempt ${ev.attempt}/${ev.maxAttempts}`,
          detail: ru ? "Выполняются команды пользовательского сценария" : uk ? "Виконуються команди користувацького сценарію" : "Executing user scenario commands",
          progressPercent: Math.min(70, 15 + Math.round((ev.attempt - 1) * 45 / Math.max(1, ev.maxAttempts))),
        });
      } else if (ev.type === "failed") {
        publishScenarioActivity({ step: 3, stage: ru ? "Анализ ошибки…" : uk ? "Аналіз помилки…" : "Analyzing failure…", detail: ev.state.category, progressPercent: 72 });
      } else if (ev.type === "patch") {
        publishScenarioActivity({ step: 3, stage: ru ? "Применение исправления…" : uk ? "Застосування виправлення…" : "Applying repair…", detail: ev.description, progressPercent: 80 });
      } else if (ev.type === "llm") {
        publishScenarioActivity({ step: 3, stage: ru ? "ИИ анализирует ошибку…" : uk ? "ШІ аналізує помилку…" : "AI is analyzing the failure…", detail: ev.note, progressPercent: 76 });
      } else if (ev.type === "success") {
        publishScenarioActivity({ taskStatus: "completed", step: 4, stage: ru ? "Сценарий завершён" : uk ? "Сценарій завершено" : "Scenario completed", detail: ru ? "Выполнение успешно завершено" : uk ? "Виконання успішно завершено" : "Execution completed successfully", progressPercent: 100 });
      } else if (ev.type === "aborted") {
        publishScenarioActivity({ taskStatus: "cancelled", step: 4, stage: ru ? "Сценарий остановлен" : uk ? "Сценарій зупинено" : "Scenario stopped", detail: ru ? "Остановлено пользователем" : uk ? "Зупинено користувачем" : "Stopped by user", progressPercent: 100 });
      } else if (ev.type === "exhausted") {
        publishScenarioActivity({ taskStatus: "failed", step: 4, stage: ru ? "Сценарий завершён с ошибкой" : uk ? "Сценарій завершено з помилкою" : "Scenario failed", detail: ru ? "Попытки восстановления исчерпаны" : uk ? "Спроби відновлення вичерпано" : "Recovery attempts exhausted", errorMessage: ru ? "Сценарий не выполнен" : uk ? "Сценарій не виконано" : "Scenario failed", progressPercent: 100 });
      }
    };

    try {
      if (useAgent) {
        const result = await runScriptWithAgent({
          scriptBody: body,
          maxAttempts: 6,
          timeoutMs: 45 * 60 * 1000,
          shouldAbort: () => abortRef.current,
          invokeLLM: async (prompt: string) => {
            try {
              // completePrompt = pure model call (no nested Termux agent)
              return await completePrompt(prompt);
            } catch (e: unknown) {
              return e instanceof Error ? e.message : String(e);
            }
          },
          onEvent: (ev) => {
            publishRunEvent(ev);
            if (ev.type === "attempt") {
              setStatusLine(`${L.agentRetry} ${ev.attempt}/${ev.maxAttempts}`);
            } else if (ev.type === "patch") {
              setStatusLine(`${L.agentPatch}: ${ev.description}`);
              postChat("assistant", `🔧 ${L.agentPatch}\n${ev.description}`);
            } else if (ev.type === "llm") {
              setStatusLine(ev.note);
            } else if (ev.type === "failed") {
              postChat(
                "assistant",
                `⚠ ${ev.state.category}\n${ev.state.strategy}\n\n${ev.logTail.slice(-1500)}`,
              );
            } else if (ev.type === "success") {
              postChat("assistant", `${L.finishedChat}\nattempts=${ev.attempt}\n\n${ev.logTail}`);
              setStatusLine(L.finishedChat);
            } else if (ev.type === "aborted") {
              postChat("assistant", L.stoppedChat);
              setStatusLine(L.stoppedChat);
            } else if (ev.type === "exhausted") {
              postChat("assistant", `${L.agentExhausted}\n\n${ev.logTail}`);
              setStatusLine(L.agentExhausted);
            }
          },
        });

        if (result.ok && result.patched.length) {
          postChat(
            "assistant",
            (ru ? "Патчи агента:\n" : uk ? "Патчі агента:\n" : "Agent patches:\n") +
              result.patched.map((x, i) => `${i + 1}. ${x}`).join("\n"),
          );
        }
        {
          const agentLog = result.log || "";
          const tail = agentLog.split("\n").slice(-40).join("\n");
          const apkPath = result.ok && !result.aborted ? extractApkPathFromLog(agentLog) : undefined;
          void pushHistory({
            scriptName: selectedScript.name,
            exitCode: result.exitCode ?? (result.ok ? 0 : 1),
            ok: !!result.ok && !result.aborted,
            tail,
            apkPath,
          });
          // Extra APK line only (success already posted via onEvent); avoid duplicate full dumps
          if (result.ok && apkPath) {
            postChat("assistant", `APK: ${apkPath}`);
          } else if (!result.ok && !result.aborted) {
            const why = summarizeFailure(agentLog, result.exitCode ?? 1);
            postChat("assistant", `Почему: ${why}`);
          }
        }
        if (result.aborted) {
          notifyAgentFailed(ru ? "Остановлено" : uk ? "Зупинено" : "Stopped");
        } else if (result.ok) {
          notifyAgentDone(selectedScript.name);
        } else {
          notifyAgentFailed(`${selectedScript.name} exit=${result.exitCode}`);
        }
      } else {
        // Без ИИ-агента: всё равно детерминированные ретраи (NDK/CMake, память)
        // по логу сборки — для Expo/RN и обычных Android-проектов.
        const autoFixLabel = ru
          ? "Авто-исправление по логу"
          : uk
            ? "Авто-виправлення за логом"
            : "Log-based auto-fix";
        postChat(
          "assistant",
          ru
            ? "ИИ-анализ отключён. Детерминированное восстановление всё равно включено для известных сбоев: корректный exit-код Gradle/tee, NDK/CMake, память, toolchain, wrapper и временная сеть — до 3 попыток."
            : uk
              ? "ІІ-аналіз вимкнено. Детерміноване відновлення все одно увімкнено для відомих збоїв: коректний exit-код Gradle/tee, NDK/CMake, памʼять, toolchain, wrapper і тимчасова мережа — до 3 спроб."
              : "LLM analysis is off. Deterministic recovery is still enabled for known build/toolchain failures: pipefail/exit-code capture, NDK/CMake, memory, toolchain, wrapper and transient network errors — up to 3 attempts.",
        );
        const result = await runScriptWithAgent({
          scriptBody: body,
          maxAttempts: 6,
          timeoutMs: 45 * 60 * 1000,
          shouldAbort: () => abortRef.current,
          // no invokeLLM → только детерминированные патчи
          onEvent: (ev) => {
            publishRunEvent(ev);
            if (ev.type === "attempt") {
              setStatusLine(`${L.agentRetry} ${ev.attempt}/${ev.maxAttempts}`);
            } else if (ev.type === "patch") {
              setStatusLine(`${autoFixLabel}: ${ev.description}`);
              postChat("assistant", `🔧 ${autoFixLabel}\n${ev.description}`);
            } else if (ev.type === "failed") {
              postChat(
                "assistant",
                `⚠ ${ev.state.category}\n${ev.state.strategy}\n\n${ev.logTail.slice(-1200)}`,
              );
            } else if (ev.type === "success") {
              postChat("assistant", `${L.finishedChat}\nattempts=${ev.attempt}\n\n${ev.logTail}`);
              setStatusLine(L.finishedChat);
            } else if (ev.type === "aborted") {
              postChat("assistant", L.stoppedChat);
              setStatusLine(L.stoppedChat);
            } else if (ev.type === "exhausted") {
              postChat("assistant", `${L.failedChat}\n\n${ev.logTail}`);
              setStatusLine(L.failedChat);
            }
          },
        });

        const agentLog = result.log || "";
        const tail = agentLog.split("\n").slice(-40).join("\n");
        const apkPath = result.ok && !result.aborted ? extractApkPathFromLog(agentLog) : undefined;
        void pushHistory({
          scriptName: selectedScript.name,
          exitCode: result.exitCode ?? (result.ok ? 0 : 1),
          ok: !!result.ok && !result.aborted,
          tail,
          apkPath,
        });
        if (result.ok && result.patched.length) {
          postChat(
            "assistant",
            (ru ? "Авто-патчи:\n" : uk ? "Авто-патчі:\n" : "Auto-patches:\n") +
              result.patched.map((x, i) => `${i + 1}. ${x}`).join("\n"),
          );
        }
        if (result.ok && apkPath) {
          postChat("assistant", `APK: ${apkPath}`);
        } else if (!result.ok && !result.aborted) {
          const why = summarizeFailure(agentLog, result.exitCode ?? 1);
          postChat("assistant", `Почему: ${why}`);
        }
        if (result.aborted) {
          notifyAgentFailed(ru ? "Остановлено" : uk ? "Зупинено" : "Stopped");
        } else if (result.ok) {
          notifyAgentDone(selectedScript.name);
        } else {
          notifyAgentFailed(`${selectedScript.name} exit=${result.exitCode}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (abortRef.current) {
        postChat("assistant", L.stoppedChat);
        setStatusLine(L.stoppedChat);
      } else {
        postChat("assistant", `${L.failedChat}\n${msg}`);
        setStatusLine(msg);
        logError("ScriptRunner", msg);
        notifyAgentFailed(msg);
        publishScenarioActivity({ taskStatus: "failed", step: 4, stage: ru ? "Сценарий завершён с ошибкой" : uk ? "Сценарій завершено з помилкою" : "Scenario failed", detail: msg, errorMessage: msg, progressPercent: 100 });
      }
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }, [
    selectedScript,
    useAgent,
    completePrompt,
    postChat,
    showDialog,
    logInfo,
    logError,
    L,
    ru,
    uk,
    pushHistory,
    publishScenarioActivity,
  ]);

  const handleStop = useCallback(async () => {
    abortRef.current = true;
    setStatusLine(L.stopHint);
    logInfo("ScriptRunner", "stop requested");
    try {
      await executeGuardedTermuxCommand(buildStopCommand(), { timeoutMs: 15_000, trustedInternal: true, isBuild: true });
    } catch {
      /* ignore */
    }
    postChat("assistant", L.stoppedChat);
    setRunning(false);
    runningRef.current = false;
    setStatusLine(L.stoppedChat);
    notifyAgentFailed(ru ? "Остановлено" : uk ? "Зупинено" : "Stopped");
    publishScenarioActivity({ taskStatus: "cancelled", step: 4, stage: ru ? "Сценарий остановлен" : uk ? "Сценарій зупинено" : "Scenario stopped", detail: ru ? "Остановлено пользователем" : uk ? "Зупинено користувачем" : "Stopped by user", progressPercent: 100 });
  }, [L, logInfo, postChat, ru, uk, publishScenarioActivity]);

  const bottomPad = Math.max(insets.bottom, 12) + 20;

  const renderIconPicker = (value: IconName, onChange: (n: IconName) => void, disabled?: boolean) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {ICON_OPTIONS.map((ic) => {
          const active = value === ic;
          return (
            <TouchableOpacity
              key={ic}
              disabled={disabled}
              onPress={() => onChange(ic)}
              style={[
                styles.iconChip,
                {
                  borderColor: active ? colors.accent : colors.line,
                  backgroundColor: active ? colors.accentDim : colors.chipBg,
                },
              ]}
              activeOpacity={0.7}
            >
              <Ionicons name={ic} size={18} color={active ? colors.accent : colors.muted} />
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        ref={pageScrollRef}
        key={desktopLayout ? "desktop" : "mobile"}
        contentContainerStyle={[styles.content, getDesktopContentStyle({ paddingBottom: bottomPad })]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={[styles.hero, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.heroRow}>
            <View style={[styles.heroIcon, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="construct" size={22} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.heroTitle, { color: colors.inkBright }]}>{L.title}</Text>
              <Text style={[styles.heroSub, { color: colors.muted }]}>{L.hero}</Text>
            </View>
          </View>
        </View>

        {/* Agent */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Checkbox
            checked={useAgent}
            onPress={() => !running && void persistAgent(!useAgent)}
            label={L.useAgent}
            description={L.useAgentDesc}
            disabled={running}
          />
        </View>

        {/* Saved scripts */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.cardHead}>
            <Ionicons name="list-outline" size={18} color={colors.accent} />
            <Text style={[styles.cardTitle, { color: colors.inkBright }]}>{L.savedList}</Text>
          </View>
            {lastApkPath ? (
              <TouchableOpacity
                onPress={() => void installLastApk()}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 12,
                  padding: 10,
                  borderRadius: 10,
                  backgroundColor: colors.surfaceRaised,
                  borderWidth: 1,
                  borderColor: colors.line,
                }}
              >
                <Ionicons name="download-outline" size={18} color={colors.success} />
                <Text style={{ color: colors.inkBright, flex: 1, fontSize: 12 }} numberOfLines={2}>
                  {(ru ? "Установить APK: " : "Install APK: ") + lastApkPath}
                </Text>
              </TouchableOpacity>
            ) : null}
                      {scripts.length === 0 ? (
            <Text style={[styles.hint, { color: colors.muted, marginBottom: 0 }]}>{L.savedEmpty}</Text>
          ) : (
            <View style={{ gap: 8 }}>
              {scripts.map((s) => {
                const active = selectedId === s.id;
                return (
                  <View
                    key={s.id}
                    style={[
                      styles.scriptCard,
                      {
                        borderColor: active ? colors.accent : colors.line,
                        backgroundColor: active ? colors.accentDim : colors.background,
                      },
                    ]}
                  >
                    <TouchableOpacity
                      style={styles.scriptCardMain}
                      onPress={() => !running && void persistSelected(s.id).then((saved) => {
                        if (!saved) showDialog(L.title, L.selectionFailed);
                      })}
                      disabled={running}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.scriptIconWrap, { backgroundColor: colors.chipBg }]}>
                        <Ionicons name={s.icon || "code-slash-outline"} size={20} color={colors.accent} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.scriptName, { color: colors.inkBright }]} numberOfLines={1}>
                          {s.name}
                        </Text>
                        <Text style={{ color: colors.muted, fontSize: 11 }}>
                          {active ? L.selected : L.select} · {s.body.split("\n").length} lines
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.checkDot,
                          {
                            borderColor: active ? colors.accent : colors.muted,
                            backgroundColor: active ? colors.accent : "transparent",
                          },
                        ]}
                      >
                        {active ? <Ionicons name="checkmark" size={12} color={colors.onAccent || "#00325A"} /> : null}
                      </View>
                    </TouchableOpacity>
                    <View style={styles.scriptActions}>
                      <TouchableOpacity
                        style={[styles.miniBtn, { borderColor: colors.line }]}
                        onPress={() => openEdit(s)}
                        disabled={running}
                      >
                        <Ionicons name="create-outline" size={15} color={colors.accent} />
                        <Text style={{ color: colors.inkBright, fontSize: 11, fontWeight: "600" }}>{L.edit}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.miniBtn, { borderColor: colors.line }]}
                        onPress={() => void handleExport(s)}
                        disabled={running}
                      >
                        <Ionicons name="share-outline" size={15} color={colors.accent} />
                        <Text style={{ color: colors.inkBright, fontSize: 11, fontWeight: "600" }}>{L.export}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.miniBtn, { borderColor: colors.line }]}
                        onPress={() => void handleDelete(s)}
                        disabled={running}
                      >
                        <Ionicons name="trash-outline" size={15} color={colors.danger} />
                        <Text style={{ color: colors.inkBright, fontSize: 11, fontWeight: "600" }}>{L.delete}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>

        {/* New / paste script */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.cardHead}>
            <Ionicons name="add-circle-outline" size={18} color={colors.accent} />
            <Text style={[styles.cardTitle, { color: colors.inkBright }]}>{L.newScript}</Text>
          </View>
          <Text style={[styles.hint, { color: colors.muted }]}>{L.scriptHint}</Text>

          <Text style={[styles.fieldLabel, { color: colors.muted }]}>{L.nameLabel}</Text>
          <TextInput
            style={[
              styles.input,
              { color: colors.inkBright, backgroundColor: colors.background, borderColor: colors.line },
            ]}
            value={draftName}
            onChangeText={setDraftName}
            placeholder={L.namePh}
            placeholderTextColor={colors.muted}
            editable={!running}
            autoCapitalize="sentences"
          />

          <Text style={[styles.fieldLabel, { color: colors.muted, marginTop: 10 }]}>{L.iconLabel}</Text>
          {renderIconPicker(draftIcon, setDraftIcon, running)}

          <Text style={[styles.fieldLabel, { color: colors.muted, marginTop: 6 }]}>{L.scriptLabel}</Text>
          <TextInput
            style={[
              styles.scriptInput,
              { color: colors.inkBright, backgroundColor: colors.background, borderColor: colors.line },
            ]}
            value={draftBody}
            onChangeText={setDraftBody}
            placeholder={"#!/usr/bin/env bash\n# your script…"}
            placeholderTextColor={colors.muted}
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!running}
            onEndEditing={() => requestAnimationFrame(() => pageScrollRef.current?.scrollToEnd({ animated: true }))}
          />
          <View style={styles.rowBtns}>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.line, backgroundColor: colors.chipBg }]}
              onPress={handleLoadScript}
              disabled={running}
              activeOpacity={0.7}
            >
              <Ionicons name="document-outline" size={16} color={colors.accent} />
              <Text style={[styles.secondaryBtnText, { color: colors.inkBright }]}>{L.loadScript}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.accent, backgroundColor: colors.accentDim }]}
              onPress={() => void handleSaveDraft()}
              disabled={running || !draftBody.trim()}
              activeOpacity={0.7}
            >
              <Ionicons name="save-outline" size={16} color={colors.accent} />
              <Text style={[styles.secondaryBtnText, { color: colors.accent }]}>{L.saveScript}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.line, backgroundColor: colors.chipBg }]}
              onPress={handleClearDraft}
              disabled={running || (!draftBody && !draftName)}
              activeOpacity={0.7}
            >
              <Ionicons name="trash-outline" size={16} color={colors.danger} />
              <Text style={[styles.secondaryBtnText, { color: colors.inkBright }]}>{L.clearDraft}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Run / Stop */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[
              styles.primaryBtn,
              {
                backgroundColor: running ? colors.muted : colors.accent,
                flex: 1,
              },
            ]}
            onPress={handleRun}
            disabled={running}
            activeOpacity={0.8}
          >
            {running ? (
              <ActivityIndicator color={colors.onAccent || "#00325A"} />
            ) : (
              <Ionicons name="play" size={20} color={colors.onAccent || "#00325A"} />
            )}
            <Text style={[styles.primaryBtnText, { color: colors.onAccent || "#00325A" }]}>
              {running ? L.running : L.run}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.stopBtn,
              {
                borderColor: colors.danger,
                backgroundColor: running ? colors.danger : colors.surface,
                opacity: running ? 1 : 0.5,
              },
            ]}
            onPress={handleStop}
            disabled={!running}
            activeOpacity={0.8}
          >
            <Ionicons name="stop" size={18} color={running ? "#fff" : colors.danger} />
            <Text style={[styles.stopBtnText, { color: running ? "#fff" : colors.danger }]}>{L.stop}</Text>
          </TouchableOpacity>
        </View>

        {!!statusLine && (
          <Text style={[styles.status, { color: colors.muted }]} numberOfLines={3}>
            {statusLine}
          </Text>
        )}

        <Text style={[styles.footerNote, { color: colors.footerMuted }]}>
          {ru
            ? "Результат дублируется в чат и в панель Termux."
            : uk
              ? "Результат дублюється в чат і в панель Termux."
              : "Output is mirrored to chat and the Termux panel."}
        </Text>
      </ScrollView>

      {/* Professional editor modal */}
      <Modal visible={editOpen} animationType="slide" transparent onRequestClose={() => setEditOpen(false)}>
        <View style={[styles.modalRoot, { backgroundColor: colors.overlay }]}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={[
              styles.modalSheet,
              {
                backgroundColor: colors.surface,
                paddingBottom: Math.max(insets.bottom, 12),
              },
            ]}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.inkBright }]}>{L.editorTitle}</Text>
              <TouchableOpacity onPress={() => setEditOpen(false)} hitSlop={12}>
                <Ionicons name="close" size={24} color={colors.muted} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.fieldLabel, { color: colors.muted }]}>{L.nameLabel}</Text>
            <TextInput
              style={[
                styles.input,
                { color: colors.inkBright, backgroundColor: colors.background, borderColor: colors.line },
              ]}
              value={editName}
              onChangeText={setEditName}
              placeholder={L.namePh}
              placeholderTextColor={colors.muted}
            />

            <Text style={[styles.fieldLabel, { color: colors.muted, marginTop: 8 }]}>{L.iconLabel}</Text>
            {renderIconPicker(editIcon, setEditIcon)}

            <View style={styles.editorTabs}>
              <Pressable
                onPress={() => setEditPreview(false)}
                style={[
                  styles.tab,
                  {
                    borderColor: !editPreview ? colors.accent : colors.line,
                    backgroundColor: !editPreview ? colors.accentDim : "transparent",
                  },
                ]}
              >
                <Text style={{ color: !editPreview ? colors.accent : colors.muted, fontSize: 12, fontWeight: "700" }}>
                  {L.editor}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setEditPreview(true)}
                style={[
                  styles.tab,
                  {
                    borderColor: editPreview ? colors.accent : colors.line,
                    backgroundColor: editPreview ? colors.accentDim : "transparent",
                  },
                ]}
              >
                <Text style={{ color: editPreview ? colors.accent : colors.muted, fontSize: 12, fontWeight: "700" }}>
                  {L.preview}
                </Text>
              </Pressable>
            </View>

            {editPreview ? (
              <ScrollView
                style={[styles.editorBox, { backgroundColor: colors.background, borderColor: colors.line }]}
                contentContainerStyle={{ padding: 10 }}
              >
                <HighlightedBash code={editBody || " "} />
              </ScrollView>
            ) : (
              <TextInput
                style={[
                  styles.editorBox,
                  styles.editorInput,
                  { color: colors.inkBright, backgroundColor: colors.background, borderColor: colors.line },
                ]}
                value={editBody}
                onChangeText={setEditBody}
                multiline
                textAlignVertical="top"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={"#!/usr/bin/env bash\n"}
                placeholderTextColor={colors.muted}
              />
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.secondaryBtn, { borderColor: colors.line, backgroundColor: colors.chipBg, flex: 1 }]}
                onPress={() => setEditOpen(false)}
              >
                <Text style={[styles.secondaryBtnText, { color: colors.inkBright }]}>{L.cancel}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryBtn, { borderColor: colors.accent, backgroundColor: colors.accentDim, flex: 1 }]}
                onPress={() => void handleApplyEdit()}
              >
                <Ionicons name="save-outline" size={16} color={colors.accent} />
                <Text style={[styles.secondaryBtnText, { color: colors.accent }]}>{L.apply}</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 12 },
  hero: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  heroRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  heroIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: { fontSize: 17, fontWeight: "800", letterSpacing: -0.2 },
  heroSub: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  cardTitle: { fontSize: 14, fontWeight: "700" },
  hint: { fontSize: 12, lineHeight: 16, marginBottom: 10 },
  fieldLabel: { fontSize: 11, fontWeight: "600", marginBottom: 4, letterSpacing: 0.2 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  scriptInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 12,
    minHeight: 140,
    fontFamily: Platform.OS === "android" ? "monospace" : "Menlo",
  },
  rowBtns: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 12, fontWeight: "600" },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  primaryBtnText: { fontSize: 15, fontWeight: "800" },
  stopBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    minWidth: 100,
  },
  stopBtnText: { fontSize: 14, fontWeight: "700" },
  status: { fontSize: 12, lineHeight: 16, textAlign: "center", marginTop: 4 },
  footerNote: { fontSize: 11, lineHeight: 15, textAlign: "center", marginTop: 8 },
  scriptCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  scriptCardMain: { flexDirection: "row", alignItems: "center", gap: 10 },
  scriptIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  scriptName: { fontSize: 14, fontWeight: "700" },
  checkDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  scriptActions: { flexDirection: "row", gap: 8 },
  miniBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  iconChip: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  modalSheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 14,
    maxHeight: "92%",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  modalTitle: { fontSize: 17, fontWeight: "800" },
  editorTabs: { flexDirection: "row", gap: 8, marginTop: 8, marginBottom: 8 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  editorBox: {
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 220,
    maxHeight: 340,
  },
  editorInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 12,
    fontFamily: Platform.OS === "android" ? "monospace" : "Menlo",
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 12 },
});
