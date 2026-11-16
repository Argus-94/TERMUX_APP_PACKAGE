/**
 * Runtime panel — AIBuilderTermux status, sessions, containers, privileges.
 * Bound to active project from ProjectContext when available.
 * Does not alter compilation settings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useLanguage } from "../components/LanguageContext";
import { runtimePreparationFailureText, runtimeProgressText, runtimeReadinessText, runtimeReasonFromDiagnostic, runtimeStageLabel, runtimeText as rtText } from "../lib/runtime-i18n";
import { shouldHideDuplicateRuntimeStatusBanner, type RuntimeStatusMessagePurpose } from "../lib/runtime-status-banner";
import { useTheme } from "../components/ThemeContext";
import { useAppSettingsContext } from "../components/AppSettingsContext";
import { useDialog } from "../components/DialogContext";
import { expandedHeaderStyle, expandedTitleColor, expandedIconColors } from "../lib/ui-expanded-highlight";
import { useProjectContext } from "../components/ProjectContext";
import { useRuntime } from "../hooks/useRuntime";
import { getRuntimeFacade } from "../lib/runtime-facade";
import { firstRunPromptDeferralStore } from "../lib/first-run-prompt";
import { ProgressBar } from "../components/ProgressBar";
import { listForegroundTasks, subscribeForegroundTasks, withForegroundTask, type ForegroundTask } from "../lib/foreground-task";
import { notifyBootstrapProgress } from "../lib/app-notifications";
import { notePossibleBuildKill, maybeSurvivalReminder } from "../lib/background-survival";
import { killAllRuntimeSessions } from "../lib/runtime-session";
import { getDesktopContentStyle, loadDesktopMode, isDesktopMode } from "../lib/appearance-prefs";
import { getFastPathSnapshot, formatFastPathMetricsBlock, resetFastPathMetrics } from "../lib/fast-path-metrics";
import { formatKeystorePolicyBlock, buildKeystorePresenceCheckCommand } from "../lib/keystore-policy";
import { buildShizukuProbeCommand, interpretPrivilegeProbeOutput, getPrivilegeSnapshot } from "../lib/privilege-awareness";
import { executeGuardedTermuxCommand } from "../lib/termux-executor";
import {
  adbWizardHelp,
  loadLastAdbHost,
  loadLastAdbSerial,
} from "../lib/adb-pairing";
import { bindProjectToRuntime } from "../core/project-runtime";
import { loadEnvironmentBackend, saveEnvironmentBackend } from "../lib/environment-manager";
import { isAgentShellBackend, type AgentShellBackend } from "../lib/agent-shell-backend";
import type { AgentShellExecutionTarget } from "../lib/agent-shell-target";
import { exportUbuntu, importUbuntu, defaultUbuntuExportPath, type DistroProgress } from "../lib/ubuntu-distro";
import { inspectTermuxProotDistro } from "../lib/proot-distro-inspector";
import { installProotDistroRootfsWithPrerequisite } from "../lib/proot-distro-bootstrap";
import type { ProotDistroState } from "../lib/proot-distro-state";
import { prepareProotRuntimeEnvironment } from "../lib/runtime-environment-preparation";
import { canOfferRuntimePreparationAction, projectProotRootfsReadiness, projectRuntimeEnvironment } from "../lib/runtime-environment-projection";
import { runProotRuntimePreparationAction } from "../lib/runtime-environment-action";
import { inspectProotRuntimeReadiness, type ProotRuntimeTarget, type RuntimeEnvironmentReadiness, type RuntimeReadinessPhase } from "../lib/runtime-environment-check";
import { TERMUX_MIRROR_REPAIR, withInstallerEnvironment } from "../lib/termux-installer-env";
import { runPackageCommand } from "../lib/package-backend";
import {
  checkTermuxReadiness,
  getAIBuilderAllFilesAccessStatus,
  getAIBuilderWorkspaceGrantStatus,
  openAIBuilderAllFilesAccessSettings,
  requestAIBuilderWorkspaceGrant,
} from "../lib/termux-bridge";
import { persistentLogger } from "../lib/persistent-logger";
import { classifyDiagnosticError, createTraceCorrelationId, type TraceStatus } from "../lib/diagnostic-trace";
import { startDeviceWatchdog, stopDeviceWatchdog } from "../lib/device-watchdog";
import { useLLM } from "../hooks/useLLM";
import type { PerformanceModeName } from "../core/enhancements/performance/PerformanceMode";
import * as Clipboard from "expo-clipboard";
import type { PublicSecondaryDisplay } from "../core/enhancements/device/types";
import { PortForwardPanel, RevokedPermissionsNotice, RuntimeStatusPanel, TerminalPreferencesPanel } from "../components/RuntimeEnhancementPanels";

type SecondaryDisplayFrame = Readonly<{ displayId: number; frameId: string; width: number; height: number; data: string }>;
type RuntimeActivityProgress = Readonly<{
  phase: string;
  detail: string;
  activeCommand: string | null;
  completedStep: string | null;
}>;

/** Never expose package-install/build actions until the private feed and device toolchain are qualified. */
const privateBuildQualificationConfirmed = false;

/** Ordered steps for live check UI (Termux / Ubuntu). */
function runtimeCheckStepIds(backend: string): string[] {
  if (backend === "termux") return ["host-check", "ready"];
  return ["host-check", "rootfs-check", "guest-baseline", "ready"];
}

function runtimeStepStatus(
  stepId: string,
  currentPhase: string,
  finished: boolean,
): "done" | "active" | "pending" {
  if (finished || currentPhase === "ready") {
    return "done";
  }
  if (currentPhase === "missing") {
    return stepId === "host-check" ? "done" : stepId === "ready" ? "active" : "pending";
  }
  if (currentPhase === "error") {
    return stepId === "ready" ? "pending" : "done";
  }
  const order = ["host-check", "rootfs-check", "guest-baseline", "guest-preflight", "guest-install", "ready"];
  const cur = order.indexOf(currentPhase);
  const step = order.indexOf(stepId);
  if (cur < 0) return stepId === currentPhase ? "active" : "pending";
  if (step < cur) return "done";
  if (step === cur) return "active";
  return "pending";
}

/** Keep UI alive during long shell probes (rootfs login can take up to ~90s). */
async function withRuntimeCommandHeartbeat<T>(
  label: string,
  run: () => Promise<T>,
  onTick: (elapsedSec: number, label: string) => void,
  intervalMs = 3000,
): Promise<T> {
  const started = Date.now();
  onTick(0, label);
  const id = setInterval(() => {
    const sec = Math.max(1, Math.floor((Date.now() - started) / 1000));
    onTick(sec, label);
  }, intervalMs);
  try {
    return await run();
  } finally {
    clearInterval(id);
  }
}

export default function RuntimeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { firstRunSetup } = useLocalSearchParams<{ firstRunSetup?: string }>();
  const firstRunAutoStarted = useRef(false);
  const { t, language } = useLanguage();
  const [desktopLayout, setDesktopLayout] = useState(isDesktopMode());
  useEffect(() => { void loadDesktopMode().then(setDesktopLayout); }, []);
  const [fastPathTick, setFastPathTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFastPathTick((n) => n + 1), 4000);
    return () => clearInterval(id);
  }, []);
  const fastPath = useMemo(() => getFastPathSnapshot(), [fastPathTick]);
  const rt = (key: Parameters<typeof rtText>[1], params?: Record<string, string | number>) => rtText(language, key, params);
  const { runDeviceDevelopmentLoop, runSelfHealingDeviceQA, runAIReleaseGate, runAIReleaseArtifact, runAIReleaseChannel, runAIRollbackReleaseChannel, runAIProductionDeployment, runAIDeviceFleetDeployment, runAIFleetCanary, runAIFleetObservability, runAIFleetCommandCenter, runAIFleetUnifiedControlCenter, runAIFleetDeviceCommand, runAIFleetPolicy, setAIFleetPolicy, runAIFleetAudit, runAISecureFleetAudit, runAIVerifyFleetAudit, runAICreateFleetSnapshot, runAIRestoreFleetSnapshot, runAIExportFleetAuditBundle, runAICreateFleetBackup, runAIVerifyFleetBackup, runAIRestoreFleetBackup, runAIListFleetBackups, runAIFleetRecoveryDrill, runAIFleetRecoverySchedule, setAIFleetRecoverySchedule, runAIFleetRecoverySlo, runAIScheduledFleetRecovery, runAIFleetSloDashboard, acknowledgeAIFleetDashboardAlert, acknowledgeAIFleetDashboardIncident, runAIFleetAlertEscalation, acknowledgeAIFleetEscalatedAlert, resolveAIFleetEscalatedAlert } = useLLM();
  const { colors } = useTheme();
  const { showDialog, confirmDialog } = useDialog();
  const { project } = useProjectContext();
  const {
    status,
    diagnostics,
    loading,
    error,
    refresh,
    openProjectSession,
    launchUbuntu,
    openTerminal,
    createAgent,
    runProotAuto,
    stopContainer,
    destroyContainer,
    runRecovery,
    listRecoveryActions,
    runFinalValidation,
    ensureRootfs,
    createBackup,
    restoreBackup,
  } = useRuntime();

  const defaultId = project?.id || project?.name || "demo";
  const [projectId, setProjectId] = useState(defaultId);
  const [busy, setBusy] = useState(false);
  const [healthBusy, setHealthBusy] = useState(false);
  const [lastBootInfo, setLastBootInfo] = useState<string | null>(null);
  const [failureRows, setFailureRows] = useState<Array<{ id: string; code: string; component: string; message: string; at: number }>>([]);
  const [healthRows, setHealthRows] = useState<Array<{ id: string; level: string; message: string; repairable?: boolean }>>([]);
  const [message, setMessageState] = useState<string | null>(null);
  const [messageSource, setMessageSource] = useState<"app" | "runtime-status">("app");
  const runtimeStatusMessageRef = useRef<string | null>(null);
  const runtimeStatusMessagePurposeRef = useRef<RuntimeStatusMessagePurpose | null>(null);
  const setMessage = useCallback((value: string | null) => {
    runtimeStatusMessageRef.current = null;
    runtimeStatusMessagePurposeRef.current = null;
    setMessageSource("app");
    setMessageState(value);
  }, []);
  const setRuntimeStatusMessage = useCallback((value: string | null, purpose: RuntimeStatusMessagePurpose = "readiness-result") => {
    runtimeStatusMessageRef.current = value;
    runtimeStatusMessagePurposeRef.current = value === null ? null : purpose;
    setMessageSource(value === null ? "app" : "runtime-status");
    setMessageState(value);
  }, []);
  const [backupPath, setBackupPath] = useState("");
  const [backupScope, setBackupScope] = useState<"full" | "projects" | "sessions" | "toolchains">("full");
  const [backupList, setBackupList] = useState<Array<{ path: string; scope?: string; createdAt?: number; digest?: string; fileCount?: number; totalBytes?: number; appVersion?: string }>>([]);
  const [backupInspect, setBackupInspect] = useState<string>("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceAvailable, setDeviceAvailable] = useState<boolean | null>(null);
  const [accessibilityStatusText, setAccessibilityStatusText] = useState("Not checked; no automatic permission request.");
  const [virtualDisplayStatusText, setVirtualDisplayStatusText] = useState("Not checked; screen capture requires the enabled Accessibility Service and a separate app grant.");
  const [secondaryDisplays, setSecondaryDisplays] = useState<readonly PublicSecondaryDisplay[]>([]);
  const [secondaryFrame, setSecondaryFrame] = useState<SecondaryDisplayFrame | null>(null);
  const [secondaryTapX, setSecondaryTapX] = useState("");
  const [secondaryTapY, setSecondaryTapY] = useState("");
  const [secondaryTreeStatus, setSecondaryTreeStatus] = useState("");
  const [adbPairHost, setAdbPairHost] = useState("");
  const [adbPairCode, setAdbPairCode] = useState("");
  const [adbConnectHost, setAdbConnectHost] = useState("");
  const [adbDevicesText, setAdbDevicesText] = useState("");
  const [deviceOutput, setDeviceOutput] = useState<string>("");
  const [deviceApkPath, setDeviceApkPath] = useState("/storage/emulated/0/AIBuilderTermux/app-debug.apk");
  const [devicePackageName, setDevicePackageName] = useState("");
  const [deviceGoal, setDeviceGoal] = useState("Проверь главный экран приложения: он должен открыться без crash, найди основное действие и убедись, что оно работает.");
  const [deviceLoopBusy, setDeviceLoopBusy] = useState(false);
  const [deviceSuiteBusy, setDeviceSuiteBusy] = useState(false);
  const [deviceSelfHealBusy, setDeviceSelfHealBusy] = useState(false);
  const [deviceReleaseGateBusy, setDeviceReleaseGateBusy] = useState(false);
  const [deviceReleaseArtifactBusy, setDeviceReleaseArtifactBusy] = useState(false);
  const [deviceReleaseChannelBusy, setDeviceReleaseChannelBusy] = useState(false);
  const [deviceRollbackBusy, setDeviceRollbackBusy] = useState(false);
  const [deviceDeployBusy, setDeviceDeployBusy] = useState(false);
  const [deviceReleaseChannel, setDeviceReleaseChannel] = useState("internal");
  const [fleetCommandBusy, setFleetCommandBusy] = useState(false);
  const [fleetSnapshot, setFleetSnapshot] = useState<any | null>(null);
  const [fleetUnifiedControl, setFleetUnifiedControl] = useState<any | null>(null);
  const [fleetPolicy, setFleetPolicy] = useState<any | null>(null);
  const [fleetRole, setFleetRole] = useState("operator");
  const [fleetConfirmation, setFleetConfirmation] = useState("DEPLOY PRODUCTION");
  const [fleetBackupSecret, setFleetBackupSecret] = useState("");
  const [fleetBackups, setFleetBackups] = useState<any[]>([]);
  const [fleetRecoverySchedule, setFleetRecoveryScheduleState] = useState<any | null>(null);
  const [fleetRecoverySlo, setFleetRecoverySlo] = useState<any | null>(null);
  const [fleetSloDashboard, setFleetSloDashboard] = useState<any | null>(null);
  const [fleetEscalation, setFleetEscalation] = useState<any | null>(null);
  const [linuxStatus, setLinuxStatus] = useState<any | null>(null);
  const { setAgentShellBackend, agentShellExecutionTarget, setAgentShellExecutionTarget } = useAppSettingsContext();
  const [aiBuilderWorkspaceGrant, setAIBuilderWorkspaceGrant] = useState<{ granted: boolean; reason: string | null } | null>(null);
  const [aiBuilderWorkspaceGrantBusy, setAIBuilderWorkspaceGrantBusy] = useState(false);
  const [aiBuilderWorkspaceGrantFeedback, setAIBuilderWorkspaceGrantFeedback] = useState<string | null>(null);
  const [aiBuilderAllFilesAccess, setAIBuilderAllFilesAccess] = useState<{ supported: boolean; granted: boolean; reason: string | null } | null>(null);
  const [aiBuilderAllFilesAccessBusy, setAIBuilderAllFilesAccessBusy] = useState(false);
  const [aiBuilderAllFilesAccessFeedback, setAIBuilderAllFilesAccessFeedback] = useState<string | null>(null);
  const refreshAIBuilderAllFilesAccess = useCallback(async () => {
    const status = await getAIBuilderAllFilesAccessStatus();
    setAIBuilderAllFilesAccess(status);
    return status;
  }, []);
  const refreshAIBuilderWorkspaceGrant = useCallback(async () => {
    const status = await getAIBuilderWorkspaceGrantStatus();
    setAIBuilderWorkspaceGrant(status);
    return status;
  }, []);
  useEffect(() => {
    void refreshAIBuilderAllFilesAccess();
    void refreshAIBuilderWorkspaceGrant();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refreshAIBuilderAllFilesAccess();
        void refreshAIBuilderWorkspaceGrant();
      }
    });
    return () => subscription.remove();
  }, [refreshAIBuilderAllFilesAccess, refreshAIBuilderWorkspaceGrant]);
  const onOpenAIBuilderAllFilesAccessSettings = useCallback(async () => {
    setAIBuilderAllFilesAccessBusy(true);
    setAIBuilderAllFilesAccessFeedback(null);
    try {
      const opened = await openAIBuilderAllFilesAccessSettings();
      setAIBuilderAllFilesAccessFeedback(opened
        ? ({ ru: "Открыты настройки Android. Включите «Доступ ко всем файлам» для AI Builder и вернитесь сюда; статус будет проверен повторно.", uk: "Відкрито налаштування Android. Увімкніть «Доступ до всіх файлів» для AI Builder і поверніться сюди; статус буде перевірено повторно.", en: "Android Settings opened. Enable All files access for AI Builder, then return here; the status will be checked again." }[language])
        : "AIB_ALL_FILES_ACCESS_SETTINGS_LAUNCH_FAILED");
    } catch (error) {
      setAIBuilderAllFilesAccessFeedback(error instanceof Error ? error.message : "AIB_ALL_FILES_ACCESS_SETTINGS_LAUNCH_FAILED");
    } finally {
      await refreshAIBuilderAllFilesAccess();
      setAIBuilderAllFilesAccessBusy(false);
    }
  }, [language, refreshAIBuilderAllFilesAccess]);
  const onRequestAIBuilderWorkspaceGrant = useCallback(async () => {
    setAIBuilderWorkspaceGrantBusy(true);
    setAIBuilderWorkspaceGrantFeedback(null);
    try {
      const status = await requestAIBuilderWorkspaceGrant();
      setAIBuilderWorkspaceGrant(status);
      await refreshAIBuilderWorkspaceGrant();
      setAIBuilderWorkspaceGrantFeedback(status.granted
        ? ({ ru: "Предоставлен read-only доступ к точной папке AIBuilderTermux.", uk: "Надано read-only доступ до точної папки AIBuilderTermux.", en: "Read-only access granted for the exact AIBuilderTermux folder." }[language])
        : status.reason || "AIB_WORKSPACE_GRANT_REQUIRED");
    } catch (error) {
      setAIBuilderWorkspaceGrantFeedback(error instanceof Error ? error.message : "AIB_WORKSPACE_GRANT_FAILED");
      await refreshAIBuilderWorkspaceGrant();
    } finally {
      setAIBuilderWorkspaceGrantBusy(false);
    }
  }, [language, refreshAIBuilderWorkspaceGrant]);
  const [environmentBackend, setEnvironmentBackend] = useState<AgentShellBackend>("termux");
  const [ubuntuDistroState, setUbuntuDistroState] = useState<ProotDistroState | null>(null);
  const [termuxReady, setTermuxReady] = useState<boolean | null>(null);
  const [runtimeReadiness, setRuntimeReadiness] = useState<RuntimeEnvironmentReadiness | null>(null);
  const [runtimeCheckProgress, setRuntimeCheckProgress] = useState<RuntimeActivityProgress | null>(null);
  const [runtimePreparationUiProgress, setRuntimePreparationUiProgress] = useState<RuntimeActivityProgress | null>(null);
  const [linuxOutput, setLinuxOutput] = useState("");
  const [containerBusy, setContainerBusy] = useState(false);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [containerOutput, setContainerOutput] = useState("");
  const [linuxBusy, setLinuxBusy] = useState(false);
  const [runtimePreparationRunning, setRuntimePreparationRunning] = useState(false);
  /** Wall-clock seconds while check/prepare runs — proves UI is alive. */
  const [runtimeActivityElapsedSec, setRuntimeActivityElapsedSec] = useState(0);
  const runtimePreparationAbortRef = useRef(false);
  const runtimeEnvironmentActionRef = useRef(false);
  const runtimeTraceIdRef = useRef<string | null>(null);
  const environmentStatusGenerationRef = useRef(0);

  useEffect(() => {
    const active = linuxBusy || runtimePreparationRunning;
    if (!active) {
      setRuntimeActivityElapsedSec(0);
      return;
    }
    setRuntimeActivityElapsedSec(0);
    const id = setInterval(() => {
      setRuntimeActivityElapsedSec((s) => s + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [linuxBusy, runtimePreparationRunning]);

  const [debianProgress, setDebianProgress] = useState<DistroProgress | null>(null);
  const [debianExportPath, setDebianExportPath] = useState("");
  const [ubuntuImportPath, setUbuntuImportPath] = useState("");
  const [ubuntuExportPath, setUbuntuExportPath] = useState("");
  const [fgTasks, setFgTasks] = useState<ForegroundTask[]>([]);
  const [bootState, setBootState] = useState<any | null>(null);
  const [bootBusy, setBootBusy] = useState(false);
  const [bootPercent, setBootPercent] = useState(0);
  const [bootMsg, setBootMsg] = useState("");
  const [firstRunReport, setFirstRunReport] = useState("");
  const [firstRunJson, setFirstRunJson] = useState("");
  const [performanceMode, setPerformanceMode] = useState<PerformanceModeName>("Balanced");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [workspaceBuildBusy, setWorkspaceBuildBusy] = useState(false);
  const [workspaceBuildOutput, setWorkspaceBuildOutput] = useState("");
  const [projectGenerateBusy, setProjectGenerateBusy] = useState(false);
  const [projectGenerateOutput, setProjectGenerateOutput] = useState("");
  const [codingAgentBusy, setCodingAgentBusy] = useState(false);
  const [codingAgentOutput, setCodingAgentOutput] = useState("");
  const [realDeviceBusy, setRealDeviceBusy] = useState(false);
  const [realDeviceOutput, setRealDeviceOutput] = useState("");
  const [persistentWorkspaceBusy, setPersistentWorkspaceBusy] = useState(false);
  const [persistentWorkspaceOutput, setPersistentWorkspaceOutput] = useState("");
  const [projectMemoryBusy, setProjectMemoryBusy] = useState(false);
  const [projectMemoryOutput, setProjectMemoryOutput] = useState("");
  const [factoryBusy, setFactoryBusy] = useState(false);
  const [factoryName, setFactoryName] = useState(defaultId);
  const [factoryPrompt, setFactoryPrompt] = useState("Создай Android Expo-приложение с главным экраном и одной полезной функцией. Подготовь рабочий APK.");
  const [factoryOutput, setFactoryOutput] = useState("");



  useEffect(() => {
    if (project?.id) setProjectId(project.id);
  }, [project?.id]);

  useEffect(() => {
    setFgTasks(listForegroundTasks());
    return subscribeForegroundTasks((tasks) => setFgTasks([...tasks]));
  }, []);

  // A3: soft-start process supervisor when Runtime screen is open (not cold-start battery).
  useEffect(() => {
    try {
      getRuntimeFacade().startSupervisor();
    } catch {
      /* optional */
    }
    return () => {
      /* leave running for long jobs; user can Stop */
    };
  }, []);


  useEffect(() => {
    void (async () => {
      const h = await loadLastAdbHost();
      if (h) setAdbConnectHost(h);
      const s = await loadLastAdbSerial();
      if (s) setAdbDevicesText((prev) => prev || `last: ${s}`);
    })();
  }, []);

  const onRunRealDeviceIntegration = useCallback(async () => {
    setRealDeviceBusy(true);
    setRealDeviceOutput("");
    try {
      const result = await getRuntimeFacade().runRealDeviceIntegration({
        apkPath: deviceApkPath.trim() || undefined,
        packageName: devicePackageName.trim() || undefined,
        launch: Boolean(devicePackageName.trim()),
        screenshotPath: `${getRuntimeFacade().home.cache}/phase33-device.png`,
      });
      setRealDeviceOutput(JSON.stringify(result, null, 2));
    } catch (e) {
      setRealDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setRealDeviceBusy(false);
    }
  }, [deviceApkPath, devicePackageName]);

  const onPersistentWorkspace = useCallback(async (action: "status" | "checkpoint" | "snapshot" | "undo") => {
    const id = projectId.trim() || project?.id || defaultId;
    setPersistentWorkspaceBusy(true);
    setPersistentWorkspaceOutput("");
    try {
      const runtime = getRuntimeFacade();
      let result: unknown;
      if (action === "status") {
        const [status, history] = await Promise.all([runtime.persistentWorkspaceStatus(id), runtime.persistentWorkspaceHistory(id, 8)]);
        result = { status, history, diff: status.clean ? "" : await runtime.persistentWorkspaceDiff(id) };
      } else if (action === "checkpoint") {
        result = await runtime.persistentWorkspaceCheckpoint(id, "AI Builder checkpoint");
      } else if (action === "snapshot") {
        result = await runtime.persistentWorkspaceSnapshot(id, "manual");
      } else {
        await runtime.persistentWorkspaceRestore(id, "HEAD~1");
        result = await runtime.persistentWorkspaceStatus(id);
      }
      setPersistentWorkspaceOutput(JSON.stringify(result, null, 2));
    } catch (e) {
      setPersistentWorkspaceOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setPersistentWorkspaceBusy(false);
    }
  }, [projectId, project?.id, defaultId]);

  const onProjectMemory = useCallback(async (action: "status" | "build" | "fix" | "test" | "reset") => {
    const id = projectId.trim() || project?.id || defaultId;
    setProjectMemoryBusy(true); setProjectMemoryOutput("");
    try {
      const runtime = getRuntimeFacade(); let result: unknown;
      if (action === "status") result = await runtime.projectMemoryGet(id);
      else if (action === "build") result = await runtime.projectMemoryRecordBuild(id, "Manual build checkpoint", "Recorded from Runtime UI");
      else if (action === "fix") result = await runtime.projectMemoryRecordFix(id, "Manual successful fix", "Recorded from Runtime UI");
      else if (action === "test") result = await runtime.projectMemoryRecordTest(id, "Manual test checkpoint", "Recorded from Runtime UI");
      else result = await runtime.projectMemoryReset(id);
      setProjectMemoryOutput(JSON.stringify(result, null, 2));
    } catch (e) { setProjectMemoryOutput(e instanceof Error ? e.message : String(e)); }
    finally { setProjectMemoryBusy(false); }
  }, [projectId, project?.id, defaultId]);

  const onOneClickFactory = useCallback(async () => {
    const name = factoryName.trim() || projectId.trim() || defaultId;
    const prompt = factoryPrompt.trim();
    if (!prompt) { setFactoryOutput("Factory prompt is required"); return; }
    setFactoryBusy(true);
    setFactoryOutput("");
    try {
      const result = await getRuntimeFacade().runOneClickAppFactory({
        name,
        prompt,
        template: "expo",
        runDeviceQA: false,
        maxCodingIterations: 3,
        maxBuildAttempts: 2,
      });
      setFactoryOutput(JSON.stringify(result, null, 2));
    } catch (e) {
      setFactoryOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setFactoryBusy(false);
      await refresh();
    }
  }, [factoryName, factoryPrompt, projectId, defaultId, refresh]);

  const onOpenSession = useCallback(() => {
    const id = projectId.trim() || defaultId;
    openProjectSession(id);
    setMessage(`session:${id}`);
  }, [openProjectSession, projectId, defaultId]);

  const onLaunchUbuntu = useCallback(async () => {
    if (environmentBackend !== "ubuntu-proot" || runtimeReadiness?.target !== "ubuntu-proot" || runtimeReadiness.status !== "ready") {
      setMessage(rtText(language, "actionRequiresCheck", { distro: "Ubuntu" }));
      return;
    }
    const id = projectId.trim() || defaultId;
    setBusy(true);
    setMessage(null);
    try {
      await launchUbuntu(id);
      setMessage(`ubuntu:${id}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [environmentBackend, runtimeReadiness, launchUbuntu, projectId, defaultId, language]);

  const onOpenTerminal = useCallback(async () => {
    const id = projectId.trim() || defaultId;
    setBusy(true);
    setMessage(null);
    try {
      const termId = await openTerminal(id, project?.id === id ? project.path : undefined);
      setMessage(`terminal:${termId}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [openTerminal, project, projectId, defaultId]);

  const onCreateAgent = useCallback(() => {
    const id = projectId.trim() || defaultId;
    try {
      const agentId = createAgent(id);
      setMessage(`agent:${agentId}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [createAgent, projectId, defaultId]);

  const onRunProot = useCallback(async () => {
    const isUbuntu = environmentBackend === "ubuntu-proot";
    if (
      !isUbuntu ||
      runtimeReadiness?.status !== "ready" ||
      runtimeReadiness?.target !== environmentBackend
    ) {
      setMessage(rtText(language, "actionRequiresCheck", { distro: "Ubuntu proot" }));
      return;
    }
    const id = projectId.trim() || defaultId;
    setBusy(true);
    setMessage(null);
    try {
      // Ubuntu proot: shell/APK via agent (apt in guest); optional container profile for legacy demos.
      setMessage(
        language === "ru"
          ? "Ubuntu proot готов. Сборка APK и shell идут через агента (apt в guest), без зависания на ложном rootfs-install."
          : language === "uk"
            ? "Ubuntu proot готовий. Збірка APK і shell йдуть через агента (apt у guest)."
            : "Ubuntu proot is ready. APK builds and shell go through the agent (apt in guest).",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [environmentBackend, runtimeReadiness, runProotAuto, projectId, defaultId, status?.containerList, language]);


  const environmentLabel = useMemo(() => ({
    termux: { ru: "Termux", uk: "Termux", en: "Termux" },
    "ubuntu-proot": { ru: "Ubuntu proot", uk: "Ubuntu proot", en: "Ubuntu proot" },
  }[environmentBackend] ?? { ru: "Termux", uk: "Termux", en: "Termux" }), [environmentBackend]);
  const selectedReadiness = runtimeReadiness?.target === environmentBackend ? runtimeReadiness : null;
  const activeProotStatus = projectProotRootfsReadiness(selectedReadiness);
  const runtimeProjection = useMemo(() => projectRuntimeEnvironment(environmentBackend, {
    termuxReady,
    ubuntu: environmentBackend === "ubuntu-proot" ? activeProotStatus : null,
    debian: environmentBackend === "ubuntu-proot" && activeProotStatus
      ? { rootfsInstalled: activeProotStatus.installed, healthy: activeProotStatus.healthy }
      : null,
  }), [environmentBackend, termuxReady, activeProotStatus]);
  const canPrepareSelected = runtimeProjection.prepareAlias !== null && canOfferRuntimePreparationAction(environmentBackend, selectedReadiness);

  const selectedEnvironmentStatusSummary = environmentBackend === "termux"
    ? termuxReady === true
      ? ({ ru: "Termux: готов", uk: "Termux: готовий", en: "Termux: ready" } as const)[language]
      : termuxReady === false
        ? ({ ru: "Termux: требуется настройка", uk: "Termux: потрібне налаштування", en: "Termux: setup required" } as const)[language]
        : ({ ru: "Termux: не проверен", uk: "Termux: не перевірено", en: "Termux: not checked" } as const)[language]
    : !selectedReadiness
      ? `${environmentLabel[language]}: ${{ ru: "не проверена", uk: "не перевірено", en: "not checked" }[language]}`
      : runtimeReadinessText(language, selectedReadiness);
  const selectedCardReadinessStatus = environmentBackend === "termux"
    ? termuxReady === true ? "ready" : termuxReady === false ? "error" : null
    : selectedReadiness?.status ?? null;
  const selectedCardCause = selectedCardReadinessStatus ? selectedEnvironmentStatusSummary : null;
  const expectedPreparationResult = selectedCardReadinessStatus === "error" && selectedCardCause && runtimeStatusMessagePurposeRef.current === "preparation-result" && environmentBackend !== "termux"
    ? rtText(language, "prepareBlocked", {
        distro: environmentBackend === "ubuntu-proot" ? "Ubuntu" : "Termux",
        reason: selectedCardCause,
      })
    : null;
  const hideDuplicateRuntimeStatusMessage = shouldHideDuplicateRuntimeStatusBanner({
    message,
    trackedRuntimeMessage: runtimeStatusMessageRef.current,
    messageSource,
    messagePurpose: runtimeStatusMessagePurposeRef.current,
    selectedReadinessStatus: selectedCardReadinessStatus,
    selectedCardCause,
    expectedPreparationResult,
  });

  const runReadOnlyEnvironmentCheck = useCallback(async (backend: AgentShellBackend, persistSelection = false) => {
    if (!isAgentShellBackend(backend)) return;
    // Allow re-entry: previous run's finally clears the lock; do not soft-deadlock UI buttons.
    const generation = ++environmentStatusGenerationRef.current;
    const traceId = createTraceCorrelationId("runtime");
    runtimeTraceIdRef.current = traceId;
    const target = backend === "ubuntu-proot" ? "ubuntu" : "termux";
    persistentLogger.trace({ correlationId: traceId, action: persistSelection ? "runtime.select-and-check" : "runtime.check", step: "ui.action", status: "started", backend, target, screen: "runtime" });
    runtimeEnvironmentActionRef.current = true;
    setLinuxBusy(true);
    setRuntimePreparationRunning(false);
    setRuntimeReadiness(null);
    setRuntimePreparationUiProgress(null);
    setRuntimeCheckProgress({ phase: "host-check", detail: "Checking selected environment", activeCommand: null, completedStep: null });
    setLinuxOutput("");
    setRuntimeStatusMessage(null);
    if (backend === "termux") setTermuxReady(null);
    try {
      if (persistSelection) {
        setEnvironmentBackend(backend);
        await saveEnvironmentBackend(backend);
        await setAgentShellBackend(backend);
        persistentLogger.trace({ correlationId: traceId, action: "runtime.select-and-check", step: "ui.environment-selection", status: "succeeded", backend, target, screen: "runtime" });
      }
      if (generation !== environmentStatusGenerationRef.current) return;

      if (backend === "termux") {
        const termuxLabel = language === "ru"
          ? "Проверка встроенного приватного runtime…"
          : language === "uk"
            ? "Перевірка вбудованого приватного runtime…"
            : "Checking the embedded private runtime…";
        setRuntimeCheckProgress({
          phase: "host-check",
          detail: termuxLabel,
          activeCommand: "checkTermuxReadiness(deep)",
          completedStep: null,
        });
        const ready = await withRuntimeCommandHeartbeat(
          termuxLabel,
          () => checkTermuxReadiness({ deep: true, refreshPermission: true }),
          (sec, label) => {
            if (generation !== environmentStatusGenerationRef.current) return;
            setRuntimeCheckProgress({
              phase: "host-check",
              detail: sec > 0
                ? (language === "ru"
                    ? `${label} Ещё работаю… ${sec} с`
                    : language === "uk"
                      ? `${label} Ще працюю… ${sec} с`
                      : `${label} Still working… ${sec} s`)
                : label,
              activeCommand: "checkTermuxReadiness(deep)",
              completedStep: null,
            });
          },
        );
        if (generation !== environmentStatusGenerationRef.current) return;
        setTermuxReady(ready.ready);
        const status = ready.ready ? "Termux: готов" : ready.probeDetail || `Termux: ${ready.reasons.join(", ")}`;
        persistentLogger.trace({ correlationId: traceId, action: "runtime.check", step: "readiness.result", status: "succeeded", backend, target, screen: "runtime", resultCode: ready.ready ? "ready" : "unknown", ...(!ready.ready && ready.reasons.some((reason) => reason.includes("permission")) ? { errorCategory: "permission-denied" as const } : {}) });
        setLinuxOutput(status);
        setRuntimeStatusMessage(status);
        setRuntimeCheckProgress({
          phase: ready.ready ? "ready" : "missing",
          detail: status,
          activeCommand: null,
          completedStep: "Termux readiness response received",
        });
        return;
      }

      const result = await inspectProotRuntimeReadiness(backend, {
        traceId,
        onRootfsProbeOutcome: (parserOutcome) => {
          persistentLogger.trace({ correlationId: traceId, action: "runtime.check", step: "rootfs.parser-result", status: parserOutcome === "healthy" ? "succeeded" : parserOutcome === "missing" ? "progress" : "failed", backend, target, screen: "runtime", parserOutcome });
        },
        onProgress: (phase: RuntimeReadinessPhase, detail: string) => {
          if (generation !== environmentStatusGenerationRef.current) return;
          persistentLogger.trace({ correlationId: traceId, action: "runtime.readiness", step: `runtime.${phase}`, status: "progress", backend, target, screen: "runtime" });
          setRuntimeCheckProgress((current) => ({
            phase,
            detail,
            activeCommand: current?.activeCommand ?? null,
            completedStep: current?.completedStep ?? null,
          }));
        },
        run: async (command, options) => {
          const targetLabel = backend === "ubuntu-proot" ? "Ubuntu" : "Termux";
          const commandLabel =
            options.packageId === "proot-distro"
              ? (language === "ru"
                  ? "Host: проверка proot-distro…"
                  : language === "uk"
                    ? "Host: перевірка proot-distro…"
                    : "Host: checking proot-distro…")
              : options.packageId.endsWith("-rootfs")
                ? (language === "ru"
                    ? `${targetLabel}: list/login/identity rootfs (до ~1–2 мин)…`
                    : language === "uk"
                      ? `${targetLabel}: list/login/identity rootfs (до ~1–2 хв)…`
                      : `${targetLabel}: rootfs list/login/identity (up to ~1–2 min)…`)
                : (language === "ru"
                    ? `${targetLabel}: базовые пакеты (${options.packageId})…`
                    : language === "uk"
                      ? `${targetLabel}: базові пакети (${options.packageId})…`
                      : `${targetLabel}: guest baseline (${options.packageId})…`);
          if (generation === environmentStatusGenerationRef.current) {
            setRuntimeCheckProgress((current) => ({
              phase: current?.phase ?? "host-check",
              detail: commandLabel,
              activeCommand: commandLabel,
              completedStep: current?.completedStep ?? null,
            }));
          }
          const result = await withRuntimeCommandHeartbeat(
            commandLabel,
            () => runPackageCommand(command, { ...options, traceId }),
            (sec, label) => {
              if (generation !== environmentStatusGenerationRef.current) return;
              setRuntimeCheckProgress((current) => ({
                phase: current?.phase ?? "host-check",
                detail:
                  sec > 0
                    ? language === "ru"
                      ? `${label} Ещё работаю… ${sec} с (не зависло)`
                      : language === "uk"
                        ? `${label} Ще працюю… ${sec} с`
                        : `${label} Still working… ${sec} s`
                    : label,
                activeCommand: label,
                completedStep: current?.completedStep ?? null,
              }));
            },
          );
          if (generation === environmentStatusGenerationRef.current) {
            setRuntimeCheckProgress((current) => ({
              phase: current?.phase ?? "host-check",
              detail: current?.detail ?? commandLabel,
              activeCommand: null,
              completedStep:
                result.timedOut || result.outputTruncated || result.exitCode !== 0
                  ? `${commandLabel}: needs classification`
                  : `${commandLabel}: done`,
            }));
          }
          return result;
        },
      });
      if (generation !== environmentStatusGenerationRef.current) return;
      setRuntimeReadiness(result);
      if (result.rootfsState) {
        if (backend === "ubuntu-proot") setUbuntuDistroState(result.rootfsState);
        else setLinuxStatus((current: any) => ({
          ...(current ?? {}),
          rootfsInstalled: result.rootfsState?.installed,
          healthy: result.rootfsState?.healthy,
          message: result.rootfsState?.diagnostic,
        }));
      }
      const localizedDetail = runtimeReadinessText(language, result);
      persistentLogger.trace({
        correlationId: traceId,
        action: "runtime.check",
        step: "readiness.result",
        status: result.status === "error" ? "failed" : "succeeded",
        backend,
        target,
        screen: "runtime",
        resultCode: result.status === "ready" ? "ready" : result.status === "missing" ? "missing" : "unknown",
        ...(result.status === "error" ? { errorCategory: result.reason === "permission" ? "permission-denied" as const : result.reason === "timeout" ? "timeout" as const : result.reason === "bridge-failure" ? "callback-missing" as const : classifyDiagnosticError(result.reason || result.detail) } : {}),
      });
      setLinuxOutput(localizedDetail);
      setRuntimeStatusMessage(result.status === "error" ? localizedDetail : null);
      setRuntimeCheckProgress((current) => ({
        phase: result.phase,
        detail: localizedDetail,
        activeCommand: null,
        completedStep: current?.completedStep ?? `${result.phase} check completed`,
      }));
    } catch (error: unknown) {
      if (generation !== environmentStatusGenerationRef.current) return;
      persistentLogger.trace({ correlationId: traceId, action: "runtime.check", step: "readiness.result", status: "failed", backend, target, screen: "runtime", resultCode: "unknown", errorCategory: classifyDiagnosticError(error) });
      const detail = rtText(language, "checkFailed", { distro: backend === "ubuntu-proot" ? "Ubuntu" : "Termux" });
      if (backend === "termux") setTermuxReady(null);
      else setRuntimeReadiness({
        target: backend,
        status: "error",
        phase: "error",
        detail,
        hostTool: "unknown",
        rootfs: "unknown",
        baseline: "unknown",
        missingItems: [],
      });
      setLinuxOutput(detail);
      setRuntimeStatusMessage(detail);
      setRuntimeCheckProgress({ phase: "error", detail, activeCommand: null, completedStep: null });
    } finally {
      // Always release the lock — skipping clear when generation changed left BOTH
      // Termux/Ubuntu buttons dead if a check was superseded or hung mid-flight.
      runtimeEnvironmentActionRef.current = false;
      if (generation === environmentStatusGenerationRef.current) {
        setLinuxBusy(false);
      }
      if (runtimeTraceIdRef.current === traceId) runtimeTraceIdRef.current = null;
    }
  }, [language, setRuntimeStatusMessage, setAgentShellBackend]);

  const runEnvironmentAction = useCallback(async (backend: AgentShellBackend, persistSelection: boolean) => {
    if (!isAgentShellBackend(backend)) return;
    if (persistSelection) {
      await runReadOnlyEnvironmentCheck(backend, true);
      return;
    }
    if (backend !== "ubuntu-proot") {
      setLinuxOutput(language === "ru"
        ? "Подготовка внешнего runtime отключена; доступна только встроенная приватная среда."
        : language === "uk"
          ? "Підготовку зовнішнього runtime вимкнено; доступне лише вбудоване приватне середовище."
          : "External runtime preparation is disabled; only the embedded private environment is available.");
      return;
    }
    if (runtimeEnvironmentActionRef.current) return;

    const generation = ++environmentStatusGenerationRef.current;
    const traceId = createTraceCorrelationId("runtime-prepare");
    runtimeTraceIdRef.current = traceId;
    const target = "ubuntu";
    let traceStatus: TraceStatus = "failed";
    let traceResultCode: "ready" | "missing" | "unknown" = "unknown";
    let traceErrorCategory: ReturnType<typeof classifyDiagnosticError> | undefined;
    persistentLogger.trace({ correlationId: traceId, action: "runtime.prepare", step: "ui.action", status: "started", backend, target, screen: "runtime" });
    runtimeEnvironmentActionRef.current = true;
    runtimePreparationAbortRef.current = false;
    const alias = "ubuntu";
    const targetLabel = backend === "ubuntu-proot" ? "Ubuntu" : "Termux";
    setLinuxBusy(true);
    setRuntimePreparationRunning(true);
    setRuntimeCheckProgress(null);
    setRuntimePreparationUiProgress({ phase: "preflight", detail: runtimeProgressText(language, "preflight", backend), activeCommand: null, completedStep: null });
    setLinuxOutput("");
    setRuntimeStatusMessage(rtText(language, "prepareStarted", { distro: targetLabel }), "preparation-start");
    try {
      const applyFreshReadiness = (readiness: RuntimeEnvironmentReadiness) => {
        setRuntimeReadiness(readiness);
        if (readiness.rootfsState) {
          if (backend === "ubuntu-proot") setUbuntuDistroState(readiness.rootfsState);
          else setLinuxStatus((current: any) => ({
            ...(current ?? {}),
            rootfsInstalled: readiness.rootfsState?.installed,
            healthy: readiness.rootfsState?.healthy,
            message: readiness.rootfsState?.diagnostic,
          }));
        }
      };
      const action = await runProotRuntimePreparationAction(backend, {
        check: () => inspectProotRuntimeReadiness(backend, {
          traceId,
          onRootfsProbeOutcome: (parserOutcome) => {
            persistentLogger.trace({ correlationId: traceId, action: "runtime.prepare", step: "preflight.rootfs-parser-result", status: parserOutcome === "healthy" ? "succeeded" : parserOutcome === "missing" ? "progress" : "failed", backend, target, screen: "runtime", parserOutcome });
          },
          onProgress: (phase, detail) => {
            persistentLogger.trace({ correlationId: traceId, action: "runtime.prepare", step: `preflight.${phase}`, status: "progress", backend, target, screen: "runtime" });
            setRuntimePreparationUiProgress((current) => ({
              phase,
              detail,
              activeCommand: current?.activeCommand ?? null,
              completedStep: current?.completedStep ?? null,
            }));
          },
          run: async (command, options) => {
            const commandLabel = options.packageId === "proot-distro"
              ? "Fresh Termux host check: proot-distro"
              : options.packageId.endsWith("-rootfs")
                ? `Fresh Termux host check: ${alias} rootfs/list/login/identity/architecture`
                : `${targetLabel} guest check: ${options.packageId}`;
            setRuntimePreparationUiProgress((current) => ({
              phase: current?.phase ?? "preflight",
              detail: current?.detail ?? commandLabel,
              activeCommand: commandLabel,
              completedStep: current?.completedStep ?? null,
            }));
            const commandResult = await withRuntimeCommandHeartbeat(
              commandLabel,
              () => runPackageCommand(command, { ...options, traceId }),
              (sec, label) => {
                setRuntimePreparationUiProgress((current) => ({
                  phase: current?.phase ?? "preflight",
                  detail:
                    sec > 0
                      ? language === "ru"
                        ? `${label} Ещё работаю… ${sec} с (не зависло)`
                        : language === "uk"
                          ? `${label} Ще працюю… ${sec} с`
                          : `${label} Still working… ${sec} s`
                      : label,
                  activeCommand: label,
                  completedStep: current?.completedStep ?? null,
                }));
              },
            );
            setRuntimePreparationUiProgress((current) => ({
              phase: current?.phase ?? "preflight",
              detail: current?.detail ?? commandLabel,
              activeCommand: null,
              completedStep: commandResult.timedOut || commandResult.outputTruncated || commandResult.exitCode !== 0
                ? `${commandLabel}: result requires classification`
                : `${commandLabel}: read-only check completed`,
            }));
            return commandResult;
          },
        }),
        prepare: async (freshReadiness) => {
          applyFreshReadiness(freshReadiness);
          setRuntimePreparationUiProgress({
            phase: "rootfs",
            detail: `Confirmed missing state: ${freshReadiness.missingItems.join(", ")}. Rechecking selected ${alias} before any rootfs install.`,
            activeCommand: null,
            completedStep: "fresh preflight confirmed an actionable missing prerequisite",
          });
          return prepareProotRuntimeEnvironment(backend, {
        traceId,
        run: async (command, options) => {
          const commandLabel = options.packageId === "proot-distro"
            ? `Termux host: ${options.kind} proot-distro`
            : options.packageId === `${alias}-rootfs`
              ? `Termux host: proot-distro ${options.kind} ${alias}`
              : options.packageId === "runtime-guest-requirements"
                ? `${targetLabel} guest: apt-get ${options.kind === "update" ? "update" : options.kind === "install" ? "install missing baseline" : "check"}`
                : `${targetLabel} guest: ${options.kind} ${options.packageId}`;
          setRuntimePreparationUiProgress((current) => ({
            phase: current?.phase ?? options.kind,
            detail: current?.detail ?? commandLabel,
            activeCommand: commandLabel,
            completedStep: current?.completedStep ?? null,
          }));
          try {
            const commandResult = await withRuntimeCommandHeartbeat(
              commandLabel,
              () => runPackageCommand(command, { ...options, selectedBackend: backend, traceId }),
              (sec, label) => {
                setRuntimePreparationUiProgress((current) => ({
                  phase: current?.phase ?? options.kind,
                  detail:
                    sec > 0
                      ? language === "ru"
                        ? `${label} Ещё работаю… ${sec} с (не зависло)`
                        : language === "uk"
                          ? `${label} Ще працюю… ${sec} с`
                          : `${label} Still working… ${sec} s`
                      : label,
                  activeCommand: label,
                  completedStep: current?.completedStep ?? null,
                }));
              },
            );
            setRuntimePreparationUiProgress((current) => ({
              phase: current?.phase ?? options.kind,
              detail: current?.detail ?? commandLabel,
              activeCommand: null,
              completedStep: commandResult.timedOut
                ? `${commandLabel}: timeout reported; outcome not confirmed`
                : commandResult.outputTruncated
                  ? `${commandLabel}: output incomplete; outcome not confirmed`
                  : `${commandLabel}: command completed with exit ${commandResult.exitCode}`,
            }));
            return commandResult;
          } catch (error: unknown) {
            setRuntimePreparationUiProgress((current) => ({
              phase: current?.phase ?? options.kind,
              detail: current?.detail ?? commandLabel,
              activeCommand: null,
              completedStep: `${commandLabel}: command result unavailable`,
            }));
            throw error;
          }
        },
        ensureRootfs: (distro, run, onProgress, shouldAbort) =>
          installProotDistroRootfsWithPrerequisite(distro, run, onProgress, shouldAbort),
        onProgress: (_percent, stage, detail) => {
          persistentLogger.trace({ correlationId: traceId, action: "runtime.prepare", step: `prepare.${stage}`, status: "progress", backend, target, screen: "runtime", progressPercent: _percent });
          setRuntimePreparationUiProgress((current) => ({
            phase: stage,
            detail,
            activeCommand: current?.activeCommand ?? null,
            completedStep: current?.completedStep ?? null,
          }));
          setLinuxOutput(runtimeProgressText(language, stage, backend));
        },
        shouldAbort: () => runtimePreparationAbortRef.current,
          });
        },
      });

      if (action.kind === "already-ready") {
        applyFreshReadiness(action.readiness);
        traceStatus = "succeeded";
        traceResultCode = "ready";
        const detail = runtimeReadinessText(language, action.readiness);
        setRuntimePreparationUiProgress({ phase: "ready", detail: runtimeProgressText(language, "ready", backend), activeCommand: null, completedStep: "no changes made" });
        setLinuxOutput(detail);
        setRuntimeStatusMessage(rtText(language, "prepareAlreadyReady", { distro: targetLabel }), "preparation-result");
        return;
      }
      if (action.kind === "blocked") {
        applyFreshReadiness(action.readiness);
        traceStatus = "blocked";
        traceResultCode = action.readiness.status === "missing" ? "missing" : "unknown";
        traceErrorCategory = action.readiness.reason === "permission" ? "permission-denied" : action.readiness.reason === "timeout" ? "timeout" : classifyDiagnosticError(action.readiness.reason || action.readiness.detail);
        const reason = runtimeReadinessText(language, action.readiness);
        setRuntimePreparationUiProgress({ phase: action.readiness.phase, detail: reason, activeCommand: null, completedStep: "preflight stopped; no rootfs or package changes were started" });
        setLinuxOutput(reason);
        setRuntimeStatusMessage(rtText(language, "prepareBlocked", { distro: targetLabel, reason }), "preparation-result");
        return;
      }
      const result = action.result;

      if (!result.ok) {
        traceStatus = result.cancelled ? "cancelled" : "failed";
        traceErrorCategory = classifyDiagnosticError(result.error);
        const detail = runtimePreparationFailureText(language, backend, result.stage, result.error, result.cancelled);
        setRuntimeReadiness({
          target: backend,
          status: "error",
          phase: "error",
          detail,
          hostTool: "unknown",
          rootfs: "unknown",
          baseline: "unknown",
          missingItems: [],
        });
        setRuntimePreparationUiProgress((current) => ({
          phase: result.stage,
          detail: runtimeProgressText(language, result.stage, backend),
          activeCommand: current?.activeCommand ?? null,
          completedStep: current?.completedStep ?? null,
        }));
        setLinuxOutput(detail);
        setRuntimeStatusMessage(detail, "preparation-result");
        return;
      }

      setRuntimePreparationUiProgress((current) => ({
        phase: "final-rootfs-readback",
        detail: `Rechecking selected ${alias} rootfs login/identity before marking ready`,
        activeCommand: `Termux host: ${alias} rootfs login/identity readback`,
        completedStep: current?.completedStep ?? null,
      }));
      let finalRootfsState: ProotDistroState | undefined;
      if (backend === "ubuntu-proot") {
        const finalStatus = await getRuntimeFacade().linuxStatus("ubuntu");
        setLinuxStatus(finalStatus);
        finalRootfsState = await inspectTermuxProotDistro("ubuntu");
        setLinuxStatus((current: any) => ({
          ...(current ?? finalStatus),
          rootfsInstalled: finalRootfsState?.installed,
          healthy: finalRootfsState?.healthy,
          message: finalRootfsState?.diagnostic ?? finalStatus.message,
        }));
        if (finalStatus.healthy !== true || finalRootfsState.healthy !== true || finalRootfsState.osReleaseId !== "ubuntu" || finalRootfsState.architectureMatches !== true) {
          traceStatus = "failed";
          traceResultCode = "unknown";
          traceErrorCategory = "invalid-response";
          const reason = runtimeReasonFromDiagnostic(finalRootfsState.diagnostic);
          const readiness = { target: backend, status: "error" as const, phase: "error" as const, reason: "unknown" as const, detail: finalRootfsState.diagnostic, hostTool: "available" as const, rootfs: "unknown" as const, baseline: "unknown" as const, missingItems: [] as string[] };
          const detail = runtimeReadinessText(language, readiness);
          setRuntimeReadiness(readiness);
          setRuntimePreparationUiProgress((current) => ({ phase: "final-rootfs-readback", detail: runtimeProgressText(language, "final-rootfs-readback", backend), activeCommand: null, completedStep: "readback did not confirm healthy login" }));
          setLinuxOutput(detail);
          setRuntimeStatusMessage(rtText(language, "finalReadbackFailed", { distro: targetLabel }), "preparation-result");
          return;
        }
      }

      const installed = result.installed.length ? result.installed.join(", ") : "—";
      const alreadyPresent = result.alreadyPresent.length ? result.alreadyPresent.join(", ") : "—";
      const detail = rtText(language, "prepareSucceeded", { distro: targetLabel, installed, existing: alreadyPresent });
      setRuntimeReadiness({ target: backend, status: "ready", phase: "ready", detail, hostTool: "available", rootfs: "healthy", baseline: "ready", missingItems: [], ...(finalRootfsState ? { rootfsState: finalRootfsState } : {}) });
      setRuntimePreparationUiProgress((current) => ({ phase: "ready", detail: runtimeProgressText(language, "ready", backend), activeCommand: null, completedStep: "final rootfs/login readback confirmed" }));
      setLinuxOutput(detail);
      setRuntimeStatusMessage(rtText(language, "readinessReady", { distro: targetLabel }), "preparation-result");
      traceStatus = "succeeded";
      traceResultCode = "ready";
    } catch (error: unknown) {
      traceStatus = runtimePreparationAbortRef.current ? "cancelled" : "failed";
      traceErrorCategory = classifyDiagnosticError(error);
      const rawError = error instanceof Error ? error.message : "";
      const detail = runtimePreparationFailureText(language, backend, "error", rawError);
      setRuntimeReadiness({ target: backend, status: "error", phase: "error", detail, hostTool: "unknown", rootfs: "unknown", baseline: "unknown", missingItems: [] });
      setRuntimePreparationUiProgress((current) => ({ phase: current?.phase ?? "error", detail: runtimeProgressText(language, current?.phase ?? "error", backend), activeCommand: null, completedStep: current?.completedStep ?? null }));
      setLinuxOutput(detail);
      setRuntimeStatusMessage(detail, "preparation-result");
    } finally {
      persistentLogger.trace({
        correlationId: traceId,
        action: "runtime.prepare",
        step: "prepare.result",
        status: traceStatus,
        backend,
        target,
        screen: "runtime",
        resultCode: traceResultCode,
        ...(traceErrorCategory ? { errorCategory: traceErrorCategory } : {}),
      });
      if (generation === environmentStatusGenerationRef.current) {
        runtimeEnvironmentActionRef.current = false;
        setRuntimePreparationRunning(false);
        setLinuxBusy(false);
      }
      if (runtimeTraceIdRef.current === traceId) runtimeTraceIdRef.current = null;
    }
  }, [runReadOnlyEnvironmentCheck, runtimeReadiness, language, setRuntimeStatusMessage]);

  const selectEnvironment = useCallback(async (backend: AgentShellBackend) => {
    if (!isAgentShellBackend(backend)) return;
    await runEnvironmentAction(backend, true);
  }, [runEnvironmentAction]);

  const refreshEnvironmentStatus = useCallback(async () => {
    const generation = ++environmentStatusGenerationRef.current;
    const backend = await loadEnvironmentBackend();
    if (generation !== environmentStatusGenerationRef.current || runtimeEnvironmentActionRef.current) return;
    setEnvironmentBackend(backend);
    await runReadOnlyEnvironmentCheck(backend, false);
  }, [runReadOnlyEnvironmentCheck]);

  useEffect(() => { void refreshEnvironmentStatus(); }, [refreshEnvironmentStatus]);

  const onPrivilegeProbe = useCallback(async () => {
    setBusy(true);
    try {
      const result = await executeGuardedTermuxCommand(buildShizukuProbeCommand(), {
        timeoutMs: 20000,
        hostTermux: true,
        trustedInternal: true,
      });
      const snap = interpretPrivilegeProbeOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
      setMessage(
        `Privilege: ${snap.level} · shizuku=${snap.shizukuAvailable} · root=${snap.rootAvailable}`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onKeystoreCheck = useCallback(async () => {
    setBusy(true);
    try {
      const result = await executeGuardedTermuxCommand(buildKeystorePresenceCheckCommand(), {
        timeoutMs: 15000,
        hostTermux: true,
        trustedInternal: true,
      });
      setMessage((result.stdout || result.stderr || "").trim().slice(0, 500) || "keystore check done");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onCheckSelectedEnvironment = useCallback(() => {
    void runReadOnlyEnvironmentCheck(environmentBackend, false);
  }, [environmentBackend, runReadOnlyEnvironmentCheck]);

  const onInstallSelectedEnvironment = useCallback(() => {
    void runEnvironmentAction(environmentBackend, false);
  }, [environmentBackend, runEnvironmentAction]);

  const cancelRuntimePreparation = useCallback(() => {
    if (!runtimePreparationRunning || !runtimeEnvironmentActionRef.current) return;
    runtimePreparationAbortRef.current = true;
    persistentLogger.trace({ correlationId: runtimeTraceIdRef.current || createTraceCorrelationId("runtime-cancel"), action: "runtime.prepare", step: "ui.cancel", status: "cancelled", backend: environmentBackend, target: environmentBackend === "ubuntu-proot" ? "ubuntu" : "termux", screen: "runtime" });
    const detail = runtimePreparationFailureText(language, "ubuntu-proot", "cancelled", "", true);
    setLinuxOutput(detail);
    setRuntimeStatusMessage(detail, "preparation-result");
  }, [environmentBackend, language, runtimePreparationRunning, setRuntimeStatusMessage]);

  /** Verify the user's configured Termux sources without overwriting them. */
  const onFixTermuxMirrors = useCallback(async () => {
    const copy = {
      ru: {
        start: "Проверка зеркал Termux…",
        update: "Обновление списка пакетов…",
        success: "Источники пакетов обновлены",
        failure: "Источник Termux не выбран или недоступен",
        manual: "Не меняйте выбранный источник автоматически. Только если его недоступность подтверждена, в Termux можно выбрать другой источник и выполнить pkg update -y.",
        error: "ошибка",
      },
      uk: {
        start: "Перевірка дзеркал Termux…",
        update: "Оновлення списку пакетів…",
        success: "Джерела пакетів оновлено",
        failure: "Джерело Termux не вибране або недоступне",
        manual: "Не змінюйте вибране джерело автоматично. Лише якщо його недоступність підтверджено, у Termux можна обрати інше джерело й виконати pkg update -y.",
        error: "помилка",
      },
      en: {
        start: "Checking Termux mirrors…",
        update: "Updating package indexes…",
        success: "Package sources updated",
        failure: "The Termux source is not selected or is unavailable",
        manual: "Do not change the selected source automatically. Only if it is confirmed unreachable, choose another source in Termux and run pkg update -y.",
        error: "error",
      },
    }[language];
    setLinuxBusy(true);
    setDebianProgress({ percent: 10, stage: "mirrors", detail: copy.start });
    setLinuxOutput(copy.start);
    try {
      setDebianProgress({ percent: 55, stage: "mirrors", detail: copy.update });
      const probe = await runPackageCommand(withInstallerEnvironment(TERMUX_MIRROR_REPAIR), {
        timeoutMs: 300_000,
        kind: "update",
        packageId: "proot-distro",
      });
      const out = [probe.stdout || "", probe.stderr || ""].filter(Boolean).join("\n").trim();
      const updateStatus = out.match(/AIB_MIRROR_REPAIR_DONE upd=(\d+)/)?.[1];
      const ok = !probe.timedOut && probe.exitCode === 0 && updateStatus === "0";
      setLinuxOutput(ok ? out : `${out}\n\n${copy.failure}\n${copy.manual}`);
      setDebianProgress({
        percent: ok ? 100 : 40,
        stage: ok ? "mirrors_ok" : "mirrors_fail",
        detail: ok ? copy.success : copy.failure,
      });
    } catch (e) {
      setLinuxOutput(e instanceof Error ? e.message : String(e));
      setDebianProgress({ percent: 0, stage: "mirrors_fail", detail: copy.error });
    } finally {
      setLinuxBusy(false);
    }
  }, [language]);

  const onFixAllowExternalApps = useCallback(async () => {
    setLinuxOutput(language === "ru" ? "Используйте встроенные настройки и bootstrap на экране Runtime; отдельный Termux не запускается." : language === "uk" ? "Скористайтеся вбудованими налаштуваннями та bootstrap на екрані Runtime; окремий Termux не запускається." : "Use the built-in settings and bootstrap on Runtime; a separate Termux app is never launched.");
  }, [language]);
  const onUbuntuExport = useCallback(async () => {
    const home = getRuntimeFacade().home?.root || status?.home || "/storage/emulated/0/AIBuilderTermux";
    const dest = ubuntuExportPath.trim() || defaultUbuntuExportPath(home);
    setUbuntuExportPath(dest);
    setDebianProgress({ percent: 0, stage: "export", detail: "Экспорт Ubuntu…" });
    setLinuxOutput("Экспорт Ubuntu (proot-distro)…");
    setLinuxBusy(true);
    try {
      const result = await exportUbuntu(dest, (p) => setDebianProgress(p));
      setLinuxOutput(result.log.slice(-4000) || (result.ok ? "Ubuntu экспортирован" : "Ошибка экспорта Ubuntu"));
      if (result.path) setUbuntuExportPath(result.path);
      setMessage(result.ok ? `Ubuntu: экспорт готов — ${result.path || dest}` : "Ubuntu: ошибка экспорта");
    } catch (e) {
      setLinuxOutput(e instanceof Error ? e.message : String(e));
      setMessage("Ubuntu: ошибка экспорта");
    } finally { setLinuxBusy(false); }
  }, [ubuntuExportPath, status?.home]);

  const onUbuntuImport = useCallback(async () => {
    const src = ubuntuImportPath.trim();
    if (!src) return;
    setDebianProgress({ percent: 0, stage: "import", detail: "Импорт Ubuntu…" });
    setLinuxOutput("Импорт Ubuntu…");
    setLinuxBusy(true);
    try {
      const result = await importUbuntu(src, (p) => setDebianProgress(p));
      setLinuxOutput(result.log.slice(-4000) || (result.ok ? "Ubuntu импортирован" : "Ошибка импорта Ubuntu"));
      setUbuntuDistroState(await inspectTermuxProotDistro("ubuntu"));
      setMessage(result.ok ? "Ubuntu: импорт завершён" : "Ubuntu: ошибка импорта");
    } catch (e) {
      setLinuxOutput(e instanceof Error ? e.message : String(e));
      setMessage("Ubuntu: ошибка импорта");
    } finally { setLinuxBusy(false); }
  }, [ubuntuImportPath]);

  const onBootstrapContinue = useCallback(async (force = false) => {
    setBootBusy(true);
    setBootMsg(
      force
        ? { ru: "Полный перезапуск стадий…", uk: "Повний перезапуск стадій…", en: "Full stage restart…" }[language]
        : { ru: "Продолжение bootstrap…", uk: "Продовження bootstrap…", en: "Resuming bootstrap…" }[language],
    );
    try {
      await withForegroundTask("bootstrap", force ? "Bootstrap (force)" : "Bootstrap", async (update) => {
        const facade = getRuntimeFacade();
        const state = await facade.bootstrapRun({
          force,
          onProgress: (e) => {
            setBootPercent(e.percent);
            setBootMsg(`${e.stageId}: ${e.message}`);
            update(e.percent, `${e.stageId}: ${e.message}`);
            void notifyBootstrapProgress(e.stageId, e.percent, e.message);
          },
        });
        setBootState(state);
        setBootMsg(
          state.lastError ||
            { ru: "Bootstrap завершён", uk: "Bootstrap завершено", en: "Bootstrap finished" }[language],
        );
        setLinuxStatus(await facade.linuxStatus("ubuntu"));
      });
    } catch (e) {
      setBootMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBootBusy(false);
    }
  }, [language]);

  const onFirstRunSetup = useCallback(async () => {
    setBootBusy(true);
    setBootMsg({ ru: "Проверка диагностики и настройка первого запуска…", uk: "Перевірка та налаштування першого запуску…", en: "Checking diagnostics and preparing first run…" }[language]);
    try {
      await withForegroundTask("first-run", "First-run setup / repair", async (update) => {
        const facade = getRuntimeFacade();
        const result = await facade.runFirstRun({
          onProgress: (event) => {
            const line = `${event.stage}: ${event.message}`;
            setBootMsg(line);
            update(event.bootstrapEvent?.percent ?? 0, line);
          },
        });
        const state = await facade.bootstrapState();
        setBootState(state);
        const report = [result.diagnostics?.humanReadable, result.defaults ? `backend=${result.defaults.backend} · security=${result.defaults.security} · preset=${result.defaults.preset} · performance=${result.defaults.performanceMode}${result.defaults.applied?.performanceMode ? " (applied)" : ""} · online=${result.defaults.models.online} · offline=${result.defaults.models.offline}` : "", result.warning || "", result.error ? `ERROR: ${result.error.code} — ${result.error.message}` : ""].filter(Boolean).join("\n");
        setFirstRunReport(report);
        let diagnosticPayload: unknown = null;
        try { diagnosticPayload = result.diagnostics ? JSON.parse(result.diagnostics.json) : null; } catch { diagnosticPayload = { error: "Sanitized diagnostics JSON was unavailable." }; }
        setFirstRunJson(JSON.stringify({ generatedAt: Date.now(), diagnostics: diagnosticPayload, defaults: result.defaults ?? null, state: result.state, warning: result.warning ?? null, error: result.error ? { code: result.error.code, message: result.error.message } : null }, null, 2));
        setBootMsg(result.error ? `${result.error.code}: ${result.error.message}` : { ru: "Первый запуск завершён", uk: "Перший запуск завершено", en: "First-run setup completed" }[language]);
      });
    } catch (error) {
      setBootMsg(error instanceof Error ? error.message : String(error));
    } finally { setBootBusy(false); }
  }, [language]);

  useEffect(() => {
    if (firstRunSetup !== "1" || firstRunAutoStarted.current) return;
    firstRunAutoStarted.current = true;
    // Route parameters may inspect first-run state, but must never start a bootstrap/install.
    void getRuntimeFacade().firstRunStatus().then((check) => {
      if (check.required) setBootMsg("First-run setup is pending; it is not started automatically from Runtime Environment. Use the selected environment's Check and explicit Install controls.");
    }).catch((error) => {
      setBootMsg(error instanceof Error ? error.message : String(error));
    });
  }, [firstRunSetup]);

  const onPerformanceMode = useCallback(async (mode: PerformanceModeName) => {
    setBusy(true);
    try {
      const result = await getRuntimeFacade().setPerformanceMode(mode);
      if (result.applied) {
        setPerformanceMode(mode);
        setMessage({ ru: `Режим: ${mode}`, uk: `Режим: ${mode}`, en: `Mode: ${mode}` }[language]);
      } else {
        setMessage({ ru: "Режим не изменён: нет доступного backend после проверки", uk: "Режим не змінено: немає доступного backend", en: "Mode unchanged: no healthy backend passed probing" }[language]);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }, [language]);

  const onAutoPerformanceMode = useCallback(async () => {
    setBusy(true);
    try {
      const facade = getRuntimeFacade();
      const mode = await facade.recommendPerformanceModeFromDevice();
      const result = await facade.setPerformanceMode(mode);
      if (result.applied) {
        setPerformanceMode(mode);
        setMessage({ ru: `Автовыбор по характеристикам устройства: ${mode}`, uk: `Автовибір за характеристиками пристрою: ${mode}`, en: `Device-based recommendation applied: ${mode}` }[language]);
      } else {
        setMessage({ ru: `Рекомендация: ${mode}; режим не изменён — нет готового backend`, uk: `Рекомендація: ${mode}; режим не змінено — немає готового backend`, en: `Recommended: ${mode}; unchanged because no backend is ready` }[language]);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }, [language]);

  const onCopyFirstRunReport = useCallback(async () => {
    if (!firstRunReport) return;
    try {
      await Clipboard.setStringAsync(firstRunReport);
      setMessage({ ru: "Диагностический отчёт скопирован", uk: "Діагностичний звіт скопійовано", en: "Diagnostic report copied" }[language]);
    } catch {
      setMessage({ ru: "Не удалось скопировать отчёт", uk: "Не вдалося скопіювати звіт", en: "Could not copy the report" }[language]);
    }
  }, [firstRunReport, language]);

  const onCopyFirstRunJson = useCallback(async () => {
    if (!firstRunJson) return;
    try {
      await Clipboard.setStringAsync(firstRunJson);
      setMessage({ ru: "JSON-отчёт скопирован", uk: "JSON-звіт скопійовано", en: "JSON report copied" }[language]);
    } catch {
      setMessage({ ru: "Не удалось скопировать JSON", uk: "Не вдалося скопіювати JSON", en: "Could not copy JSON" }[language]);
    }
  }, [firstRunJson, language]);

  const onBootstrapReset = useCallback(async () => {
    try {
      const s = await getRuntimeFacade().bootstrapReset();
      setBootState(s);
      setBootPercent(0);
      setBootMsg({
          ru: "Стадии сброшены",
          uk: "Стадії скинуто",
          en: "Stages reset",
        }[language]);
    } catch (e) {
      setBootMsg(e instanceof Error ? e.message : String(e));
    }
  }, [language]);


  const onBackupRefreshList = useCallback(async () => {
    setBackupBusy(true);
    try {
      const list = await getRuntimeFacade().listBackups();
      setBackupList(list || []);
      setMessage(`backups: ${(list || []).length}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  }, []);

  const onBackupCreate = useCallback(async () => {
    setBackupBusy(true);
    try {
      await withForegroundTask("backup", `Backup ${backupScope}`, async () => {
        const facade = getRuntimeFacade();
        const home = facade.home?.root || status?.home || "";
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const path = backupPath.trim() || `${home}/backups/manual-${backupScope}-${ts}`;
        setBackupPath(path);
        const man = await createBackup(backupScope, path);
        setMessage(`backup OK · ${man || path}`);
        await onBackupRefreshList();
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  }, [backupPath, backupScope, createBackup, onBackupRefreshList, status?.home]);

  const onBackupVerify = useCallback(async () => {
    const path = backupPath.trim();
    if (!path) return;
    setBackupBusy(true);
    try {
      const plan = await getRuntimeFacade().inspectBackup(path);
      if ("ok" in plan && plan.ok === false) {
        setBackupInspect(`VERIFY FAIL: ${plan.error}`);
      } else {
        const p = plan as import("../core/backup/RestoreTransaction").RestorePlan;
        setBackupInspect(
          `OK · scope=${p.manifest.scope} · files=${p.manifest.fileCount ?? "?"} · digest=${(p.manifest.digest || "").slice(0, 16)}…`,
        );
      }
    } catch (e) {
      setBackupInspect(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  }, [backupPath]);

  const onBackupRestore = useCallback(async () => {
    const path = backupPath.trim();
    if (!path) return;
    const approved = await confirmDialog(
      language === "en" ? "Restore this backup?" : language === "uk" ? "Відновити цю резервну копію?" : "Восстановить эту резервную копию?",
      language === "en" ? `The selected backup may replace current state:\n${path}` : language === "uk" ? `Вибрана копія може замінити поточний стан:\n${path}` : `Выбранная копия может заменить текущее состояние:\n${path}`,
      language === "en" ? "Restore" : language === "uk" ? "Відновити" : "Восстановить",
      language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена",
    );
    if (!approved) return;
    setBackupBusy(true);
      try {
        await withForegroundTask("restore", "Restore backup", async () => {
          const result = await restoreBackup(path);
          if (!result.ok) {
            setMessage(`restore failed: ${result.error || "RESTORE_FAILED"}`);
            return;
          }
          setMessage(result.preBackupPath
            ? `restore OK · recovery backup: ${result.preBackupPath}`
            : "restore OK · pre-restore backup was skipped");
          await onBackupRefreshList();
        });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  }, [backupPath, restoreBackup, onBackupRefreshList, confirmDialog, language]);


  // Only load the app-wide performance preference here. Backend checks run through the selected-target Check flow.
  useEffect(() => {
    void getRuntimeFacade().initializePerformanceMode().then(setPerformanceMode).catch(() => undefined);
  }, []);

  const onContainerCreate = useCallback(async () => {
    setContainerBusy(true);
    try {
      const facade = getRuntimeFacade();
      const instance = await facade.containerCreate({ imageId: "ubuntu:24.04", name: `aib-${defaultId}`, projectId: defaultId });
      setContainerId(instance.id);
      await facade.containerStart(instance.id);
      const result = await facade.containerExec(instance.id, "uname", ["-a"]);
      setContainerOutput((result.stdout || result.stderr || `exit=${result.exitCode}`).slice(-3000));
    } catch (e) {
      setContainerOutput(e instanceof Error ? e.message : String(e));
    } finally { setContainerBusy(false); }
  }, [defaultId]);

  const onWorkspaceBuild = useCallback(async () => {
    if (!privateBuildQualificationConfirmed) {
      setWorkspaceBuildOutput(language === "en" ? "Unavailable: the private package feed and toolchain are not qualified." : language === "uk" ? "Недоступно: приватний feed пакетів і toolchain не підтверджені." : "Недоступно: приватный feed пакетов и toolchain не подтверждены.");
      return;
    }
    if (!containerId) return;
    setWorkspaceBuildBusy(true);
    try {
      const result = await getRuntimeFacade().runAIWorkspaceBuild(containerId, { template: "node", install: true, build: false, test: false, timeoutMs: 5 * 60_000 });
      setWorkspaceBuildOutput(JSON.stringify({ ok: result.ok, failedStep: result.failedStep, steps: result.steps.map((x) => ({ name: x.name, ok: x.ok, exitCode: x.exitCode })) }, null, 2));
    } catch (e) { setWorkspaceBuildOutput(e instanceof Error ? e.message : String(e)); }
    finally { setWorkspaceBuildBusy(false); }
  }, [containerId, language]);

  const onProjectGenerate = useCallback(async () => {
    if (!privateBuildQualificationConfirmed) {
      setProjectGenerateOutput(language === "en" ? "Unavailable: the private package feed and toolchain are not qualified." : language === "uk" ? "Недоступно: приватний feed пакетів і toolchain не підтверджені." : "Недоступно: приватный feed пакетов и toolchain не подтверждены.");
      return;
    }
    if (!containerId) return;
    setProjectGenerateBusy(true);
    try {
      const result = await getRuntimeFacade().generateAIProject(containerId, {
        name: `aib-${defaultId}`,
        goal: "Создать минимальный проект, который можно собрать и протестировать внутри Linux workspace.",
        template: "node",
        runWorkflow: true,
        build: true,
        test: true,
      });
      setProjectGenerateOutput(JSON.stringify({ ok: result.ok, name: result.name, template: result.template, files: result.files, failedStep: result.build?.failedStep }, null, 2));
    } catch (e) { setProjectGenerateOutput(e instanceof Error ? e.message : String(e)); }
    finally { setProjectGenerateBusy(false); }
  }, [containerId, defaultId, language]);

  const onCodingAgent = useCallback(async () => {
    if (!privateBuildQualificationConfirmed) {
      setCodingAgentOutput(language === "en" ? "Unavailable: the private package feed and toolchain are not qualified." : language === "uk" ? "Недоступно: приватний feed пакетів і toolchain не підтверджені." : "Недоступно: приватный feed пакетов и toolchain не подтверждены.");
      return;
    }
    if (!containerId) return;
    setCodingAgentBusy(true);
    try {
      const result = await getRuntimeFacade().runAICodingAgent(containerId, {
        name: `aib-${defaultId}`,
        goal: "Проверить и улучшить минимальный проект внутри Linux workspace, затем собрать и протестировать его.",
        template: "node",
        maxIterations: 3,
        build: true,
        test: true,
      });
      setCodingAgentOutput(JSON.stringify({ ok: result.ok, iterations: result.iterations.map((x) => ({ iteration: x.iteration, summary: x.plan.summary, ok: x.build?.ok, failedStep: x.build?.failedStep })), changedFiles: result.changedFiles, error: result.error }, null, 2));
    } catch (e) { setCodingAgentOutput(e instanceof Error ? e.message : String(e)); }
    finally { setCodingAgentBusy(false); }
  }, [containerId, defaultId, language]);

  const onContainerStop = useCallback(async () => {
    if (!containerId) return;
    setContainerBusy(true);
    try { await getRuntimeFacade().containerStop(containerId); setContainerOutput("Container stopped"); }
    catch (e) { setContainerOutput(e instanceof Error ? e.message : String(e)); }
    finally { setContainerBusy(false); }
  }, [containerId]);

  const onContainerRemove = useCallback(async () => {
    if (!containerId) return;
    setContainerBusy(true);
    try { await getRuntimeFacade().containerRemove(containerId); setContainerId(null); setContainerOutput("Container removed; project files are preserved"); }
    catch (e) { setContainerOutput(e instanceof Error ? e.message : String(e)); }
    finally { setContainerBusy(false); }
  }, [containerId]);

  const onConnectDevice = useCallback(async () => {
    setDeviceBusy(true);
    setDeviceOutput("");
    try {
      const facade = getRuntimeFacade();
      if (!facade.devicePolicy.isGranted("device.adb")) throw new Error("Grant the separate ADB capability first.");
      const listed = await facade.wirelessAdb.list();
      setAdbDevicesText((listed.devices || []).map((d) => `${d.serial}  ${d.state}`).join("\n") || (listed.ok ? "No connected ADB devices." : "ADB unavailable."));
      const bridge = facade.createTermuxAdbDeviceBridge();
      facade.useDeviceBridge(bridge);
      const available = listed.ok && (listed.devices || []).some((device) => device.state === "device");
      setDeviceAvailable(available);
      if (available) {
        await startDeviceWatchdog();
        setDeviceOutput("ADB device connected");
      } else {
        setDeviceOutput(listed.ok ? "No authorized ADB device is connected." : "ADB unavailable or no device is authorized.");
      }
      await refresh();
    } catch (e) {
      setDeviceAvailable(false);
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally { setDeviceBusy(false); }
  }, [refresh]);

  const onAdbPair = useCallback(async () => {
    if (!adbPairHost.trim() || !adbPairCode.trim()) {
      setDeviceOutput(
        {
          ru: "Укажите IP:порт сопряжения и 6-значный код с экрана «Пара»",
          uk: "Вкажіть IP:порт спарювання та 6-значний код",
          en: "Enter pairing IP:port and the 6-digit code from the Pair screen",
        }[language],
      );
      return;
    }
    setDeviceBusy(true);
    try {
      const facade = getRuntimeFacade();
      if (!facade.devicePolicy.isGranted("device.adb")) throw new Error("Grant the separate ADB capability first.");
      const r = await facade.wirelessAdb.pair(adbPairHost, adbPairCode); setAdbPairCode("");
      setDeviceOutput(r.message);
    } catch (e) {
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally { setDeviceBusy(false); }
  }, [adbPairHost, adbPairCode, language]);

  const onAdbConnect = useCallback(async () => {
    if (!adbConnectHost.trim() || !adbConnectHost.includes(":")) {
      setDeviceOutput(
        {
          ru: "Укажите IP:порт подключения (не порт pair), например 192.168.1.10:5555",
          uk: "Вкажіть IP:порт підключення (не порт pair)",
          en: "Enter connect IP:port (not the pair port), e.g. 192.168.1.10:5555",
        }[language],
      );
      return;
    }
    setDeviceBusy(true);
    try {
      const facade = getRuntimeFacade();
      if (!facade.devicePolicy.isGranted("device.adb")) throw new Error("Grant the separate ADB capability first.");
      const r = await facade.wirelessAdb.connect(adbConnectHost);
      setDeviceOutput(r.message);
      const listed = await facade.wirelessAdb.list();
      setAdbDevicesText((listed.devices || []).map((d) => `${d.serial}  ${d.state}`).join("\n") || (listed.ok ? "No connected ADB devices." : "ADB unavailable."));
      const available = r.ok && listed.ok && (listed.devices || []).some((device) => device.state === "device");
      setDeviceAvailable(available);
      if (available) {
        const bridge = facade.createTermuxAdbDeviceBridge();
        facade.useDeviceBridge(bridge);
        await startDeviceWatchdog();
      }
    } catch (e) {
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally { setDeviceBusy(false); }
  }, [adbConnectHost, language]);

  const onAdbReconnect = useCallback(async () => {
    setDeviceBusy(true);
    try {
      const facade = getRuntimeFacade();
      if (!facade.devicePolicy.isGranted("device.adb")) throw new Error("Grant the separate ADB capability first.");
      const reconnect = await facade.wirelessAdb.reconnect();
      setDeviceOutput(reconnect.message);
      const listed = await facade.wirelessAdb.list();
      setAdbDevicesText((listed.devices || []).map((device) => `${device.serial}  ${device.state}`).join("\n") || (listed.ok ? "No connected ADB devices." : "ADB unavailable."));
      const available = reconnect.ok && (listed.devices || []).some((device) => device.state === "device");
      setDeviceAvailable(available);
      if (available) {
        const bridge = facade.createTermuxAdbDeviceBridge();
        facade.useDeviceBridge(bridge);
        await startDeviceWatchdog();
      }
    } catch (e) {
      setDeviceAvailable(false);
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally { setDeviceBusy(false); }
  }, [startDeviceWatchdog]);

  const onDeviceLogcat = useCallback(async () => {
    try {
      const facade = getRuntimeFacade();
      // Ensure Termux ADB bridge is wired (list devices does this; logcat alone may not)
      try {
        const bridge = facade.createTermuxAdbDeviceBridge();
        facade.useDeviceBridge(bridge);
      } catch { /* keep existing bridge */ }
      const result = await facade.device.logcat(["-d", "-t", "120"]);
      const body = (result.stdout || result.stderr || "").slice(-12000);
      if (result.exitCode !== 0 && /DEVICE_BRIDGE_UNAVAILABLE|not found|no devices/i.test(body || "")) {
        setDeviceOutput(
          {
            ru: "Logcat недоступен: сначала Pair/Connect или «Обновить устройства». Инструменты ADB в приватной среде не поставляются; эта функция требует готового toolchain.",
            uk: "Logcat недоступний: спочатку Pair/Connect.",
            en: "Logcat unavailable: Pair/Connect first (android-tools in Termux).",
          }[language] + (body ? "\n" + body : ""),
        );
      } else {
        setDeviceOutput(body || "logcat: empty");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/unavailable|DEVICE_UNAVAILABLE|no devices|not found|ADB_/i.test(msg)) {
        setDeviceOutput(
          {
            ru: "Logcat недоступен: сначала Pair/Connect или «Обновить устройства». Нужны android-tools в Termux и устройство в adb devices.",
            uk: "Logcat недоступний: спочатку Pair/Connect. Інструменти ADB у приватному середовищі не постачаються; функція потребує готового toolchain.",
            en: "Logcat unavailable: Pair/Connect first (android-tools in Termux, device in adb devices).",
          }[language] + "\n" + msg,
        );
      } else {
        setDeviceOutput(msg);
      }
    }
  }, [language]);

  const onRunAutonomousDeviceLoop = useCallback(async () => {
    const packageName = devicePackageName.trim();
    if (!packageName) { setDeviceOutput("Enter Android package name first"); return; }
    if (!deviceGoal.trim()) { setDeviceOutput("Enter AI device test goal first"); return; }
    setDeviceLoopBusy(true);
    setDeviceOutput("AI device loop: starting…");
    try {
      const result = await runDeviceDevelopmentLoop({
        packageName,
        goal: deviceGoal.trim(),
        maxBuildAttempts: 3,
        maxDeviceSteps: 8,
        onEvent: (event) => {
          if (event.type === "build_started") setDeviceOutput(`Build ${event.attempt}/${event.maxAttempts}…`);
          else if (event.type === "build_failed") {
            setDeviceOutput(`Build ${event.attempt} failed — AI repair…`);
            void notePossibleBuildKill(`device-loop-build-${event.attempt}`);
            void maybeSurvivalReminder(language as "ru" | "uk" | "en").then((m) => {
              if (m) setMessage(m);
            });
          }
          else if (event.type === "device_started") setDeviceOutput(`APK ready. Device test ${event.attempt}…`);
          else if (event.type === "device_finished") setDeviceOutput(`Device: ${event.result.reason}`);
          else if (event.type === "repair_started") setDeviceOutput(`AI repair ${event.attempt}…`);
          else if (event.type === "completed") setDeviceOutput("AI device loop: test passed ✓");
          else if (event.type === "failed") setDeviceOutput(`AI device loop: ${event.reason}`);
        },
      });
      setDeviceOutput(result.completed
        ? `AI device loop completed: goal reached after ${result.buildAttempts} build attempt(s).`
        : `AI device loop stopped: ${result.device?.reason || result.build?.errors?.[0]?.message || "unknown failure"}`);
    } catch (e) {
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setDeviceLoopBusy(false);
      await refresh();
    }
  }, [devicePackageName, deviceGoal, runDeviceDevelopmentLoop, refresh]);


  const onRunDeviceSuite = useCallback(async () => {
    if (!project) { setDeviceOutput("Bind an active project first"); return; }
    if (!deviceApkPath.trim() || !deviceGoal.trim()) { setDeviceOutput("APK path and test specification are required"); return; }
    setDeviceSuiteBusy(true);
    setDeviceOutput("AI Test Planner: generating suite…");
    try {
      const result = await getRuntimeFacade().runDeviceTestSuite({
        apkPath: deviceApkPath.trim(),
        packageName: devicePackageName.trim() || undefined,
        goal: deviceGoal.trim(),
        projectPath: project.path,
        runId: `suite-${Date.now()}`,
      });
      const t = result.report.totals;
      setDeviceOutput(`AI Test Suite: ${result.report.status.toUpperCase()} · ${t.passed}/${t.cases} passed · evidence: ${result.report.evidenceRoot}`);
    } catch (e) {
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setDeviceSuiteBusy(false);
      await refresh();
    }
  }, [project, deviceApkPath, devicePackageName, deviceGoal, refresh]);

  const onRunSelfHealingQA = useCallback(async () => {
    if (!project) { setDeviceOutput("Bind an active project first"); return; }
    if (!deviceGoal.trim()) { setDeviceOutput("Test specification is required"); return; }
    setDeviceSelfHealBusy(true);
    setDeviceOutput("AI Self-Healing QA: build → test → evidence → repair…");
    try {
      const result = await runSelfHealingDeviceQA({
        packageName: devicePackageName.trim() || undefined,
        goal: deviceGoal.trim(),
        maxBuildAttempts: 3,
        maxActionsPerCase: 12,
        onEvent: (event) => {
          if (event.type === "suite_planned") setDeviceOutput(`AI QA: planned ${event.cases} test case(s)`);
          else if (event.type === "build_started") setDeviceOutput(`AI QA: build ${event.attempt}/${event.maxAttempts}…`);
          else if (event.type === "suite_started") setDeviceOutput(`AI QA: running ${event.caseIds?.length ? event.caseIds.join(", ") : "full suite"}…`);
          else if (event.type === "suite_finished") setDeviceOutput(`AI QA: ${event.run.report.status.toUpperCase()} · ${event.run.report.totals.passed}/${event.run.report.totals.cases} passed`);
          else if (event.type === "repair_started") setDeviceOutput(`AI QA: repairing ${event.failedCases.join(", ") || "build"}…`);
          else if (event.type === "repair_finished") setDeviceOutput("AI QA: repair applied, rebuilding…");
          else if (event.type === "completed") setDeviceOutput(`AI Self-Healing QA passed after ${event.attempt} attempt(s) ✓`);
          else if (event.type === "failed") setDeviceOutput(`AI Self-Healing QA stopped: ${event.reason}`);
        },
      });
      const report = result.finalRun?.report;
      setDeviceOutput(result.completed
        ? `AI Self-Healing QA: PASSED · ${report?.totals.passed || 0}/${report?.totals.cases || 0} cases · repaired: ${result.repairedCaseIds.length}`
        : `AI Self-Healing QA: FAILED · ${report?.totals.passed || 0}/${report?.totals.cases || 0} cases · repaired: ${result.repairedCaseIds.join(", ") || "none"}`);
    } catch (e) {
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setDeviceSelfHealBusy(false);
      await refresh();
    }
  }, [project, deviceGoal, devicePackageName, runSelfHealingDeviceQA, refresh]);

  const onRunReleaseGate = useCallback(async () => {
    if (!project) { setDeviceOutput("Bind an active project first"); return; }
    if (!deviceGoal.trim()) { setDeviceOutput("Release test specification is required"); return; }
    setDeviceReleaseGateBusy(true);
    setDeviceOutput("AI Release Gate: build → sign → regression…");
    try {
      const result = await runAIReleaseGate({
        packageName: devicePackageName.trim() || undefined,
        goal: deviceGoal.trim(),
        requireDeviceRegression: true,
        maxActionsPerCase: 12,
      });
      setDeviceOutput(result.releaseAllowed
        ? `Release Gate: ALLOWED · APK: ${result.artifact}`
        : `Release Gate: BLOCKED · ${result.checks.map((c) => `${c.id}:${c.status}`).join(" · ")}`);
    } catch (e) {
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setDeviceReleaseGateBusy(false);
      await refresh();
    }
  }, [project, deviceGoal, devicePackageName, runAIReleaseGate, refresh]);

  const onRunReleaseArtifact = useCallback(async () => {
    if (!project) { setDeviceOutput("Bind an active project first"); return; }
    if (!deviceGoal.trim()) { setDeviceOutput("Release test specification is required"); return; }
    setDeviceReleaseArtifactBusy(true);
    setDeviceOutput("AI Release Bundle: gate → manifest → checksums → zip…");
    try {
      const result = await runAIReleaseArtifact({
        packageName: devicePackageName.trim() || undefined,
        goal: deviceGoal.trim(),
        requireDeviceRegression: true,
        maxActionsPerCase: 12,
        releaseName: `v${getRuntimeFacade().runtimeIdentity.runtimeVersion}-${Date.now()}`,
      });
      setDeviceOutput(result.created
        ? `Release Bundle: READY · ${result.bundleArchive || result.bundleZip} · SHA256: ${result.sha256}`
        : `Release Bundle: NOT CREATED · ${result.message}`);
    } catch (e) {
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setDeviceReleaseArtifactBusy(false);
      await refresh();
    }
  }, [project, deviceGoal, devicePackageName, runAIReleaseArtifact, refresh]);

  const onPublishReleaseChannel = useCallback(async () => {
    if (!deviceGoal.trim()) { setDeviceOutput("Release test specification is required"); return; }
    setDeviceReleaseChannelBusy(true);
    setDeviceOutput(`AI Release Channel: gate → artifact → ${deviceReleaseChannel}…`);
    try {
      const result = await runAIReleaseChannel({ packageName: devicePackageName.trim() || undefined, goal: deviceGoal, channel: deviceReleaseChannel as any });
      setDeviceOutput(result.published ? `Channel ${result.channel}: PUBLISHED · ${result.entry?.versionName} (${result.entry?.versionCode}) · ${result.entry?.apkPath}` : `Channel ${result.channel}: BLOCKED · ${result.message}`);
      refresh();
    } catch (e) { setDeviceOutput(`Release Channel error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setDeviceReleaseChannelBusy(false); }
  }, [deviceGoal, devicePackageName, deviceReleaseChannel, runAIReleaseChannel, refresh]);

  const onRollbackReleaseChannel = useCallback(async () => {
    setDeviceRollbackBusy(true);
    setDeviceOutput(`AI Rollback: ${deviceReleaseChannel}…`);
    try {
      const result = await runAIRollbackReleaseChannel({ channel: deviceReleaseChannel as any });
      setDeviceOutput(result.rolledBack ? `Rollback ${result.channel}: ${result.entry?.releaseId} · version ${result.entry?.versionName} (${result.entry?.versionCode})` : `Rollback ${result.channel}: ${result.message}`);
      refresh();
    } catch (e) { setDeviceOutput(`Rollback error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setDeviceRollbackBusy(false); }
  }, [deviceReleaseChannel, runAIRollbackReleaseChannel, refresh]);


  const onProductionDeploy = useCallback(async () => {
    setDeviceDeployBusy(true);
    setDeviceOutput(`AI Production Deploy: ${deviceReleaseChannel} → install → health-check → rollback if needed…`);
    try {
      const result = await runAIProductionDeployment({ channel: deviceReleaseChannel as any, packageName: devicePackageName.trim() || undefined, autoRollback: true, healthTimeoutMs: 8000, confirmation: fleetConfirmation, backupSecret: fleetBackupSecret || undefined, backupRetention: 5 });
      setDeviceOutput(result.deployed
        ? `Deployment ${result.channel}: HEALTHY · ${result.entry?.versionName} (${result.entry?.versionCode}) · ${result.packageName}`
        : result.rolledBack
          ? `Deployment ${result.channel}: AUTO-ROLLBACK · restored ${result.rollbackEntry?.versionName} (${result.rollbackEntry?.versionCode}) · ${result.rollbackHealth?.detail}`
          : `Deployment ${result.channel}: FAILED · ${result.message}`);
      refresh();
    } catch (e) { setDeviceOutput(`Deployment error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setDeviceDeployBusy(false); }
  }, [devicePackageName, deviceReleaseChannel, runAIProductionDeployment, refresh]);

  const onFleetDeploy = useCallback(async () => {
    setDeviceDeployBusy(true);
    setDeviceOutput(`AI Device Fleet: ${deviceReleaseChannel} → rollout → health-check → per-device rollback…`);
    try {
      const result = await runAIDeviceFleetDeployment({ channel: deviceReleaseChannel as any, packageName: devicePackageName.trim() || undefined, concurrency: 2, autoRollback: true, healthTimeoutMs: 8000, confirmation: fleetConfirmation });
      setDeviceOutput(`Fleet ${result.channel}: ${result.healthy}/${result.total} healthy · ${result.rolledBack} rollback · ${result.failed} failed`);
    } catch (e) { setDeviceOutput(`Fleet deployment error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setDeviceDeployBusy(false); refresh(); }
  }, [devicePackageName, deviceReleaseChannel, runAIDeviceFleetDeployment, refresh]);

  const onFleetCanary = useCallback(async () => {
    setDeviceDeployBusy(true);
    setDeviceOutput(`AI Fleet Canary: ${deviceReleaseChannel} → 10% → 25% → 100% with failure gates…`);
    try {
      const result = await runAIFleetCanary({ channel: deviceReleaseChannel as any, packageName: devicePackageName.trim() || undefined, concurrency: 2, autoRollback: true, healthTimeoutMs: 8000, confirmation: fleetConfirmation });
      setDeviceOutput(result.stopped
        ? `Canary ${result.channel}: STOPPED · ${result.stopReason} · ${result.healthy}/${result.attempted} healthy`
        : `Canary ${result.channel}: COMPLETE · ${result.healthy}/${result.attempted} healthy`);
    } catch (e) { setDeviceOutput(`Fleet canary error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setDeviceDeployBusy(false); refresh(); }
  }, [devicePackageName, deviceReleaseChannel, runAIFleetCanary, refresh]);

  const onFleetCommandCenter = useCallback(async () => {
    setFleetCommandBusy(true);
    try {
      const result = await runAIFleetCommandCenter({ channel: deviceReleaseChannel as any });
      setFleetSnapshot(result);
      const healthy = result.devices.filter((d: any) => d.status === "healthy").length;
      setDeviceOutput(`Fleet Command Center: ${result.channel} · ${healthy}/${result.devices.length} healthy · ${result.observability.status.toUpperCase()} · incidents ${result.observability.incidentCount}`);
    } catch (e) { setDeviceOutput(`Fleet command center error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setFleetCommandBusy(false); refresh(); }
  }, [deviceReleaseChannel, runAIFleetCommandCenter, refresh]);

  const onFleetDeviceCommand = useCallback(async (serial: string, action: "deploy" | "rollback") => {
    setFleetCommandBusy(true);
    try {
      const result = await runAIFleetDeviceCommand({ channel: deviceReleaseChannel as any, serial, packageName: devicePackageName.trim() || undefined, action, confirmation: fleetConfirmation });
      setDeviceOutput(`${action.toUpperCase()} ${serial}: ${result.message}`);
      const snapshot = await runAIFleetCommandCenter({ channel: deviceReleaseChannel as any });
      setFleetSnapshot(snapshot);
    } catch (e) { setDeviceOutput(`Fleet device command error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setFleetCommandBusy(false); refresh(); }
  }, [devicePackageName, deviceReleaseChannel, runAIFleetDeviceCommand, runAIFleetCommandCenter, refresh]);

  const onFleetPolicy = useCallback(async () => {
    try {
      const result = await runAIFleetPolicy();
      setFleetPolicy(result);
      setFleetRole(result.role);
      setFleetConfirmation(result.productionConfirmationPhrase);
      setDeviceOutput(`Fleet Policy: ${result.role} · production confirmation ${result.requireProductionConfirmation ? "ON" : "OFF"}`);
    } catch (e) { setDeviceOutput(`Fleet policy error: ${e instanceof Error ? e.message : String(e)}`); }
  }, [runAIFleetPolicy]);

  const onSaveFleetPolicy = useCallback(async () => {
    setFleetCommandBusy(true);
    try {
      const result = await setAIFleetPolicy({ role: fleetRole as any, requireProductionConfirmation: true, productionConfirmationPhrase: fleetConfirmation });
      setFleetPolicy(result);
      setDeviceOutput(`Fleet Policy saved: ${result.role} · audit enabled`);
    } catch (e) { setDeviceOutput(`Fleet policy save error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setFleetCommandBusy(false); refresh(); }
  }, [fleetConfirmation, fleetRole, setAIFleetPolicy, refresh]);

  const onFleetBackupCreate = useCallback(async () => {
    if (!fleetBackupSecret || fleetBackupSecret.length < 12) return;
    setFleetCommandBusy(true);
    try {
      const result = await runAICreateFleetBackup({ secret: fleetBackupSecret, channel: deviceReleaseChannel as any, retention: 5, reason: "manual" });
      setFleetBackups(await runAIListFleetBackups({ limit: 10 }));
      showDialog("Fleet Backup", `Created ${result.id}`);
    } catch (error) { showDialog("Fleet Backup", error instanceof Error ? error.message : String(error)); }
    finally { setFleetCommandBusy(false); }
  }, [deviceReleaseChannel, fleetBackupSecret, runAICreateFleetBackup, runAIListFleetBackups]);

  const onFleetBackupVerify = useCallback(async () => {
    if (!fleetBackupSecret || !fleetBackups[0]?.id) return;
    setFleetCommandBusy(true);
    try { const result = await runAIVerifyFleetBackup({ backupId: fleetBackups[0].id, secret: fleetBackupSecret }); showDialog("Fleet Backup", result.valid ? "Integrity OK" : `Invalid: ${result.reason}`); }
    catch (error) { showDialog("Fleet Backup", error instanceof Error ? error.message : String(error)); }
    finally { setFleetCommandBusy(false); }
  }, [fleetBackupSecret, fleetBackups, runAIVerifyFleetBackup]);

  const onFleetRecoveryDrill = useCallback(async () => {
    if (!fleetBackupSecret || fleetBackupSecret.length < 12) return;
    setFleetCommandBusy(true);
    try {
      const result = await runAIFleetRecoveryDrill({ secret: fleetBackupSecret, backupId: fleetBackups[0]?.id });
      showDialog("Recovery Drill", `${result.status} · ${result.files} files · ${result.failureReason || "isolated restore verified"}`);
    } catch (error) { showDialog("Recovery Drill", error instanceof Error ? error.message : String(error)); }
    finally { setFleetCommandBusy(false); }
  }, [fleetBackupSecret, fleetBackups, runAIFleetRecoveryDrill]);

  const onFleetRecoverySchedule = useCallback(async () => {
    try { const result = await runAIFleetRecoverySchedule(deviceReleaseChannel as any); setFleetRecoveryScheduleState(result); const slo = await runAIFleetRecoverySlo(deviceReleaseChannel as any); setFleetRecoverySlo(slo); showDialog("Recovery SLO", `${slo.status} · backup ${slo.backupFresh ? "fresh" : "stale"} · drill ${slo.drillFresh ? "fresh" : "stale"}`); }
    catch (error) { showDialog("Recovery Scheduler", error instanceof Error ? error.message : String(error)); }
  }, [deviceReleaseChannel, runAIFleetRecoverySchedule, runAIFleetRecoverySlo]);

  const onFleetUnifiedControlCenter = useCallback(async () => {
    setFleetCommandBusy(true);
    try {
      const result = await runAIFleetUnifiedControlCenter({ channel: deviceReleaseChannel as any });
      setFleetUnifiedControl(result);
      setDeviceOutput(`Control Center: ${result.status.toUpperCase()} · devices ${result.summary.healthyDevices}/${result.summary.devices} healthy · incidents ${result.summary.openIncidents} · alerts ${result.summary.activeAlerts} · critical ${result.summary.criticalAlerts}`);
    } catch (error) { setDeviceOutput(`Control Center error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setFleetCommandBusy(false); }
  }, [deviceReleaseChannel, runAIFleetUnifiedControlCenter]);

  const onFleetSloDashboard = useCallback(async () => {
    setDeviceDeployBusy(true);
    try {
      const result = await runAIFleetSloDashboard({ channel: deviceReleaseChannel as any });
      setFleetSloDashboard(result);
      setDeviceOutput(`Fleet SLO: ${result.overallStatus.toUpperCase()} · failure ${result.metrics.failureRate.toFixed(1)}% · open incidents ${result.metrics.openIncidentCount} · backup ${result.metrics.backupFresh ? "fresh" : "STALE"} · drill ${result.metrics.drillFresh ? "fresh" : "STALE"}`);
    } catch (error) { setDeviceOutput(`Fleet SLO dashboard error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setDeviceDeployBusy(false); }
  }, [deviceReleaseChannel, runAIFleetSloDashboard]);

  const onFleetAlertEscalation = useCallback(async () => {
    setDeviceDeployBusy(true);
    try {
      const result = await runAIFleetAlertEscalation({ channel: deviceReleaseChannel as any });
      setFleetEscalation(result);
      setDeviceOutput(`Fleet alerts: ${result.escalatedCount} active · ${result.acknowledgedCount} acknowledged · outbox ${result.pendingNotifications}`);
    } catch (error) { setDeviceOutput(`Fleet escalation error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setDeviceDeployBusy(false); }
  }, [deviceReleaseChannel, runAIFleetAlertEscalation]);

  const onFleetSloAcknowledge = useCallback(async (item: any) => {
    try {
      if (item.incidentId) await acknowledgeAIFleetDashboardIncident({ channel: deviceReleaseChannel as any, incidentId: item.incidentId });
      else await acknowledgeAIFleetDashboardAlert({ channel: deviceReleaseChannel as any, alertId: item.id });
      const result = await runAIFleetSloDashboard({ channel: deviceReleaseChannel as any });
      setFleetSloDashboard(result);
    } catch (error) { setDeviceOutput(`Acknowledge error: ${error instanceof Error ? error.message : String(error)}`); }
  }, [deviceReleaseChannel, acknowledgeAIFleetDashboardAlert, acknowledgeAIFleetDashboardIncident, runAIFleetSloDashboard]);

  const onFleetRecoveryScheduledRun = useCallback(async () => {
    if (!fleetBackupSecret || fleetBackupSecret.length < 12) return;
    setFleetCommandBusy(true);
    try { const result = await runAIScheduledFleetRecovery({ secret: fleetBackupSecret, channel: deviceReleaseChannel as any, reason: "runtime-scheduled-recovery" }); setFleetRecoveryScheduleState(result.schedule); setFleetRecoverySlo(result.slo); setFleetBackups(await runAIListFleetBackups({ limit: 10 })); showDialog("Scheduled Recovery", `${result.drill.status} · SLO ${result.slo.status}`); }
    catch (error) { showDialog("Scheduled Recovery", error instanceof Error ? error.message : String(error)); }
    finally { setFleetCommandBusy(false); }
  }, [deviceReleaseChannel, fleetBackupSecret, runAIScheduledFleetRecovery, runAIListFleetBackups]);

  const onFleetBackupRestore = useCallback(async () => {
    if (!fleetBackupSecret || !fleetBackups[0]?.id) return;
    const approved = await confirmDialog(
      language === "en" ? "Restore fleet backup?" : language === "uk" ? "Відновити резервну копію флоту?" : "Восстановить резервную копию парка?",
      language === "en" ? `This applies the selected snapshot (${fleetBackups[0].id}) and may replace current state.` : language === "uk" ? `Буде застосовано вибраний знімок (${fleetBackups[0].id}); поточний стан може бути замінений.` : `Будет применён выбранный снимок (${fleetBackups[0].id}); текущее состояние может быть заменено.`,
      language === "en" ? "Restore" : language === "uk" ? "Відновити" : "Восстановить",
      language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена",
    );
    if (!approved) return;
    setFleetCommandBusy(true);
    try { const result = await runAIRestoreFleetBackup({ backupId: fleetBackups[0].id, secret: fleetBackupSecret }); showDialog("Fleet Backup", `Restored ${result.snapshotId}`); }
    catch (error) { showDialog("Fleet Backup", error instanceof Error ? error.message : String(error)); }
    finally { setFleetCommandBusy(false); }
  }, [fleetBackupSecret, fleetBackups, runAIRestoreFleetBackup, confirmDialog, language]);

  const onFleetAudit = useCallback(async () => {
    try {
      const entries = await runAIFleetAudit({ limit: 12 });
      setDeviceOutput(entries.length ? `Audit: ${entries.slice(-6).map((x: any) => `${x.action}/${x.channel}/${x.result}${x.serial ? `/${x.serial}` : ""}`).join(" · ")}` : "Audit: no entries");
    } catch (e) { setDeviceOutput(`Fleet audit error: ${e instanceof Error ? e.message : String(e)}`); }
  }, [runAIFleetAudit]);

  const onFleetAuditSecurity = useCallback(async () => {
    try {
      const verification = await runAIVerifyFleetAudit();
      const entries = await runAISecureFleetAudit({ limit: 12 });
      setDeviceOutput(`Secure Audit: ${verification.valid ? "VALID" : "TAMPERED"} · ${verification.entries} chained entries${entries.length ? ` · latest ${entries.slice(-3).map((x: any) => `${x.action}/${x.channel}/${x.result}`).join(" · ")}` : ""}`);
    } catch (e) { setDeviceOutput(`Secure audit error: ${e instanceof Error ? e.message : String(e)}`); }
  }, [runAIVerifyFleetAudit, runAISecureFleetAudit]);

  const onFleetSnapshot = useCallback(async () => {
    try {
      const result = await runAICreateFleetSnapshot();
      setDeviceOutput(`Fleet snapshot: ${result.id} · ${result.files.length} files · ${result.manifestSha256.slice(0, 16)}…`);
    } catch (e) { setDeviceOutput(`Fleet snapshot error: ${e instanceof Error ? e.message : String(e)}`); }
  }, [runAICreateFleetSnapshot]);

  const onFleetRecovery = useCallback(async () => {
    const approved = await confirmDialog(
      language === "en" ? "Restore fleet snapshot?" : language === "uk" ? "Відновити знімок флоту?" : "Восстановить снимок парка?",
      language === "en" ? "This applies a stored fleet snapshot to the current runtime state." : language === "uk" ? "Збережений знімок флоту буде застосований до поточного стану середовища." : "Сохранённый снимок парка будет применён к текущему состоянию среды.",
      language === "en" ? "Restore" : language === "uk" ? "Відновити" : "Восстановить",
      language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена",
    );
    if (!approved) return;
    try {
      const result = await runAIRestoreFleetSnapshot();
      setDeviceOutput(`Fleet recovery: ${result.restored ? "RESTORED" : "FAILED"} · ${result.snapshotId} · ${result.files} files`);
      const snapshot = await runAIFleetCommandCenter({ channel: deviceReleaseChannel as any });
      setFleetSnapshot(snapshot);
    } catch (e) { setDeviceOutput(`Fleet recovery error: ${e instanceof Error ? e.message : String(e)}`); }
  }, [deviceReleaseChannel, runAIRestoreFleetSnapshot, runAIFleetCommandCenter, confirmDialog, language]);

  const onFleetAuditExport = useCallback(async () => {
    try {
      const result = await runAIExportFleetAuditBundle({ channel: deviceReleaseChannel as any });
      setDeviceOutput(`Fleet audit bundle: ${result.path} · chain ${result.verification.valid ? "VALID" : "INVALID"}`);
    } catch (e) { setDeviceOutput(`Audit bundle error: ${e instanceof Error ? e.message : String(e)}`); }
  }, [deviceReleaseChannel, runAIExportFleetAuditBundle]);

  const onFleetObservability = useCallback(async () => {
    setDeviceDeployBusy(true);
    setDeviceOutput(`AI Fleet Observability: ${deviceReleaseChannel}…`);
    try {
      const result = await runAIFleetObservability({ channel: deviceReleaseChannel as any });
      const stages = result.canary?.stages.map(s => `#${s.stage} ${s.percentage}% ${s.failureRate.toFixed(1)}% ${s.passed ? "PASS" : "STOP"}`).join(" · ") || "no canary stages";
      const healthy = result.canary?.healthy ?? result.fleet?.healthy ?? 0;
      const attempted = result.canary?.attempted ?? result.fleet?.total ?? 0;
      setDeviceOutput(`Fleet ${result.channel}: ${result.status.toUpperCase()} · ${healthy}/${attempted} healthy · failure ${result.failureRate.toFixed(1)}% · incidents ${result.incidentCount}\n${stages}`);
    } catch (e) { setDeviceOutput(`Fleet observability error: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setDeviceDeployBusy(false); refresh(); }
  }, [deviceReleaseChannel, runAIFleetObservability, refresh]);

  const onStopDevice = useCallback(async () => {
    await stopDeviceWatchdog();
    setDeviceAvailable(false);
    setDeviceOutput("Device watchdog stopped");
  }, []);

  const onRunDeviceLoop = useCallback(async () => {

    setDeviceBusy(true);
    try {
      const result = await getRuntimeFacade().runDeviceAppLoop({
        apkPath: deviceApkPath.trim(),
        packageName: devicePackageName.trim() || undefined,
        screenshot: true,
        screenshotPath: "/storage/emulated/0/AIBuilderTermux/AIBuilder-device.png",
        settleMs: 1000,
      });
      setDeviceOutput([
        "DEVICE_APP_LOOP_OK",
        `install=${result.installed.exitCode}`,
        `launch=${result.launched.exitCode}`,
        `screenshot=${result.screenshotPath || "captured"}`,
        `screenshotBase64=${result.screenshotBase64 ? result.screenshotBase64.length + " chars" : "none"}`,
        result.logcat?.stderr ? `logcat=${result.logcat.stderr}` : "logcat=collected",
      ].join("\n"));
    } catch (e) {
      setDeviceOutput(e instanceof Error ? e.message : String(e));
    } finally { setDeviceBusy(false); }
  }, [deviceApkPath, devicePackageName]);

  const onBindActive = useCallback(async () => {
    if (!project) {
      setMessage(
        {
          ru: "Нет активного проекта — откройте проект или укажите ID выше",
          uk: "Немає активного проєкту",
          en: "No active project — open one or set Project ID above",
        }[language],
      );
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (!project?.id) return;
      const binding = await bindProjectToRuntime(getRuntimeFacade(), project.id, {
        launchUbuntu: false,
      });
      setProjectId(project.id);
      setMessage(`bound:${binding?.session?.id ?? "?"} · ${project.path}`);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [project, refresh, language]);

  return (
    <ScrollView
      key={desktopLayout ? "desktop" : "mobile"}
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={getDesktopContentStyle(
        undefined,
        { padding: 16, paddingBottom: insets.bottom + 24, gap: 12 },
      )}
    >
      <View style={styles.headerRow}>
        <Text style={[styles.title, { color: colors.inkBright, opacity: 0, height: 0, overflow: "hidden" }]}>
          {t("runtime")}
        </Text>
        <TouchableOpacity
          onPress={() => void refresh()}
          style={[styles.btn, { borderColor: colors.line, backgroundColor: colors.surface }]}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Ionicons name="refresh" size={18} color={colors.accent} />
          )}
        </TouchableOpacity>
      </View>

      <View style={[styles.card, { borderColor: colors.line, backgroundColor: colors.surface }, desktopLayout ? { flexDirection: "row", flexWrap: "wrap", gap: 12 } : null]}>
        <View style={{ flex: 1, minWidth: desktopLayout ? 280 : undefined }}>
          <Text style={[styles.cardTitle, { color: colors.inkBright }]}>
            {{ ru: "Fast Path", uk: "Fast Path", en: "Fast Path" }[language]}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 12 }}>
            host {fastPath.hostTermux} · proot {fastPath.ubuntuProot} · hits {fastPath.fastPathHits}
          </Text>
          <TouchableOpacity
            onPress={() => { resetFastPathMetrics(); setFastPathTick((n) => n + 1); }}
            style={{ marginTop: 6, alignSelf: "flex-start" }}
          >
            <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "700" }}>
              {language === "ru" ? "Сбросить счётчики" : language === "uk" ? "Скинути лічильники" : "Reset counters"}
            </Text>
          </TouchableOpacity>
        </View>
        {desktopLayout ? (
          <View style={{ flex: 1, minWidth: 280 }}>
            <Text style={[styles.cardTitle, { color: colors.inkBright }]}>Keystore</Text>
            <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={3}>
              {formatKeystorePolicyBlock().split("\n").slice(0, 3).join(" · ")}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[desktopLayout ? styles.desktopActionRow : { gap: 8 }, !desktopLayout && { flexDirection: "column" }]}>
        <TouchableOpacity
          disabled={busy}
          onPress={() => void onPrivilegeProbe()}
          style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1, flex: 1 }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="shield-checkmark-outline" size={18} color={colors.accent} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: colors.inkBright }]} numberOfLines={1}>
                {t("privilegeProbe")}
              </Text>
              <Text style={styles.actionHintMuted}>
                {t("privilegeProbeHint")}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          disabled={busy}
          onPress={() => void onKeystoreCheck()}
          style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1, flex: 1 }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="key-outline" size={18} color={colors.accent} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: colors.inkBright }]} numberOfLines={1}>
                {t("keystoreCheck")}
              </Text>
              <Text style={styles.actionHintMuted}>{t("keystoreCheckHint")}</Text>
            </View>
          </View>
        </TouchableOpacity>
      </View>

      {error ? (
        <Text style={{ color: colors.danger ?? "#f66" }}>{error}</Text>
      ) : null}

      {message && !hideDuplicateRuntimeStatusMessage ? (
        <Text style={{ color: colors.muted }}>{message}</Text>
      ) : null}

      {/* ===== UNIFIED ENVIRONMENT MANAGER ===== */}
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <View style={styles.cardHeader}>
          <Ionicons name="layers-outline" size={22} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>
              {{ ru: "Среда выполнения", uk: "Середовище виконання", en: "Runtime environment" }[language]}
            </Text>
            <Text style={[styles.helpText, { marginTop: 3 }]}>
              {environmentBackend === "termux"
                ? ({
                    ru: "Для Termux доступна отдельная проверка готовности; нажатие «Проверить» ничего не устанавливает. Подготовка Linux-rootfs не запускается в режиме Termux.",
                    uk: "Для Termux доступна окрема перевірка готовності; кнопка «Перевірити» нічого не встановлює. Підготовка Linux-rootfs у режимі Termux не запускається.",
                    en: "Termux offers its own readiness check; Check does not install anything. Linux rootfs preparation does not run in Termux mode.",
                  } as const)[language]
                : environmentBackend === "ubuntu-proot"
                  ? ({
                      ru: "Выбор и проверка Ubuntu только анализируют host prerequisite, Ubuntu rootfs/login и базовые guest-пакеты. «Установить» появляется только при подтверждённом отсутствии; unknown/timeout/ошибка доступа — это ошибка, не отсутствие. Установка запускается только отдельным нажатием.",
                      uk: "Вибір і перевірка Ubuntu лише аналізують host prerequisite, Ubuntu rootfs/login і базові guest-пакети. «Встановити» з'являється лише за підтвердженої відсутності; unknown/timeout/помилка доступу — це помилка, не відсутність. Встановлення запускається лише окремим натисканням.",
                      en: "Selecting or checking Ubuntu only inspects the host prerequisite, Ubuntu rootfs/login and baseline guest packages. Install appears only for confirmed absence; unknown/timeout/access errors are errors, not absence. Installation starts only after a separate button press.",
                    } as const)[language]
                  : ({
                      ru: "Выбор и проверка Debian только анализируют host prerequisite, Debian rootfs/login и базовые guest-пакеты. «Установить» появляется только при подтверждённом отсутствии; unknown/timeout/ошибка доступа — это ошибка, не отсутствие. Установка запускается только отдельным нажатием.",
                      uk: "Вибір і перевірка Debian лише аналізують host prerequisite, Debian rootfs/login і базові guest-пакети. «Встановити» з'являється лише за підтвердженої відсутності; unknown/timeout/помилка доступу — це помилка, не відсутність. Встановлення запускається лише окремим натисканням.",
                      en: "Selecting or checking Debian only inspects the host prerequisite, Debian rootfs/login and baseline guest packages. Install appears only for confirmed absence; unknown/timeout/access errors are errors, not absence. Installation starts only after a separate button press.",
                    } as const)[language]}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 8, marginTop: 12, width: "100%" }}>
          {([
            ["termux", "terminal-outline", "Termux"],
            ["ubuntu-proot", "planet-outline", "Ubuntu"],
          ] as const).map(([id, icon, label]) => {
            const active = environmentBackend === id;
            return (
              <TouchableOpacity
                key={id}
                onPress={() => void selectEnvironment(id)}
                disabled={linuxBusy}
                style={{
                  flex: 1,
                  minWidth: 0,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  paddingVertical: 12,
                  paddingHorizontal: 6,
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor: active ? DARK_SLATE_GRAY : colors.line,
                  backgroundColor: active ? DARK_SLATE_GRAY : colors.surfaceRaised,
                  opacity: linuxBusy ? 0.55 : 1,
                }}
              >
                <Ionicons name={icon as any} size={18} color={active ? "#FFFFFF" : colors.muted} />
                <Text
                  numberOfLines={1}
                  style={{ color: active ? "#FFFFFF" : colors.inkBright, fontWeight: active ? "800" : "600", fontSize: 13 }}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={[styles.helpText, { marginTop: 6 }]}>{selectedEnvironmentStatusSummary}</Text>

        <View style={{ marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background }}>
          <Text style={{ color: colors.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7 }}>
            {{ ru: "Активная среда", uk: "Активне середовище", en: "Active environment" }[language]}
          </Text>
          <Text style={{ color: colors.inkBright, fontSize: 18, fontWeight: "800", marginTop: 4 }}>{environmentLabel[language]}</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>
            {environmentBackend === "termux"
              ? `shell: Termux · packages: pkg · build: Termux · agent shell: ${agentShellExecutionTarget === "embedded-private" ? "embedded private (TERMUX_RUN only)" : "Termux"}`
              : environmentBackend === "ubuntu-proot"
                ? `shell: Ubuntu proot · packages: apt · build: Ubuntu · agent shell: ${agentShellExecutionTarget === "embedded-private" ? "embedded private (TERMUX_RUN only)" : "Ubuntu"}`
                : `shell: Ubuntu proot · packages: apt · build: Debian · agent shell: ${agentShellExecutionTarget === "embedded-private" ? "embedded private (TERMUX_RUN only)" : "Debian"}`}
          </Text>
        </View>

        <View style={{ marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background }}>
          <Text style={{ color: colors.inkBright, fontSize: 14, fontWeight: "800" }}>
            {{ ru: "Цель shell-команд агента", uk: "Ціль shell-команд агента", en: "Agent shell command target" }[language]}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4, lineHeight: 17 }}>
            {{
              ru: "Экспериментальный этап: TERMUX_RUN и read-only archive probe выполняются во встроенном private runtime. AIB_TOOL runtime.status запускает только фиксированную read-only printf-проверку Bash; внешние проверки готовности или автоустановка пакетов не выполняются. workspace.list отдельно показывает метаданные только прямых элементов точной папки AIBuilderTermux и только после явного read-only SAF-разрешения. build.run — отдельное ограниченное действие: только assembleDebug для проверенного проекта в AIBuilderTermux, при MANAGE_EXTERNAL_STORAGE, SDK/JDK в app-private PREFIX и уже кэшированном Gradle; запуск проходит с --offline, без clean, скачивания или установки. Если чего-либо не хватает, возвращается TOOLCHAIN_UNAVAILABLE с причиной. При подключённом GitHub доступны только зарегистрированные типизированные API-вызовы: чтение — только read-only, а каждое создание/изменение/merge/комментарий требует отдельного подтверждения. Произвольная сеть/shell и GitHub materialize/download/pack/copy, pkg.ensure/toolchain.ensure, обычные project-path tools, прочие shared-storage-пути, host Termux/proot/Terminal и изменения interceptor отклоняются без dispatch на другой backend. workspace.read/write используют native procfd no-follow API; SAF остаётся только для метаданных. Поведение и кэш на Android-устройстве ещё не проверены.",
              uk: "Експериментальний етап: TERMUX_RUN і read-only archive probe працюють у вбудованому private runtime. AIB_TOOL runtime.status запускає лише фіксовану read-only printf-перевірку Bash; зовнішні перевірки готовності або автоінсталяція пакетів не виконуються. workspace.list окремо показує метадані лише прямих елементів точної папки AIBuilderTermux і тільки після явного read-only SAF-дозволу. build.run — окрема обмежена дія: тільки assembleDebug для перевіреного проєкту в AIBuilderTermux, за наявності MANAGE_EXTERNAL_STORAGE, SDK/JDK в app-private PREFIX і вже кешованого Gradle; запуск відбувається з --offline, без clean, завантаження чи встановлення. Якщо чогось бракує, повертається TOOLCHAIN_UNAVAILABLE із причиною. За підключеного GitHub доступні лише зареєстровані типізовані API-виклики: читання — тільки read-only, а кожне створення/зміна/merge/коментар потребує окремого підтвердження. Довільна мережа/shell і GitHub materialize/download/pack/copy, pkg.ensure/toolchain.ensure, звичайні project-path tools, інші shared-storage-шляхи, host Termux/proot/Terminal і зміни interceptor відхиляються без dispatch на інший backend. workspace.read/write використовують native procfd no-follow API; SAF залишається лише для метаданих. Поведінку й кеш на Android-пристрої ще не перевірено.",
              en: "Experimental stage: TERMUX_RUN and its same-target read-only archive probe use embedded private. AIB_TOOL runtime.status runs only the fixed read-only printf Bash probe. No external readiness checks or package auto-install run. workspace.list separately exposes direct-child metadata for the exact AIBuilderTermux folder only after an explicit read-only SAF grant. build.run is a separate restricted action: assembleDebug only, for a validated AIBuilderTermux project, with MANAGE_EXTERNAL_STORAGE, SDK/JDK inside the app-private PREFIX, and an already-cached Gradle distribution; it runs with --offline and never cleans, downloads, or installs. Missing prerequisites return TOOLCHAIN_UNAVAILABLE with a reason. When GitHub is connected, only registered typed GitHub API calls are available: reads are read-only, and every create/change/merge/comment requires a separate confirmation. Arbitrary network/shell and GitHub materialize/download/pack/copy, pkg.ensure, toolchain.ensure, ordinary project-path tools, other shared-storage paths, host Termux/proot/Terminal controls, and interceptor mutations are rejected without another-backend dispatch. workspace.read/write use the native procfd no-follow API; SAF remains metadata-only. Android device behavior and toolchain cache are not yet verified.",
            }[language]}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            {([
              ["embedded-private", language === "ru" ? "Встроенная private" : language === "uk" ? "Вбудована private" : "Embedded private"],
            ] as const).map(([target, label]) => {
              const active = agentShellExecutionTarget === target;
              return (
                <TouchableOpacity
                  key={target}
                  onPress={() => void setAgentShellExecutionTarget(target as AgentShellExecutionTarget)}
                  disabled={busy || linuxBusy}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    alignItems: "center",
                    justifyContent: "center",
                    paddingVertical: 11,
                    paddingHorizontal: 8,
                    borderRadius: 10,
                    borderWidth: 1.5,
                    borderColor: active ? DARK_SLATE_GRAY : colors.line,
                    backgroundColor: active ? DARK_SLATE_GRAY : colors.surfaceRaised,
                    opacity: busy || linuxBusy ? 0.55 : 1,
                  }}
                >
                  <Text numberOfLines={1} style={{ color: active ? "#FFFFFF" : colors.inkBright, fontWeight: active ? "800" : "600", fontSize: 12 }}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {Platform.OS === "android" ? (
            <View style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line }}>
              <Text style={{ color: colors.inkBright, fontSize: 12, fontWeight: "700" }}>
                {{ ru: "Специальный доступ Android: ко всем файлам", uk: "Спеціальний доступ Android: до всіх файлів", en: "Android special access: All files" }[language]}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 }}>
                {{
                  ru: "Это широкое разрешение для общей памяти, а не песочница только для /storage/emulated/0/AIBuilderTermux. В этой тестовой/sideload-сборке API рабочей папки всё равно ограничены точным корнем; это не shell-песочница. Файловые API читают и записывают только вложенные UTF-8 файлы до 2 MiB в AIBuilderTermux через procfd и O_NOFOLLOW. Данные внешнего Termux не используются; без нативной возможности операция отклоняется.",
                  uk: "Це широкий дозвіл для спільного сховища, а не ізоляція лише для /storage/emulated/0/AIBuilderTermux. У цій тестовій/sideload-збірці API робочої папки все одно обмежені точним коренем; це не shell-ізоляція. Файлові API читають і записують лише вкладені UTF-8 файли до 2 MiB у AIBuilderTermux через procfd та O_NOFOLLOW. Дані зовнішнього Termux не використовуються; без нативної можливості операція відхиляється.",
                  en: "This is broad shared-storage access for AI Builder, not a sandbox limited to /storage/emulated/0/AIBuilderTermux. In this test/sideload build, workspace APIs remain restricted to that exact root; this is not a shell sandbox. File APIs read and write only nested UTF-8 files up to 2 MiB in AIBuilderTermux using procfd and O_NOFOLLOW. External Termux data is not used; missing native capability rejects the operation.",
                }[language]}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 }}>
                {{
                  ru: "Google Play ограничивает MANAGE_EXTERNAL_STORAGE: для публикации нужны допустимый основной сценарий, форма декларации и одобрение. Эта тестовая/sideload-сборка не подтверждает соответствие критериям Play.",
                  uk: "Google Play обмежує MANAGE_EXTERNAL_STORAGE: для публікації потрібні дозволений основний сценарій, форма декларації та схвалення. Ця тестова/sideload-збірка не підтверджує відповідність критеріям Play.",
                  en: "Google Play restricts MANAGE_EXTERNAL_STORAGE: publishing requires an eligible core use case, a permissions declaration, and approval. This test/sideload build does not establish Play eligibility.",
                }[language]}
              </Text>
              <Text style={{ color: aiBuilderAllFilesAccess?.granted ? colors.inkBright : colors.muted, fontSize: 11, marginTop: 6 }}>
                {aiBuilderAllFilesAccess === null
                  ? ({ ru: "Проверка специального доступа…", uk: "Перевірка спеціального доступу…", en: "Checking special access…" }[language])
                  : !aiBuilderAllFilesAccess.supported
                    ? ({ ru: "Этот специальный доступ поддерживается начиная с Android 11.", uk: "Цей спеціальний доступ підтримується починаючи з Android 11.", en: "This special access is supported on Android 11 and later." }[language])
                    : aiBuilderAllFilesAccess.granted
                      ? ({ ru: "Доступ ко всем файлам включён; разрешение охватывает общую память, а не только папку проекта.", uk: "Доступ до всіх файлів увімкнено; дозвіл охоплює спільне сховище, а не лише папку проєкту.", en: "All files access is enabled; it covers shared storage, not only the project folder." }[language])
                      : ({ ru: "Не включён: операции с рабочей папкой завершаются типизированным отказом без перехода на другой backend.", uk: "Не ввімкнено: операції з робочою папкою завершуються типізованою відмовою без переходу на інший backend.", en: "Not enabled: workspace operations fail with a typed denial and never fall back to another backend." }[language])}
              </Text>
              <TouchableOpacity
                onPress={() => void onOpenAIBuilderAllFilesAccessSettings()}
                disabled={aiBuilderAllFilesAccessBusy || aiBuilderAllFilesAccess?.supported === false}
                style={{ alignItems: "center", justifyContent: "center", paddingVertical: 9, paddingHorizontal: 8, marginTop: 8, borderRadius: 9, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceRaised, opacity: aiBuilderAllFilesAccessBusy || aiBuilderAllFilesAccess?.supported === false ? 0.5 : 1 }}
              >
                <Text style={{ color: colors.inkBright, fontSize: 11, fontWeight: "700", textAlign: "center" }}>
                  {{ ru: "Открыть настройки доступа ко всем файлам", uk: "Відкрити налаштування доступу до всіх файлів", en: "Open all-files access settings" }[language]}
                </Text>
              </TouchableOpacity>
              {aiBuilderAllFilesAccessFeedback ? <Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>{aiBuilderAllFilesAccessFeedback}</Text> : null}
              <Text style={{ color: colors.inkBright, fontSize: 12, fontWeight: "700" }}>
                {{ ru: "Рабочая папка (только метаданные)", uk: "Робоча папка (лише метадані)", en: "Project workspace (metadata only)" }[language]}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 }}>
                {{
                  ru: "Чтобы включить AIB_TOOL workspace.list, выберите именно /storage/emulated/0/AIBuilderTermux в системном выборе папки. Разрешение read-only: только имена, тип, размер и дата прямых элементов; файлы не читаются и не копируются. Чтение и запись содержимого выполняются не через SAF, а отдельными workspace.read/workspace.write при all-files доступе и доступном нативном procfd API. Другие корни отвергаются.",
                  uk: "Щоб увімкнути AIB_TOOL workspace.list, виберіть саме /storage/emulated/0/AIBuilderTermux у системному виборі папки. Дозвіл read-only: лише назви, тип, розмір і дата прямих елементів; файли не читаються й не копіюються. Читання й запис вмісту виконуються не через SAF, а окремими workspace.read/workspace.write за all-files доступу та доступного нативного procfd API. Інші корені відхиляються.",
                  en: "To enable AIB_TOOL workspace.list, choose exactly /storage/emulated/0/AIBuilderTermux in Android's folder picker. Read-only grant: names, type, size, and date for direct children only; no file contents or copies. Content read/write uses separate workspace.read/workspace.write operations, not SAF, after all-files access and an available native procfd API. Other roots are rejected.",
                }[language]}
              </Text>
              <Text style={{ color: aiBuilderWorkspaceGrant?.granted ? colors.inkBright : colors.muted, fontSize: 11, marginTop: 6 }}>
                {aiBuilderWorkspaceGrant === null
                  ? ({ ru: "Проверка разрешения…", uk: "Перевірка дозволу…", en: "Checking saved permission…" }[language])
                  : aiBuilderWorkspaceGrant.granted
                    ? ({ ru: "Точное дерево AIBuilderTermux: read-only разрешение активно.", uk: "Точне дерево AIBuilderTermux: read-only дозвіл активний.", en: "Exact AIBuilderTermux tree: read-only permission active." }[language])
                    : `${language === "ru" ? "Нет разрешения" : language === "uk" ? "Немає дозволу" : "No grant"}${aiBuilderWorkspaceGrant.reason ? ` · ${aiBuilderWorkspaceGrant.reason}` : ""}`}
              </Text>
              {aiBuilderWorkspaceGrantFeedback ? <Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }}>{aiBuilderWorkspaceGrantFeedback}</Text> : null}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <TouchableOpacity
                  onPress={() => void onRequestAIBuilderWorkspaceGrant()}
                  disabled={aiBuilderWorkspaceGrantBusy || agentShellExecutionTarget !== "embedded-private" || aiBuilderAllFilesAccess?.granted !== true}
                  style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 9, paddingHorizontal: 8, borderRadius: 9, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceRaised, opacity: aiBuilderWorkspaceGrantBusy || agentShellExecutionTarget !== "embedded-private" || aiBuilderAllFilesAccess?.granted !== true ? 0.5 : 1 }}
                >
                  <Text style={{ color: colors.inkBright, fontSize: 11, fontWeight: "700", textAlign: "center" }}>
                    {{ ru: "Выбрать AIBuilderTermux", uk: "Вибрати AIBuilderTermux", en: "Choose AIBuilderTermux" }[language]}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
          <TouchableOpacity
            onPress={() => void onCheckSelectedEnvironment()}
            disabled={linuxBusy}
            style={[
              styles.action,
              {
                // Never let flex:1 stretch this button vertically when alone or after
                // Ubuntu/Debian → Termux switch (settingsPath toggles sibling).
                flex: runtimeProjection.settingsPath ? 1 : 0,
                flexGrow: runtimeProjection.settingsPath ? 1 : 0,
                flexShrink: 0,
                alignSelf: "stretch",
                width: runtimeProjection.settingsPath ? undefined : "100%",
                minHeight: 44,
                maxHeight: 52,
                height: 48,
                justifyContent: "center",
                backgroundColor: DARK_SLATE_GRAY,
                opacity: linuxBusy ? 0.55 : 1,
              },
            ]}
          >
            <Text style={styles.actionText} numberOfLines={1}>
              {linuxBusy
                ? ({ ru: "Проверка…", uk: "Перевірка…", en: "Working…" } as const)[language]
                : environmentBackend === "termux"
                  ? ({ ru: "Проверить Termux", uk: "Перевірити Termux", en: "Check Termux" } as const)[language]
                  : environmentBackend === "ubuntu-proot"
                    ? ({ ru: "Проверить Ubuntu", uk: "Перевірити Ubuntu", en: "Check Ubuntu" } as const)[language]
                    : ({ ru: "Проверить Debian", uk: "Перевірити Debian", en: "Check Debian" } as const)[language]}
            </Text>
          </TouchableOpacity>
          {runtimeProjection.settingsPath ? (
            <TouchableOpacity
              onPress={() => router.push(runtimeProjection.settingsPath as any)}
              style={[
                styles.action,
                {
                  flex: 1,
                  flexGrow: 1,
                  flexShrink: 0,
                  alignSelf: "stretch",
                  minHeight: 44,
                  maxHeight: 52,
                  height: 48,
                  justifyContent: "center",
                  backgroundColor: colors.surfaceRaised ?? colors.surface,
                  borderWidth: 1,
                  borderColor: colors.line,
                },
              ]}
            >
              <Text style={[styles.actionText, { color: colors.inkBright }]} numberOfLines={1}>
                {{ ru: "Настройки Termux", uk: "Налаштування Termux", en: "Termux settings" }[language]}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {canPrepareSelected ? (
          <TouchableOpacity
            onPress={() => void onInstallSelectedEnvironment()}
            disabled={linuxBusy}
            style={[styles.actionFull, { marginTop: 8, backgroundColor: DARK_SLATE_GRAY, opacity: linuxBusy ? 0.55 : 1 }]}
          >
            <Text style={styles.actionText}>
              {linuxBusy
                ? ({ ru: "Проверка и подготовка…", uk: "Перевірка й підготовка…", en: "Checking and preparing…" } as const)[language]
                : environmentBackend === "ubuntu-proot"
                  ? selectedReadiness?.status === "missing" && selectedReadiness.rootfs === "missing"
                    ? ({ ru: "Установить Ubuntu", uk: "Встановити Ubuntu", en: "Install Ubuntu" } as const)[language]
                    : ({ ru: "Подготовить Ubuntu", uk: "Підготувати Ubuntu", en: "Prepare Ubuntu" } as const)[language]
                  : selectedReadiness?.status === "missing" && selectedReadiness.rootfs === "missing"
                    ? ({ ru: "Установить Debian", uk: "Встановити Debian", en: "Install Debian" } as const)[language]
                    : ({ ru: "Подготовить Debian", uk: "Підготувати Debian", en: "Prepare Debian" } as const)[language]}
            </Text>
          </TouchableOpacity>
        ) : null}

        {selectedReadiness?.rootfs === "unknown" ? (
          <Text style={[styles.helpText, { marginTop: 10, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.line }]}>
            {language === "ru"
              ? "Состояние rootfs пока неизвестно. Проверьте диагностику встроенного runtime и повторите проверку; внешнее приложение Termux не используется. Подготовка остаётся заблокирована, пока состояние неизвестно."
              : language === "uk"
                ? "Стан rootfs поки невідомий. Перевірте діагностику вбудованого runtime й повторіть перевірку; зовнішній застосунок Termux не використовується. Підготовка залишається заблокованою, доки стан невідомий."
                : "The rootfs state is unknown. Check embedded runtime diagnostics and retry; no external Termux app is used. Preparation remains blocked while the state is unknown."}
          </Text>
        ) : null}

        {runtimePreparationRunning ? (
          <TouchableOpacity
            onPress={cancelRuntimePreparation}
            style={[styles.actionFull, { marginTop: 8, backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line }]}
          >
            <Text style={[styles.actionText, { color: colors.inkBright }]}>
              {{ ru: "Остановить после текущей команды", uk: "Зупинити після поточної команди", en: "Stop after current command" }[language]}
            </Text>
          </TouchableOpacity>
        ) : null}

      </View>

      {/* ===== SIMPLE: environment at a glance ===== */}
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.cardTitle, { color: colors.inkBright }]}>
          {{ ru: "Что работает", uk: "Що працює", en: "Status" }[language]}
        </Text>
        <Text style={[styles.helpText, { marginBottom: 10 }]}> 
          {{
            ru: "Зелёный — проверка пройдена; красный — подтверждённый сбой; серый — статус неизвестен, это не означает отсутствие.",
            uk: "Зелений — перевірку пройдено; червоний — підтверджений збій; сірий — статус невідомий, це не означає відсутність.",
            en: "Green = verified; red = a confirmed failure; grey = unknown, not absent.",
          }[language]}
        </Text>

        {(() => {
          const row = (label: string, ok: boolean | null, hint: string) => (
            <View
              key={label}
              style={{
                flexDirection: "row",
                alignItems: "center",
                marginBottom: 10,
                gap: 10,
              }}
            >
              <View
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor:
                    ok === null ? colors.muted : ok ? (colors.success || colors.accent) : (colors.danger || "#f66"),
                }}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.inkBright, fontSize: 15, fontWeight: "600" }}>{label}</Text>
                <Text style={{ color: colors.muted, fontSize: 12 }}>{hint}</Text>
              </View>
              <Text
                style={{
                  color: ok === null ? colors.muted : ok ? (colors.success || colors.accent) : (colors.danger || "#f66"),
                  fontWeight: "700",
                  fontSize: 12,
                }}
              >
                {ok === null ? "…" : ok ? "OK" : "—"}
              </Text>
            </View>
          );
          return (
            <View>
              {runtimeProjection.statusRows.map((item) => row(
                item.label,
                item.ready,
                item.id === "termux"
                  ? { ru: "Встроенная приватная среда", uk: "Вбудоване приватне середовище", en: "Embedded private environment" }[language]
                  : item.id === "ubuntu-rootfs"
                    ? { ru: "Выбранная Ubuntu: host, rootfs/login и базовые инструменты", uk: "Вибрана Ubuntu: host, rootfs/login і базові інструменти", en: "Selected Ubuntu: host, rootfs/login and baseline tools" }[language]
                    : { ru: "Выбранный Debian: host, rootfs/login и базовые инструменты", uk: "Вибраний Debian: host, rootfs/login і базові інструменти", en: "Selected Debian: host, rootfs/login and baseline tools" }[language],
              ))}
            </View>
          );
        })()}

        {(linuxBusy && !runtimePreparationRunning && runtimeCheckProgress) ? (
          <View style={{ marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceRaised }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ActivityIndicator size="small" color={DARK_SLATE_GRAY} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.inkBright, fontWeight: "800", fontSize: 14 }}>
                  {language === "ru" ? "Идёт проверка среды — не зависло" : language === "uk" ? "Йде перевірка середовища — не зависло" : "Environment check in progress — not frozen"}
                </Text>
                <Text style={{ color: colors.muted, marginTop: 2, fontSize: 12 }}>
                  {(language === "ru" ? "Прошло" : language === "uk" ? "Минуло" : "Elapsed") + `: ${runtimeActivityElapsedSec} ${language === "en" ? "s" : "с"} · `}
                  {environmentBackend === "termux" ? "Termux" : environmentBackend === "ubuntu-proot" ? "Ubuntu" : "Termux"}
                </Text>
              </View>
            </View>
            <Text style={{ color: colors.inkBright, fontWeight: "700", marginTop: 10 }}>
              {rt("checkPhaseLabel")}: {runtimeStageLabel(language, runtimeCheckProgress.phase)}
            </Text>
            <Text style={{ color: colors.muted, marginTop: 4, fontSize: 13 }}>
              {environmentBackend === "ubuntu-proot"
                ? runtimeProgressText(language, runtimeCheckProgress.phase, environmentBackend)
                : (runtimeCheckProgress.detail || (language === "ru" ? "Проверка встроенной среды…" : "Checking embedded runtime…"))}
            </Text>
            <View style={{ marginTop: 10, gap: 6 }}>
              {runtimeCheckStepIds(environmentBackend).map((stepId) => {
                const st = runtimeStepStatus(stepId, runtimeCheckProgress.phase, false);
                const label = runtimeStageLabel(language, stepId);
                const mark = st === "done" ? "✓" : st === "active" ? "●" : "○";
                const color = st === "done" ? "#2e7d32" : st === "active" ? DARK_SLATE_GRAY : colors.muted;
                return (
                  <Text key={stepId} style={{ color, fontSize: 13, fontWeight: st === "active" ? "700" : "500" }}>
                    {mark} {label}
                  </Text>
                );
              })}
            </View>
            {runtimeCheckProgress.activeCommand ? (
              <Text style={{ color: colors.muted, marginTop: 8, fontSize: 11 }} numberOfLines={2}>
                {rt("activeCommandLabel")}: {runtimeCheckProgress.activeCommand}
              </Text>
            ) : null}
          </View>
        ) : null}

        {runtimePreparationRunning && runtimeProjection.prepareAlias ? (
          <View style={{ marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceRaised }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ActivityIndicator size="small" color={DARK_SLATE_GRAY} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.inkBright, fontWeight: "800", fontSize: 14 }}>
                  {language === "ru" ? "Идёт установка/подготовка — не зависло" : language === "uk" ? "Йде встановлення/підготовка — не зависло" : "Install/prepare in progress — not frozen"}
                </Text>
                <Text style={{ color: colors.muted, marginTop: 2, fontSize: 12 }}>
                  {(language === "ru" ? "Прошло" : language === "uk" ? "Минуло" : "Elapsed") + `: ${runtimeActivityElapsedSec} ${language === "en" ? "s" : "с"} · `}
                  {runtimeProjection.prepareAlias === "ubuntu" ? "Ubuntu" : "Debian"}
                </Text>
              </View>
            </View>
            <Text style={{ color: colors.inkBright, fontWeight: "700", marginTop: 10 }}>
              {rt("preparationPhaseLabel")}: {runtimeStageLabel(language, runtimePreparationUiProgress?.phase || "preflight")}
            </Text>
            <Text style={{ color: colors.muted, marginTop: 4, fontSize: 13 }}>
              {runtimeProgressText(language, runtimePreparationUiProgress?.phase || "preflight", runtimeProjection.prepareAlias === "ubuntu" ? "ubuntu-proot" : "ubuntu-proot")}
            </Text>
            {runtimePreparationUiProgress?.activeCommand ? (
              <Text style={{ color: colors.muted, marginTop: 8, fontSize: 11 }} numberOfLines={3}>
                {rt("activeCommandLabel")}: {runtimePreparationUiProgress.activeCommand}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      <TouchableOpacity
        onPress={() => setShowAdvanced((v) => !v)}
        accessibilityState={{ expanded: showAdvanced }}
        style={[
          styles.card,
          {
            ...expandedHeaderStyle(showAdvanced, colors),
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 14,
          },
        ]}
      >
        <Text style={{ color: expandedTitleColor(showAdvanced, colors.inkBright), fontWeight: "600", fontSize: 15 }}>
          {{ ru: "Дополнительно", uk: "Додатково", en: "Advanced" }[language]}
        </Text>
        <Ionicons name={showAdvanced ? "chevron-up" : "chevron-down"} size={20} color={expandedIconColors(showAdvanced, colors).chevron} />
      </TouchableOpacity>

      {showAdvanced ? (
      <>

      {environmentBackend === "termux" && fgTasks.length > 0 ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.cardHeader}>
            <Ionicons name="pulse" size={20} color={colors.accent} />
            <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>
              {{ ru: "Фоновые задачи", uk: "Фонові задачі", en: "Background tasks" }[language]}
            </Text>
          </View>
          <Text style={styles.helpText}>
            {{
              ru: "Долгие операции (bootstrap, сборка, backup). Держите приложение открытым или с разрешением работы в фоне.",
              uk: "Тривалі операції. Тримайте застосунок відкритим або з дозволом фону.",
              en: "Long operations (bootstrap, build, backup). Keep the app open or allow background work.",
            }[language]}
          </Text>
          {fgTasks.map((task) => (
            <View key={task.id} style={{ marginBottom: 8 }}>
              <Text style={{ color: colors.inkBright, fontSize: 13, fontWeight: "600" }}>
                [{task.kind}] {task.title}
              </Text>
              <ProgressBar
                progress={Math.round((task.progress ?? 0) * 100)}
                sublabel={new Date(task.startedAt).toLocaleTimeString()}
              />
            </View>
          ))}
        </View>
      ) : null}

      {environmentBackend === "termux" && status ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.cardHeader}>
            <Ionicons name="pulse-outline" size={20} color={colors.accent} />
            <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>{rt("supervisor")}</Text>
          </View>
          <Text style={styles.helpText}>{rt("supervisorHelp")}</Text>
          <Row label={rt("runtimeLabel")} value={status.runtimeIdentity.runtimeVersion} colors={colors} />
          <Row label={rt("rootfs")} value={status.runtimeIdentity.rootfsVersion} colors={colors} />
          <Row label={rt("schema")} value={String(status.runtimeIdentity.schemaVersion)} colors={colors} />
          <Row label={rt("watchdog")} value={`${status.supervisor.status} · ${status.supervisor.watched} ${rt("watched")}`} colors={colors} />
          <Text style={styles.helpText}>{rt("watchdogHelp")}</Text>
          {(status.processList || []).filter((p) => p.watchdog).slice(0, 8).map((p) => (
            <Text key={p.id} style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>
              · [{p.kind}] {p.label || p.id}
            </Text>
          ))}
          <View style={{ gap: 10, marginTop: 4 }}>
            <View style={styles.rowBtns}>
            <TouchableOpacity onPress={() => { getRuntimeFacade().startSupervisor(); void refresh(); }} style={[styles.action, styles.actionInRow, { backgroundColor: DARK_SLATE_GRAY }]}>
              <Text style={styles.actionText}>{rt("startWatchdog")}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { getRuntimeFacade().stopSupervisor(); void refresh(); }} style={[styles.action, styles.actionInRow, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line }]}>
              <Text style={[styles.actionText, { color: colors.inkBright }]}>{rt("stopWatchdog")}</Text>
            </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => { getRuntimeFacade().clearSupervisorQuarantine(); void refresh(); }} style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line }]}>
              <Text style={[styles.actionText, { color: colors.inkBright }]}>
                {{ ru: "Сброс карантина", uk: "Скинути карантин", en: "Clear quarantine" }[language]}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}


      

      {/* Linux setup is available only through the confirmed-missing Install action above. */}

      {environmentBackend !== "termux" && selectedReadiness?.status === "ready" ? (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.helpText, { marginTop: 14, marginBottom: 2, fontWeight: "700", color: colors.inkBright }]}> 
          {environmentBackend === "ubuntu-proot"
            ? ({ ru: "Экспорт / импорт Ubuntu", uk: "Експорт / імпорт Ubuntu", en: "Export / import Ubuntu" }[language])
            : ({ ru: "Экспорт / импорт Debian", uk: "Експорт / імпорт Debian", en: "Export / import Debian" }[language])}
        </Text>
        <Text style={{ color: colors.muted, fontSize: 11, marginBottom: 6 }}>
          {{
            ru: "Сохранение и восстановление полного rootfs через .tar.gz — удобно для переноса или резервной копии.",
            uk: "Збереження та відновлення повного rootfs через .tar.gz.",
            en: "Save and restore the full rootfs as .tar.gz for transfer or backup.",
          }[language]}
        </Text>
        <TextInput
          value={environmentBackend === "ubuntu-proot" ? ubuntuExportPath : debianExportPath}
          onChangeText={environmentBackend === "ubuntu-proot" ? setUbuntuExportPath : setDebianExportPath}
          placeholder={
            status?.home
              ? (environmentBackend === "ubuntu-proot" ? defaultUbuntuExportPath(status.home) : `${status.home}/exports/debian.tar.gz`)
              : (environmentBackend === "ubuntu-proot" ? "/storage/emulated/0/AIBuilderTermux/exports/ubuntu.tar.gz" : "/storage/emulated/0/AIBuilderTermux/exports/debian.tar.gz")
          }
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]}
          autoCapitalize="none"
        />
        <TouchableOpacity
          onPress={() => void (onUbuntuExport())}
          disabled={linuxBusy}
          style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line }]}
        >
          <Text style={[styles.actionText, { color: colors.inkBright }]}>
            {environmentBackend === "ubuntu-proot"
              ? ({ ru: "Экспорт Ubuntu", uk: "Експорт Ubuntu", en: "Export Ubuntu" }[language])
              : ({ ru: "Экспорт Ubuntu", uk: "Експорт Ubuntu", en: "Export Ubuntu" }[language])}
          </Text>
        </TouchableOpacity>
        <TextInput
          value={ubuntuImportPath}
          onChangeText={setUbuntuImportPath}
          placeholder={{ ru: "Путь к .tar.gz для импорта", uk: "Шлях до .tar.gz", en: "Path to .tar.gz to import" }[language]}
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.inkBright, borderColor: colors.line, marginTop: 8 }]}
          autoCapitalize="none"
        />
        <TouchableOpacity
          onPress={() => void (onUbuntuImport())}
          disabled={linuxBusy || !(environmentBackend === "ubuntu-proot" ? ubuntuImportPath.trim() : ubuntuImportPath.trim())}
          style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: (environmentBackend === "ubuntu-proot" ? !ubuntuImportPath.trim() : !ubuntuImportPath.trim()) ? 0.45 : 1 }]}
        >
          <Text style={styles.actionText}>
            {environmentBackend === "ubuntu-proot"
              ? ({ ru: "Импорт Ubuntu", uk: "Імпорт Ubuntu", en: "Import Ubuntu" }[language])
              : ({ ru: "Импорт Ubuntu", uk: "Імпорт Ubuntu", en: "Import Ubuntu" }[language])}
          </Text>
        </TouchableOpacity>
      </View>
      ) : null}

      {environmentBackend === "ubuntu-proot" && selectedReadiness?.status === "ready" ? (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}> 
        <View style={styles.cardHeader}>
          <Ionicons name="cube-outline" size={20} color={colors.accent} />
          <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>{rt("containerManager")}</Text>
        </View>
        <Text style={styles.helpText}>{rt("containerHelp")}</Text>
        <Row label={rt("container")} value={containerId ?? rt("none")} colors={colors} />
        <Text style={{ color: colors.muted, fontSize: 11 }}>{rt("ubuntuUserspace")}</Text>
        <TouchableOpacity onPress={() => void onContainerCreate()} disabled={containerBusy} style={[styles.actionFull, { backgroundColor: DARK_SLATE_GRAY }]}>
          <View style={styles.actionInner}>
            <Ionicons name="play-circle-outline" size={20} color="#fff" />
            <View style={styles.actionTextCol}>
              <Text style={styles.actionText}>{containerBusy ? rt("working") : rt("createStartUbuntu")}</Text>
              <Text style={styles.actionHint}>
                {{ ru: "Поднять proot-Ubuntu и привязать к проекту", uk: "Підняти proot-Ubuntu і прив'язати до проєкту", en: "Start proot-Ubuntu and bind to the project" }[language]}
              </Text>
            </View>
          </View>
        </TouchableOpacity>

        <Text style={[styles.helpText, { marginTop: 4, marginBottom: 2 }]}>
          {{ ru: "Цепочка внутри контейнера (нужен запущенный Ubuntu):", uk: "Ланцюжок у контейнері (потрібен запущений Ubuntu):", en: "In-container pipeline (Debian must be running):" }[language]}
        </Text>

        <TouchableOpacity onPress={() => void onWorkspaceBuild()} disabled={!containerId || workspaceBuildBusy || !privateBuildQualificationConfirmed} style={[styles.actionFull, { backgroundColor: DARK_SLATE_GRAY, opacity: !containerId || !privateBuildQualificationConfirmed ? 0.45 : 1 }]}>
          <View style={styles.actionInner}>
            <Ionicons name="construct-outline" size={20} color="#fff" />
            <View style={styles.actionTextCol}>
              <Text style={styles.actionText}>{workspaceBuildBusy ? rt("buildingWorkspace") : rt("installCheckWorkspace")}</Text>
              <Text style={styles.actionHint}>
                {privateBuildQualificationConfirmed ? ({ ru: "Пакеты, toolchain и проверка /workspace", uk: "Пакети, toolchain і перевірка /workspace", en: "Packages, toolchain and /workspace check" }[language]) : ({ ru: "Недоступно: приватный feed и toolchain ещё не подтверждены", uk: "Недоступно: приватний feed і toolchain ще не підтверджені", en: "Unavailable: private feed and toolchain are not yet qualified" }[language])}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        {!!workspaceBuildOutput && <Text selectable style={{ color: colors.muted, fontSize: 11 }}>{workspaceBuildOutput.slice(-2500)}</Text>}

        <TouchableOpacity onPress={() => void onProjectGenerate()} disabled={!containerId || projectGenerateBusy || !privateBuildQualificationConfirmed} style={[styles.actionFull, { backgroundColor: DARK_SLATE_GRAY, opacity: !containerId || !privateBuildQualificationConfirmed ? 0.45 : 1 }]}>
          <View style={styles.actionInner}>
            <Ionicons name="code-slash-outline" size={20} color="#fff" />
            <View style={styles.actionTextCol}>
              <Text style={styles.actionText}>{projectGenerateBusy ? rt("generatingProject") : rt("generateBuildTest")}</Text>
              <Text style={styles.actionHint}>
                {privateBuildQualificationConfirmed ? ({ ru: "Сгенерировать код, собрать и прогнать тест", uk: "Згенерувати код, зібрати й прогнати тест", en: "Generate code, build and run a test" }[language]) : ({ ru: "Недоступно до подтверждения private feed/toolchain", uk: "Недоступно до підтвердження private feed/toolchain", en: "Unavailable until the private feed/toolchain is qualified" }[language])}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        {!!projectGenerateOutput && <Text selectable style={{ color: colors.muted, fontSize: 10 }}>{projectGenerateOutput.slice(-3500)}</Text>}

        <TouchableOpacity onPress={() => void onCodingAgent()} disabled={!containerId || codingAgentBusy || !privateBuildQualificationConfirmed} style={[styles.actionFull, { backgroundColor: DARK_SLATE_GRAY, opacity: !containerId || !privateBuildQualificationConfirmed ? 0.45 : 1 }]}>
          <View style={styles.actionInner}>
            <Ionicons name="sparkles-outline" size={20} color="#fff" />
            <View style={styles.actionTextCol}>
              <Text style={styles.actionText}>{codingAgentBusy ? rt("codingAgent") : rt("codeBuildTestRepair")}</Text>
              <Text style={styles.actionHint}>
                {privateBuildQualificationConfirmed ? ({ ru: "ИИ-агент: правка → сборка → тест → автопочинка", uk: "ШІ-агент: правки → збірка → тест → автопочинка", en: "AI agent: edit → build → test → self-repair" }[language]) : ({ ru: "Сборка отключена до проверки feed и toolchain", uk: "Збирання вимкнено до перевірки feed і toolchain", en: "Build disabled pending feed and toolchain verification" }[language])}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        {!!codingAgentOutput && <Text selectable style={{ color: colors.muted, fontSize: 10 }}>{codingAgentOutput.slice(-4000)}</Text>}

        <View style={styles.rowBtns}>
          <TouchableOpacity onPress={() => void onContainerStop()} disabled={!containerId || containerBusy} style={[styles.miniBtn, { borderColor: colors.line, flex: 1, opacity: !containerId ? 0.45 : 1, alignItems: "center" }]}>
            <Ionicons name="stop-outline" size={16} color={colors.inkBright} />
            <Text style={{ color: colors.inkBright, fontSize: 12, marginTop: 2 }}>{rt("stop")}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => void onContainerRemove()} disabled={!containerId || containerBusy} style={[styles.miniBtn, { borderColor: colors.line, flex: 1, opacity: !containerId ? 0.45 : 1, alignItems: "center" }]}>
            <Ionicons name="trash-outline" size={16} color={colors.inkBright} />
            <Text style={{ color: colors.inkBright, fontSize: 12, marginTop: 2 }}>{rt("remove")}</Text>
          </TouchableOpacity>
        </View>
        {containerOutput ? <Text selectable style={{ color: colors.muted, fontSize: 10 }}>{containerOutput}</Text> : null}
      </View>
      ) : null}

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}> 
        <View style={styles.cardHeader}>
          <Ionicons name="phone-portrait-outline" size={20} color={colors.accent} />
          <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>{rt("deviceBridge")}</Text>
        </View>
        <Text style={styles.helpText}>
          {{
            ru: "ADB к этому или другому устройству: установка APK, logcat, автотесты. Инструменты ADB в приватной среде не поставляются; эта функция требует готового toolchain.",
            uk: "ADB до пристрою: APK, logcat, автотести. Інструменти ADB у приватному середовищі не постачаються; функція потребує готового toolchain.",
            en: "ADB to this or another device: APK install, logcat, tests. ADB tools are not currently supplied in the private runtime; this feature requires a qualified toolchain.",
          }[language]}
        </Text>
        <Row label={rt("status")} value={deviceAvailable == null ? rt("notChecked") : deviceAvailable ? rt("connected") : rt("unavailable")} colors={colors} />
        <Text style={styles.helpText}>{adbWizardHelp(language)}</Text>
        <Text style={styles.helpText}>Accessibility service: permission is granted only after you manually enable AI Builder in Android Accessibility settings. Device bridge actions are not active automatically.</Text>
        <Text style={styles.helpText}>Loopback read-only endpoints expose only device model/Android version or battery percentage/charging/low-power state. Each category requires a separate session-only grant; no arbitrary device files or other sensors are exposed.</Text>
        <TouchableOpacity onPress={() => { getRuntimeFacade().grantDeviceCapabilityByUser("device.metadata.read"); setDeviceOutput("Read-only device model and Android-version metadata grant enabled for this app session."); }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Grant read-only model/Android-version metadata</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { await getRuntimeFacade().revokeDeviceCapabilityByUser("device.metadata.read"); setDeviceOutput("Device metadata grant revoked."); }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Revoke device metadata grant</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => { getRuntimeFacade().grantDeviceCapabilityByUser("device.sensors.read"); setDeviceOutput("Read-only battery/charging/low-power sensor grant enabled for this app session."); }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Grant read-only battery sensor</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { await getRuntimeFacade().revokeDeviceCapabilityByUser("device.sensors.read"); setDeviceOutput("Battery sensor grant revoked."); }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Revoke battery sensor grant</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { const f = getRuntimeFacade(); f.grantDeviceCapabilityByUser("device.accessibility"); try { await f.openAccessibilitySettingsByUser(); } catch (e) { setDeviceOutput(e instanceof Error ? e.message : String(e)); } }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Grant app accessibility capability & open Android settings</Text></TouchableOpacity>
        <Text style={styles.helpText}>Accessibility status: {accessibilityStatusText}</Text>
        <TouchableOpacity onPress={async () => { try { const s = await getRuntimeFacade().accessibility.status(); setAccessibilityStatusText(`${s.state}${s.reason ? ` — ${s.reason}` : ""}`); } catch (e) { setAccessibilityStatusText(e instanceof Error ? e.message : String(e)); } }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Check accessibility permission/service status</Text></TouchableOpacity>
        <Text style={styles.helpText}>Android 11+ only: after the Accessibility Service is enabled and this app capability is explicitly granted, AI Builder can enumerate currently visible public secondary displays, inspect only windows the service can access on that display, capture that exact display, and tap within its latest captured frame. Private displays, arbitrary app launch, display creation, and fallback to the primary display are unsupported.</Text>
        <TouchableOpacity onPress={async () => { try { const f = getRuntimeFacade(); f.grantDeviceCapabilityByUser("device.virtualdisplay"); const s = await f.virtualDisplay.status(); setVirtualDisplayStatusText(`${s.state}${s.reason ? ` — ${s.reason}` : ""}`); } catch (e) { setVirtualDisplayStatusText(e instanceof Error ? e.message : String(e)); } }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Grant separate screen-capture capability and check status</Text></TouchableOpacity>
        <Text style={styles.helpText}>Screen capture status: {virtualDisplayStatusText}</Text>
        <TouchableOpacity onPress={async () => { try { const r = await getRuntimeFacade().virtualDisplay.capture(); setVirtualDisplayStatusText(r.frameId ? `Captured ${r.width}×${r.height}; frame ${r.frameId}.` : `${r.status.state}${r.status.reason ? ` — ${r.status.reason}` : ""}`); } catch (e) { setVirtualDisplayStatusText(e instanceof Error ? e.message : String(e)); } }} disabled={deviceBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Capture current screen once</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { try { const f = getRuntimeFacade(); f.grantDeviceCapabilityByUser("device.virtualdisplay"); const r = await f.virtualDisplay.listDisplays(); setSecondaryDisplays(r.displays); setSecondaryFrame(null); setVirtualDisplayStatusText(`${r.status.state}${r.status.reason ? ` — ${r.status.reason}` : ""}; ${r.displays.length} public secondary display(s).`); } catch (e) { setVirtualDisplayStatusText(e instanceof Error ? e.message : String(e)); } }} disabled={deviceBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Discover live public secondary displays</Text></TouchableOpacity>
        {secondaryDisplays.map((display) => <View key={display.displayId} style={{ borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 8 }}>
          <Text style={{ color: colors.inkBright, fontSize: 12 }}>{display.name} — display {display.displayId}, {display.width}×{display.height}</Text>
          <TouchableOpacity onPress={async () => { try { const r = await getRuntimeFacade().virtualDisplay.capture(display.displayId); if (r.frameId && r.data && r.displayId === display.displayId) { setSecondaryFrame({ displayId: display.displayId, frameId: r.frameId, width: r.width!, height: r.height!, data: r.data }); setSecondaryTreeStatus(""); setVirtualDisplayStatusText(`Captured exact public display ${display.displayId}: ${r.width}×${r.height}; tap is restricted to this frame.`); } else { setSecondaryFrame(null); setVirtualDisplayStatusText(`${r.status.state}${r.status.reason ? ` — ${r.status.reason}` : ""}`); } } catch (e) { setSecondaryFrame(null); setVirtualDisplayStatusText(e instanceof Error ? e.message : String(e)); } }} disabled={deviceBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Capture display {display.displayId}</Text></TouchableOpacity>
          <TouchableOpacity onPress={async () => { try { const nodes = await getRuntimeFacade().virtualDisplay.readDisplayTree(display.displayId); setSecondaryTreeStatus(`Display ${display.displayId}: ${nodes.length} accessible node(s) returned by Android; text is not copied to logs.`); } catch (e) { setSecondaryTreeStatus(e instanceof Error ? e.message : String(e)); } }} disabled={deviceBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Read accessible UI tree on display {display.displayId}</Text></TouchableOpacity>
        </View>)}
        {secondaryTreeStatus ? <Text style={styles.helpText}>{secondaryTreeStatus}</Text> : null}
        {secondaryFrame ? <View style={{ marginTop: 8 }}>
          <Text style={styles.helpText}>Frame {secondaryFrame.frameId} — display {secondaryFrame.displayId}, coordinates x=0…{secondaryFrame.width - 1}, y=0…{secondaryFrame.height - 1}</Text>
          <Image source={{ uri: `data:image/jpeg;base64,${secondaryFrame.data}` }} resizeMode="contain" style={{ width: "100%", height: 240, backgroundColor: "#101010" }} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput value={secondaryTapX} onChangeText={setSecondaryTapX} keyboardType="number-pad" placeholder="Frame x" placeholderTextColor={colors.muted} style={[styles.input, { flex: 1, color: colors.inkBright, borderColor: colors.line }]} />
            <TextInput value={secondaryTapY} onChangeText={setSecondaryTapY} keyboardType="number-pad" placeholder="Frame y" placeholderTextColor={colors.muted} style={[styles.input, { flex: 1, color: colors.inkBright, borderColor: colors.line }]} />
          </View>
          <TouchableOpacity onPress={async () => { try { const result = await getRuntimeFacade().virtualDisplay.input(secondaryFrame.frameId, Number(secondaryTapX), Number(secondaryTapY)); setVirtualDisplayStatusText(result.ok ? `Tap dispatched to display ${secondaryFrame.displayId} using the captured frame coordinates.` : "The platform did not accept the display tap."); } catch (e) { setVirtualDisplayStatusText(e instanceof Error ? e.message : String(e)); } }} disabled={deviceBusy || !secondaryTapX.trim() || !secondaryTapY.trim()} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Tap this frame coordinate</Text></TouchableOpacity>
        </View> : null}
        <TouchableOpacity onPress={async () => { try { await getRuntimeFacade().revokeDeviceCapabilityByUser("device.virtualdisplay"); setVirtualDisplayStatusText("Screen-capture capability revoked."); } catch (e) { setVirtualDisplayStatusText(e instanceof Error ? e.message : String(e)); } }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Revoke screen-capture capability</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { await getRuntimeFacade().revokeDeviceCapabilityByUser("device.accessibility"); setAccessibilityStatusText("App accessibility capability revoked."); }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Revoke accessibility capability and stop bridge</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => { const f = getRuntimeFacade(); f.grantDeviceCapabilityByUser("device.adb"); setDeviceOutput("ADB capability granted for this app session. Pair/connect actions remain explicit."); }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Grant separate ADB capability</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { try { const f = getRuntimeFacade(); const session = await f.startDeviceLoopbackByUser(); await Clipboard.setStringAsync(session.token); setDeviceOutput("Loopback bridge listening on 127.0.0.1; token copied only after this explicit start action."); } catch (e) { setDeviceOutput(e instanceof Error ? e.message : String(e)); } }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Grant and start loopback bridge (token copied once)</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { const f = getRuntimeFacade(); await f.stopDeviceLoopbackByUser(); setDeviceOutput("Loopback bridge stopped and listen grant revoked."); }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Stop loopback bridge and revoke listen grant</Text></TouchableOpacity>
        <TouchableOpacity onPress={async () => { await getRuntimeFacade().revokeDeviceCapabilityByUser("device.adb"); setDeviceOutput("ADB capability revoked."); }} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}><Text style={styles.actionText}>Revoke ADB capability</Text></TouchableOpacity>
        <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 4 }}>
          {{ ru: "1. Сопряжение (pair)", uk: "1. Спарювання", en: "1. Pair" }[language]}
        </Text>
        <TextInput
          value={adbPairHost}
          onChangeText={setAdbPairHost}
          placeholder="192.168.1.10:37000"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
        />
        <TextInput
          value={adbPairCode}
          onChangeText={setAdbPairCode}
          placeholder={{ ru: "6-значный код", uk: "6-значний код", en: "6-digit code" }[language]}
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]}
          keyboardType="number-pad"
          maxLength={6}
        />
        <TouchableOpacity
          onPress={() => void onAdbPair()}
          disabled={deviceBusy || !adbPairHost.trim() || adbPairCode.length < 6}
          style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line, opacity: adbPairCode.length < 6 ? 0.45 : 1 }]}
        >
          <Text style={[styles.actionText, { color: colors.inkBright }]}>
            {{ ru: "Pair (сопряжение)", uk: "Pair", en: "Pair" }[language]}
          </Text>
        </TouchableOpacity>
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 10, marginBottom: 4 }}>
          {{ ru: "2. Подключение (connect)", uk: "2. Підключення", en: "2. Connect" }[language]}
        </Text>
        <TextInput
          value={adbConnectHost}
          onChangeText={setAdbConnectHost}
          placeholder="192.168.1.10:5555"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
        />
        <View style={styles.rowBtns}>
          <TouchableOpacity
            onPress={() => void onAdbConnect()}
            disabled={deviceBusy || !adbConnectHost.trim()}
            style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: !adbConnectHost.trim() ? 0.45 : 1 }]}
          >
            <Text style={styles.actionText}>
              {{ ru: "Connect", uk: "Connect", en: "Connect" }[language]}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => void onConnectDevice()} disabled={deviceBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}>
            <Text style={styles.actionText}>{deviceBusy ? "…" : rt("connectAdb")}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => void onAdbReconnect()} disabled={deviceBusy || !adbConnectHost.trim()} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: !adbConnectHost.trim() ? 0.45 : 1 }]}>
          <Text style={styles.actionText}>
            {{ ru: "Reconnect сохранённое ADB-устройство", uk: "Reconnect збережений ADB-пристрій", en: "Reconnect saved ADB device" }[language]}
          </Text>
        </TouchableOpacity>
        {adbDevicesText ? (
          <Text selectable style={{ color: colors.muted, fontSize: 11, marginTop: 8 }}>{adbDevicesText}</Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity onPress={() => void onDeviceLogcat()} disabled={!deviceAvailable} style={[styles.miniBtn, { borderColor: colors.line, flex: 1 }]}>
            <Text style={{ color: colors.inkBright, fontSize: 12 }}>{rt("logcat")}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => void onStopDevice()} style={[styles.miniBtn, { borderColor: colors.line, flex: 1 }]}>
            <Text style={{ color: colors.inkBright, fontSize: 12 }}>{rt("stopSession")}</Text>
          </TouchableOpacity>
        </View>
        <TextInput value={deviceApkPath} onChangeText={setDeviceApkPath} placeholder={rt("apkPath")} placeholderTextColor={colors.muted} style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]} autoCapitalize="none" />
        <TextInput value={devicePackageName} onChangeText={setDevicePackageName} placeholder={rt("packagePath")} placeholderTextColor={colors.muted} style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]} autoCapitalize="none" />
        <TouchableOpacity onPress={() => void onRunDeviceLoop()} disabled={!deviceAvailable || deviceBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}>
          <Text style={styles.actionText}>{deviceBusy ? rt("runningDevice") : rt("installLaunchScreenshotLogcat")}</Text>
        </TouchableOpacity>
        <TextInput
          value={deviceGoal}
          onChangeText={setDeviceGoal}
          placeholder={rt("deviceTestGoal")}
          placeholderTextColor={colors.muted}
          style={[styles.input, styles.multilineInput, { color: colors.inkBright, borderColor: colors.line }]}
          multiline
        />
        <TouchableOpacity onPress={() => void onRunDeviceSuite()} disabled={!deviceAvailable || deviceSuiteBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceSuiteBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceSuiteBusy ? rt("runSuite") : rt("generateRunSuite")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onRunSelfHealingQA()} disabled={!deviceAvailable || deviceSelfHealBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceSelfHealBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceSelfHealBusy ? rt("selfHealingRunning") : rt("selfHealingQa")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onRunReleaseGate()} disabled={!deviceAvailable || deviceReleaseGateBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceReleaseGateBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceReleaseGateBusy ? rt("releaseGateRunning") : rt("releaseGate")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onRunReleaseArtifact()} disabled={!deviceAvailable || deviceReleaseArtifactBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceReleaseArtifactBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceReleaseArtifactBusy ? rt("releaseBundleRunning") : rt("releaseBundle")}</Text>
        </TouchableOpacity>
        <TextInput value={deviceReleaseChannel} onChangeText={setDeviceReleaseChannel} placeholder={rt("releaseChannel")} placeholderTextColor={colors.muted} style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]} autoCapitalize="none" />
        <TouchableOpacity onPress={() => void onPublishReleaseChannel()} disabled={!deviceAvailable || deviceReleaseChannelBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceReleaseChannelBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceReleaseChannelBusy ? rt("publishingChannel") : rt("publishChannel")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onRollbackReleaseChannel()} disabled={!deviceAvailable || deviceRollbackBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceRollbackBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceRollbackBusy ? rt("rollingBack") : rt("rollbackRelease")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onProductionDeploy()} disabled={!deviceAvailable || deviceDeployBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceDeployBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceDeployBusy ? rt("productionDeploying") : rt("productionDeploy")}</Text>
        </TouchableOpacity>
        <Text style={[styles.helpText, { marginTop: 10 }]}>
          {{
            ru: "Флот / релиз (продвинутое). Нужны ADB и несколько устройств или CI. Обычной сборке APK эти кнопки не обязательны: используйте проект выше и «Пакети»/Termux.",
            uk: "Флот / реліз (просунуте). Потрібні ADB і кілька пристроїв. Для звичайної збірки APK не обовʼязково.",
            en: "Fleet / release (advanced). Needs ADB and multiple devices or CI. Not required for a normal single-device APK build.",
          }[language]}
        </Text>
        <TouchableOpacity onPress={() => void onFleetDeploy()} disabled={!deviceAvailable || deviceDeployBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceDeployBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceDeployBusy ? rt("fleetDeploying") : rt("fleetRollout")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetCanary()} disabled={!deviceAvailable || deviceDeployBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceDeployBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceDeployBusy ? rt("fleetCanaryRunning") : rt("fleetCanary")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetObservability()} disabled={deviceDeployBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceDeployBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceDeployBusy ? rt("fleetObservabilityRunning") : rt("fleetObservability")}</Text>
        </TouchableOpacity>
        <TextInput value={fleetRole} onChangeText={setFleetRole} placeholder={rt("fleetRole")} placeholderTextColor={colors.muted} style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]} autoCapitalize="none" />
        <TextInput value={fleetConfirmation} onChangeText={setFleetConfirmation} placeholder={rt("productionPhrase")} placeholderTextColor={colors.muted} style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]} autoCapitalize="characters" />
        <TouchableOpacity onPress={() => void onFleetPolicy()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("fleetPolicy")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onSaveFleetPolicy()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("saveFleetPolicy")}</Text>
        </TouchableOpacity>
        <TextInput value={fleetBackupSecret} onChangeText={setFleetBackupSecret} placeholder={rt("backupSecret")} placeholderTextColor={colors.muted} secureTextEntry style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]} />
        <TouchableOpacity onPress={() => void onFleetBackupCreate()} disabled={fleetCommandBusy || !project || fleetBackupSecret.length < 12} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy || fleetBackupSecret.length < 12 ? 0.5 : 1 }]}>
          <Text style={styles.actionText}>{rt("fleetBackup")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetBackupVerify()} disabled={fleetCommandBusy || !project || !fleetBackups[0]} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy || !fleetBackups[0] ? 0.5 : 1 }]}>
          <Text style={styles.actionText}>{rt("verifyBackup")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetRecoverySchedule()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("recoverySlo")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetRecoveryScheduledRun()} disabled={fleetCommandBusy || !project || fleetBackupSecret.length < 12} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy || fleetBackupSecret.length < 12 ? 0.5 : 1 }]}>
          <Text style={styles.actionText}>{rt("scheduledRecovery")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetUnifiedControlCenter()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{fleetCommandBusy ? rt("unifiedControlRunning") : rt("unifiedFleet")}</Text>
        </TouchableOpacity>
        {fleetUnifiedControl ? (
          <View style={{ paddingVertical: 5 }}>
            <Text selectable style={{ color: fleetUnifiedControl.status === "incident" ? colors.danger : colors.muted, fontSize: 10 }}>Control Center: {fleetUnifiedControl.status.toUpperCase()} · {fleetUnifiedControl.channel}</Text>
            <Text selectable style={{ color: colors.muted, fontSize: 10 }}>Devices: {fleetUnifiedControl.summary.healthyDevices}/{fleetUnifiedControl.summary.devices} healthy · failed {fleetUnifiedControl.summary.failedDevices} · offline {fleetUnifiedControl.summary.offlineDevices}</Text>
            <Text selectable style={{ color: colors.muted, fontSize: 10 }}>Incidents: {fleetUnifiedControl.summary.openIncidents} · alerts {fleetUnifiedControl.summary.activeAlerts} · critical {fleetUnifiedControl.summary.criticalAlerts} · outbox {fleetUnifiedControl.summary.pendingNotifications}</Text>
          </View>
        ) : null}
        <TouchableOpacity onPress={() => void onFleetSloDashboard()} disabled={deviceDeployBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceDeployBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("fleetSlo")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetAlertEscalation()} disabled={deviceDeployBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceDeployBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceDeployBusy ? rt("fleetEscalationRunning") : rt("fleetEscalation")}</Text>
        </TouchableOpacity>
        {fleetEscalation ? (
          <View style={{ marginTop: 6, gap: 3 }}>
            <Text selectable style={{ color: colors.muted, fontSize: 10 }}>Escalation: active {fleetEscalation.escalatedCount} · acknowledged {fleetEscalation.acknowledgedCount} · resolved {fleetEscalation.resolvedCount} · outbox {fleetEscalation.pendingNotifications}</Text>
            {fleetEscalation.alerts.filter((x: any) => x.state !== "resolved").slice(0, 5).map((item: any) => (
              <View key={item.id} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Text selectable style={{ flex: 1, color: item.level === "critical" ? colors.danger : colors.muted, fontSize: 9 }}>{item.level.toUpperCase()} · {item.type} · {item.message}</Text>
                <TouchableOpacity onPress={() => void acknowledgeAIFleetEscalatedAlert({ channel: deviceReleaseChannel as any, alertId: item.id }).then(() => onFleetAlertEscalation())}>
                  <Text style={{ color: colors.accent, fontSize: 9 }}>{rt("ack")}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => void resolveAIFleetEscalatedAlert({ channel: deviceReleaseChannel as any, alertId: item.id }).then(() => onFleetAlertEscalation())}>
                  <Text style={{ color: colors.accent, fontSize: 9 }}>{rt("resolve")}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : null}
        {fleetSloDashboard ? (
          <View style={{ marginTop: 6, gap: 4 }}>
            <Text selectable style={{ color: fleetSloDashboard.overallStatus === "incident" ? colors.danger : colors.muted, fontSize: 10 }}>SLO Dashboard: {fleetSloDashboard.overallStatus.toUpperCase()} · failure {fleetSloDashboard.metrics.failureRate.toFixed(1)}% · incidents {fleetSloDashboard.metrics.incidentCount} · open {fleetSloDashboard.metrics.openIncidentCount}</Text>
            <Text selectable style={{ color: colors.muted, fontSize: 10 }}>Backup: {fleetSloDashboard.metrics.backupFresh ? "FRESH" : "STALE"} · Drill: {fleetSloDashboard.metrics.drillFresh ? "FRESH" : "STALE"} · consecutive failures: {fleetSloDashboard.metrics.consecutiveRecoveryFailures}</Text>
            {fleetSloDashboard.timeline.slice(0, 4).map((item: any, index: number) => (
              <TouchableOpacity key={`${item.at}-${index}`} onPress={() => void onFleetSloAcknowledge(item)} style={{ paddingVertical: 2 }}>
                <Text selectable style={{ color: item.severity === "critical" ? colors.danger : colors.muted, fontSize: 9 }}>{item.severity.toUpperCase()} · {item.type} · {item.message}{item.incidentId ? " · tap to acknowledge" : ""}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
        {fleetRecoverySchedule ? <Text selectable style={{ color: colors.muted, fontSize: 10 }}>Recovery: {fleetRecoverySchedule.enabled ? "ON" : "OFF"} · every {fleetRecoverySchedule.intervalMinutes}m · next {fleetRecoverySchedule.nextRunAt || "due now"}</Text> : null}
        {fleetRecoverySlo ? <Text selectable style={{ color: fleetRecoverySlo.status === "FAIL" ? colors.danger : colors.muted, fontSize: 10 }}>Recovery SLO: {fleetRecoverySlo.status} · alerts {fleetRecoverySlo.alerts?.length || 0}</Text> : null}
        <TouchableOpacity onPress={() => void onFleetBackupRestore()} disabled={fleetCommandBusy || !project || !fleetBackups[0]} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy || !fleetBackups[0] ? 0.5 : 1 }]}>
          <Text style={styles.actionText}>{rt("restoreBackup")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetRecoveryDrill()} disabled={fleetCommandBusy || !project || !fleetBackups[0] || fleetBackupSecret.length < 12} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy || !fleetBackups[0] || fleetBackupSecret.length < 12 ? 0.5 : 1 }]}>
          <Text style={styles.actionText}>{rt("disasterRecovery")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetAudit()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("audit")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetAuditSecurity()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("secureAudit")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetAuditExport()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("exportAudit")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetSnapshot()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("createSnapshot")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onFleetRecovery()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{rt("restoreSnapshot")}</Text>
        </TouchableOpacity>
        {fleetPolicy ? <Text selectable style={{ color: colors.muted, fontSize: 10 }}>Fleet Policy: {fleetPolicy.role} · Production confirmation: {fleetPolicy.requireProductionConfirmation ? "ON" : "OFF"}</Text> : null}
        <TouchableOpacity onPress={() => void onFleetCommandCenter()} disabled={fleetCommandBusy || !project} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: fleetCommandBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{fleetCommandBusy ? rt("fleetCommandRunning") : rt("fleetCommand")}</Text>
        </TouchableOpacity>
        {fleetSnapshot ? (
          <View style={{ marginTop: 8, gap: 6 }}>
            <Text style={{ color: colors.inkBright, fontWeight: "700", fontSize: 12 }}>
              {String(fleetSnapshot.channel).toUpperCase()} · {String(fleetSnapshot.observability.status).toUpperCase()} · failure {Number(fleetSnapshot.observability.failureRate || 0).toFixed(1)}%
            </Text>
            {fleetSnapshot.devices.map((d: any) => (
              <View key={d.serial} style={{ borderWidth: 1, borderColor: colors.line, padding: 7, borderRadius: 8 }}>
                <Text selectable style={{ color: colors.inkBright, fontSize: 11 }}>{d.serial} · {d.status} · {d.currentVersionName || "no release"}</Text>
                <View style={{ flexDirection: "row", gap: 6, marginTop: 5 }}>
                  <TouchableOpacity onPress={() => void onFleetDeviceCommand(d.serial, "deploy")} disabled={fleetCommandBusy || d.state !== "device"} style={[styles.action, { flex: 1, marginTop: 0, paddingVertical: 6, opacity: fleetCommandBusy || d.state !== "device" ? 0.5 : 1 }]}>
                    <Text style={styles.actionText}>{rt("deploy")}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => void onFleetDeviceCommand(d.serial, "rollback")} disabled={fleetCommandBusy || !d.previousReleaseId || d.state !== "device"} style={[styles.action, { flex: 1, marginTop: 0, paddingVertical: 6, opacity: fleetCommandBusy || !d.previousReleaseId || d.state !== "device" ? 0.5 : 1 }]}>
                    <Text style={styles.actionText}>{rt("rollback")}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            {fleetSnapshot.observability.incidents.slice(-3).map((incident: any) => (
              <Text key={incident.id} selectable style={{ color: colors.muted, fontSize: 10 }}>Incident {incident.id}: {incident.reason} · {incident.devices?.length || 0} devices</Text>
            ))}
          </View>
        ) : null}
        <TouchableOpacity onPress={() => void onRunAutonomousDeviceLoop()} disabled={!deviceAvailable || deviceLoopBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: deviceLoopBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{deviceLoopBusy ? rt("buildVisionFixRunning") : rt("buildVisionFix")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void onRunRealDeviceIntegration()} disabled={realDeviceBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: realDeviceBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{realDeviceBusy ? rt("realAndroidRunning") : rt("realAndroid")}</Text>
        </TouchableOpacity>
        {realDeviceOutput ? <Text selectable style={{ color: colors.muted, fontSize: 10, marginTop: 6 }}>{realDeviceOutput}</Text> : null}
        <View style={{ gap: 8, marginTop: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity onPress={() => void onPersistentWorkspace("status")} disabled={persistentWorkspaceBusy} style={[styles.iconActionBtn, { opacity: persistentWorkspaceBusy ? 0.6 : 1 }]}>
              <Ionicons name="pulse-outline" size={18} color="#FFFFFF" />
              <Text style={styles.actionText} numberOfLines={2}>{persistentWorkspaceBusy ? rt("workspaceRunning") : rt("workspaceStatus")}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void onPersistentWorkspace("checkpoint")} disabled={persistentWorkspaceBusy} style={[styles.iconActionBtn, { opacity: persistentWorkspaceBusy ? 0.6 : 1 }]}>
              <Ionicons name="bookmark-outline" size={18} color="#FFFFFF" />
              <Text style={styles.actionText} numberOfLines={2}>{rt("checkpoint")}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity onPress={() => void onPersistentWorkspace("snapshot")} disabled={persistentWorkspaceBusy} style={[styles.iconActionBtn, { opacity: persistentWorkspaceBusy ? 0.6 : 1 }]}>
              <Ionicons name="camera-outline" size={18} color="#FFFFFF" />
              <Text style={styles.actionText} numberOfLines={2}>{rt("snapshot")}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void onPersistentWorkspace("undo")} disabled={persistentWorkspaceBusy} style={[styles.iconActionBtn, { opacity: persistentWorkspaceBusy ? 0.6 : 1 }]}>
              <Ionicons name="arrow-undo-outline" size={18} color="#FFFFFF" />
              <Text style={styles.actionText} numberOfLines={2}>{rt("undoLast")}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TouchableOpacity onPress={() => void onProjectMemory("status")} disabled={projectMemoryBusy} style={[styles.iconActionBtn, { opacity: projectMemoryBusy ? 0.6 : 1 }]}>
              <Ionicons name="hardware-chip-outline" size={18} color="#FFFFFF" />
              <Text style={styles.actionText} numberOfLines={2}>{projectMemoryBusy ? rt("memoryRunning") : rt("aiMemory")}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void onProjectMemory("build")} disabled={projectMemoryBusy} style={[styles.iconActionBtn, { opacity: projectMemoryBusy ? 0.6 : 1 }]}>
              <Ionicons name="construct-outline" size={18} color="#FFFFFF" />
              <Text style={styles.actionText} numberOfLines={2}>{rt("recordBuild")}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 8 }}>
            <TouchableOpacity onPress={() => void onProjectMemory("test")} disabled={projectMemoryBusy} style={[styles.iconActionBtn, { opacity: projectMemoryBusy ? 0.6 : 1, maxWidth: "50%" }]}>
              <Ionicons name="flask-outline" size={18} color="#FFFFFF" />
              <Text style={styles.actionText} numberOfLines={2}>{rt("recordTest")}</Text>
            </TouchableOpacity>
          </View>
        </View>
        {projectMemoryOutput ? <Text selectable style={{ color: colors.muted, fontSize: 10, marginTop: 6 }}>{projectMemoryOutput}</Text> : null}

        <Text style={[styles.cardTitle, { color: colors.inkBright, marginTop: 12 }]}>{rt("factory")}</Text>
        <TextInput value={factoryName} onChangeText={setFactoryName} placeholder={rt("appProjectName")} placeholderTextColor={colors.muted} style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]} autoCapitalize="none" />
        <TextInput value={factoryPrompt} onChangeText={setFactoryPrompt} placeholder={rt("describeApp")} placeholderTextColor={colors.muted} style={[styles.input, styles.multilineInput, { color: colors.inkBright, borderColor: colors.line }]} multiline />
        <TouchableOpacity onPress={() => void onOneClickFactory()} disabled={factoryBusy} style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: factoryBusy ? 0.6 : 1 }]}>
          <Text style={styles.actionText}>{factoryBusy ? rt("factoryRunning") : rt("factoryRun")}</Text>
        </TouchableOpacity>
        {factoryOutput ? <Text selectable style={{ color: colors.muted, fontSize: 10, marginTop: 6 }}>{factoryOutput.slice(-7000)}</Text> : null}
        {deviceOutput ? <Text selectable style={{ color: colors.muted, fontSize: 11, marginTop: 6 }}>{deviceOutput}</Text> : null}
      </View>

      {project ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <View style={styles.cardHeader}>
          <Ionicons name="folder-open-outline" size={20} color={colors.accent} />
          <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>{rt("activeProject")}</Text>
        </View>
        <Text style={styles.helpText}>
          {{
            ru: "Привязка текущего проекта к Runtime (сессии, контейнер, backup paths).",
            uk: "Прив'язка поточного проєкту до Runtime.",
            en: "Bind the current project to Runtime (sessions, container, backup paths).",
          }[language]}
        </Text>
          <Row label={rt("id")} value={project.id} colors={colors} />
          <Row label={rt("name")} value={project.name} colors={colors} />
          <Row label={rt("path")} value={project.path} colors={colors} />
          <TouchableOpacity
            onPress={() => void onBindActive()}
            disabled={busy}
            style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, marginTop: 6 }]}
          >
            <Text style={styles.actionText}>
              {busy ? "…" : rt("bindActive")}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {environmentBackend === "termux" ? (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.cardTitle, { color: colors.inkBright }]}>
          {t("runtimeStatus")}
        </Text>
        {status ? (
          <>
            <Row label="HOME" value={status.home} colors={colors} />
            <Row label={rt("sessions")} value={String(status.sessions)} colors={colors} />
            {(status.sessionList?.length ?? 0) > 0 ? (
              <View style={{ gap: 2, marginBottom: 4 }}>
                {status.sessionList.slice(0, 8).map((s) => (
                  <Text key={s.id} style={{ color: colors.inkBright, fontSize: 12 }}>
                    {s.id}
                    {s.projectId ? ` · ${s.projectId}` : ""}
                  </Text>
                ))}
              </View>
            ) : null}
            <Row label={rt("processes")} value={String(status.processes)} colors={colors} />
            <Row label={rt("containers")} value={String(status.containers)} colors={colors} />
            <Row label={rt("images")} value={String(status.containerImages)} colors={colors} />
            <Row label={rt("agents")} value={String(status.agents)} colors={colors} />
            <Row label={rt("toolchains")} value={String(status.toolchains)} colors={colors} />
            <Row label={rt("privilege")} value={status.privilegeActive} colors={colors} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
              <TouchableOpacity
                onPress={() => void (async () => {
                  try {
                    const p = await getRuntimeFacade().refreshPrivileges();
                    setMessage(`privileges: active=${p.active} shizuku=${p.shizuku} root=${p.root} adb=${p.adb}`);
                    await refresh();
                  } catch (e) {
                    setMessage(e instanceof Error ? e.message : String(e));
                  }
                })()}
                style={[styles.miniBtn, { borderColor: colors.line }]}
              >
                <Text style={{ color: colors.accent, fontSize: 12 }}>
                  {{ ru: "Обновить privileges", uk: "Оновити privileges", en: "Refresh privileges" }[language]}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void (async () => {
                  try {
                    const r = await getRuntimeFacade().shizukuSelfCheck();
                    setMessage(r.message);
                  } catch (e) {
                    setMessage(e instanceof Error ? e.message : String(e));
                  }
                })()}
                style={[styles.miniBtn, { borderColor: colors.line }]}
              >
                <Text style={{ color: colors.accent, fontSize: 12 }}>
                  {{ ru: "Тест Shizuku/rish", uk: "Тест Shizuku/rish", en: "Test Shizuku/rish" }[language]}
                </Text>
              </TouchableOpacity>
            </View>
            <Row
              label={rt("native")}
              value={status.nativeAvailable ? rt("yes") : rt("no")}
              colors={colors}
            />
            {(status.processList?.length ?? 0) > 0 ? (
              <View style={{ marginTop: 6, gap: 4 }}>
                <Text style={{ color: colors.muted, fontWeight: "700" }}>{rt("processes")}</Text>
                {status.processList.slice(0, 12).map((p) => (
                  <Text key={p.id} style={{ color: colors.inkBright, fontSize: 12 }}>
                    [{p.kind}] {p.label || p.id}
                    {p.projectId ? ` · ${p.projectId}` : ""}
                  </Text>
                ))}
              </View>
            ) : null}
            {(status.toolchainList?.length ?? 0) > 0 ? (
              <View style={{ marginTop: 6, gap: 4 }}>
                <Text style={{ color: colors.muted, fontWeight: "700" }}>{rt("toolchains")}</Text>
                {status.toolchainList.slice(0, 12).map((m) => (
                  <Text key={m.id} style={{ color: colors.inkBright, fontSize: 12 }}>
                    [{m.health}] {m.kind}: {m.name}
                    {m.version ? ` · ${m.version}` : ""}
                  </Text>
                ))}
              </View>
            ) : null}
            {(status.agentList?.length ?? 0) > 0 ? (
              <View style={{ marginTop: 6, gap: 4 }}>
                <Text style={{ color: colors.muted, fontWeight: "700" }}>{rt("agents")}</Text>
                {status.agentList.slice(0, 12).map((a) => (
                  <Text key={a.id} style={{ color: colors.inkBright, fontSize: 12 }}>
                    [{a.status}] {a.id}
                    {a.projectId ? ` · ${a.projectId}` : ""}
                  </Text>
                ))}
              </View>
            ) : null}
            {(status.containerList?.length ?? 0) > 0 ? (
              <View style={{ marginTop: 6, gap: 6 }}>
                <Text style={{ color: colors.muted, fontWeight: "700" }}>{rt("containers")}</Text>
                {status.containerList.slice(0, 12).map((c) => (
                  <View key={c.id} style={{ gap: 4 }}>
                    <Text style={{ color: colors.inkBright, fontSize: 12 }}>
                      [{c.status}] {c.name} · {c.imageId}
                      {c.projectId ? ` · ${c.projectId}` : ""}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <TouchableOpacity
                        onPress={() => {
                          void (async () => {
                            setBusy(true);
                            try {
                              await stopContainer(c.id);
                              setMessage(`stopped:${c.id}`);
                            } catch (e) {
                              setMessage(e instanceof Error ? e.message : String(e));
                            } finally {
                              setBusy(false);
                            }
                          })();
                        }}
                        disabled={busy}
                        style={[styles.miniBtn, { borderColor: colors.line }]}
                      >
                        <Text style={{ color: colors.inkBright, fontSize: 11 }}>
                          {t("runtimeStopContainer")}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => {
                          void (async () => {
                            setBusy(true);
                            try {
                              await destroyContainer(c.id);
                              setMessage(`destroyed:${c.id}`);
                            } catch (e) {
                              setMessage(e instanceof Error ? e.message : String(e));
                            } finally {
                              setBusy(false);
                            }
                          })();
                        }}
                        disabled={busy}
                        style={[styles.miniBtn, { borderColor: colors.line }]}
                      >
                        <Text style={{ color: colors.inkBright, fontSize: 11 }}>
                          {t("runtimeDestroyContainer")}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <Text style={{ color: colors.muted }}>{rt("noData")}</Text>
        )}
      </View>
      ) : null}

      <RevokedPermissionsNotice colors={colors} language={language} />
      {environmentBackend === "termux" ? <RuntimeStatusPanel colors={colors} language={language} onDetails={() => router.push("/runtime-timeline")} /> : null}
      <PortForwardPanel colors={colors} language={language} />
      {environmentBackend === "termux" ? <TerminalPreferencesPanel colors={colors} language={language} compact /> : null}

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.cardTitle, { color: colors.inkBright }]}>
          {t("runtimeProject")}
        </Text>
        <TextInput
          value={projectId}
          onChangeText={setProjectId}
          placeholder="project id"
          placeholderTextColor={colors.muted}
          style={[
            styles.input,
            {
              color: colors.inkBright,
              borderColor: colors.line,
              backgroundColor: colors.background,
            },
          ]}
          autoCapitalize="none"
        />
        <Text style={styles.helpText}>
          {{
            ru: "Действия привязаны к project id ниже. Сначала откройте сессию, затем контейнер/терминал.",
            uk: "Дії прив'язані до project id. Спочатку сесія, потім контейнер/термінал.",
            en: "Actions use the project id below. Open a session first, then container/terminal.",
          }[language]}
        </Text>
        <TouchableOpacity
          onPress={onOpenSession}
          disabled={busy}
          style={[styles.actionFull, { backgroundColor: DARK_SLATE_GRAY }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="folder-open-outline" size={20} color={"#fff"} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: "#fff" }]}>{t("runtimeOpenSession")}</Text>
              <Text style={styles.actionHint}>
                {{ ru: "Создать/открыть builder-сессию проекта", uk: "Створити/відкрити сесію проєкту", en: "Create/open the project builder session" }[language]}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        {environmentBackend === "ubuntu-proot" && runtimeReadiness?.target === "ubuntu-proot" && runtimeReadiness.status === "ready" ? (
        <TouchableOpacity
          onPress={() => void onLaunchUbuntu()}
          disabled={busy}
          style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1 }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="planet-outline" size={20} color={colors.accent} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: colors.inkBright }]}>{busy ? "…" : t("runtimeLaunchUbuntu")}</Text>
              <Text style={styles.actionHintMuted}>
                {{ ru: "Запуск Ubuntu userspace для проекта", uk: "Запуск Ubuntu userspace для проєкту", en: "Start Ubuntu userspace for this project" }[language]}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        ) : null}
        {environmentBackend === "termux" ? (
        <TouchableOpacity
          onPress={() => router.push("/terminal")}
          disabled={busy}
          style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1 }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="terminal" size={20} color={colors.accent} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: colors.inkBright }]}>{language === "ru" ? "Открыть command terminal" : language === "uk" ? "Відкрити command terminal" : "Open command terminal"}</Text>
              <Text style={styles.actionHintMuted}>{language === "ru" ? "Команды по одной через Termux userspace; не PTY" : language === "uk" ? "Команди по одній через Termux userspace; не PTY" : "One-shot commands through Termux userspace; not a PTY"}</Text>
            </View>
          </View>
        </TouchableOpacity>
        ) : null}
        {environmentBackend === "termux" ? (
        <TouchableOpacity
          onPress={() => void onOpenTerminal()}
          disabled={busy}
          style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1 }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="terminal-outline" size={20} color={colors.accent} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: colors.inkBright }]}>{busy ? "…" : t("runtimeOpenTerminal")}</Text>
              <Text style={styles.actionHintMuted}>
                {{ ru: "Интерактивный терминал в контексте проекта", uk: "Інтерактивний термінал у контексті проєкту", en: "Interactive terminal in project context" }[language]}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={onCreateAgent}
          disabled={busy}
          style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1 }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="hardware-chip-outline" size={20} color={colors.accent} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: colors.inkBright }]}>{t("runtimeCreateAgent")}</Text>
              <Text style={styles.actionHintMuted}>
                {{ ru: "Фоновый агент, привязанный к проекту", uk: "Фоновий агент, прив'язаний до проєкту", en: "Background agent bound to the project" }[language]}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        {(environmentBackend === "ubuntu-proot") && runtimeReadiness?.target === environmentBackend && runtimeReadiness.status === "ready" ? (
        <TouchableOpacity
          onPress={() => void onRunProot()}
          disabled={busy}
          style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1 }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="git-network-outline" size={20} color={colors.accent} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: colors.inkBright }]}>{busy ? "…" : t("runtimeRunProot")}</Text>
              <Text style={styles.actionHintMuted}>
                {environmentBackend === "ubuntu-proot"
                  ? { ru: "Ubuntu proot готов для агента (apt / сборка APK)", uk: "Ubuntu proot готовий для агента (apt / збірка APK)", en: "Ubuntu proot ready for agent (apt / APK build)" }[language]
                  : { ru: "Автовыбор proot-контейнера Ubuntu", uk: "Автовибір proot-контейнера Ubuntu", en: "Auto-select Ubuntu proot container" }[language]}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        ) : null}

      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.cardTitle, { color: colors.inkBright }]}>
          {rt("recovery")}
        </Text>
        <TouchableOpacity
          onPress={() => {
            try {
              const report = runFinalValidation();
              setMessage(
                {
                  ru: `Итоговая проверка: OK=${report.passed}, проблем=${report.failed}` +
                    (report.failed
                      ? ": " + report.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")
                      : ""),
                  uk: `Підсумкова перевірка: OK=${report.passed}, проблем=${report.failed}` +
                    (report.failed
                      ? ": " + report.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")
                      : ""),
                  en: `Final check: passed=${report.passed}, failed=${report.failed}` +
                    (report.failed
                      ? ": " + report.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")
                      : ""),
                }[language],
              );
            } catch (e) {
              setMessage(e instanceof Error ? e.message : String(e));
            }
          }}
          disabled={busy}
          style={[styles.actionFull, { backgroundColor: DARK_SLATE_GRAY }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="checkmark-done-outline" size={20} color="#fff" />
            <View style={styles.actionTextCol}>
              <Text style={styles.actionText}>{rt("finalValidation")}</Text>
              <Text style={styles.actionHint}>
                {{ ru: "Сводка Health + supervisor + journal", uk: "Зводка Health + supervisor + journal", en: "Health + supervisor + journal summary" }[language]}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
        <Text style={styles.helpText}>
          {{
            ru: "Быстрые действия восстановления без удаления проектов. Нажмите, если сессия или процессы «зависли».",
            uk: "Швидкі дії відновлення без видалення проєктів.",
            en: "Quick recovery actions that keep projects. Use if a session or processes are stuck.",
          }[language]}
        </Text>
        {listRecoveryActions().map((a) => {
          const labels: Record<string, { title: string; hint: string; icon: any }> = {
            recreate_session: {
              title: { ru: "Пересоздать сессию builder", uk: "Перестворити сесію builder", en: "Recreate builder session" }[language],
              hint: { ru: "Закрыть и открыть заново рабочую сессию", uk: "Закрити й відкрити робочу сесію", en: "Close and open a fresh builder session" }[language],
              icon: "refresh-outline",
            },
            clear_process_registry: {
              title: { ru: "Очистить реестр процессов", uk: "Очистити реєстр процесів", en: "Clear process registry" }[language],
              hint: { ru: "Сбросить список отслеживаемых процессов", uk: "Скинути список процесів", en: "Reset tracked process list" }[language],
              icon: "list-outline",
            },
            stop_all_containers: {
              title: { ru: "Остановить все контейнеры", uk: "Зупинити всі контейнери", en: "Stop all containers" }[language],
              hint: { ru: "Проекты на диске сохраняются", uk: "Проєкти на диску залишаються", en: "Projects on disk are kept" }[language],
              icon: "stop-circle-outline",
            },
            close_all_terminals: {
              title: { ru: "Закрыть все терминалы", uk: "Закрити всі термінали", en: "Close all terminals" }[language],
              hint: { ru: "Завершить Termux/терминальные сессии UI", uk: "Завершити термінальні сесії", en: "End Termux/UI terminal sessions" }[language],
              icon: "terminal-outline",
            },
            refresh_toolchains: {
              title: { ru: "Обновить toolchain", uk: "Оновити toolchain", en: "Refresh toolchains" }[language],
              hint: { ru: "Заново обнаружить Java/SDK/Gradle в среде", uk: "Знову знайти Java/SDK/Gradle", en: "Re-discover Java/SDK/Gradle" }[language],
              icon: "build-outline",
            },
            refresh_privileges: {
              title: { ru: "Перепроверить права", uk: "Перевірити права", en: "Re-detect privileges" }[language],
              hint: { ru: "Shizuku / Root / ADB заново", uk: "Shizuku / Root / ADB знову", en: "Shizuku / Root / ADB again" }[language],
              icon: "shield-checkmark-outline",
            },
            destroy_all_containers: {
              title: { ru: "Уничтожить контейнеры", uk: "Знищити контейнери", en: "Destroy all containers" }[language],
              hint: { ru: "Удалить instances; проекты не трогаем", uk: "Видалити instances; проєкти лишаються", en: "Remove instances; projects kept" }[language],
              icon: "trash-outline",
            },
          };
          const fallbackTitle =
            typeof a.description === "string"
              ? a.description
              : a.description && typeof a.description === "object" && "ru" in (a.description as object)
                ? String((a.description as Record<string, string>)[language] ?? (a.description as Record<string, string>).ru ?? a.id)
                : a.id;
          const L = labels[a.id] || {
            title: fallbackTitle,
            hint: a.id,
            icon: "ellipse-outline" as any,
          };
          return (
            <TouchableOpacity
              key={a.id}
              onPress={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    const msg = await runRecovery(a.id);
                    setMessage(msg);
                  } catch (e) {
                    setMessage(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              disabled={busy}
              style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1 }]}
            >
              <View style={styles.actionInner}>
                <Ionicons name={L.icon} size={20} color={colors.accent} />
                <View style={styles.actionTextCol}>
                  <Text style={[styles.actionText, { color: colors.inkBright }]} numberOfLines={2}>{L.title}</Text>
                  <Text style={styles.actionHintMuted}>{L.hint}</Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity
          onPress={() => {
            showDialog(
              t("stopAllSessions"),
              t("stopAllSessionsConfirm"),
              [
                { text: t("cancel"), style: "cancel" },
                {
                  text: t("stopAllSessions"),
                  style: "destructive",
                  onPress: () => {
                    void (async () => {
                      try {
                        const result = await killAllRuntimeSessions();
                        showDialog(
                          result.ok ? t("stopSessionDone") : t("stopSessionFail"),
                          result.ok
                            ? (result.sessionName || "aib-*")
                            : String(result.error || "unknown"),
                        );
                      } catch (e: any) {
                        showDialog(t("stopSessionFail"), String(e?.message || e));
                      }
                    })();
                  },
                },
              ],
            );
          }}
          style={[styles.actionFull, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderColor: colors.line, borderWidth: 1, marginTop: 8 }]}
        >
          <View style={styles.actionInner}>
            <Ionicons name="stop-circle-outline" size={20} color={colors.accent} />
            <View style={styles.actionTextCol}>
              <Text style={[styles.actionText, { color: colors.inkBright }]} numberOfLines={2}>{t("stopAllSessions")}</Text>
              <Text style={styles.actionHintMuted}>
                {{ ru: "Завершить все изолированные aib-* tmux-сессии", uk: "Завершити всі ізольовані aib-* tmux-сесії", en: "End all isolated aib-* tmux sessions" }[language]}
              </Text>
            </View>
          </View>
        </TouchableOpacity>

      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <View style={styles.cardHeader}>
          <Ionicons name="cloud-upload-outline" size={22} color={colors.accent} />
          <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>{rt("backupRestore")}</Text>
        </View>
        <Text style={styles.helpText}>
          {{
            ru: "Снимок данных AI Builder. Scope: full / projects / sessions / toolchains. Restore делает pre-backup текущего состояния.",
            uk: "Знімок даних. Restore робить pre-backup поточного стану.",
            en: "Snapshot of AI Builder data. Restore takes a pre-backup of current state first.",
          }[language]}
        </Text>
        <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 4 }}>
          {{ ru: "Объём копии", uk: "Обсяг копії", en: "Backup scope" }[language]}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {(["full", "projects", "sessions", "toolchains"] as const).map((s) => (
            <TouchableOpacity
              key={s}
              onPress={() => setBackupScope(s)}
              style={[styles.miniBtn, {
                borderColor: backupScope === s ? colors.accent : colors.line,
                backgroundColor: backupScope === s ? (colors.accentDim || colors.line) : "transparent",
              }]}
            >
              <Text style={{ color: backupScope === s ? colors.accent : colors.inkBright, fontSize: 12 }}>{s}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          value={backupPath}
          onChangeText={setBackupPath}
          placeholder={status ? `${status.home}/backups/manual-1` : "backup path"}
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.inkBright, borderColor: colors.line }]}
          autoCapitalize="none"
        />
        <View style={styles.rowBtns}>
          <TouchableOpacity
            disabled={backupBusy}
            onPress={() => void onBackupCreate()}
            style={[styles.action, { backgroundColor: DARK_SLATE_GRAY, opacity: backupBusy ? 0.5 : 1 }]}
          >
            <Text style={styles.actionText}>{backupBusy ? "…" : rt("createFullBackup")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            disabled={backupBusy || !backupPath.trim()}
            onPress={() => void onBackupVerify()}
            style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line, opacity: !backupPath.trim() ? 0.45 : 1 }]}
          >
            <Text style={[styles.actionText, { color: colors.inkBright }]}>
              {{ ru: "Проверить", uk: "Перевірити", en: "Verify" }[language]}
            </Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          disabled={backupBusy || !backupPath.trim()}
          onPress={() => void onBackupRestore()}
          style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line, marginTop: 8, opacity: !backupPath.trim() ? 0.45 : 1 }]}
        >
          <Text style={[styles.actionText, { color: colors.inkBright }]}>{rt("restoreBackup")}</Text>
        </TouchableOpacity>
        <View style={styles.rowBtns}>
          <TouchableOpacity
            disabled={backupBusy}
            onPress={() => void (async () => {
              setBackupBusy(true);
              try {
                await withForegroundTask("backup", "Export profile", async () => {
                  const r = await getRuntimeFacade().exportProfile();
                  setMessage(r.message);
                  if (r.path) setBackupPath(r.path);
                });
              } catch (e) {
                setMessage(e instanceof Error ? e.message : String(e));
              } finally {
                setBackupBusy(false);
              }
            })()}
            style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line }]}
          >
            <Text style={[styles.actionText, { color: colors.inkBright }]}>
              {{ ru: "Экспорт профиля", uk: "Експорт профілю", en: "Export profile" }[language]}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            disabled={backupBusy || !backupPath.trim()}
            onPress={() => void (async () => {
              setBackupBusy(true);
              try {
                await withForegroundTask("restore", "Import profile", async () => {
                  const r = await getRuntimeFacade().importProfile(backupPath.trim());
                  setMessage(r.message);
                });
              } catch (e) {
                setMessage(e instanceof Error ? e.message : String(e));
              } finally {
                setBackupBusy(false);
              }
            })()}
            style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line, opacity: !backupPath.trim() ? 0.45 : 1 }]}
          >
            <Text style={[styles.actionText, { color: colors.inkBright }]}>
              {{ ru: "Импорт профиля", uk: "Імпорт профілю", en: "Import profile" }[language]}
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={{ color: colors.muted, fontSize: 11, marginTop: 6 }}>
          {{
            ru: "Экспорт → /storage/emulated/0/AIBuilderTermux/AIBuilder-profile-*.tar.gz (переживает переустановку). Импорт: укажите путь к tar.gz.",
            uk: "Експорт у Download/ (переживає перевстановлення).",
            en: "Export to Download/AIBuilder-profile-*.tar.gz (survives reinstall). Import: path to tar.gz.",
          }[language]}
        </Text>
        {backupInspect ? (
          <Text selectable style={{ color: colors.muted, fontSize: 11, marginTop: 8 }}>{backupInspect}</Text>
        ) : null}
        <View style={[styles.cardHeader, { marginTop: 12 }]}>
          <Ionicons name="list-outline" size={18} color={colors.accent} />
          <Text style={{ color: colors.inkBright, fontWeight: "700", fontSize: 14 }}>
            {{ ru: "Список бэкапов", uk: "Список бекапів", en: "Backup list" }[language]}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => void onBackupRefreshList()}
          disabled={backupBusy}
          style={[styles.miniBtn, { borderColor: colors.line, alignSelf: "flex-start", marginBottom: 8 }]}
        >
          <Text style={{ color: colors.accent, fontSize: 12 }}>
            {{ ru: "Обновить список", uk: "Оновити список", en: "Refresh list" }[language]}
          </Text>
        </TouchableOpacity>
        {backupList.length === 0 ? (
          <Text style={{ color: colors.muted, fontSize: 12 }}>
            {{ ru: "Пока пусто — создайте бэкап или нажмите «Обновить список»", uk: "Порожньо — створіть бекап", en: "Empty — create a backup or refresh" }[language]}
          </Text>
        ) : (
          backupList.map((b) => (
            <TouchableOpacity
              key={b.path}
              onPress={() => setBackupPath(b.path)}
              style={{ marginBottom: 8, paddingVertical: 4 }}
            >
              <Text style={{ color: colors.inkBright, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
                {b.path.split("/").slice(-2).join("/")}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 11 }}>
                {b.scope || "?"} · {b.createdAt ? new Date(b.createdAt).toLocaleString() : "—"}
                {b.digest ? ` · ${(b.digest || "").slice(0, 8)}` : ""}
              </Text>
            </TouchableOpacity>
          ))
        )}
      </View>

      {environmentBackend === "termux" && lastBootInfo ? (
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.cardHeader}>
            <Ionicons name="time-outline" size={20} color={colors.accent} />
            <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>{rt("startupTrace")}</Text>
          </View>
          <Text style={{ color: colors.muted, fontSize: 12 }}>{lastBootInfo}</Text>
        </View>
      ) : null}

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <Text style={[styles.cardTitle, { color: colors.inkBright }]}>
          {{ ru: "Общая настройка приложения", uk: "Загальна настройка застосунку", en: "Shared app setting" }[language]}
        </Text>
        <Text style={styles.helpText}>
          {{ ru: "Режим производительности — общий параметр AI Builder и не показывает состояние соседних сред.", uk: "Режим продуктивності — спільний параметр AI Builder і не показує стан інших середовищ.", en: "Performance mode is an app-wide setting; it does not report the state of other environments." }[language]}
        </Text>
        <Text style={{ color: colors.inkBright, fontSize: 12, fontWeight: "700", marginTop: 8, marginBottom: 6 }}>
          {{ ru: "Режим производительности", uk: "Режим продуктивності", en: "Performance mode" }[language]} · {performanceMode}
        </Text>
        <View style={styles.rowBtns}>
          {(["Performance", "Balanced", "Battery", "Compatibility"] as const).map((mode) => (
            <TouchableOpacity key={mode} onPress={() => void onPerformanceMode(mode)} disabled={busy}
              style={[styles.miniBtn, { borderColor: performanceMode === mode ? colors.accent : colors.line, backgroundColor: performanceMode === mode ? colors.surfaceRaised ?? colors.surface : "transparent", opacity: busy ? 0.6 : 1 }]}>
              <Text style={{ color: performanceMode === mode ? colors.accent : colors.muted, fontSize: 11 }}>{mode}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity onPress={() => void onAutoPerformanceMode()} disabled={busy} style={[styles.miniBtn, { borderColor: colors.line, opacity: busy ? 0.6 : 1 }]}>
            <Text style={{ color: colors.accent, fontSize: 11 }}>{{ ru: "Авто", uk: "Авто", en: "Auto" }[language]}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {environmentBackend === "termux" ? (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <View style={styles.cardHeader}>
          <Ionicons name="heart-outline" size={20} color={colors.accent} />
          <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>{rt("health")}</Text>
        </View>
        <Text style={styles.helpText}>
          {{ ru: "Проверка Termux, Java/Gradle/Node, userspace. «Исправить всё» запускает только безопасные рецепты.", uk: "Перевірка Termux і toolchain. «Виправити все» — лише безпечні рецепти.", en: "Probes Termux and toolchain. Repair all runs allowlisted recipes only." }[language]}
        </Text>
        <View style={styles.rowBtns}>
          <TouchableOpacity
            disabled={healthBusy}
            onPress={() => void (async () => {
              setHealthBusy(true);
              try {
                const facade = getRuntimeFacade();
                const rows = await facade.runHealthChecks();
                setHealthRows(rows.map((r) => ({ id: r.id, level: r.level, message: r.message, repairable: r.repairable })));
                setMessage(`health: ${rows.filter((x) => x.level === "ok").length}/${rows.length} ok`);
              } catch (e) {
                setMessage(e instanceof Error ? e.message : String(e));
              } finally {
                setHealthBusy(false);
              }
            })()}
            style={[styles.action, { backgroundColor: DARK_SLATE_GRAY }]}
          >
            <Text style={styles.actionText}>{healthBusy ? "…" : rt("runHealth")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            disabled={healthBusy || !healthRows.some((r) => r.repairable && r.level !== "ok")}
            onPress={() => void (async () => {
              setHealthBusy(true);
              try {
                const facade = getRuntimeFacade();
                const targets = healthRows.filter((r) => r.repairable && r.level !== "ok");
                for (const row of targets) {
                  await facade.repairHealth(row.id);
                }
                const rows = await facade.runHealthChecks();
                setHealthRows(rows.map((r) => ({ id: r.id, level: r.level, message: r.message, repairable: r.repairable })));
                try {
                  const fails = await facade.listOpenFailures();
                  setFailureRows((fails || []).slice(0, 12).map((f: any) => ({
                    id: f.id, code: f.code, component: f.component, message: f.message, at: f.at,
                  })));
                } catch { /* ignore */ }
                setMessage(`repair attempted: ${targets.length}`);
              } catch (e) {
                setMessage(e instanceof Error ? e.message : String(e));
              } finally {
                setHealthBusy(false);
              }
            })()}
            style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line }]}
          >
            <Text style={[styles.actionText, { color: colors.inkBright }]}>{rt("repairAll")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            disabled={healthBusy}
            onPress={() => void (async () => {
              setHealthBusy(true);
              try {
                const facade = getRuntimeFacade();
                const out = await facade.exportHealthReport();
                setMessage(`health export: ${out.count} rules → ${out.path}`);
              } catch (e) {
                setMessage(e instanceof Error ? e.message : String(e));
              } finally {
                setHealthBusy(false);
              }
            })()}
            style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line }]}
          >
            <Text style={[styles.actionText, { color: colors.inkBright }]}>
              {{ ru: "Export", uk: "Export", en: "Export" }[language]}
            </Text>
          </TouchableOpacity>
        </View>
        {healthRows.length === 0 ? (
          <Text style={{ color: colors.muted, marginTop: 8 }}>{rt("healthHint")}</Text>
        ) : (
          healthRows.map((item) => (
            <View key={item.id} style={styles.diagRow}>
              <Text style={{ color: levelColor(item.level as any, colors), fontWeight: "700" }}>
                {item.level.toUpperCase()}
              </Text>
              <Text style={{ color: colors.inkBright, flex: 1 }}>
                [{item.id}] {item.message}
              </Text>
            </View>
          ))
        )}
      </View>
      ) : null}

      {environmentBackend === "termux" ? (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <View style={styles.cardHeader}>
          <Ionicons name="warning-outline" size={20} color={colors.accent} />
          <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>
            {{ ru: "Журнал сбоев", uk: "Журнал збоїв", en: "Failure journal" }[language]}
          </Text>
        </View>
        <Text style={styles.helpText}>
          {{
            ru: "Открытые (ещё не исправленные) записи из Health и recovery. Пусто — всё чисто.",
            uk: "Відкриті (ще не виправлені) записи Health і recovery.",
            en: "Open unrepaired entries from Health and recovery. Empty means clean.",
          }[language]}
        </Text>
        {failureRows.length === 0 ? (
          <Text style={{ color: colors.muted }}>
            {{ ru: "Нет открытых сбоев", uk: "Немає відкритих збоїв", en: "No open failures" }[language]}
          </Text>
        ) : (
          failureRows.map((f) => (
            <View key={f.id} style={{ marginBottom: 8 }}>
              <View style={styles.diagRow}>
                <Text style={{ color: colors.danger || "#f66", fontWeight: "700", fontSize: 11 }}>{f.code}</Text>
                <Text style={{ color: colors.inkBright, flex: 1, fontSize: 12 }}>
                  [{f.component}] {f.message}
                </Text>
              </View>
              <TouchableOpacity
                disabled={healthBusy}
                onPress={() => void (async () => {
                  setHealthBusy(true);
                  try {
                    const facade = getRuntimeFacade();
                    await facade.repairHealth(f.component);
                    const fails = await facade.listOpenFailures();
                    setFailureRows(
                      (fails || []).slice(0, 12).map((x: any) => ({
                        id: x.id,
                        code: x.code,
                        component: x.component,
                        message: x.message,
                        at: x.at,
                      })),
                    );
                    const rows = await facade.runHealthChecks();
                    setHealthRows(rows.map((r: any) => ({
                      id: r.id, level: r.level, message: r.message, repairable: r.repairable,
                    })));
                    setMessage(`repair: ${f.component}`);
                  } catch (e) {
                    setMessage(e instanceof Error ? e.message : String(e));
                  } finally {
                    setHealthBusy(false);
                  }
                })()}
                style={[styles.miniBtn, { borderColor: colors.line, alignSelf: "flex-start", marginTop: 4 }]}
              >
                <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "600" }}>
                  {{ ru: "Исправить", uk: "Виправити", en: "Repair" }[language]}
                </Text>
              </TouchableOpacity>
            </View>
          ))
        )}
        <TouchableOpacity
          onPress={() => void (async () => {
            try {
              const facade = getRuntimeFacade();
              const fails = await facade.listOpenFailures();
              setFailureRows(
                (fails || []).slice(0, 12).map((f: any) => ({
                  id: f.id,
                  code: f.code,
                  component: f.component,
                  message: f.message,
                  at: f.at,
                })),
              );
            } catch (e) {
              setMessage(e instanceof Error ? e.message : String(e));
            }
          })()}
          style={[styles.action, { backgroundColor: colors.surfaceRaised ?? colors.surface, borderWidth: 1, borderColor: colors.line, marginTop: 8 }]}
        >
          <Text style={[styles.actionText, { color: colors.inkBright }]}>
            {{ ru: "Обновить", uk: "Оновити", en: "Refresh" }[language]}
          </Text>
        </TouchableOpacity>
      </View>
      ) : null}

      {environmentBackend === "termux" ? (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <View style={styles.cardHeader}>
          <Ionicons name="analytics-outline" size={20} color={colors.accent} />
          <Text style={[styles.cardTitle, { color: colors.inkBright, marginBottom: 0 }]}>
            {rt("diagnostics")}
          </Text>
        </View>
        <Text style={styles.helpText}>
          {{
            ru: "Сводка статуса среды (HOME, процессы). Для живых проверок toolchain — блок Health выше.",
            uk: "Зведення статусу середовища. Живі перевірки toolchain — у блоці Health.",
            en: "Runtime status summary. Live toolchain probes are in the Health card above.",
          }[language]}
        </Text>
        {diagnostics?.items?.map((item, i) => (
          <View key={`${item.area}-${i}`} style={styles.diagRow}>
            <Text style={{ color: levelColor(item.level, colors), fontWeight: "700" }}>
              {item.level.toUpperCase()}
            </Text>
            <Text style={{ color: colors.inkBright, flex: 1 }}>
              [{item.area}] {item.message}
            </Text>
          </View>
        )) ?? <Text style={{ color: colors.muted }}>{rt("noData")}</Text>}
      </View>
      ) : null}
    
      </>
      ) : null}

</ScrollView>
  );
}

function Row({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: Record<string, string>;
}) {
  return (
    <View style={styles.row}>
      <Text style={{ color: colors.muted, width: 100 }}>{label}</Text>
      <Text style={{ color: colors.inkBright, flex: 1 }} numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
}

function levelColor(level: string, colors: Record<string, string>) {
  if (level === "error") return colors.danger ?? "#f66";
  if (level === "warn") return colors.warning;
  if (level === "ok") return colors.accent;
  return colors.muted;
}

/** Primary filled action buttons — user theme: DarkSlateGray (not light accent). */
const DARK_SLATE_GRAY = "#2F4F4F";

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 20, fontWeight: "700" },
  btn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: "700", marginBottom: 4 },
  row: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  multilineInput: { minHeight: 72, textAlignVertical: "top" },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  rowBtns: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  action: {
    // flex is set by callers in horizontal rows; do not default flex:1 or
    // single full-width buttons stretch vertically inside column cards.
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: DARK_SLATE_GRAY,
  },
  actionInRow: {
    flex: 1,
    minWidth: 0,
  },
  iconActionBtn: {
    flex: 1,
    minWidth: 0,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: DARK_SLATE_GRAY,
    flexDirection: "row",
  },
  desktopActionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  actionFull: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  actionInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  actionTextCol: {
    flex: 1,
    gap: 2,
  },
  actionText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  actionHint: { color: "rgba(255,255,255,0.75)", fontSize: 11, lineHeight: 15, fontWeight: "500" },
  actionHintMuted: { color: "#9AA3AC", fontSize: 11, lineHeight: 15, fontWeight: "500" },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  helpText: { color: "#9AA3AC", fontSize: 12, lineHeight: 17, marginBottom: 8 },
  badgeRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 8 },
  badge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  diagRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },

  miniBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
