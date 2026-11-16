import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Animated,
  Dimensions,
  ActivityIndicator,
  Pressable,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";
import { useTermuxContext } from "./TermuxContext";
import {
  isNativeModuleAvailable,
  pickOfflinePackageArchive,
  stageOfflinePackageBundle,
  installOfflinePackageBundle,
  cancelOfflinePackageBundle,
  onOfflineBundleProgress,
} from "../lib/termux-bridge";
import { classifyPackageMenuAvailability, packageMenuAvailabilityMessage } from "../lib/package-menu-availability";
import {
  RIGHT_MENU_COMPILE_PACKAGES,
  type CompilePkgId,
  type PackageRuntimeState,
  installCompilePackage,
  removeCompilePackage,
  checkPackageInstalled,
  verifyAllPackages,
  loadInstalledMap,
} from "../lib/compile-packages";
import type { PackageCheckOutcome } from "../lib/package-check-outcome";
import {
  REVERSE_PACKAGES,
  type ReversePkgId,
  installReversePackage,
  removeReversePackage,
  verifyAllReversePackages,
  checkReversePackageInstalled,
  loadReverseInstalledMap,
} from "../lib/reverse-packages";
import {
  loadCustomTools,
  installCustomTool,
  removeCustomToolPkg,
  checkCustomToolInstalled,
  deleteCustomTool,
  type CustomToolDef,
} from "../lib/custom-packages";
import { AddToolDialog } from "./AddToolDialog";
import { ProgressBar } from "./ProgressBar";
import { useDialog } from "./DialogContext";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistentLogger } from "../lib/persistent-logger";
import { runTermuxCacheCleanup } from "../lib/termux-cache-cleanup";
import { RIGHT_PACKAGE_MENU_BACKEND, resolveRightPackageMenuExpansionScanPlan } from "../lib/package-menu-routing";
import { packageScanCoordinator } from "../lib/package-catalog-scan";
import { getPrivatePackageMutationAvailability } from "../lib/private-package-install-policy";
import { FullCandidatePackagesPanel } from "./FullCandidatePackagesPanel";
import { OnlinePackageFeedPanel } from "./OnlinePackageFeedPanel";

const BUSY_INSTALL_KEY = "aibuilder.packages.busyInstall.v1";

async function persistBusyInstall(id: string | null) {
  try {
    if (!id) await AsyncStorage.removeItem(BUSY_INSTALL_KEY);
    else await AsyncStorage.setItem(BUSY_INSTALL_KEY, id);
  } catch {
    /* ignore */
  }
}

async function loadBusyInstall(): Promise<string | null> {
  try {
    return (await AsyncStorage.getItem(BUSY_INSTALL_KEY)) || null;
  } catch {
    return null;
  }
}


const MENU_WIDTH = Math.min(340, Dimensions.get("window").width * 0.88);

type SectionId = "compile" | "reverse" | "custom";
type AnyPkgId = CompilePkgId | ReversePkgId;
type OfflineBundleUiState = "idle" | "staging" | "ready" | "installing" | "installed" | "partial" | "blocked" | "rejected" | "cancelled";
type OfflineBundlePackage = { name: string; version: string; architecture: "aarch64" | "all"; sizeBytes: number };
type OfflineBundleStageResult = {
  status: "ready" | "rejected" | "blocked";
  code: string;
  stageId?: string;
  packageCount?: number;
  totalBytes?: number;
  packages?: OfflineBundlePackage[];
};
type OfflineBundleInstallResult = { status: "installed" | "partial" | "rejected" | "blocked"; code: string; installed?: unknown };
type OfflineBundleProgressEvent = { requestId: string; phase: string; percent: number };
type OfflineBundleActiveOperation = { requestId: string; kind: "stage" | "install"; unsubscribe: () => void; cancelRequested: boolean };
const COLLAPSED_SECTIONS: Record<SectionId, boolean> = { compile: false, reverse: false, custom: false };

let offlineBundleRequestSequence = 0;
function createOfflineBundleRequestId(): string {
  offlineBundleRequestSequence += 1;
  return `offline-${Date.now().toString(36)}-${offlineBundleRequestSequence.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function formatOfflineBundleBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function offlineBundlePhaseMessage(phase: string, language: "ru" | "uk" | "en"): string {
  const labels: Record<string, Record<"ru" | "uk" | "en", string>> = {
    opening: { ru: "Открытие архива", uk: "Відкриття архіву", en: "Opening archive" },
    signature: { ru: "Проверка подписи манифеста Karat", uk: "Перевірка підпису маніфесту Karat", en: "Verifying Karat manifest signature" },
    hashes: { ru: "Проверка SHA-256 всех файлов", uk: "Перевірка SHA-256 усіх файлів", en: "Verifying every file SHA-256" },
    metadata: { ru: "Проверка .deb и индекса пакетов", uk: "Перевірка .deb та індексу пакетів", en: "Checking .deb and package-index metadata" },
    simulation: { ru: "Локальная симуляция APT без сети", uk: "Локальна симуляція APT без мережі", en: "Local-only APT simulation" },
    installing: { ru: "Установка проверенных пакетов", uk: "Встановлення перевірених пакетів", en: "Installing verified packages" },
    done: { ru: "Проверка завершена", uk: "Перевірку завершено", en: "Check complete" },
  };
  return labels[phase]?.[language] ?? phase;
}

function offlineBundleStatusMessage(code: string, language: "ru" | "uk" | "en"): string {
  if (code.startsWith("AIB_OFFLINE_PACKAGE_PICKER_")) {
    return language === "en" ? "Android did not return a selected archive. Open the picker again; no package was installed."
      : language === "uk" ? "Android не повернув вибраний архів. Відкрийте вибір файлу ще раз; пакети не встановлювалися."
        : "Android не вернул выбранный архив. Откройте выбор файла ещё раз; пакеты не устанавливались.";
  }
  if (code === "AIB_OFFLINE_PACKAGE_ARCHIVE_SIZE_INVALID") {
    return language === "en" ? "The selected archive exceeds the 200 MiB limit. No package was installed."
      : language === "uk" ? "Вибраний архів перевищує ліміт 200 MiB. Пакети не встановлювалися."
        : "Выбранный архив превышает лимит 200 MiB. Пакеты не устанавливались.";
  }
  if (code === "AIB_OFFLINE_PACKAGE_READ_FAILED") {
    return language === "en" ? "The selected archive could not be read. Select it again; no package was installed."
      : language === "uk" ? "Не вдалося прочитати вибраний архів. Виберіть його ще раз; пакети не встановлювалися."
        : "Не удалось прочитать выбранный архив. Выберите его ещё раз; пакеты не устанавливались.";
  }
  if (code === "AIB_OFFLINE_PACKAGE_CANCELLED") {
    return language === "en" ? "Native reported that the operation was cancelled. No rollback is claimed." : language === "uk" ? "Native повідомив, що операцію скасовано. Відкат не стверджується." : "Native сообщил, что операция отменена. Откат не заявляется.";
  }
  if (code === "AIB_OFFLINE_PACKAGE_CANCELLATION_REQUESTED") {
    return language === "en" ? "Cancellation requested; waiting for the native result. Changes already made are not claimed to be rolled back." : language === "uk" ? "Надіслано запит на скасування; очікуємо результат native. Відкат уже зроблених змін не стверджується." : "Запрошена отмена; ожидаем результат native. Откат уже сделанных изменений не заявляется.";
  }
  if (code === "AIB_OFFLINE_PACKAGE_CANCEL_REQUEST_FAILED") {
    return language === "en" ? "The native cancellation request failed; the operation may still be running." : language === "uk" ? "Не вдалося надіслати native-запит скасування; операція може тривати." : "Не удалось отправить native-запрос отмены; операция может продолжаться.";
  }
  return language === "en"
    ? `Offline package operation was blocked or failed (${code}). No successful install is claimed.`
    : language === "uk"
      ? `Операцію з офлайн-пакетом заблоковано або не вдалося завершити (${code}). Успішне встановлення не заявляється.`
      : `Операция с офлайн-пакетом заблокирована или не завершилась (${code}). Успешная установка не заявляется.`;
}

function offlinePackageMutationGateMessage(language: "ru" | "uk" | "en"): string {
  return language === "en"
    ? "Ordinary catalog install/update/removal is disabled. APT indexes are unsigned. An offline archive is eligible only after native verification of the Karat-signed manifest, every file SHA-256, package/index metadata, and a local-only APT simulation."
    : language === "uk"
      ? "Звичайне встановлення, оновлення й видалення з каталогу вимкнені. Індекси APT не підписані. Офлайн-архів допустимий лише після нативної перевірки підписаного Karat маніфесту, SHA-256 кожного файлу, метаданих пакетів/індексу та локальної симуляції APT без мережі."
      : "Обычная установка, обновление и удаление из каталога отключены. Индексы APT не подписаны. Офлайн-архив допустим только после нативной проверки подписанного Karat манифеста, SHA-256 каждого файла, метаданных пакетов/индекса и локальной симуляции APT без сети.";
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function PackagesRightMenu({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { language } = useLanguage();
  const { enabled: termuxEnabled } = useTermuxContext();
  const { showDialog, confirmDialog } = useDialog();
  const bridgeAvailable = isNativeModuleAvailable();
  const availability = classifyPackageMenuAvailability(bridgeAvailable, termuxEnabled);
  const termuxOk = availability.reason === "eligible";
  const packageMutationAllowed = getPrivatePackageMutationAvailability().allowed;
  const buildBackend = RIGHT_PACKAGE_MENU_BACKEND;
  const backendLabel = language === "en" ? "Embedded Termux" : language === "uk" ? "Вбудований Termux" : "Встроенный Termux";
  const packageBackendLabel = useCallback((_packageId: string) => language === "en" ? "Embedded Termux" : language === "uk" ? "Вбудований Termux" : "Встроенный Termux", [language]);

  const slide = useRef(new Animated.Value(MENU_WIDTH)).current;
  const [states, setStates] = useState<Record<string, PackageRuntimeState>>({});
  const [scanningSection, setScanningSection] = useState<SectionId | null>(null);
  const scanGenerationRef = useRef(0);
  const activeScanGenerationRef = useRef<number | null>(null);
  const openFlowStartedGenerationRef = useRef<number | null>(null);
  const customToolsReadyRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** Scans are lazy: only an explicitly expanded section may issue host probes. */
  const [expanded, setExpanded] = useState<Record<SectionId, boolean>>(COLLAPSED_SECTIONS);
  const expandedRef = useRef<Record<SectionId, boolean>>({ ...COLLAPSED_SECTIONS });
  const sectionExpansionGenerationRef = useRef<Record<SectionId, number>>({ compile: 0, reverse: 0, custom: 0 });
  /** Track live checks by selected backend + section; cache never implies OK. */
  const verifiedRef = useRef<Record<string, boolean>>({});
  const abortRef = useRef(false);
  const busyIdRef = useRef<AnyPkgId | null>(null);
  /** state-копия busyId — ref не триггерит re-render, кнопки иначе не disabled */
  const [busyId, setBusyId] = useState<AnyPkgId | null>(null);
  const [cleaningCache, setCleaningCache] = useState(false);
  const [cleanProgress, setCleanProgress] = useState(0);
  const [cleanDetail, setCleanDetail] = useState("");
  const [customTools, setCustomTools] = useState<CustomToolDef[]>([]);
  const [addToolOpen, setAddToolOpen] = useState(false);
  const [editTool, setEditTool] = useState<CustomToolDef | null>(null);
  const [offlineBundleState, setOfflineBundleState] = useState<OfflineBundleUiState>("idle");
  const [offlineBundleProgress, setOfflineBundleProgress] = useState(0);
  const [offlineBundlePhase, setOfflineBundlePhase] = useState("");
  const [offlineBundleCode, setOfflineBundleCode] = useState<string | null>(null);
  const [offlineBundlePackages, setOfflineBundlePackages] = useState<OfflineBundlePackage[]>([]);
  const [offlineBundlePackageCount, setOfflineBundlePackageCount] = useState(0);
  const [offlineBundleTotalBytes, setOfflineBundleTotalBytes] = useState(0);
  const offlineBundleOperationRef = useRef<OfflineBundleActiveOperation | null>(null);
  const offlineBundlePickerBusyRef = useRef(false);
  const offlineBundleStageRef = useRef<{ stageId: string; requestId: string } | null>(null);

  const setOne = useCallback((id: string, patch: Partial<PackageRuntimeState>) => {
    setStates((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || { status: "unknown", progress: 0 }), ...patch },
    }));
  }, []);

  const reviewRawCommand = useCallback((def: CustomToolDef, action: "install" | "check" | "remove", proceed: () => void) => {
    if (def.installKind !== "custom") {
      proceed();
      return;
    }
    const isEn = language === "en";
    const isUk = language === "uk";
    const commands = action === "install"
      ? [[isEn ? "Install command" : isUk ? "Команда встановлення" : "Команда установки", def.installCmd], [isEn ? "Follow-up check" : isUk ? "Подальша перевірка" : "Последующая проверка", def.checkCmd]]
      : action === "remove"
        ? [[isEn ? "Remove command" : isUk ? "Команда видалення" : "Команда удаления", def.removeCmd], [isEn ? "Follow-up check" : isUk ? "Подальша перевірка" : "Последующая проверка", def.checkCmd]]
        : [[isEn ? "Check command" : isUk ? "Команда перевірки" : "Команда проверки", def.checkCmd]];
    const title = isEn ? "Review custom shell command" : isUk ? "Перевірте shell-команду" : "Проверьте shell-команду";
    const notice = isEn
      ? `This user-authored shell command will run in ${backendLabel}. It may change files or system packages. Review the exact command before continuing.`
      : isUk
        ? `Ця користувацька shell-команда буде виконана в середовищі ${backendLabel}. Вона може змінювати файли або пакети. Перевірте точний текст перед продовженням.`
        : `Эта пользовательская shell-команда будет выполнена в среде ${backendLabel}. Она может изменять файлы или пакеты. Проверьте точный текст перед продолжением.`;
    const body = `${notice}\n\n${commands.map(([label, command]) => `${label}:\n${command}`).join("\n\n")}`;
    showDialog(title, body, [
      { text: isEn ? "Cancel" : "Отмена", style: "cancel" },
      { text: isEn ? "Run reviewed command" : isUk ? "Виконати команду" : "Выполнить команду", style: "destructive", onPress: proceed },
    ]);
  }, [backendLabel, language, showDialog]);

  const listenToOfflineBundleProgress = useCallback((requestId: string, kind: "stage" | "install") => {
    const subscription = onOfflineBundleProgress((event: OfflineBundleProgressEvent) => {
      const active = offlineBundleOperationRef.current;
      if (event.requestId !== requestId || active?.requestId !== requestId || !visibleRef.current) return;
      setOfflineBundlePhase(event.phase);
      // Native may emit a terminal progress event before its promise settles.
      // Do not render 100%/ready until the matching native result confirms it.
      setOfflineBundleProgress(Math.min(99, Math.max(0, Number.isFinite(event.percent) ? event.percent : 0)));
    });
    const unsubscribe = () => {
      if (typeof subscription === "function") subscription();
      else (subscription as { remove?: () => void } | null | undefined)?.remove?.();
    };
    return { requestId, kind, unsubscribe, cancelRequested: false } satisfies OfflineBundleActiveOperation;
  }, []);

  const clearOfflineBundleStage = useCallback(() => {
    const staged = offlineBundleStageRef.current;
    offlineBundleStageRef.current = null;
    if (staged) void cancelOfflinePackageBundle(staged.requestId).catch(() => undefined);
    setOfflineBundlePackages([]);
    setOfflineBundlePackageCount(0);
    setOfflineBundleTotalBytes(0);
  }, []);

  const cancelOfflineBundleWork = useCallback(() => {
    const active = offlineBundleOperationRef.current;
    if (active) {
      active.cancelRequested = true;
      void cancelOfflinePackageBundle(active.requestId).catch(() => undefined);
    }
    clearOfflineBundleStage();
    offlineBundleOperationRef.current?.unsubscribe();
    offlineBundleOperationRef.current = null;
  }, [clearOfflineBundleStage]);

  const cancelOfflineBundleOperation = useCallback(() => {
    const active = offlineBundleOperationRef.current;
    if (!active) return;
    active.cancelRequested = true;
    setOfflineBundleCode("AIB_OFFLINE_PACKAGE_CANCELLATION_REQUESTED");
    void cancelOfflinePackageBundle(active.requestId).catch(() => {
      if (offlineBundleOperationRef.current?.requestId === active.requestId) {
        setOfflineBundleCode("AIB_OFFLINE_PACKAGE_CANCEL_REQUEST_FAILED");
      }
    });
  }, []);

  const installReadyOfflineBundle = useCallback(async (stage: { stageId: string; requestId: string }) => {
    if (offlineBundleStageRef.current?.stageId !== stage.stageId || !visibleRef.current) return;
    // The opaque native stage is consumed only after the destructive dialog's
    // explicit confirm-button callback reaches this function.
    offlineBundleStageRef.current = null;
    const requestId = createOfflineBundleRequestId();
    setOfflineBundleState("installing");
    setOfflineBundleProgress(0);
    setOfflineBundlePhase("installing");
    setOfflineBundleCode(null);
    const operation = listenToOfflineBundleProgress(requestId, "install");
    offlineBundleOperationRef.current = operation;
    try {
      const result: OfflineBundleInstallResult = await installOfflinePackageBundle(stage.stageId, requestId);
      if (offlineBundleOperationRef.current?.requestId !== requestId) return;
      setOfflineBundleCode(result.code);
      if (result.status === "installed") {
        setOfflineBundleState("installed");
        setOfflineBundleProgress(100);
      } else if (result.status === "partial") {
        setOfflineBundleState("partial");
      } else if (result.code === "AIB_OFFLINE_PACKAGE_CANCELLED") {
        setOfflineBundleState("cancelled");
      } else {
        setOfflineBundleState(result.status);
      }
    } catch {
      if (offlineBundleOperationRef.current?.requestId !== requestId) return;
      setOfflineBundleState("rejected");
      setOfflineBundleCode("AIB_OFFLINE_PACKAGE_INSTALL_RESULT_UNAVAILABLE");
    } finally {
      if (offlineBundleOperationRef.current?.requestId === requestId) {
        operation.unsubscribe();
        offlineBundleOperationRef.current = null;
      }
    }
  }, [listenToOfflineBundleProgress]);

  const selectOfflineBundle = useCallback(async () => {
    if (offlineBundleOperationRef.current || offlineBundlePickerBusyRef.current) return;
    clearOfflineBundleStage();
    offlineBundlePickerBusyRef.current = true;
    let selection: Awaited<ReturnType<typeof pickOfflinePackageArchive>>;
    try {
      selection = await pickOfflinePackageArchive();
    } catch (error) {
      const nativeCode = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : null;
      setOfflineBundleState("rejected");
      setOfflineBundleCode(typeof nativeCode === "string" && nativeCode.startsWith("AIB_OFFLINE_PACKAGE_")
        ? nativeCode
        : "AIB_OFFLINE_PACKAGE_PICKER_FAILED");
      return;
    } finally {
      offlineBundlePickerBusyRef.current = false;
    }
    if (selection.canceled || typeof selection.uri !== "string") return;

    const requestId = createOfflineBundleRequestId();
    setOfflineBundleState("staging");
    setOfflineBundleProgress(0);
    setOfflineBundlePhase("opening");
    setOfflineBundleCode(null);
    setOfflineBundlePackages([]);
    setOfflineBundlePackageCount(0);
    setOfflineBundleTotalBytes(0);
    const operation = listenToOfflineBundleProgress(requestId, "stage");
    offlineBundleOperationRef.current = operation;
    try {
      const result: OfflineBundleStageResult = await stageOfflinePackageBundle(selection.uri, requestId);
      if (offlineBundleOperationRef.current?.requestId !== requestId || !visibleRef.current) return;
      setOfflineBundleCode(result.code);
      if (result.status !== "ready") {
        setOfflineBundleState(result.status);
        return;
      }
      const exactPackageList = Array.isArray(result.packages) && Number.isSafeInteger(result.packageCount) &&
        result.packageCount === result.packages.length && Number.isFinite(result.totalBytes) && result.totalBytes! >= 0;
      if (!result.stageId || !exactPackageList) {
        setOfflineBundleState("blocked");
        setOfflineBundleCode("AIB_OFFLINE_PACKAGE_STAGE_RESULT_INCOMPLETE");
        return;
      }
      const staged = { stageId: result.stageId, requestId };
      offlineBundleStageRef.current = staged;
      setOfflineBundleState("ready");
      setOfflineBundleProgress(100);
      setOfflineBundlePhase("done");
      setOfflineBundlePackages(result.packages!);
      setOfflineBundlePackageCount(result.packageCount!);
      setOfflineBundleTotalBytes(result.totalBytes!);
      const maxVisiblePackages = 10;
      const packageRows = result.packages!.slice(0, maxVisiblePackages).map(pkg =>
        `• ${pkg.name} ${pkg.version} (${pkg.architecture}, ${formatOfflineBundleBytes(pkg.sizeBytes)})`
      );
      if (result.packages!.length > maxVisiblePackages) {
        packageRows.push(language === "en"
          ? `…and ${result.packages!.length - maxVisiblePackages} more (of ${result.packageCount})`
          : language === "uk"
            ? `…і ще ${result.packages!.length - maxVisiblePackages} (усього ${result.packageCount})`
            : `…и ещё ${result.packages!.length - maxVisiblePackages} (всего ${result.packageCount})`);
      }
      const confirmation = language === "en"
        ? `This will install ${result.packageCount} validated package(s) (${formatOfflineBundleBytes(result.totalBytes!)} total .deb/archive bytes):\n${packageRows.join("\n")}\n\nThe APT index is unsigned. Before this confirmation, native preflight verified the detached Karat manifest signature (SHA256withRSA), SHA-256 for every archive file, package/index metadata, and a local-only APT simulation. Installation may change the private package environment; cancellation does not promise rollback.`
        : language === "uk"
          ? `Буде встановлено ${result.packageCount} перевірених пакетів (усього ${formatOfflineBundleBytes(result.totalBytes!)} байтів .deb/архіву):\n${packageRows.join("\n")}\n\nІндекс APT не підписаний. До цього підтвердження native preflight перевірив відокремлений підпис маніфесту Karat (SHA256withRSA), SHA-256 кожного файлу архіву, метадані пакетів/індексу та локальну симуляцію APT без мережі. Встановлення може змінити приватне середовище пакетів; скасування не гарантує відкату.`
          : `Будут установлены ${result.packageCount} проверенных пакетов (всего ${formatOfflineBundleBytes(result.totalBytes!)} байт .deb/архива):\n${packageRows.join("\n")}\n\nИндекс APT не подписан. До этого подтверждения native preflight проверил отделённую подпись манифеста Karat (SHA256withRSA), SHA-256 каждого файла архива, метаданные пакетов/индекса и локальную симуляцию APT без сети. Установка может изменить приватную среду пакетов; отмена не гарантирует откат.`;
      showDialog(
        language === "en" ? "Confirm offline package installation" : language === "uk" ? "Підтвердьте встановлення офлайн-пакетів" : "Подтвердите установку офлайн-пакетов",
        confirmation,
        [
          { text: language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена", style: "cancel", onPress: () => {
            if (offlineBundleStageRef.current?.stageId === staged.stageId) {
              clearOfflineBundleStage();
              setOfflineBundleState("idle");
              setOfflineBundleCode(null);
            }
          } },
          { text: language === "en" ? "Install these packages" : language === "uk" ? "Встановити ці пакети" : "Установить эти пакеты", style: "destructive", onPress: () => void installReadyOfflineBundle(staged) },
        ],
      );
    } catch {
      if (offlineBundleOperationRef.current?.requestId === requestId) {
        setOfflineBundleState("rejected");
        setOfflineBundleCode("AIB_OFFLINE_PACKAGE_STAGE_RESULT_UNAVAILABLE");
      }
    } finally {
      if (offlineBundleOperationRef.current?.requestId === requestId) {
        operation.unsubscribe();
        offlineBundleOperationRef.current = null;
      }
    }
  }, [clearOfflineBundleStage, installReadyOfflineBundle, language, listenToOfflineBundleProgress, showDialog]);

  useEffect(() => () => cancelOfflineBundleWork(), [cancelOfflineBundleWork]);

  useEffect(() => {
    if (visible) {
      persistentLogger.add("info", "PackagesGate", "Package menu opened", "app", { action: "open", extra: { bridgeAvailable: availability.bridgeAvailable, sessionEnabled: availability.sessionEnabled, reason: availability.reason } });
      scanGenerationRef.current += 1;
      abortRef.current = false;
      verifiedRef.current = {};
      setStates({});
      customToolsReadyRef.current = false;
      openFlowStartedGenerationRef.current = null;
      expandedRef.current = { ...COLLAPSED_SECTIONS };
      sectionExpansionGenerationRef.current = { compile: 0, reverse: 0, custom: 0 };
      setExpanded({ ...COLLAPSED_SECTIONS });
      Animated.timing(slide, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }).start();
    } else {
      cancelOfflineBundleWork();
      setOfflineBundleState("idle");
      setOfflineBundleProgress(0);
      setOfflineBundlePhase("");
      setOfflineBundleCode(null);
      scanGenerationRef.current += 1;
      activeScanGenerationRef.current = null;
      openFlowStartedGenerationRef.current = null;
      expandedRef.current = { ...COLLAPSED_SECTIONS };
      setExpanded({ ...COLLAPSED_SECTIONS });
      setScanningSection(null);
      Animated.timing(slide, {
        toValue: MENU_WIDTH,
        duration: 220,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, slide, availability.bridgeAvailable, availability.sessionEnabled, availability.reason]);

  const verifySection = useCallback(
    async (section: SectionId, customToolsOverride?: readonly CustomToolDef[]) => {
      if (!termuxOk) return;
      if (!expandedRef.current[section]) return;
      if (section === "custom" && !customToolsReadyRef.current && !customToolsOverride) return;
      const selectedBackend = RIGHT_PACKAGE_MENU_BACKEND;
      const scanGeneration = scanGenerationRef.current;
      const sectionGeneration = sectionExpansionGenerationRef.current[section];
      const scanKey = `${selectedBackend}:${section}:${scanGeneration}:${sectionGeneration}`;
      const verifiedKey = `${selectedBackend}:${section}`;
      const isCurrentTarget = () => visibleRef.current
        && scanGenerationRef.current === scanGeneration
        && expandedRef.current[section]
        && sectionExpansionGenerationRef.current[section] === sectionGeneration;
      await packageScanCoordinator.run(scanKey, async () => {
        if (!isCurrentTarget()) return;
        activeScanGenerationRef.current = scanGeneration;
        setScanningSection(section);
        let inconclusive = false;
        try {
          if (section === "compile") {
            await verifyAllPackages((id, check: PackageCheckOutcome) => {
              if (!isCurrentTarget()) return;
              if (check.status === "error") {
                inconclusive = true;
                setOne(id, { status: "error", progress: 0, detail: "Не удалось проверить", lastError: check.detail });
                return;
              }
              const installed = check.status === "installed";
              setOne(id, {
                status: installed ? "installed" : "missing",
                progress: installed ? 100 : 0,
                detail: installed ? `Проверено в ${packageBackendLabel(id)}` : "Не найдено",
                lastError: undefined,
              });
            }, {
              selectedBackend,
              definitions: RIGHT_MENU_COMPILE_PACKAGES,
              shouldContinue: isCurrentTarget,
              onStart: (id) => {
                if (isCurrentTarget()) {
                  setOne(id, { status: "checking", progress: 0, detail: `Проверка в ${packageBackendLabel(id)}…`, lastError: undefined });
                }
              },
            });
          } else if (section === "reverse") {
            await verifyAllReversePackages((id, check) => {
              if (!isCurrentTarget()) return;
              const def = REVERSE_PACKAGES.find((p) => p.id === id);
              const blocked = !!def?.blocked;
              if (check.status === "error") {
                inconclusive = true;
                setOne(id, { status: "error", progress: 0, detail: "Не удалось проверить", lastError: check.detail });
                return;
              }
              const installed = check.status === "installed";
              if (blocked && !installed) {
                setOne(id, { status: "blocked", progress: 0, detail: def?.blockedReason || "Автоустановка отключена", lastError: undefined });
                return;
              }
              setOne(id, {
                status: installed ? "installed" : "missing",
                progress: installed ? 100 : 0,
                detail: installed ? `Проверено в ${packageBackendLabel(id)}` : "Не найдено",
                lastError: undefined,
              });
            }, {
              selectedBackend,
              definitions: REVERSE_PACKAGES,
              shouldContinue: isCurrentTarget,
              onStart: (id) => {
                if (!isCurrentTarget()) return;
                const def = REVERSE_PACKAGES.find((p) => p.id === id);
                setOne(id, def?.blocked
                  ? { status: "blocked", progress: 0, detail: def.blockedReason || "Автоустановка отключена", lastError: undefined }
                  : { status: "checking", progress: 0, detail: `Проверка в ${packageBackendLabel(id)}…`, lastError: undefined });
              },
            });
          } else {
            for (const def of customToolsOverride ?? customTools) {
              if (!isCurrentTarget()) break;
              if (def.installKind === "custom") {
                setOne(def.id, {
                  status: "unknown",
                  progress: 0,
                  detail: language === "en"
                    ? "Custom check runs only after you review it."
                    : language === "uk"
                      ? "Користувацька перевірка запускається лише після перегляду."
                      : "Пользовательская проверка запускается только после просмотра.",
                  lastError: undefined,
                });
                continue;
              }
              setOne(def.id, { status: "checking", progress: 0, detail: `Проверка в ${packageBackendLabel(def.id)}…`, lastError: undefined });
              const check = await checkCustomToolInstalled(def, false, selectedBackend);
              if (!isCurrentTarget()) continue;
              if (check.status === "error") {
                inconclusive = true;
                setOne(def.id, { status: "error", progress: 0, detail: "Не удалось проверить", lastError: check.detail });
                continue;
              }
              const installed = check.status === "installed";
              setOne(def.id, {
                status: installed ? "installed" : "missing",
                progress: installed ? 100 : 0,
                detail: installed ? `Проверено в ${packageBackendLabel(def.id)}` : "Не найдено",
                lastError: undefined,
              });
            }
          }
          if (isCurrentTarget()) {
            verifiedRef.current[verifiedKey] = !inconclusive;
            persistentLogger.add("info", "PackagesMenu", `VERIFY_${section.toUpperCase()} complete target=${selectedBackend}`, "app");
          }
        } catch (e: unknown) {
          persistentLogger.add(
            "error",
            "PackagesMenu",
            `VERIFY_${section} failed: ${e instanceof Error ? e.message : String(e)}`,
            "app"
          );
        } finally {
          if (activeScanGenerationRef.current === scanGeneration) {
            activeScanGenerationRef.current = null;
            setScanningSection((current) => current === section ? null : current);
          }
        }
      });
    },
    [termuxOk, setOne, customTools, packageBackendLabel, language]
  );

  const toggleSection = useCallback(
    (section: SectionId) => {
      const opening = !expandedRef.current[section];
      const next = { ...expandedRef.current, [section]: opening };
      expandedRef.current = next;
      sectionExpansionGenerationRef.current[section] += 1;
      const sectionIds = section === "compile"
        ? RIGHT_MENU_COMPILE_PACKAGES.map((item) => item.id)
        : section === "reverse"
          ? REVERSE_PACKAGES.map((item) => item.id)
          : customTools.map((item) => item.id);
      setStates((previous) => {
        const cleared = { ...previous };
        for (const id of sectionIds) delete cleared[id];
        return cleared;
      });
      setExpanded(next);
      verifiedRef.current[`${RIGHT_PACKAGE_MENU_BACKEND}:${section}`] = false;
      if (!opening) {
        setScanningSection((current) => current === section ? null : current);
        persistentLogger.add("info", "PackagesMenu", `SCAN_COLLAPSE section=${section}`, "app");
        return;
      }
      const plan = resolveRightPackageMenuExpansionScanPlan(RIGHT_PACKAGE_MENU_BACKEND, section);
      persistentLogger.add("info", "PackagesMenu", `SCAN_EXPAND target=${plan.target} section=${plan.section} generation=${sectionExpansionGenerationRef.current[section]}`, "app");
      if (section !== "custom" || customToolsReadyRef.current) {
        void verifySection(section);
      }
    },
    [customTools, verifySection]
  );

  useEffect(() => {
    if (!visible) {
      persistentLogger.add("debug", "PackagesMenu", "CLOSE", "app");
      return;
    }
    const generation = scanGenerationRef.current;
    if (openFlowStartedGenerationRef.current === generation) {
      return;
    }
    openFlowStartedGenerationRef.current = generation;
    void (async () => {
      const interrupted = await loadBusyInstall();
      if (!visibleRef.current || generation !== scanGenerationRef.current) return;
      if (interrupted) {
        setOne(interrupted, {
          status: "checking",
          progress: 0,
          detail: "Проверка после перезапуска…",
          lastError: undefined,
        });
        void persistBusyInstall(null);
      }
      const tools = await loadCustomTools();
      if (!visibleRef.current || generation !== scanGenerationRef.current) return;
      customToolsReadyRef.current = true;
      setCustomTools(tools);
      if (expandedRef.current.custom) void verifySection("custom", tools);
    })();
  }, [visible, verifySection, setOne]);

  const runInstall = useCallback(
    async (id: AnyPkgId, kind: SectionId) => {
      if (busyIdRef.current) return;
      if (!getPrivatePackageMutationAvailability().allowed) {
        showDialog(backendLabel, offlinePackageMutationGateMessage(language));
        return;
      }
      if (!termuxOk) {
        showDialog(
          "Termux",
          language === "en" ? "The embedded private runtime is not ready. Package actions are blocked until the signed private feed and runtime qualification are available." : language === "uk" ? "Вбудоване приватне середовище виконання не готове. Дії з пакетами заблоковані до появи підписаного приватного feed і кваліфікації runtime." : "Встроенная приватная среда выполнения не готова. Действия с пакетами заблокированы до появления подписанного private feed и квалификации runtime."
        );
        return;
      }

      try {
      if (kind === "compile") {
        const def = RIGHT_MENU_COMPILE_PACKAGES.find((p) => p.id === id);
        if (!def) return;
        busyIdRef.current = id;
        setBusyId(id);
        abortRef.current = false;
        void persistBusyInstall(id);
        persistentLogger.add("info", "PackagesMenu", `INSTALL start id=${id}`, "app");
        setOne(id, { status: "installing", progress: 0, detail: "Старт…", lastError: undefined });
        const result = await installCompilePackage(
          def,
          (p, detail) => setOne(id, { status: "installing", progress: p, detail }),
          () => abortRef.current,
          buildBackend,
        );
        // Always re-check in the target backend; never trust only install exit / local cache.
        setOne(id, { status: "checking", progress: 0, detail: `Проверка после установки в ${packageBackendLabel(id)}…` });
        const verification = await checkPackageInstalled(def, buildBackend);
        const reallyThere = verification.status === "installed";
        void persistBusyInstall(null);
        if (verification.status === "error") {
          setOne(id, { status: "error", progress: 0, detail: "Не удалось подтвердить установку", lastError: verification.detail });
          showDialog(def.name, `Проверка установки завершилась без подтверждения:\n${verification.detail}`);
        } else if (result.ok && reallyThere) {
          setOne(id, { status: "installed", progress: 100, detail: `Проверено в ${packageBackendLabel(id)}` });
        } else if (result.error === "aborted") {
          setOne(id, {
            status: reallyThere ? "installed" : "missing",
            progress: reallyThere ? 100 : 0,
            detail: reallyThere ? "Отменено (наличие подтверждено)" : "Отменено",
          });
        } else {
          setOne(id, { status: "error", progress: 0, detail: "Ошибка", lastError: result.error || "verify failed" });
          showDialog(def.name, `Не удалось установить:\n${result.error || "пакет не найден после установки"}`);
        }
      } else {
        const def = REVERSE_PACKAGES.find((p) => p.id === id);
        if (!def) return;
        if (def.blocked) {
          setOne(id, {
            status: "blocked",
            progress: 0,
            detail: def.blockedReason || "Автоустановка отключена",
            lastError: def.blockedReason,
          });
          showDialog(def.name, def.blockedReason || "Автоустановка отключена (нет integrity pin).");
          return;
        }
        busyIdRef.current = id;
        setBusyId(id);
        abortRef.current = false;
        void persistBusyInstall(id);
        persistentLogger.add("info", "PackagesMenu", `INSTALL reverse id=${id}`, "app");
        setOne(id, { status: "installing", progress: 0, detail: "Старт…", lastError: undefined });
        const result = await installReversePackage(
          def,
          (p, detail) => setOne(id, { status: "installing", progress: p, detail }),
          () => abortRef.current,
          buildBackend,
        );
        setOne(id, { status: "checking", progress: 0, detail: `Проверка после установки в ${packageBackendLabel(id)}…` });
        const verification = await checkReversePackageInstalled(def, buildBackend);
        const reallyThere = verification.status === "installed";
        void persistBusyInstall(null);
        if (verification.status === "error") {
          setOne(id, { status: "error", progress: 0, detail: "Не удалось подтвердить установку", lastError: verification.detail });
          showDialog(def.name, `Проверка установки завершилась без подтверждения:\n${verification.detail}`);
        } else if (result.ok && reallyThere) {
          setOne(id, { status: "installed", progress: 100, detail: `Проверено в ${packageBackendLabel(id)}` });
        } else if (result.error === "aborted") {
          setOne(id, {
            status: reallyThere ? "installed" : "missing",
            progress: reallyThere ? 100 : 0,
            detail: reallyThere ? "Отменено (наличие подтверждено)" : "Отменено",
          });
        } else {
          setOne(id, { status: "error", progress: 0, detail: "Ошибка", lastError: result.error || "verify failed" });
          showDialog(def.name, `Не удалось установить:\n${result.error || "пакет не найден после установки"}`);
        }
      }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        persistentLogger.add("error", "PackagesMenu", `INSTALL exception id=${id}: ${msg}`, "app");
        setOne(id, { status: "error", progress: 0, detail: "Ошибка", lastError: msg });
        showDialog("Установка", `Сбой установки:\n${msg}`);
      } finally {
        void persistBusyInstall(null);
        busyIdRef.current = null;
        setBusyId(null);
      }
    },
    [termuxOk, setOne, showDialog, backendLabel, packageBackendLabel, buildBackend, language]
  );

  const runRemove = useCallback(
    async (id: AnyPkgId, kind: SectionId) => {
      if (busyIdRef.current) return;
      if (!getPrivatePackageMutationAvailability().allowed) {
        showDialog(backendLabel, offlinePackageMutationGateMessage(language));
        return;
      }
      if (!termuxOk) {
        showDialog(backendLabel, "Нужна активная Termux-сессия для запуска выбранной среды.");
        return;
      }

      try {
      if (kind === "compile") {
        const def = RIGHT_MENU_COMPILE_PACKAGES.find((p) => p.id === id);
        if (!def) return;
        busyIdRef.current = id;
        setBusyId(id);
        abortRef.current = false;
        setOne(id, { status: "removing", progress: 0, detail: "Удаление…", lastError: undefined });
        const result = await removeCompilePackage(
          def,
          (p, detail) => setOne(id, { status: "removing", progress: p, detail }),
          () => abortRef.current,
          buildBackend,
        );
        if (result.ok) {
          setOne(id, { status: "missing", progress: 0, detail: "Удалено" });
        } else if (result.error === "aborted") {
          setOne(id, { status: "checking", progress: 0, detail: "Проверка после отмены…" });
          const check = await checkPackageInstalled(def, buildBackend);
          if (check.status === "error") {
            setOne(id, { status: "error", progress: 0, detail: "Не удалось проверить после отмены", lastError: check.detail });
          } else {
            const installed = check.status === "installed";
            setOne(id, { status: installed ? "installed" : "missing", progress: installed ? 100 : 0, detail: installed ? `Проверено в ${packageBackendLabel(id)}` : "Пакет отсутствует" });
          }
        } else {
          setOne(id, { status: "error", progress: 0, detail: "Ошибка", lastError: result.error });
          showDialog(def.name, `Не удалось удалить:\n${result.error || "unknown"}`);
        }
      } else {
        const def = REVERSE_PACKAGES.find((p) => p.id === id);
        if (!def) return;
        busyIdRef.current = id;
        setBusyId(id);
        abortRef.current = false;
        setOne(id, { status: "removing", progress: 0, detail: "Удаление…", lastError: undefined });
        const result = await removeReversePackage(
          def,
          (p, detail) => setOne(id, { status: "removing", progress: p, detail }),
          () => abortRef.current,
          buildBackend,
        );
        if (result.ok) {
          setOne(id, { status: "missing", progress: 0, detail: "Удалено" });
        } else if (result.error === "aborted") {
          setOne(id, { status: "checking", progress: 0, detail: "Проверка после отмены…" });
          const check = await checkReversePackageInstalled(def, buildBackend);
          if (check.status === "error") {
            setOne(id, { status: "error", progress: 0, detail: "Не удалось проверить после отмены", lastError: check.detail });
          } else {
            const installed = check.status === "installed";
            setOne(id, { status: installed ? "installed" : "missing", progress: installed ? 100 : 0, detail: installed ? `Проверено в ${packageBackendLabel(id)}` : "Пакет отсутствует" });
          }
        } else {
          setOne(id, { status: "error", progress: 0, detail: "Ошибка", lastError: result.error });
          showDialog(def.name, `Не удалось удалить:\n${result.error || "unknown"}`);
        }
      }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        persistentLogger.add("error", "PackagesMenu", `REMOVE exception id=${id}: ${msg}`, "app");
        setOne(id, { status: "error", progress: 0, detail: "Ошибка", lastError: msg });
      } finally {
        busyIdRef.current = null;
        setBusyId(null);
      }
    },
    [termuxOk, setOne, showDialog, backendLabel, packageBackendLabel, buildBackend, language]
  );

  const cancelBusy = useCallback(() => {
    abortRef.current = true;
    const activeId = busyIdRef.current;
    if (activeId) {
      setOne(activeId, { detail: "Отмена запрошена — ждём завершения текущей команды перед проверкой состояния…" });
    }
    persistentLogger.add("warn", "PackagesMenu", `CANCEL requested id=${busyIdRef.current || "none"}`, "app");
  }, [setOne]);

  const refreshCustom = useCallback(async () => {
    const tools = await loadCustomTools();
    customToolsReadyRef.current = true;
    setCustomTools(tools);
  }, []);

  const handleVerifyCustom = useCallback(
    async (def: CustomToolDef) => {
      if (!termuxOk || busyIdRef.current) return;
      busyIdRef.current = def.id as AnyPkgId;
      setBusyId(def.id as AnyPkgId);
      setOne(def.id, { status: "checking", progress: 0, detail: `Проверка в ${packageBackendLabel(def.id)}…`, lastError: undefined });
      try {
        const check = await checkCustomToolInstalled(def, def.installKind === "custom", buildBackend);
        if (check.status === "error") {
          setOne(def.id, { status: "error", progress: 0, detail: "Не удалось проверить", lastError: check.detail });
        } else {
          const installed = check.status === "installed";
          setOne(def.id, {
            status: installed ? "installed" : "missing",
            progress: installed ? 100 : 0,
            detail: installed ? `Проверено в ${packageBackendLabel(def.id)}` : "Не найдено",
            lastError: undefined,
          });
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        setOne(def.id, { status: "error", progress: 0, detail: "Не удалось проверить", lastError: detail });
      } finally {
        busyIdRef.current = null;
        setBusyId(null);
      }
    },
    [termuxOk, setOne, packageBackendLabel, buildBackend]
  );

  const handleInstallCustom = useCallback(
    async (def: CustomToolDef) => {
      if (!getPrivatePackageMutationAvailability().allowed) {
        showDialog(backendLabel, offlinePackageMutationGateMessage(language));
        return;
      }
      if (!termuxOk || busyIdRef.current) return;
      abortRef.current = false;
      busyIdRef.current = def.id as AnyPkgId;
      setBusyId(def.id as AnyPkgId);
      void persistBusyInstall(def.id);
      setOne(def.id, { status: "installing", progress: 2, detail: "Старт…", lastError: undefined });
      try {
      const result = await installCustomTool(
        def,
        (p, detail) => setOne(def.id, { status: "installing", progress: p, detail }),
        () => abortRef.current,
        def.installKind === "custom",
        buildBackend,
      );
      setOne(def.id, { status: "checking", progress: 0, detail: `Проверка после установки в ${packageBackendLabel(def.id)}…` });
      const verification = await checkCustomToolInstalled(def, def.installKind === "custom", buildBackend);
      const reallyThere = verification.status === "installed";
      void persistBusyInstall(null);
      if (verification.status === "error") {
        setOne(def.id, { status: "error", progress: 0, detail: "Не удалось подтвердить установку", lastError: verification.detail });
        showDialog(def.name, `Проверка установки завершилась без подтверждения:\n${verification.detail}`);
      } else if (result.ok && reallyThere) {
        setOne(def.id, { status: "installed", progress: 100, detail: `Проверено в ${packageBackendLabel(def.id)}` });
      } else if (result.error === "aborted") {
        setOne(def.id, {
          status: reallyThere ? "installed" : "missing",
          progress: reallyThere ? 100 : 0,
          detail: reallyThere ? "Отменено (наличие подтверждено)" : "Отменено",
        });
      } else {
        setOne(def.id, { status: "error", progress: 0, detail: "Ошибка", lastError: result.error || "verify failed" });
        showDialog(def.name, `Не удалось установить:\n${result.error || "пакет не найден после установки"}`);
      }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        persistentLogger.add("error", "PackagesMenu", `CUSTOM INSTALL exception: ${msg}`, "app");
        setOne(def.id, { status: "error", progress: 0, detail: "Ошибка", lastError: msg });
        showDialog(def.name, `Сбой установки:\n${msg}`);
      } finally {
        void persistBusyInstall(null);
        busyIdRef.current = null;
        setBusyId(null);
      }
    },
    [termuxOk, setOne, showDialog, backendLabel, packageBackendLabel, buildBackend, language]
  );

  const handleRemoveCustom = useCallback(
    async (def: CustomToolDef) => {
      if (!getPrivatePackageMutationAvailability().allowed) {
        showDialog(backendLabel, offlinePackageMutationGateMessage(language));
        return;
      }
      if (!termuxOk || busyIdRef.current) return;
      abortRef.current = false;
      busyIdRef.current = def.id as AnyPkgId;
      setBusyId(def.id as AnyPkgId);
      void persistBusyInstall(def.id);
      setOne(def.id, { status: "removing", progress: 5, detail: "Удаление…" });
      try {
        const result = await removeCustomToolPkg(
          def,
          (p, detail) => setOne(def.id, { status: "removing", progress: p, detail }),
          () => abortRef.current,
          def.installKind === "custom",
          buildBackend,
        );
        if (result.ok) {
          setOne(def.id, { status: "missing", progress: 0, detail: "Удалено" });
        } else if (result.error === "aborted") {
          setOne(def.id, { status: "checking", progress: 0, detail: "Проверка после отмены…" });
          const check = await checkCustomToolInstalled(def, def.installKind === "custom", buildBackend);
          if (check.status === "error") {
            setOne(def.id, { status: "error", progress: 0, detail: "Не удалось проверить после отмены", lastError: check.detail });
          } else {
            const installed = check.status === "installed";
            setOne(def.id, { status: installed ? "installed" : "missing", progress: installed ? 100 : 0, detail: installed ? `Проверено в ${packageBackendLabel(def.id)}` : "Инструмент отсутствует" });
          }
        } else {
          setOne(def.id, { status: "error", progress: 0, detail: "Ошибка", lastError: result.error });
          showDialog(def.name, `Не удалось удалить:\n${result.error || "unknown"}`);
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        setOne(def.id, { status: "error", progress: 0, detail: "Ошибка", lastError: detail });
        showDialog(def.name, `Не удалось удалить:\n${detail}`);
      } finally {
        void persistBusyInstall(null);
        busyIdRef.current = null;
        setBusyId(null);
      }
    },
    [termuxOk, setOne, showDialog, packageBackendLabel, buildBackend, backendLabel, language]
  );

  const handleDeleteCustomDef = useCallback(
    async (def: CustomToolDef) => {
      showDialog(
        language === "en" ? "Remove from list?" : language === "uk" ? "Прибрати зі списку?" : "Убрать из списка?",
        language === "en"
          ? `Delete “${def.name}” definition? (Does not uninstall from the selected environment.)`
          : language === "uk"
            ? `Видалити «${def.name}» зі списку? (З вибраного середовища не знімає.)`
            : `Удалить «${def.name}» из списка? (Из выбранной среды не снимает.)`,
        [
          { text: language === "en" ? "Cancel" : "Отмена", style: "cancel" },
          {
            text: language === "en" ? "Delete" : "Удалить",
            style: "destructive",
            onPress: () => {
              void (async () => {
                await deleteCustomTool(def.id);
                await refreshCustom();
                setStates((prev) => {
                  const n = { ...prev };
                  delete n[def.id];
                  return n;
                });
              })();
            },
          },
        ]
      );
    },
    [showDialog, language, refreshCustom]
  );



  const title =
    language === "en" ? "Packages for install" : language === "uk" ? "Пакети для встановлення" : "Пакеты для установки";

  const sectionCompile =
    language === "en" ? "For compilation" : language === "uk" ? "Для компіляції" : "Для компиляции";
  const sectionReverse =
    language === "en" ? "Reverse engineering" : language === "uk" ? "Реверс-інжиніринг" : "Реверсинженеринг";
  const sectionCustom =
    language === "en" ? "User tools" : language === "uk" ? "Користувацькі" : "Пользовательские";
  const addToolsTitle =
    language === "en" ? "Add tools" : language === "uk" ? "Додавання інструментів" : "Добавление инструментов";
  const addToolsHint =
    language === "en"
      ? "Create a custom installable tool for compilation or reverse sections"
      : language === "uk"
        ? "Створіть свій інструмент для розділів компіляції або реверсу"
        : "Создайте свой инструмент для разделов компиляции или реверса";

  const renderPkgCard = (
    def: { id: string; name: string; nameEn: string; installCmd: string; blocked?: boolean; blockedReason?: string; removeBlockedReason?: string },
    kind: SectionId
  ) => {
    const st = states[def.id] || { status: "unknown" as const, progress: 0 };
    const isBusy = st.status === "installing" || st.status === "removing";
    const isInstalled = st.status === "installed";
    const isError = st.status === "error";
    const isBlocked = st.status === "blocked" || !!def.blocked;
    const isChecking = st.status === "checking";
    const name = language === "en" ? def.nameEn : def.name;
    const sharedRemovalNotice = language === "en"
      ? "Removal is disabled here because this SDK/package is shared with other tools."
      : language === "uk"
        ? "Видалення тут вимкнено: цей SDK/пакет спільний з іншими інструментами."
        : "Удаление здесь отключено: этот SDK/пакет общий с другими инструментами.";

    const badgeBg = isInstalled
      ? "rgba(143, 214, 154, 0.18)"
      : isBusy || isChecking
        ? "rgba(242, 200, 121, 0.18)"
        : isError
          ? colors.dangerDim
          : isBlocked
            ? "rgba(148,163,184,0.22)"
            : "rgba(154, 163, 172, 0.15)";
    const badgeLabel = isBusy
      ? "…"
      : isChecking
        ? "…"
        : isInstalled
          ? "OK"
          : isError
            ? "ERR"
            : isBlocked
              ? "OFF"
              : "—";
    const badgeColor = isBusy || isChecking
      ? colors.warning
      : isInstalled
        ? colors.success
        : isError
          ? colors.danger
          : colors.muted;

    return (
      <View
        key={def.id}
        style={[
          styles.card,
          {
            backgroundColor: colors.surface,
            borderColor: isError ? colors.danger : colors.line,
          },
        ]}
      >
        <View style={styles.cardTop}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.pkgName, { color: colors.inkBright }]} numberOfLines={2}>
              {name}
            </Text>
            <Text style={[styles.pkgId, { color: colors.muted }]}>{def.id}</Text>
            {!!st.detail && !isBusy && (
              <Text style={[styles.pkgId, { color: colors.muted, marginTop: 2 }]} numberOfLines={2}>
                {st.detail}
              </Text>
            )}
          </View>
          <View style={[styles.badge, { backgroundColor: badgeBg }]}>
            <Text style={{ color: badgeColor, fontWeight: "800", fontSize: 11 }}>{badgeLabel}</Text>
          </View>
        </View>

        {isBusy && (
          <View style={{ marginTop: 8 }}>
            <ProgressBar progress={st.progress} indeterminate sublabel={st.detail} />
          </View>
        )}

        {isError && !!st.lastError && (
          <Text style={[styles.errText, { color: colors.danger }]} numberOfLines={3}>
            {st.lastError}
          </Text>
        )}
        {!isBlocked && !!def.removeBlockedReason && (
          <Text style={[styles.pkgId, { color: colors.muted, marginTop: 4 }]}>{sharedRemovalNotice}</Text>
        )}

        <View style={styles.actions}>
          {isBusy ? (
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.dangerDim, borderColor: colors.danger }]}
              onPress={cancelBusy}
              activeOpacity={0.75}
            >
              <Ionicons name="close-circle-outline" size={18} color={colors.danger} />
              <Text style={[styles.btnText, { color: colors.danger }]}>Отмена</Text>
            </TouchableOpacity>
          ) : isBlocked ? (
            <View
              style={[
                styles.btn,
                {
                  backgroundColor: "rgba(148,163,184,0.12)",
                  borderColor: colors.line,
                  flex: 1,
                  opacity: 0.85,
                },
              ]}
            >
              <Ionicons name="lock-closed-outline" size={18} color={colors.muted} />
              <Text style={[styles.btnText, { color: colors.muted }]}>
                {isInstalled ? "Установлено · действия отключены" : "Недоступно"}
              </Text>
            </View>
          ) : (
            <>
              <TouchableOpacity
                style={[
                  styles.btn,
                  {
                    backgroundColor: packageMutationAllowed ? (isInstalled ? colors.accentDim : "#2F4F4F") : colors.surface,
                    borderColor: packageMutationAllowed ? (isInstalled ? colors.accent : "#2F4F4F") : colors.line,
                    flex: 1,
                    opacity: packageMutationAllowed ? 1 : 0.55,
                  },
                ]}
                onPress={() => void runInstall(def.id as AnyPkgId, kind)}
                activeOpacity={0.75}
                disabled={!!busyId || isChecking}
              >
                <Ionicons
                  name={isInstalled ? "refresh-outline" : "download-outline"}
                  size={18}
                  color={isInstalled ? colors.accent : "#FFFFFF"}
                />
                <Text
                  style={[
                    styles.btnText,
                    { color: isInstalled ? colors.accent : "#FFFFFF" },
                  ]}
                >
                  {packageMutationAllowed ? (isInstalled ? "Переуст." : "Установить") : (language === "en" ? "Unavailable" : "Недоступно")}
                </Text>
              </TouchableOpacity>

              {isInstalled && !def.removeBlockedReason && (
                <TouchableOpacity
                  style={[
                    styles.btnIcon,
                    { backgroundColor: colors.dangerDim, borderColor: colors.danger },
                  ]}
                  onPress={() => void runRemove(def.id as AnyPkgId, kind)}
                  activeOpacity={0.75}
                  disabled={!!busyId}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.danger} />
                </TouchableOpacity>
              )}
            </>
          )}
        </View>


      </View>
    );
  };


  const renderCustomCard = (def: CustomToolDef) => {
    const st = states[def.id] || { status: "unknown" as const, progress: 0 };
    const isBusy = st.status === "installing" || st.status === "removing";
    const isInstalled = st.status === "installed";
    const isError = st.status === "error";
    const isChecking = st.status === "checking";
    const name = language === "en" ? def.nameEn || def.name : def.name;
    const sectionLabel =
      def.section === "compile"
        ? language === "en"
          ? "Compilation"
          : language === "uk"
            ? "Компіляція"
            : "Компиляция"
        : language === "en"
          ? "Reverse"
          : language === "uk"
            ? "Реверс"
            : "Реверс";

    const badgeBg = isInstalled
      ? "rgba(143, 214, 154, 0.18)"
      : isBusy || isChecking
        ? "rgba(242, 200, 121, 0.18)"
        : isError
          ? colors.dangerDim
          : "rgba(154, 163, 172, 0.15)";
    const badgeLabel = isBusy
      ? "…"
      : isChecking
        ? "…"
        : isInstalled
          ? "OK"
          : isError
            ? "ERR"
            : "—";
    const badgeColor =
      isBusy || isChecking ? colors.warning : isInstalled ? colors.success : isError ? colors.danger : colors.muted;

    return (
      <View
        key={def.id}
        style={[
          styles.card,
          {
            backgroundColor: colors.surface,
            borderColor: isError ? colors.danger : colors.line,
          },
        ]}
      >
        <View style={styles.cardTop}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons
                name={(def.icon as any) || "extension-puzzle-outline"}
                size={18}
                color={colors.accent}
              />
              <Text style={[styles.pkgName, { color: colors.inkBright, flex: 1 }]} numberOfLines={2}>
                {name}
              </Text>
            </View>
            <Text style={[styles.pkgId, { color: colors.muted }]}> 
              {def.id} · {sectionLabel} · {def.installKind}
            </Text>
            {!!def.description && (
              <Text style={[styles.pkgId, { color: colors.muted, marginTop: 2 }]} numberOfLines={2}>
                {def.description}
              </Text>
            )}
            {!!st.detail && !isBusy && (
              <Text style={[styles.pkgId, { color: colors.muted, marginTop: 2 }]} numberOfLines={2}>
                {st.detail}
              </Text>
            )}
          </View>
          <View style={[styles.badge, { backgroundColor: badgeBg }]}>
            <Text style={{ color: badgeColor, fontWeight: "800", fontSize: 11 }}>{badgeLabel}</Text>
          </View>
        </View>

        {isBusy && (
          <View style={{ marginTop: 8 }}>
            <ProgressBar progress={st.progress} indeterminate sublabel={st.detail} />
          </View>
        )}

        {isError && !!st.lastError && (
          <Text style={[styles.errText, { color: colors.danger }]} numberOfLines={4}>
            {st.lastError}
          </Text>
        )}

        <View style={styles.cardActions}>
          {isBusy ? (
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.dangerDim, borderColor: colors.danger, flex: 1 }]}
              onPress={cancelBusy}
              activeOpacity={0.75}
            >
              <Ionicons name="stop-outline" size={18} color={colors.danger} />
              <Text style={[styles.btnText, { color: colors.danger }]}>
                {language === "en" ? "Cancel" : "Отмена"}
              </Text>
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity
                style={[
                  styles.btn,
                  {
                    backgroundColor: packageMutationAllowed ? (isInstalled ? colors.accentDim : "#2F4F4F") : colors.surface,
                    borderColor: packageMutationAllowed ? (isInstalled ? colors.accent : "#2F4F4F") : colors.line,
                    flex: 1,
                    opacity: packageMutationAllowed ? 1 : 0.55,
                  },
                ]}
                onPress={() => reviewRawCommand(def, "install", () => void handleInstallCustom(def))}
                activeOpacity={0.75}
                disabled={!!busyId || isChecking || !termuxOk}
              >
                <Ionicons
                  name={isInstalled ? "refresh-outline" : "download-outline"}
                  size={18}
                  color={isInstalled ? colors.accent : "#FFFFFF"}
                />
                <Text
                  style={[
                    styles.btnText,
                    { color: isInstalled ? colors.accent : "#FFFFFF" },
                  ]}
                >
                  {!packageMutationAllowed
                    ? language === "en" ? "Unavailable" : "Недоступно"
                    : isInstalled
                    ? language === "en"
                      ? "Reinstall"
                      : "Переуст."
                    : language === "en"
                      ? "Install"
                      : "Установить"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.btnIcon, { backgroundColor: colors.accentDim, borderColor: colors.accent }]}
                onPress={() => reviewRawCommand(def, "check", () => void handleVerifyCustom(def))}
                activeOpacity={0.75}
                disabled={!!busyId || isChecking || !termuxOk}
                accessibilityRole="button"
                accessibilityLabel={language === "en" ? "Verify custom tool" : language === "uk" ? "Перевірити інструмент" : "Проверить инструмент"}
              >
                <Ionicons name="checkmark-circle-outline" size={18} color={colors.accent} />
              </TouchableOpacity>

              {isInstalled && (
                <TouchableOpacity
                  style={[
                    styles.btnIcon,
                    { backgroundColor: colors.dangerDim, borderColor: colors.danger },
                  ]}
                  onPress={() => reviewRawCommand(def, "remove", () => void handleRemoveCustom(def))}
                  activeOpacity={0.75}
                  disabled={!!busyId}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.danger} />
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[
                  styles.btnIcon,
                  { backgroundColor: colors.accentDim, borderColor: colors.accent },
                ]}
                onPress={() => {
                  setEditTool(def);
                  setAddToolOpen(true);
                }}
                activeOpacity={0.75}
                disabled={!!busyId}
              >
                <Ionicons name="create-outline" size={18} color={colors.accent} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.btnIcon,
                  { backgroundColor: "rgba(154, 163, 172, 0.15)", borderColor: colors.line },
                ]}
                onPress={() => void handleDeleteCustomDef(def)}
                activeOpacity={0.75}
                disabled={!!busyId}
              >
                <Ionicons name="close-outline" size={18} color={colors.muted} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  };

  const runCacheCleanup = useCallback(async () => {
    if (cleaningCache || busyIdRef.current) return;
    if (!termuxOk) {
      showDialog(
        "Termux",
        language === "en"
          ? "Enable Termux session first."
          : language === "uk"
            ? "Спочатку увімкніть сесію Termux."
            : "Сначала включите сессию Termux.",
      );
      return;
    }
    const title =
      language === "en" ? "Clear Termux cache?" : language === "uk" ? "Очистити кеш Termux?" : "Очистить кеш Termux?";
    const message =
      language === "en"
        ? "Removes temporary files, apt/Gradle/pip/npm caches and AI Builder tmp/inbox.\n\nWill NOT delete: installed tools, Termux settings (~/.termux), Debian rootfs, project sources."
        : language === "uk"
          ? "Видалить тимчасові файли, кеш apt/Gradle/pip/npm і tmp/inbox AI Builder.\n\nНЕ чіпає: встановлені інструменти, налаштування Termux (~/.termux), Debian rootfs, вихідники проєктів."
          : "Удалит временные файлы, кеш apt/Gradle/pip/npm и tmp/inbox AI Builder.\n\nНЕ удалит: установленные инструменты, настройки Termux (~/.termux), Debian rootfs, исходники проектов.";
    const ok = await confirmDialog(
      title,
      message,
      language === "en" ? "Clear" : language === "uk" ? "Очистити" : "Очистить",
      language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена",
    );
    if (!ok) return;
    setCleaningCache(true);
    setCleanProgress(0);
    setCleanDetail(
      language === "en" ? "Starting…" : language === "uk" ? "Старт…" : "Старт…",
    );
    try {
      const result = await runTermuxCacheCleanup((p) => {
        setCleanProgress(p.percent);
        setCleanDetail(p.detail);
      });
      if (result.ok) {
        const extra = result.freedHint ? `\n${result.freedHint}` : "";
        showDialog(
          language === "en" ? "Cache cleared" : language === "uk" ? "Кеш очищено" : "Кеш очищен",
          (language === "en"
            ? "Temporary files and caches removed. Tools and Termux settings were kept."
            : language === "uk"
              ? "Тимчасові файли та кеші видалено. Інструменти й налаштування Termux збережено."
              : "Временные файлы и кеши удалены. Инструменты и настройки Termux сохранены.") + extra,
        );
      } else {
        showDialog(
          language === "en" ? "Cleanup failed" : language === "uk" ? "Помилка очищення" : "Ошибка очистки",
          (result.log || "unknown").slice(0, 500),
        );
      }
    } finally {
      setCleaningCache(false);
      setCleanProgress(0);
      setCleanDetail("");
    }
  }, [cleaningCache, termuxOk, language, confirmDialog, showDialog]);

  const renderSectionHeader = (

    section: SectionId,
    label: string,
    icon: keyof typeof Ionicons.glyphMap,
    count: number
  ) => {
    const isOpen = expanded[section];
    const isScanning = scanningSection === section;
    return (
      <TouchableOpacity
        style={[
          styles.sectionHeader,
          {
            backgroundColor: colors.surface,
            borderColor: colors.line,
          },
        ]}
        onPress={() => toggleSection(section)}
        activeOpacity={0.75}
      >
        <View style={styles.sectionHeaderLeft}>
          <View style={[styles.sectionIconWrap, { backgroundColor: colors.accentDim }]}>
            <Ionicons name={icon} size={18} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.sectionTitle, { color: colors.inkBright }]}>{label}</Text>
            <Text style={[styles.sectionMeta, { color: colors.muted }]}>
              {count} {language === "en" ? "tools" : language === "uk" ? "інструментів" : "инструментов"}
            </Text>
          </View>
        </View>
        {isScanning ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Ionicons
            name={isOpen ? "chevron-up" : "chevron-down"}
            size={20}
            color={colors.muted}
          />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.overlayRoot}>
        <Pressable style={[styles.backdrop, { backgroundColor: colors.overlay }]} onPress={onClose} />
        <Animated.View
          style={[
            styles.panel,
            {
              width: MENU_WIDTH,
              backgroundColor: colors.drawerBg,
              paddingTop: Math.max(insets.top, 12),
              paddingBottom: Math.max(insets.bottom, 12),
              transform: [{ translateX: slide }],
            },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: colors.line }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.inkBright }]}>{title}</Text>
              <View style={{ marginTop: 8, padding: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.surface }}>
                <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
                  {language === "en"
                    ? "Ordinary catalog changes remain disabled. Offline archives require native verification of the Karat-signed manifest, every file SHA-256, package/index metadata and a local-only APT simulation. The APT index itself is unsigned."
                    : language === "uk"
                      ? "Звичайні зміни каталогу вимкнені. Для офлайн-архіву потрібна нативна перевірка підписаного Karat маніфесту, SHA-256 кожного файлу, метаданих пакетів/індексу та локальної симуляції APT без мережі. Сам індекс APT не підписаний."
                      : "Обычные изменения каталога отключены. Для офлайн-архива необходима нативная проверка подписанного Karat манифеста, SHA-256 каждого файла, метаданных пакетов/индекса и локальной симуляции APT без сети. Сам индекс APT не подписан."}
                </Text>
              </View>
              <Text style={[styles.sectionMeta, { color: colors.muted, marginTop: 2 }]}>{language === "en" ? `Environment: ${backendLabel}` : language === "uk" ? `Середовище: ${backendLabel}` : `Среда: ${backendLabel}`}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>

          {availability.reason !== "eligible" && (
            <View style={[styles.warnBanner, { backgroundColor: colors.dangerDim }]}> 
              <Ionicons name="warning-outline" size={18} color={colors.danger} />
              <Text style={[styles.warnText, { color: colors.danger }]}> 
                {packageMenuAvailabilityMessage(availability.reason, language)}
              </Text>
            </View>
          )}


          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {scanningSection ? (
              <View style={[styles.scanRow, { borderBottomWidth: 1, borderBottomColor: colors.line, paddingBottom: 8, marginBottom: 6 }]}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={[styles.scanText, { color: colors.muted }]}>
                  {language === "en"
                    ? `Checking Termux ${scanningSection} tools; card results update as each check completes…`
                    : language === "uk"
                      ? `Перевірка інструментів Termux (${scanningSection}); статуси карток оновлюються по черзі…`
                      : `Проверка инструментов Termux (${scanningSection}); статусы карточек обновляются по очереди…`}
                </Text>
              </View>
            ) : null}

            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: offlineBundleState === "rejected" || offlineBundleState === "partial" ? colors.danger : colors.line }]}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.pkgName, { color: colors.inkBright }]}>
                    {language === "en" ? "Offline package archive" : language === "uk" ? "Офлайн-архів пакетів" : "Офлайн-архив пакетов"}
                  </Text>
                  <Text style={[styles.pkgId, { color: colors.muted }]}>
                    {language === "en"
                      ? "Stage an archive for native preflight. No package changes occur until you confirm the exact staged package list."
                      : language === "uk"
                        ? "Підготуйте архів для нативної перевірки. Пакети не змінюються, доки ви не підтвердите точний список підготовлених пакетів."
                        : "Подготовьте архив для нативной проверки. Пакеты не меняются, пока вы не подтвердите точный список подготовленных пакетов."}
                  </Text>
                </View>
                <Ionicons name={offlineBundleState === "blocked" ? "lock-closed-outline" : "archive-outline"} size={20} color={offlineBundleState === "rejected" || offlineBundleState === "partial" ? colors.danger : colors.accent} />
              </View>
              {offlineBundleState === "staging" || offlineBundleState === "installing" ? (
                <ProgressBar
                  progress={offlineBundleProgress}
                  indeterminate={false}
                  label={offlineBundlePhaseMessage(offlineBundlePhase, language)}
                  sublabel={offlineBundleState === "staging"
                    ? (language === "en" ? "Native preflight only; installation awaits your confirmation." : language === "uk" ? "Лише нативна перевірка; встановлення чекатиме на ваше підтвердження." : "Только нативная проверка; установка будет ждать вашего подтверждения.")
                    : (language === "en" ? "Native install in progress; cancellation may not undo completed changes." : language === "uk" ? "Нативне встановлення триває; скасування може не відкотити завершені зміни." : "Идёт нативная установка; отмена может не откатить завершённые изменения.")}
                />
              ) : null}
              {offlineBundleState === "ready" ? (
                <Text style={[styles.pkgId, { color: colors.accent, marginTop: 7 }]}>
                  {language === "en"
                    ? `Native preflight ready: ${offlineBundlePackageCount} package(s), ${formatOfflineBundleBytes(offlineBundleTotalBytes)} total archive/.deb bytes. Review the confirmation before installation.`
                    : language === "uk"
                      ? `Нативну перевірку пройдено: ${offlineBundlePackageCount} пакетів, ${formatOfflineBundleBytes(offlineBundleTotalBytes)} байтів архіву/.deb загалом. Перегляньте підтвердження перед встановленням.`
                      : `Нативная проверка пройдена: ${offlineBundlePackageCount} пакетов, ${formatOfflineBundleBytes(offlineBundleTotalBytes)} байт архива/.deb всего. Проверьте подтверждение перед установкой.`}
                </Text>
              ) : null}
              {offlineBundleState === "installed" ? (
                <Text style={[styles.pkgId, { color: colors.accent, marginTop: 7 }]}>
                  {language === "en" ? "The native installer reported: installed." : language === "uk" ? "Нативний інсталятор повідомив: встановлено." : "Нативный установщик сообщил: установлено."}
                </Text>
              ) : null}
              {offlineBundleState === "partial" ? (
                <Text style={[styles.pkgId, { color: colors.danger, marginTop: 7 }]}>
                  {language === "en" ? "The native installer reported a partial result. Some changes may have occurred; no rollback is claimed." : language === "uk" ? "Нативний інсталятор повідомив про частковий результат. Деякі зміни могли відбутися; відкат не стверджується." : "Нативный установщик сообщил о частичном результате. Некоторые изменения могли произойти; откат не заявляется."}
                </Text>
              ) : null}
              {offlineBundleState === "blocked" || offlineBundleState === "rejected" || offlineBundleState === "cancelled" ? (
                <Text style={[styles.pkgId, { color: offlineBundleState === "rejected" ? colors.danger : colors.muted, marginTop: 7 }]}>
                  {offlineBundleStatusMessage(offlineBundleCode ?? "AIB_OFFLINE_PACKAGE_RESULT_UNKNOWN", language)}
                </Text>
              ) : null}
              {offlineBundleCode === "AIB_OFFLINE_PACKAGE_CANCELLATION_REQUESTED" || offlineBundleCode === "AIB_OFFLINE_PACKAGE_CANCEL_REQUEST_FAILED" ? (
                <Text style={[styles.pkgId, { color: colors.muted, marginTop: 7 }]}>{offlineBundleStatusMessage(offlineBundleCode, language)}</Text>
              ) : null}
              {offlineBundleState === "rejected" && offlineBundleCode && !["AIB_OFFLINE_PACKAGE_CANCELLED"].includes(offlineBundleCode) ? (
                <Text style={[styles.pkgId, { color: colors.danger, marginTop: 7 }]}>
                  {language === "en" ? `Offline archive selection or validation failed (${offlineBundleCode}); no packages were installed.` : language === "uk" ? `Не вдалося вибрати або перевірити офлайн-архів (${offlineBundleCode}); пакети не встановлювалися.` : `Не удалось выбрать или проверить офлайн-архив (${offlineBundleCode}); пакеты не устанавливались.`}
                </Text>
              ) : null}
              <View style={styles.actions}>
                {offlineBundleState !== "staging" && offlineBundleState !== "installing" ? (
                  <TouchableOpacity
                    style={[styles.btn, { flex: 1, backgroundColor: colors.accentDim, borderColor: colors.accent }]}
                    onPress={() => void selectOfflineBundle()}
                    activeOpacity={0.75}
                  >
                    <Ionicons name="folder-open-outline" size={18} color={colors.accent} />
                    <Text style={[styles.btnText, { color: colors.accent }]}>
                      {language === "en" ? "Choose archive to stage" : language === "uk" ? "Вибрати архів для підготовки" : "Выбрать архив для проверки"}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {offlineBundleState === "staging" ? (
                  <TouchableOpacity
                    style={[styles.btn, { flex: 1, backgroundColor: colors.accentDim, borderColor: colors.accent }]}
                    onPress={cancelOfflineBundleOperation}
                    activeOpacity={0.75}
                  >
                    <Ionicons name="close-circle-outline" size={18} color={colors.accent} />
                    <Text style={[styles.btnText, { color: colors.accent }]}>{language === "en" ? "Cancel preflight" : language === "uk" ? "Скасувати перевірку" : "Отменить проверку"}</Text>
                  </TouchableOpacity>
                ) : null}
                {offlineBundleState === "installing" ? (
                  <TouchableOpacity
                    style={[styles.btn, { flex: 1, backgroundColor: colors.dangerDim, borderColor: colors.danger }]}
                    onPress={cancelOfflineBundleOperation}
                    activeOpacity={0.75}
                  >
                    <Ionicons name="close-circle-outline" size={18} color={colors.danger} />
                    <Text style={[styles.btnText, { color: colors.danger }]}>{language === "en" ? "Cancel install" : language === "uk" ? "Скасувати встановлення" : "Отменить установку"}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            <OnlinePackageFeedPanel sessionEnabled={termuxOk} />
            <FullCandidatePackagesPanel colors={colors} language={language} sessionEnabled={termuxOk} />
            {/* Add custom tools */}
            <TouchableOpacity
              style={[
                styles.addToolsBtn,
                { backgroundColor: colors.accentDim, borderColor: colors.accent },
              ]}
              onPress={() => {
                setEditTool(null);
                setAddToolOpen(true);
              }}
              activeOpacity={0.75}
            >
              <View style={[styles.addToolsIcon, { backgroundColor: colors.surface }]}>
                <Ionicons name="add-circle-outline" size={22} color={colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.addToolsTitle, { color: colors.inkBright }]}>{addToolsTitle}</Text>
                <Text style={[styles.addToolsHint, { color: colors.muted }]}>{addToolsHint}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.accent} />
            </TouchableOpacity>

            {/* Section: For compilation */}
            {renderSectionHeader(
              "compile",
              sectionCompile,
              "construct-outline",
              RIGHT_MENU_COMPILE_PACKAGES.length
            )}
            {expanded.compile && (
              <View style={styles.sectionBody}>
                {scanningSection === "compile" ? (
                  <View style={styles.scanRow}>
                    <ActivityIndicator size="small" color={colors.accent} />
                    <Text style={[styles.scanText, { color: colors.muted }]}>
                      {language === "en" ? "Checking Termux host tools…" : language === "uk" ? "Перевірка інструментів Termux…" : "Проверка инструментов Termux…"}
                    </Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.scanRow}
                    onPress={() => {
                      verifiedRef.current[`${buildBackend}:compile`] = false;
                      void verifySection("compile");
                    }}
                    disabled={!!busyId}
                  >
                    <Ionicons name="refresh-outline" size={16} color={colors.accent} />
                    <Text style={[styles.scanText, { color: colors.accent }]}>
                      {language === "en" ? "Recheck Termux tools" : language === "uk" ? "Повторно перевірити інструменти Termux" : "Перепроверить инструменты Termux"}
                    </Text>
                  </TouchableOpacity>
                )}
                {RIGHT_MENU_COMPILE_PACKAGES.map((def) => renderPkgCard(def, "compile"))}
              </View>
            )}

            {/* Section: Reverse engineering */}
            {renderSectionHeader("reverse", sectionReverse, "code-slash-outline", REVERSE_PACKAGES.length)}
            {expanded.reverse && (
              <View style={styles.sectionBody}>
                {scanningSection === "reverse" ? (
                  <View style={styles.scanRow}>
                    <ActivityIndicator size="small" color={colors.accent} />
                    <Text style={[styles.scanText, { color: colors.muted }]}>
                      {language === "en" ? "Checking Termux host tools…" : language === "uk" ? "Перевірка інструментів Termux…" : "Проверка инструментов Termux…"}
                    </Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.scanRow}
                    onPress={() => {
                      verifiedRef.current[`${RIGHT_PACKAGE_MENU_BACKEND}:reverse`] = false;
                      void verifySection("reverse");
                    }}
                    disabled={!!busyId}
                  >
                    <Ionicons name="refresh-outline" size={16} color={colors.accent} />
                    <Text style={[styles.scanText, { color: colors.accent }]}> 
                      {language === "en" ? "Recheck Termux tools" : language === "uk" ? "Повторно перевірити інструменти Termux" : "Перепроверить инструменты Termux"}
                    </Text>
                  </TouchableOpacity>
                )}
                {REVERSE_PACKAGES.map((def) => renderPkgCard(def, "reverse"))}
              </View>
            )}

            {/* Section: User / custom tools */}
            {renderSectionHeader("custom", sectionCustom, "person-outline", customTools.length)}
            {expanded.custom && (
              <View style={styles.sectionBody}>
                {customTools.length === 0 ? (
                  <Text style={[styles.scanText, { color: colors.muted, paddingVertical: 8 }]}>
                    {language === "en"
                      ? "No user tools yet. Tap “Add tools” above."
                      : language === "uk"
                        ? "Поки немає користувацьких інструментів. Натисніть «Додавання інструментів»."
                        : "Пока нет пользовательских инструментов. Нажмите «Добавление инструментов»."}
                  </Text>
                ) : (
                  <>
                    {scanningSection === "custom" ? (
                      <View style={styles.scanRow}>
                        <ActivityIndicator size="small" color={colors.accent} />
                        <Text style={[styles.scanText, { color: colors.muted }]}>
                          {language === "en" ? "Checking Termux host tools…" : language === "uk" ? "Перевірка інструментів Termux…" : "Проверка инструментов Termux…"}
                        </Text>
                      </View>
                    ) : (
                      <TouchableOpacity
                        style={styles.scanRow}
                        onPress={() => {
                          verifiedRef.current[`${RIGHT_PACKAGE_MENU_BACKEND}:custom`] = false;
                          void verifySection("custom");
                        }}
                        disabled={!!busyId}
                      >
                        <Ionicons name="refresh-outline" size={16} color={colors.accent} />
                        <Text style={[styles.scanText, { color: colors.accent }]}>
                          {language === "en" ? "Recheck tools" : language === "uk" ? "Повторно перевірити інструменти" : "Перепроверить инструменты"}
                        </Text>
                      </TouchableOpacity>
                    )}
                    {[...customTools]
                      .sort((a, b) => a.order - b.order)
                      .map((def) => renderCustomCard(def))}
                  </>
                )}
              </View>
            )}


            {/* Termux cache cleanup — bottom of menu */}
            <View
              style={[
                styles.cleanupCard,
                { backgroundColor: colors.surface, borderColor: colors.line },
              ]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <View style={[styles.sectionIconWrap, { backgroundColor: colors.accentDim }]}>
                  <Ionicons name="trash-bin-outline" size={20} color={colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.pkgName, { color: colors.inkBright }]}>
                    {language === "en"
                      ? "Clear Termux cache"
                      : language === "uk"
                        ? "Очистити кеш Termux"
                        : "Очистка кеша Termux"}
                  </Text>
                  <Text style={[styles.pkgId, { color: colors.muted }]}>
                    {language === "en"
                      ? "Temp files, apt/Gradle/npm caches. Tools & settings kept."
                      : language === "uk"
                        ? "Тимчасові файли, кеш apt/Gradle/npm. Інструменти й налаштування лишаються."
                        : "Временные файлы, кеш apt/Gradle/npm. Инструменты и настройки не трогаем."}
                  </Text>
                </View>
              </View>
              {cleaningCache ? (
                <View style={{ gap: 6 }}>
                  <ProgressBar progress={cleanProgress} sublabel={cleanDetail} />
                  <Text style={[styles.scanText, { color: colors.muted }]}>
                    {cleanDetail || `${cleanProgress}%`}
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={[
                    styles.btn,
                    {
                      backgroundColor: colors.accentDim,
                      borderColor: colors.accent,
                      opacity: busyId || !termuxOk ? 0.5 : 1,
                    },
                  ]}
                  disabled={!!busyId || cleaningCache || !termuxOk}
                  onPress={() => void runCacheCleanup()}
                  activeOpacity={0.75}
                >
                  <Ionicons name="trash-outline" size={16} color={colors.accent} />
                  <Text style={[styles.btnText, { color: colors.accent }]}>
                    {language === "en" ? "Clear cache" : language === "uk" ? "Очистити" : "Очистить"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={{ height: 24 }} />
          </ScrollView>
        </Animated.View>
      </View>
      <AddToolDialog
        visible={addToolOpen}
        initial={editTool}
        onClose={() => {
          setAddToolOpen(false);
          setEditTool(null);
        }}
        onSaved={(tool) => {
          void refreshCustom();
          setOne(tool.id, { status: "missing", progress: 0, detail: "Добавлено" });
          setExpanded((e) => ({ ...e, custom: true }));
          setEditTool(null);
          setAddToolOpen(false);
        }}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlayRoot: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  panel: {
    height: "100%",
    elevation: 16,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: -4, height: 0 },
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  closeBtn: {
    padding: 4,
    marginLeft: 8,
  },
  warnBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 12,
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
  },
  warnText: {
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
  },
  scanRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  scanText: {
    fontSize: 12,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 10,
  },
  addToolsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 4,
  },
  addToolsIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  addToolsTitle: {
    fontSize: 14,
    fontWeight: "800",
  },
  addToolsHint: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  pkgIcon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  pkgMeta: {
    fontSize: 10,
    marginTop: 2,
  },
  pkgDesc: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 6,
  },
  pkgDetail: {
    fontSize: 11,
    marginTop: 4,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    marginTop: 8,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
  cardActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  sectionHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  sectionIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "800",
  },
  sectionMeta: {
    fontSize: 11,
    marginTop: 1,
  },
  sectionBody: {
    gap: 10,
    marginTop: 2,
    marginBottom: 6,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  pkgName: {
    fontSize: 14,
    fontWeight: "700",
  },
  pkgId: {
    fontSize: 11,
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    minWidth: 40,
    alignItems: "center",
  },
  errText: {
    fontSize: 11,
    marginTop: 6,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  btnIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: {
    fontSize: 13,
    fontWeight: "700",
  },
  cleanupCard: {
    marginTop: 14,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 4,
  },
});
