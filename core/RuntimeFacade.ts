/**
 * Unified runtime facade for AIBuilderTermux.
 * Wires HOME → Environment → Project → Terminal → Toolchains →
 * Process/Session → Containers → Agent → Bridge → Privilege → Native.
 * Runtime-only; does not alter compilation settings.
 */

import { createHomeLayout, type HomeLayout } from "./home/HomeLayout";
import { validateProjectName } from "./project-manager";
import { createHomeEnvironment } from "./home/HomeEnvironment";
import { AIBuilderTermuxEnvironment } from "./environment/AIBuilderTermuxEnvironment";
import { getBuildBackend } from "../lib/agent-shell-backend";
import { runAndroidToolchainBuildOnly, runAndroidToolchainSign, verifyAndroidToolchainArtifact } from "../lib/build-loop";
import type { ExecutionEnvironment } from "./environment/ExecutionEnvironment";
import { persistentLogger } from "../lib/persistent-logger";
import { normalizeAbsolutePosixPath } from "../lib/agent-tools/posix-path";
import { createProcessRegistry, type ProcessRegistry } from "./process/ProcessRegistry";
import { createLockManager, type LockManager } from "./process/LockManager";
import { createSessionManager, type SessionManager } from "./session/SessionManager";
import { createToolchainManager, type ToolchainManager } from "./toolchain/ToolchainManager";
import {
  createUserspaceContainerBackend,
  type UserspaceContainerBackend,
} from "./container/UserspaceContainerBackend";
import { ubuntuImageManifest } from "./ubuntu/UbuntuProfile";
import { buildContainerShellSpec } from "./container/ContainerShell";
import { buildProotLaunchPlan, buildProxySafeEnvironment } from "./container/ProotCommandBuilder";
import { discoverRootfsPath } from "./container/RootfsDiscovery";
import { detectDevicePrivileges } from "./privilege/DevicePrivilegeDetection";
import { buildRootfsImageManifest, isRootfsReady } from "./container/RootfsImageManifest";
import { ensureRootfsLayout } from "./container/RootfsEnsure";
import { createAgentManager, type AgentManager, type AgentHostHooks } from "./agent/AgentManager";
import type { AgentCapability, AgentSession } from "./agent/AgentTypes";
import {
  createInMemoryAndroidBridge,
  type InMemoryAndroidBridge,
} from "./bridge/AndroidBridge";
import {
  NoneProvider,
  ShizukuProvider,
  RootProvider,
  detectPrivileges,
  type CapabilityDetection,
  type PrivilegeProvider,
} from "./privilege/PrivilegeProvider";
import {
  createNativeContainerRuntime,
  type DefaultNativeContainerRuntime,
} from "./native/NativeContainerRuntime";
import { createRecoveryManager, type RecoveryManager } from "./recovery/RecoveryManager";
import { buildDiagnosticReport, type DiagnosticReport } from "./diagnostics/DiagnosticReport";
import {
  runFinalValidation,
  type FinalValidationReport,
} from "./FinalValidation";
import { TerminalSessionManager } from "./terminal-session-manager";
import type { TerminalAdapter } from "./terminal";
import { createTermuxTerminalBackend } from "./environment/TermuxTerminalBackend";
import { CURRENT_RUNTIME_IDENTITY, type RuntimeIdentity } from "./runtime/RuntimeIdentity";
import { RuntimeTaskGate } from "./runtime/RuntimeTaskGate";
import { RuntimeJournal } from "./runtime/RuntimeJournal";
import { EnvironmentTextStore } from "./runtime/RuntimeStores";
import { BootstrapPipeline, createBootstrapPipeline, type BootstrapPipelineState, type BootstrapProgressEvent } from "./runtime/BootstrapPipeline";
import { RuntimeSupervisor } from "./runtime/RuntimeSupervisor";
import { buildStorageAccessProbeCommand, classifyStorageAccessProbeExitCode } from "./enhancements/onboarding/StorageAccessProbe";
import { RuntimeTransaction } from "./runtime/RuntimeTransaction";
import { createAibUserspaceRuntime, type AibUserspaceRuntime } from "./runtime/AibUserspaceRuntime";
import { RuntimeMaintenanceCoordinator } from "./runtime/RuntimeMaintenanceCoordinator";
import {
  probeJava,
  probeGradle,
  probeNode,
  probeAdb,
  probeSdk,
  probeProotDistro,
  probeTermuxSession,
  probeDiskFree,
  probeGit,
  probeUnzip,
  probeDebianDistro,
  probeHomeLayout,
  probeNdk,
  probeAapt2,
  probeShizuku,
} from "./diagnostics/LiveProbes";
import {
  createGradleRule,
  createJavaRule,
  createNodeRule,
  createSdkRule,
} from "./diagnostics/rules/BuiltinRules";
import { RuntimeHealth } from "./diagnostics/RuntimeHealth";
import { StartupTrace } from "./diagnostics/StartupTrace";
import { FailureJournal } from "./diagnostics/FailureJournal";
import {
  createIdentityRule,
  createJournalPendingRule,
  createSelfTestRule,
  createProotRule,
  createAdbRule,
  createUserspaceRuntimeRule,
  createTermuxSessionRule,
  createDiskFreeRule,
  createGitRule,
  createUnzipRule,
  createDebianDistroRule,
  createHomeLayoutRule,
  createNdkRule,
  createAapt2Rule,
  createShizukuRule,
  createSupervisorRule,
} from "./diagnostics/rules/BuiltinRules";
import { BackupManager } from "./backup/BackupManager";
import { createDeterministicRepair, type DeterministicRepair } from "./recovery/DeterministicRepair";
import { TermuxBackupAdapter } from "./backup/TermuxBackupAdapter";
import { UnavailableDeviceAgentBridge, type DeviceAgentBridge } from "./device/DeviceAgentBridge";
import { DeviceAgentTools } from "./device/DeviceAgentTools";
import { runDeviceAppLoop, type DeviceAppLoopOptions, type DeviceAppLoopResult } from "./device/DeviceAppLoop";
import { DeviceAutomationAgent, type DeviceAutomationOptions, type DeviceAutomationResult } from "./device/DeviceAutomationAgent";
import { generateDeviceTestSuite, type DeviceTestSuite, type TestPlanModel } from "./device/DeviceTestPlanner";
import { DeviceEvidenceStore } from "./device/DeviceEvidenceStore";
import { runDeviceTestSuite, type DeviceTestSuiteRun } from "./device/DeviceTestRunner";
import { LinuxRuntime, type LinuxExecResult, type LinuxRuntimeProfile, type LinuxRuntimeStatus } from "./linux/LinuxRuntime";
import { createProotContainerManager, type ProotContainerManager, type ContainerExecResult } from "./container/ProotContainerManager";
import { UBUNTU_IMAGE } from "./container/ContainerProfiles";
import { createAIWorkspaceBuilder, type WorkspaceBuildPlan, type WorkspaceBuildResult } from "./workspace/AIWorkspaceBuilder";
import { createAIProjectGenerator, type AIProjectRequest, type AIProjectResult } from "./workspace/AIProjectGenerator";
import { createAICodingAgent, type AICodingAgentRequest, type AICodingAgentResult } from "./workspace/AICodingAgent";
import { createLLMCodingBrain, type LLMCodingBrain } from "./workspace/LLMCodingBrain";
import { runAgenticBuildLoop, type AgenticBuildLoopRequest, type AgenticBuildLoopResult } from "./workspace/AgenticBuildLoop";
import { runRealDeviceIntegration, type RealDeviceIntegrationRequest, type RealDeviceIntegrationResult } from "./device/RealDeviceIntegration";
import { createPersistentAIWorkspace, type PersistentAIWorkspace, type PersistentWorkspaceSnapshot, type PersistentWorkspaceStatus, type WorkspaceGitEntry } from "./workspace/PersistentAIWorkspace";
import { createAIProjectMemory, type AIProjectMemoryStore, type AIProjectMemory } from "./workspace/AIProjectMemory";
import { createOneClickAppFactory, type OneClickAppFactoryRequest, type OneClickAppFactoryResult } from "./workspace/OneClickAppFactory";
import { AgentAuthStore } from "./enhancements/auth/AgentAuthStore";
import { createSecureCredentialStorage } from "./enhancements/auth/SecureStoreAdapter";
import { CredentialProxy } from "./enhancements/auth/CredentialProxy";
import { NativeProxyTransportAdapter } from "./enhancements/auth/NativeProxyTransport";
import { resolveAgentProviderRoute } from "./enhancements/auth/productionProviderTransport";
import type { ProxyClientConfiguration } from "./enhancements/auth/types";
import { EventStore } from "./enhancements/timeline/EventStore";
import type { TimelineEventInput } from "./enhancements/timeline/EventStore";
import { ActivityTimeline } from "./enhancements/timeline/ActivityTimeline";
import { GitPrivateRef } from "./enhancements/checkpoint/GitPrivateRef";
import { TaskCheckpointManager } from "./enhancements/checkpoint/TaskCheckpointManager";
import { WorkspaceSnapshot } from "./enhancements/snapshot/WorkspaceSnapshot";
import { HomeDocumentStorage } from "./enhancements/persistence/HomeDocumentStorage";
import { UninstallSafeStore } from "./enhancements/persistence/UninstallSafeStore";
import { DataMigration } from "./enhancements/persistence/DataMigration";
import { configureDurablePersistence } from "../lib/durable-persistence";
import { SleepWakeManager } from "./enhancements/lifecycle/SleepWakeManager";
import { ResourcePressureReaper, type PressurePolicy } from "./enhancements/lifecycle/ResourcePressureReaper";
import type { AppLifecycleState, LifecyclePolicy, LifecycleStore, ReaperAdapter, SleepWakeAdapter } from "./enhancements/lifecycle/types";
import { InContainerSupervisor } from "./enhancements/supervisor/InContainerSupervisor";
import type { InContainerSupervisorAdapter } from "./enhancements/supervisor/types";
import type { ManifestProcessAdapter, RuntimeManifest } from "./enhancements/manifest/types";
import { ManifestError } from "./enhancements/manifest/types";
import { parseManifest } from "./enhancements/manifest/ManifestParser";
import { getRuntimePreset, type RuntimePresetName } from "./enhancements/manifest/Presets";
import { BootstrapDiagnostics, probeInternetConnectivity } from "./enhancements/onboarding/BootstrapDiagnostics.ts";
import { FirstRunOrchestrator, type FirstRunCheck, type FirstRunOptions, type FirstRunProgress, type FirstRunResult, type FirstRunStore } from "./enhancements/onboarding/FirstRunOrchestrator.ts";
import { recommendSmartDefaults, summarizeProviderConfiguration, type SmartDefaultsRecommendation } from "./enhancements/onboarding/SmartDefaults.ts";
import { BackendTuner } from "./enhancements/performance/BackendTuner.ts";
import { NativeAccelSlot } from "./enhancements/performance/NativeAccelSlot.ts";
import { PerformanceModeController, type PerformanceModeName } from "./enhancements/performance/PerformanceMode.ts";
import { DevicePolicy, AccessibilityEngine, WirelessAdbManager, VirtualDisplay, DeviceBridge, createNativeAccessibilityAdapter, createNativeVirtualDisplayAdapter, createNativeLoopbackTransport, loadNativeAccessibilityModule, loadNativeMemoryPressureModule, unsupportedVirtualDisplayAdapter, PolicyGatedDeviceAgentBridge, createTermuxAdbPairingAdapter, type DeviceBridgeRequest, type DeviceCapability } from "./enhancements/device";
import { GGUFLifecycle, OfflineAgentRuntime, type GGUFModelPort, type OfflineAgentEvent, type OfflineChatTurn, type OfflineTool } from "./enhancements/offline";
import { runAndroidToolchainCoordinator, type AndroidAppIdentity, type AndroidToolchainResult } from "./enhancements/toolchain/AndroidToolchainCoordinator";
import { createAndroidToolchainProductionAdapter, readAndroidProjectIdentity, type AndroidToolchainProductionHost } from "./enhancements/toolchain/AndroidToolchainProductionAdapter";
import { TerminalTheme, TerminalFont, TerminalSessionManager as TerminalUXSessionManager } from "./enhancements/terminal";
import type { TerminalPreferenceStore, TerminalSessionSnapshot } from "./enhancements/terminal";
import { PortForwardManager, PortForwardPolicy, PortForwardStore, SocatPortForwardTransport } from "./enhancements/networking";
import type { PortForwardTransport, PortForwardRequest, PortForwardSource } from "./enhancements/networking";
import { RuntimeLiveStatus, StatusCollector } from "./enhancements/runtime-status";
import { InterceptorAgentBridge, InterceptorCapture, InterceptorCertificate, InterceptorEngine, InterceptorPathPolicy, InterceptorPolicy, InterceptorReplay, InterceptorRules, InterceptorSessionStorage, InterceptorStore } from "./enhancements/interceptor";
import type { InterceptorAgentCommand, InterceptorCertificateAdapter, InterceptorRule, InterceptorRuntimeAdapter } from "./enhancements/interceptor";

export type RuntimeFacadeOptions = {
  homeRoot?: string;
  /** App-private marker store; legacy Termux storage remains the core-only fallback. */
  firstRunStore?: FirstRunStore;
  shizukuAvailable?: boolean;
  rootAvailable?: boolean;
  terminalAdapter?: TerminalAdapter;
  /** App-private durable storage for terminal session snapshots; absent adapters stay process-local. */
  terminalSessionStore?: TerminalPreferenceStore;
  runtimeIdentity?: RuntimeIdentity;
  deviceBridge?: DeviceAgentBridge;
  /** Optional platform adapters; absent transports remain unavailable and fail closed. */
  enhancements?: Readonly<{
    lifecycle?: Readonly<{ adapter: SleepWakeAdapter; store?: LifecycleStore; policy?: LifecyclePolicy; reaperAdapter?: ReaperAdapter; pressurePolicy?: PressurePolicy; containerIdForProject?: (projectId: string) => string | undefined }>;
    manifest?: Readonly<{ processAdapter: InContainerSupervisorAdapter; manifestAdapter: ManifestProcessAdapter }>;
    networking?: Readonly<{ transport?: PortForwardTransport }>;
  interceptor?: Readonly<{ runtimeAdapter?: InterceptorRuntimeAdapter; certificateAdapter?: InterceptorCertificateAdapter; fetcher?: typeof fetch }>;
  }>;
  /** App-owned hooks, such as a verified project-isolated shell runner. */
  agentHostHooks?: Partial<AgentHostHooks>;
};

function normalizeTerminalCwd(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.length > 1024) return null;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length === 0) return null; parts.pop(); continue; }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isTerminalCwdWithin(root: string, candidate: string): boolean {
  const cleanRoot = root.replace(/\/$/, "");
  return candidate === cleanRoot || candidate.startsWith(`${cleanRoot}/`);
}

function createVolatileTerminalSessionStore(): TerminalPreferenceStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
  };
}

export type RuntimeOfflineAgentOptions = Readonly<{
  /** File writes are omitted from the tool catalog unless explicitly enabled for this run. */
  allowFileWrites?: boolean;
  /** Enables only a local cached assembleDebug + verify + debug-sign tool; no shell/network/device capability is granted. */
  allowAndroidToolchain?: boolean;
  /** Install additionally requires a live device.adb user grant and this per-install confirmation callback. */
  allowDeviceInstall?: boolean;
  confirmDeviceInstall?: (details: Readonly<{ projectId: string; applicationId: string; variant: "debug" }>) => Promise<boolean>;
  /** OpenRouter fallback requires this per-run opt-in and a configured SecureStore credential. */
  allowHybridFallback?: boolean;
  history?: readonly OfflineChatTurn[];
  signal?: AbortSignal;
  language?: "uk" | "ru" | "en";
}>;

type RuntimeOfflineModelServices = Readonly<{
  engine: GGUFModelPort & {
    chat(history: OfflineChatTurn[], generation?: { temperature: number; maxTokens: number; topP: number }, language?: "uk" | "ru" | "en", systemPrompt?: string, signal?: AbortSignal): Promise<string>;
  };
  lifecycle: GGUFLifecycle;
}>;

type OfflineToolchainSession = Readonly<{
  projectId: string;
  expectedIdentity: AndroidAppIdentity;
  allowDeviceInstall: boolean;
  confirmDeviceInstall?: RuntimeOfflineAgentOptions["confirmDeviceInstall"];
}>;

function normalizedCommandExitCode(result: { exitCode?: unknown; code?: unknown }): number {
  const value = result.exitCode ?? result.code;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : -1;
}

const ACTIVE_AGENT_CREDENTIAL_PROVIDERS = new Set(["openrouter", "opencode", "custom.slot1", "custom.slot2"]);
function isActiveAgentCredentialProvider(provider: string): boolean {
  return ACTIVE_AGENT_CREDENTIAL_PROVIDERS.has(String(provider || "").trim().toLowerCase());
}

export class RuntimeFacade {
  readonly home: HomeLayout;
  readonly environment: ExecutionEnvironment;
  readonly processRegistry: ProcessRegistry;
  readonly locks: LockManager;
  readonly sessions: SessionManager;
  readonly toolchains: ToolchainManager;
  readonly containers: UserspaceContainerBackend;
  readonly linux: LinuxRuntime;
  readonly containerRuntime: ProotContainerManager;
  readonly workspaceBuilder: ReturnType<typeof createAIWorkspaceBuilder>;
  readonly projectGenerator: ReturnType<typeof createAIProjectGenerator>;
  readonly codingAgent: ReturnType<typeof createAICodingAgent>;
  readonly codingBrain: LLMCodingBrain;
  readonly persistentWorkspace: PersistentAIWorkspace;
  readonly projectMemory: AIProjectMemoryStore;
  readonly oneClickAppFactory: ReturnType<typeof createOneClickAppFactory>;
  readonly agents: AgentManager;
  /** SecureStore-backed public credential API; no plaintext resolver is exposed. */
  readonly agentAuthStore: Pick<AgentAuthStore, "setProviderKey" | "getProviderKey" | "hasKey" | "deleteKey">;
  #agentAuthStore: AgentAuthStore;
  /** Native loopback proxy; the Android listener is started per provider session. */
  readonly credentialProxy: CredentialProxy;
  /** Durable structured activity log with a bounded recent UI buffer. */
  readonly timeline: ActivityTimeline;
  /** Git-private task checkpoints; existing user refs and index stay untouched. */
  readonly checkpoints: TaskCheckpointManager;
  /** Workspace-only tar snapshots; system/rootfs backup remains with BackupManager. */
  readonly workspaceSnapshots: WorkspaceSnapshot;
  /** HOME-backed durable non-secret records; sensitive values are rejected or omitted. */
  readonly uninstallSafeStore: UninstallSafeStore;
  readonly sleepWake: SleepWakeManager | null;
  readonly pressureReaper: ResourcePressureReaper | null;
  readonly inContainerSupervisor: InContainerSupervisor | null;
  readonly bridge: InMemoryAndroidBridge;
  readonly privileges: {
    none: PrivilegeProvider;
    shizuku: PrivilegeProvider;
    root: PrivilegeProvider;
  };
  readonly native: DefaultNativeContainerRuntime;
  readonly recovery: RecoveryManager;
  readonly terminals: TerminalSessionManager | null;
  /** Persisted terminal appearance and bounded logical session state. */
  readonly terminalTheme: TerminalTheme;
  readonly terminalFont: TerminalFont;
  readonly terminalUx: TerminalUXSessionManager;
  /** Policy-gated, loopback-only userspace port forwarding. */
  readonly portForwardPolicy: PortForwardPolicy;
  readonly portForwards: PortForwardManager;
  readonly interceptorPolicy: InterceptorPolicy;
  readonly interceptorStore: InterceptorStore;
  readonly interceptorCapture: InterceptorCapture;
  readonly interceptorSessions: InterceptorSessionStorage;
  readonly interceptorEngine: InterceptorEngine;
  readonly interceptorCertificate: InterceptorCertificate;
  readonly interceptorReplay: InterceptorReplay;
  readonly interceptorAgentBridge: InterceptorAgentBridge;
  /** Subscriber-driven cached live status; no polling without a visible consumer. */
  readonly runtimeLiveStatus: RuntimeLiveStatus;
  readonly runtimeIdentity: RuntimeIdentity;
  readonly taskGate: RuntimeTaskGate;
  readonly journal: RuntimeJournal;
  readonly supervisor: RuntimeSupervisor;
  readonly health: RuntimeHealth;
  readonly transaction: RuntimeTransaction;
  readonly userspace: AibUserspaceRuntime;
  readonly maintenance: RuntimeMaintenanceCoordinator;
  readonly startupTrace: StartupTrace;
  readonly failureJournal: FailureJournal;
  readonly bootstrapPipeline: BootstrapPipeline;
  readonly deterministicRepair: DeterministicRepair;
  readonly backups: BackupManager;
  /** Explicit first-run and major-update orchestration; never runs without a caller request. */
  firstRunOrchestrator: FirstRunOrchestrator;
  readonly backendTuner: BackendTuner;
  readonly performanceModes: PerformanceModeController;
  readonly nativeAccelSlot: NativeAccelSlot;
  private offlineModelServices: RuntimeOfflineModelServices | null = null;
  private offlineModelServicesPromise: Promise<RuntimeOfflineModelServices> | null = null;
  private readonly firstRunStore?: FirstRunStore;
  private readonly offlineToolchainSessions = new Map<string, OfflineToolchainSession>();
  private deviceBridgeConfigured = false;
  private currentPerformanceMode: PerformanceModeName = "Balanced";
  private lastBootstrapOnline: boolean | "unknown" = "unknown";
  private lastBootstrapNetworkAt = 0;
  device: DeviceAgentBridge;
  readonly devicePolicy: DevicePolicy;
  readonly accessibility: AccessibilityEngine;
  readonly wirelessAdb: WirelessAdbManager;
  readonly virtualDisplay: VirtualDisplay;
  readonly deviceBridge: DeviceBridge;
  deviceTools: DeviceAgentTools;
  deviceAutomation: DeviceAutomationAgent;

  private privilegeSnapshot: CapabilityDetection | null = null;
  private defaultToolchainSourcesRegistered = false;
  private readonly taskProxySessions = new Map<string, string>();
  private portForwardAutoRestore = true;
  private lifecycleBasePolicy: LifecyclePolicy = { idleThresholdMs: 12 * 60_000, backgroundIdleThresholdMs: 60_000, healthTimeoutMs: 30_000 };

  constructor(options: RuntimeFacadeOptions = {}) {
    const homeEnv = createHomeEnvironment(
      options.homeRoot ? { AI_BUILDER_HOME: options.homeRoot } : {},
    );
    this.home = homeEnv.layout;
    this.firstRunStore = options.firstRunStore;
    this.runtimeIdentity = options.runtimeIdentity ?? CURRENT_RUNTIME_IDENTITY;
    this.taskGate = new RuntimeTaskGate({ drainTimeoutMs: 15_000 });
    this.journal = new RuntimeJournal(new EnvironmentTextStore(
      new AIBuilderTermuxEnvironment(this.home.root),
      `${this.home.metadata}/runtime-journal.json`,
    ));
    this.transaction = new RuntimeTransaction(this.taskGate, this.journal);
    this.userspace = createAibUserspaceRuntime(
      async (command, opts) => {
        const r = await this.environment.exec(command, {
          cwd: opts?.cwd ?? this.home.root,
          timeoutMs: opts?.timeoutMs ?? 60_000,
        });
        return {
          exitCode: normalizedCommandExitCode(r as { exitCode?: unknown; code?: unknown }),
          stdout: (r as { stdout?: string }).stdout ?? "",
          stderr: (r as { stderr?: string }).stderr ?? "",
        };
      },
      this.taskGate,
      {
        prootProfile: "debian",
        prootProfileProvider: () => {
          const selected = getBuildBackend();
          if (selected === "ubuntu-proot") return "ubuntu";
          return null;
        },
        policy: "prefer-priority",
        manifestApplier: options.enhancements?.manifest ? {
          apply: async (manifest, projectId) => {
            if (!this.inContainerSupervisor) throw new ManifestError("APPLY_FAILED", "No real manifest process adapter is configured");
            return this.inContainerSupervisor.apply(manifest, projectId);
          },
        } : undefined,
      },
    );
    this.startupTrace = new StartupTrace(new EnvironmentTextStore(
      new AIBuilderTermuxEnvironment(this.home.root),
      `${this.home.metadata}/startup-trace.json`,
    ));
    this.failureJournal = new FailureJournal(new EnvironmentTextStore(
      new AIBuilderTermuxEnvironment(this.home.root),
      `${this.home.metadata}/failure-journal.json`,
    ));
    // Bootstrap pipeline store only — runner injected lazily via lib to avoid native import cycles
    this.bootstrapPipeline = createBootstrapPipeline(
      new EnvironmentTextStore(
        new AIBuilderTermuxEnvironment(this.home.root),
        `${this.home.metadata}/bootstrap-pipeline.json`,
      ),
      async () => ({ ok: false, message: "Bootstrap runner not bound" }),
    );
    this.deterministicRepair = createDeterministicRepair();

    this.environment = new AIBuilderTermuxEnvironment(this.home.root);
    this.uninstallSafeStore = new UninstallSafeStore(new HomeDocumentStorage(this.environment, `${this.home.metadata}/uninstall-safe`));
    const persistenceMigration = new DataMigration(this.uninstallSafeStore);
    configureDurablePersistence({
      read: (key) => this.uninstallSafeStore.read(key, "private"),
      write: (key, value) => this.uninstallSafeStore.write(key, value, "private"),
      remove: (key) => this.uninstallSafeStore.remove(key, "private"),
    });
    const authStore = new AgentAuthStore(createSecureCredentialStorage());
    this.#agentAuthStore = authStore;
    this.agentAuthStore = Object.freeze({
      setProviderKey: (provider, key) => {
        if (!isActiveAgentCredentialProvider(provider)) throw new Error("PROVIDER_NOT_SUPPORTED");
        return authStore.setProviderKey(provider, key);
      },
      getProviderKey: (provider) => isActiveAgentCredentialProvider(provider)
        ? authStore.getProviderKey(provider)
        : Promise.resolve({ provider: String(provider || "").trim().toLowerCase(), configured: false, masked: null }),
      hasKey: (provider) => isActiveAgentCredentialProvider(provider) ? authStore.hasKey(provider) : Promise.resolve(false),
      // A retired credential may still exist in storage; unsupported IDs are never read or automatically deleted.
      deleteKey: (provider) => isActiveAgentCredentialProvider(provider) ? authStore.deleteKey(provider) : Promise.resolve(),
    });
    this.credentialProxy = new CredentialProxy(this.#agentAuthStore, {
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
    }, { nativeTransport: new NativeProxyTransportAdapter() });
    this.timeline = new ActivityTimeline(new EventStore(new EnvironmentTextStore(
      this.environment,
      `${this.home.metadata}/activity-events.jsonl`,
    )));
    this.backendTuner = new BackendTuner({
      probeAll: async () => [...(await this.userspace.status()).probes],
      setPolicy: (policy) => this.userspace.setBackendPolicy(policy),
      setFailureThreshold: (threshold) => this.userspace.setBackendFailureThreshold(threshold),
      setPriorityOrder: (ids) => this.userspace.setBackendPriorityOrder(ids),
      snapshot: () => this.userspace.snapshot(),
    }, new EnvironmentTextStore(this.environment, `${this.home.metadata}/backend-policy.json`), {
      record: async (event) => { await this.timeline.append({ type: "backend.policy", actor: "runtime", payload: event }); },
    });
    this.performanceModes = new PerformanceModeController(this.backendTuner, new EnvironmentTextStore(this.environment, `${this.home.metadata}/performance-mode.json`), {
      record: async (event) => { await this.timeline.append({ type: "performance.mode", actor: "runtime", payload: event }); },
    });
    this.nativeAccelSlot = new NativeAccelSlot({
      discover: async () => {
        const result = await this.userspace.status();
        const probe = result.probes.find((entry) => entry.id === "aib-native-accel");
        return {
          linked: Boolean(probe?.detail.includes("native accel linked")),
          available: probe?.health === "ready",
          detail: probe?.detail || "Native accelerator probe is unavailable.",
        };
      },
    });
    this.firstRunOrchestrator = this.createFirstRunOrchestrator();
    const gitRunner = async (cwd: string, command: string, env?: Readonly<Record<string, string>>) => {
      const result = await this.environment.exec(command, { cwd, env: env ? { ...env } : undefined, timeoutMs: 60_000 });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    };
    this.checkpoints = new TaskCheckpointManager(
      new GitPrivateRef(this.home.root, gitRunner, this.environment.resolvePath ? (path) => this.environment.resolvePath!(path) : undefined),
      new EnvironmentTextStore(this.environment, `${this.home.metadata}/task-checkpoints.json`),
    );
    let snapshotMetadataMigration: Promise<string | null> | null = null;
    const snapshotMetadataStore = {
      read: async () => {
        const current = await this.uninstallSafeStore.read("workspace-snapshots.json", "private");
        if (current !== null) return current;
        if (!snapshotMetadataMigration) {
          snapshotMetadataMigration = (async () => {
            const legacyPath = `${this.home.metadata}/workspace-snapshots.json`;
            if (!(await this.environment.exists(legacyPath))) return null;
            const contents = await this.environment.read(legacyPath);
            await persistenceMigration.migrate("snapshot-metadata-v231", [{ key: "workspace-snapshots.json", contents, visibility: "private" }]);
            return this.uninstallSafeStore.read("workspace-snapshots.json", "private");
          })();
        }
        return snapshotMetadataMigration;
      },
      write: (value: string) => this.uninstallSafeStore.write("workspace-snapshots.json", value, "private"),
    };
    this.workspaceSnapshots = new WorkspaceSnapshot(this.environment, this.home, {
      taskGate: this.taskGate,
      metadataStore: snapshotMetadataStore,
      beforeRestore: async (projectRoot, snapshot) => {
        try {
          await this.checkpoints.createBeforeTask({ id: "workspace-restore", projectId: projectRoot }, `restore-${snapshot.id}`, `before workspace restore ${snapshot.id}`);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "NOT_GIT_REPOSITORY")) throw error;
        }
      },
    });
    const lifecycleOptions = options.enhancements?.lifecycle;
    this.lifecycleBasePolicy = lifecycleOptions?.policy ?? this.lifecycleBasePolicy;
    const nativeMemoryPressure = loadNativeMemoryPressureModule();
    const defaultLifecycleAdapter: SleepWakeAdapter = {
      stopProcesses: async (containerId) => {
        if (this.containerRuntime.isExecuting(containerId)) throw new Error("CONTAINER_BUSY");
        await this.containerRuntime.stop(containerId);
      },
      startFromManifest: async (containerId) => { await this.containerRuntime.start(containerId); },
      waitForHealth: async (containerId, timeoutMs) => {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        do {
          try { if ((await this.containerRuntime.inspect(containerId)).status === "running") return true; } catch { /* retry until the bounded deadline */ }
          if (Date.now() >= deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        } while (true);
      },
    };
    this.sleepWake = new SleepWakeManager(
      lifecycleOptions?.adapter ?? defaultLifecycleAdapter,
      lifecycleOptions?.store ?? new EnvironmentTextStore(this.environment, `${this.home.metadata}/container-lifecycle.json`),
      lifecycleOptions?.policy ?? this.lifecycleBasePolicy,
    );
    const defaultReaperAdapter: ReaperAdapter | undefined = !lifecycleOptions && nativeMemoryPressure ? {
      availableMemoryBytes: async () => {
        const bytes = await nativeMemoryPressure.getAvailableMemoryBytes();
        if (!Number.isFinite(bytes) || bytes < 0) throw new Error("ANDROID_MEMORY_METRIC_INVALID");
        return Math.floor(bytes);
      },
      stopNonCriticalWorkers: async () => {
        let stopped = 0;
        for (const record of await this.sleepWake!.list()) {
          if (record.state !== "running" || this.containerRuntime.isExecuting(record.containerId)) continue;
          try { if (await this.sleepWake!.sleep(record.containerId, "memory-pressure")) stopped++; } catch { /* continue to independent workloads */ }
        }
        return stopped;
      },
      quarantineNonCriticalContainers: async () => {
        let quarantined = 0;
        for (const record of await this.sleepWake!.list()) {
          if (record.state === "quarantined" || this.containerRuntime.isExecuting(record.containerId)) continue;
          try { await this.sleepWake!.quarantine(record.containerId, "critical-memory-pressure"); quarantined++; } catch { /* continue to independent workloads */ }
        }
        return quarantined;
      },
    } : undefined;
    const reaperAdapter = lifecycleOptions?.reaperAdapter ?? defaultReaperAdapter;
    this.pressureReaper = reaperAdapter
      ? new ResourcePressureReaper(this.sleepWake, reaperAdapter, lifecycleOptions?.pressurePolicy)
      : null;
    this.processRegistry = createProcessRegistry();
    this.locks = createLockManager();
    this.sessions = createSessionManager();
    this.toolchains = createToolchainManager();
    this.containers = createUserspaceContainerBackend();
    this.containers.registerImage(ubuntuImageManifest(this.home));
    this.linux = new LinuxRuntime(this.environment, this.home);
    this.containerRuntime = createProotContainerManager(this.environment, this.home);
    this.containerRuntime.registerImage(UBUNTU_IMAGE);
    this.workspaceBuilder = createAIWorkspaceBuilder(this.containerRuntime);
    this.projectGenerator = createAIProjectGenerator(this.containerRuntime, this.workspaceBuilder);
    this.codingAgent = createAICodingAgent(this.containerRuntime, this.workspaceBuilder);
    this.codingBrain = createLLMCodingBrain(this.containerRuntime);
    this.persistentWorkspace = createPersistentAIWorkspace(this.environment, this.home);
    this.projectMemory = createAIProjectMemory(this.environment, this.home);
    this.oneClickAppFactory = createOneClickAppFactory(this);
    this.agents = createAgentManager(this.environment);
    this.bridge = createInMemoryAndroidBridge();
    this.privileges = {
      none: new NoneProvider(),
      shizuku: new ShizukuProvider(options.shizukuAvailable ?? false),
      root: new RootProvider(options.rootAvailable ?? false),
    };
    this.native = createNativeContainerRuntime();
    this.recovery = createRecoveryManager();
    this.recovery.setEventSink(async (event) => {
      await this.timeline.append({ type: event.type, actor: "runtime", level: event.level, payload: event.payload });
    });
    this.supervisor = new RuntimeSupervisor(this.processRegistry, async (process) => {
      try {
        await this.failureJournal.record(
          "WATCHDOG_HEALTH_FAILED",
          process.kind || "process",
          `watchdog failed: ${process.id} (${process.label || ""})`,
          { processId: process.id, kind: process.kind || "" },
        );
      } catch {
        /* non-fatal */
      }
      if (process.metadata?.manifestManaged === "true") {
        const stopped = await this.inContainerSupervisor?.stopFailedProcess(process) ?? false;
        if (!stopped) this.processRegistry.patchMetadata(process.id, { health: "quarantined", watchdogFailureAt: String(Date.now()), watchdogStopFailed: "true" });
        return;
      }
      this.processRegistry.unregister(process.id);
    });
    const manifestAdapters = options.enhancements?.manifest;
    this.inContainerSupervisor = manifestAdapters
      ? new InContainerSupervisor(this.processRegistry, this.supervisor, this.journal, manifestAdapters.processAdapter, manifestAdapters.manifestAdapter)
      : null;
    this.supervisor.setEventSink(async (event) => {
      await this.timeline.append({ type: event.type, actor: "runtime", projectId: event.projectId, level: event.level, payload: event.payload });
    });
    this.maintenance = new RuntimeMaintenanceCoordinator(this.taskGate, this.journal, this.processRegistry, {
      tickSupervisor: async () => {
        if (this.inContainerSupervisor) await this.inContainerSupervisor.tick();
        else await this.supervisor.tick();
      },
      reapResources: async () => {
        if (!this.sleepWake) return;
        const before = await this.sleepWake.list();
        if (this.pressureReaper) await this.pressureReaper.reap();
        else await this.sleepWake.reapIdle();
        const after = await this.sleepWake.list();
        for (const record of after) {
          const oldState = before.find((item) => item.containerId === record.containerId)?.state;
          if (oldState === "running" && record.state === "sleeping") await this.timeline.append({ type: "container.sleep", actor: "runtime", payload: { containerId: record.containerId, reason: record.reason ?? "maintenance" } }).catch(() => undefined);
          if (oldState !== "quarantined" && record.state === "quarantined") await this.timeline.append({ type: "container.quarantine", actor: "runtime", level: "warn", payload: { containerId: record.containerId, reason: record.reason ?? "pressure" } }).catch(() => undefined);
        }
      },
      wakeContainer: async (containerId) => {
        if (await this.sleepWake?.wake(containerId)) await this.timeline.append({ type: "container.wake", actor: "runtime", payload: { containerId } }).catch(() => undefined);
      },
    });
    this.health = new RuntimeHealth(this.failureJournal);
    const nativeA11y = loadNativeAccessibilityModule();
    const unsupportedAccessibility = { status: async () => ({ state: "unsupported" as const, reason: "Android Accessibility native module is not installed on this platform/build." }), openSettings: async () => { throw new Error("ACCESSIBILITY_UNSUPPORTED"); }, getTree: async () => [], clickText: async () => false, tap: async () => false, swipe: async () => false, inputText: async () => false, systemKey: async () => false };
    this.devicePolicy = new DevicePolicy({ timeline: async (event) => { await this.timeline.append({ type: "device.policy", actor: "runtime", level: event.outcome === "blocked" ? "warn" : "info", payload: { operation: event.operation, capability: event.capability, outcome: event.outcome, durationMs: event.durationMs } }); } });
    const nativeAdapter = nativeA11y ? createNativeAccessibilityAdapter(nativeA11y) : unsupportedAccessibility;
    this.accessibility = new AccessibilityEngine(this.devicePolicy, nativeAdapter);
    this.wirelessAdb = new WirelessAdbManager(this.devicePolicy, nativeA11y ? createTermuxAdbPairingAdapter() : { pair: async () => ({ ok: false, message: "ADB is unsupported outside an Android native runtime." }), connect: async () => ({ ok: false, message: "ADB is unsupported outside an Android native runtime." }), list: async () => ({ ok: false, devices: [] }) });
    this.virtualDisplay = new VirtualDisplay(this.devicePolicy, nativeA11y ? createNativeVirtualDisplayAdapter(nativeA11y) : unsupportedVirtualDisplayAdapter);
    const nativeMemory = loadNativeMemoryPressureModule();
    this.deviceBridge = new DeviceBridge(this.devicePolicy, this.accessibility, this.wirelessAdb, this.virtualDisplay, undefined, nativeA11y ? createNativeLoopbackTransport(nativeA11y) : undefined, {
      readMetadata: async (item) => {
        const { getDeviceProfile } = await import("../lib/device-profile");
        const profile = await getDeviceProfile();
        return item === "device-model" ? profile.modelName : profile.osVersion;
      },
      readBattery: async () => {
        if (!nativeMemory) throw new Error("DEVICE_SENSORS_UNSUPPORTED");
        return nativeMemory.getDevicePowerState();
      },
    });
    this.deviceBridgeConfigured = options.deviceBridge !== undefined;
    this.device = new PolicyGatedDeviceAgentBridge(this.devicePolicy, options.deviceBridge ?? new UnavailableDeviceAgentBridge());
    this.deviceTools = new DeviceAgentTools(this.device);
    this.deviceAutomation = new DeviceAutomationAgent(this.device);
    this.backups = new BackupManager(
      this.home,
      this.runtimeIdentity,
      new TermuxBackupAdapter(this.environment, this.home),
      this.taskGate,
      this.journal,
      this.workspaceSnapshots,
    );
    this.backups.setEventSink(async (event) => {
      await this.timeline.append({ type: event.type, actor: "runtime", level: event.level, payload: event.payload });
    });
    const terminalAdapter =
      options.terminalAdapter ?? createTermuxTerminalBackend(this.environment);
    this.terminals = new TerminalSessionManager(terminalAdapter);

    const fixedPreferenceStore = (path: string): TerminalPreferenceStore => ({
      get: async () => (await this.environment.exists(path) ? this.environment.read(path) : null),
      set: async (_key, value) => this.environment.write(path, value),
    });
    this.terminalTheme = new TerminalTheme(fixedPreferenceStore(`${this.home.metadata}/terminal-theme.json`));
    this.terminalFont = new TerminalFont(fixedPreferenceStore(`${this.home.metadata}/terminal-font.json`));
    this.terminalUx = new TerminalUXSessionManager(
      options.terminalSessionStore ?? createVolatileTerminalSessionStore(),
      {
        createProjectSession: async (projectId, projectRoot) => {
          const session = await this.openTerminalForProject(projectId, projectRoot);
          return { id: session.id, cwd: session.cwd, env: { AI_BUILDER_HOME: session.home ?? this.home.root, PWD: session.cwd, PROJECT_ROOT: session.projectRoot ?? session.cwd } };
        },
        restoreProjectSession: async (projectId, cwd, _env, projectRoot) => {
          const session = await this.openTerminalForProjectAtCwd(projectId, cwd, projectRoot);
          return { id: session.id, cwd: session.cwd, env: { AI_BUILDER_HOME: session.home ?? this.home.root, PWD: session.cwd, PROJECT_ROOT: session.projectRoot ?? session.cwd } };
        },
        closeSession: async (sessionId) => {
          await this.terminals?.close(sessionId);
          this.processRegistry.unregister(`terminal-${sessionId}`);
        },
        send: async (sessionId, text) => {
          const session = this.terminals?.get(sessionId);
          if (!session) throw new Error("TERMINAL_SESSION_UNAVAILABLE");
          await session.write(text);
        },
        isAttached: (sessionId) => Boolean(this.terminals?.has(sessionId)),
      },
    );

    this.portForwardPolicy = new PortForwardPolicy();
    const portForwardTimeline = async (event: Parameters<NonNullable<ConstructorParameters<typeof PortForwardManager>[3]>>[0]) => {
      await this.timeline.append({
        type: "network.portforward",
        actor: event.source === "agent" ? "agent" : "runtime",
        level: event.outcome === "denied" ? "warn" : event.outcome === "failed" ? "error" : "info",
        payload: { operation: event.operation, outcome: event.outcome, ruleId: event.ruleId, hostPort: event.hostPort, reason: event.reason, source: event.source },
      });
    };
    const portForwardStore = new PortForwardStore(
      new EnvironmentTextStore(this.environment, `${this.home.metadata}/port-forwards.json`),
      this.portForwardPolicy,
    );
    this.portForwards = new PortForwardManager(
      portForwardStore,
      this.portForwardPolicy,
      options.enhancements?.networking?.transport ?? new SocatPortForwardTransport(this.environment, this.home.root),
      portForwardTimeline,
    );

    const interceptorTimeline = async (event: Parameters<NonNullable<ConstructorParameters<typeof InterceptorPolicy>[0]>>[0]) => {
      await this.timeline.append({
        type: "network.interceptor",
        actor: event.source === "agent" ? "agent" : event.source === "user" ? "user" : "runtime",
        level: event.outcome === "denied" ? "warn" : event.outcome === "failed" ? "error" : "info",
        payload: { operation: event.operation, outcome: event.outcome, reason: event.reason, source: event.source, ...(event.details ?? {}) },
      });
    };
    this.interceptorPolicy = new InterceptorPolicy(interceptorTimeline);
    this.interceptorStore = new InterceptorStore(new EnvironmentTextStore(this.environment, `${this.home.metadata}/interceptor.json`));
    this.interceptorCapture = new InterceptorCapture();
    this.interceptorSessions = new InterceptorSessionStorage(new EnvironmentTextStore(this.environment, `${this.home.metadata}/interceptor-sessions.json`));
    this.interceptorEngine = new InterceptorEngine(
      this.interceptorStore,
      this.interceptorPolicy,
      this.interceptorCapture,
      new InterceptorRules(interceptorTimeline),
      options.enhancements?.interceptor?.runtimeAdapter,
      new InterceptorPathPolicy(this.environment, `${this.home.root}/interceptor-maps`, this.home.root),
      interceptorTimeline,
      options.enhancements?.interceptor?.fetcher,
      async (port) => (await this.portForwards.list()).some((status) => status.state === "listening" && status.rule.hostPort === port),
    );
    this.interceptorCertificate = new InterceptorCertificate(options.enhancements?.interceptor?.certificateAdapter, interceptorTimeline);
    this.interceptorReplay = new InterceptorReplay(this.interceptorPolicy, options.enhancements?.interceptor?.fetcher, interceptorTimeline);
    this.interceptorAgentBridge = new InterceptorAgentBridge(this.interceptorEngine, this.interceptorStore, this.interceptorCapture, this.interceptorReplay, interceptorTimeline);

    this.runtimeLiveStatus = new RuntimeLiveStatus(
      new StatusCollector({
        backends: () => this.userspace.snapshot().backends.map((backend) => ({
          id: backend.id,
          status: backend.health === "ready" ? "up" as const : backend.health === "degraded" ? "degraded" as const : "down" as const,
          latencyMs: backend.latencyMs,
        })),
        containers: async () => (await this.sleepWake?.list() ?? []).map((record) => ({
          id: record.containerId,
          name: record.containerId,
          state: record.state === "running" ? "running" as const : record.state === "sleeping" ? "sleeping" as const : "stopped" as const,
        })),
        processes: () => {
          const supervisor = this.supervisor.snapshot();
          return { total: this.processRegistry.size(), supervised: supervisor.watched, quarantined: supervisor.quarantined };
        },
        resources: () => ({}),
        portForwards: () => this.portForwards.activeCount,
        interceptorActive: () => this.interceptorEngine.getSnapshot().enabled,
        lastError: () => {
          const supervisor = this.supervisor.snapshot();
          return supervisor.failures > 0 ? `Supervisor reports ${supervisor.failures} failure(s).` : undefined;
        },
      }),
      async ({ previous, current }) => {
        await this.timeline.append({
          type: "runtime.status.change",
          actor: "runtime",
          level: current.lastError || current.processes.quarantined > (previous?.processes.quarantined ?? 0) ? "warn" : "info",
          payload: {
            backends: current.backends.map(({ id, status }) => ({ id, status })),
            quarantined: current.processes.quarantined,
            interceptorActive: current.interceptorActive === true,
            lastError: current.lastError,
          },
        });
      },
      1_000,
      () => this.tickMaintenance(),
      30_000,
    );

    this.agents.setHostHooks({
      ...options.agentHostHooks,
      openTerminalForProject: (projectId) => this.openTerminalForProject(projectId),
      portForward: async (agent, args) => {
        const action = args.action;
        if (action === "list") return this.portForwards.list();
        if (action === "remove") {
          if (typeof args.id !== "string" || args.id.length > 80) throw new Error("PORT_FORWARD_ID_INVALID");
          return this.portForwards.remove(args.id, agent.policy.allowedCapabilities.includes("network.portforward"), "agent");
        }
        if (action !== "add" || typeof args.name !== "string" || (args.protocol !== "tcp" && args.protocol !== "udp") || typeof args.hostPort !== "number" || typeof args.targetPort !== "number" || typeof args.targetHost !== "string") {
          throw new Error("PORT_FORWARD_ARGUMENT_INVALID");
        }
        const request: PortForwardRequest = {
          name: args.name,
          protocol: args.protocol,
          hostPort: args.hostPort,
          targetHost: args.targetHost,
          targetPort: args.targetPort,
          source: "agent" as PortForwardSource,
        };
        return this.portForwards.add(request, agent.policy.allowedCapabilities.includes("network.portforward"));
      },
      interceptor: async (agent, args) => {
        const hasCapability = agent.policy.allowedCapabilities.includes("network.intercept");
        if (args.action === "command") {
          if (typeof args.text !== "string" || args.text.length > 500) throw new Error("INTERCEPTOR_COMMAND_INVALID");
          return this.interceptorAgentBridge.executeNaturalLanguage(args.text, hasCapability);
        }
        const command = { ...args, action: args.action } as unknown as InterceptorAgentCommand;
        return this.interceptorAgentBridge.execute(command, hasCapability);
      },
      setTerminalTheme: async (_agent, themeId) => {
        const theme = await this.terminalTheme.setActiveTheme(themeId);
        return { id: theme.id, name: theme.name };
      },
      runShell: async (command, opts) => {
        const result = await this.environment.exec(command, {
          cwd: opts?.cwd,
          env: opts?.env,
          signal: opts?.signal,
        });
        if (result && typeof result === "object") {
          const r = result as {
            exitCode?: number;
            stdout?: string;
            stderr?: string;
          };
          return {
            exitCode: r.exitCode ?? null,
            stdout: r.stdout ?? "",
            stderr: r.stderr ?? "",
          };
        }
        return { exitCode: null, stdout: String(result ?? ""), stderr: "" };
      },
      runDeviceAutomation: (options) => this.runDeviceAutomation(options),
      runAndroidToolchain: (agent, args, projectRoot, signal) => this.runOfflineAndroidToolchain(agent, args, projectRoot, signal),
      runDeviceTool: async (tool, args) => {
        const a = args as Record<string, unknown>;
        const str = (key: string) => typeof a[key] === "string" ? a[key] as string : "";
        const num = (key: string) => typeof a[key] === "number" ? a[key] as number : Number.NaN;
        let request: DeviceBridgeRequest;
        switch (tool) {
          case "device.accessibility.status": request = { type: "screen.status" }; break;
          case "device.accessibility.tree": request = { type: "screen.tree" }; break;
          case "device.accessibility.clickText": request = { type: "input.clickText", text: str("text") }; break;
          case "device.accessibility.tap": request = { type: "input.tap", x: num("x"), y: num("y") }; break;
          case "device.accessibility.swipe": request = { type: "input.swipe", x1: num("x1"), y1: num("y1"), x2: num("x2"), y2: num("y2"), durationMs: a.durationMs === undefined ? 350 : num("durationMs") }; break;
          case "device.accessibility.inputText": request = { type: "input.text", text: str("text") }; break;
          case "device.accessibility.systemKey": request = { type: "input.key", key: str("key") as "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS" | "QUICK_SETTINGS" }; break;
          case "device.adb.pair": request = { type: "adb.pair", hostPort: str("hostPort"), pairingCode: str("pairingCode") }; break;
          case "device.adb.connect": request = { type: "adb.connect", hostPort: str("hostPort") }; break;
          case "device.adb.list": request = { type: "adb.list" }; break;
          case "device.adb.reconnect": request = { type: "adb.reconnect" }; break;
          case "device.virtualdisplay.status": request = { type: "virtualdisplay.status" }; break;
          case "device.virtualdisplay.displays": request = { type: "virtualdisplay.displays" }; break;
          case "device.virtualdisplay.tree": request = { type: "virtualdisplay.tree", displayId: num("displayId") }; break;
          case "device.virtualdisplay.capture": request = { type: "virtualdisplay.capture", displayId: a.displayId === undefined ? undefined : num("displayId") }; break;
          case "device.virtualdisplay.input": request = { type: "virtualdisplay.input", frameId: str("frameId"), x: num("x"), y: num("y") }; break;
          default: throw new Error("[POLICY_BLOCKED] tool is not allowlisted");
        }
        const result = await this.deviceBridge.requestFromTrustedHost(request);
        if (!result.ok) throw new Error(result.error ?? "DEVICE_BRIDGE_OPERATION_FAILED");
        return result.value;
      },
      wakeForTask: async (agent) => {
        const projectId = agent.projectId;
        const configuredId = projectId ? options.enhancements?.lifecycle?.containerIdForProject?.(projectId) : undefined;
        const projectContainer = !configuredId && projectId ? await this.containerRuntime.findByProjectId(projectId) : undefined;
        const containerId = configuredId ?? projectContainer?.id;
        if (!containerId) return;
        let lifecycle = (await this.sleepWake!.list()).find((record) => record.containerId === containerId);
        if (!lifecycle) {
          if (configuredId) throw new Error("LIFECYCLE_CONTAINER_NOT_REGISTERED");
          if (!projectContainer || !["running", "error"].includes(projectContainer.status)) return;
          await this.sleepWake!.register(containerId);
          lifecycle = (await this.sleepWake!.list()).find((record) => record.containerId === containerId);
        }
        if (!lifecycle) throw new Error("LIFECYCLE_STATE_UNAVAILABLE");
        if (lifecycle.state === "quarantined") throw new Error("CONTAINER_QUARANTINED: explicit restart is required");
        if (lifecycle.state === "running" && projectContainer?.status === "stopped") {
          await this.sleepWake!.sleep(containerId, "runtime-state-reconcile");
          lifecycle = (await this.sleepWake!.list()).find((record) => record.containerId === containerId);
        }
        if (lifecycle?.state === "sleeping") await this.maintenance.wakeContainer(containerId);
        else await this.sleepWake!.touch(containerId);
      },
      beforeFileWrite: async (agent, absolutePath) => {
        const projectRoot = agent.projectId ? await this.checkedAgentProjectRoot(agent) : null;
        if (!projectRoot) throw new Error("FILE_WRITE_PROJECT_ROOT_UNAVAILABLE");
        const canonicalRoot = normalizeAbsolutePosixPath(projectRoot);
        const canonicalTarget = normalizeAbsolutePosixPath(absolutePath);
        if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot.replace(/\/+$/, "")}/`)) throw new Error("FILE_WRITE_PATH_OUTSIDE_PROJECT");
        const taskId = `offline-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          const checkpoint = await this.checkpoints.createBeforeTask({ id: agent.id, projectId: projectRoot, policy: { allowedCapabilities: agent.policy.allowedCapabilities } }, taskId, "offline agent file write");
          await this.recordTimeline({ type: "checkpoint.created", actor: "runtime", projectId: agent.projectId, taskId, payload: { sha: checkpoint.sha } });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "CHECKPOINT_FAILED") : "CHECKPOINT_FAILED";
          if (code !== "NOT_GIT_REPOSITORY") throw new Error("FILE_WRITE_CHECKPOINT_FAILED");
          const snapshot = await this.workspaceSnapshots.createSnapshot(projectRoot, "offline-prewrite");
          await this.recordTimeline({ type: "checkpoint.created", actor: "runtime", projectId: agent.projectId, taskId, payload: { snapshotId: snapshot.id } });
        }
      },
      beforeTask: async (agent, taskId, promptSummary, request) => {
        const projectRoot = agent.projectId ? await this.checkedAgentProjectRoot(agent) : null;
        if (projectRoot) {
          try {
            const checkpoint = await this.checkpoints.createBeforeTask({ id: agent.id, projectId: projectRoot, policy: { allowedCapabilities: agent.policy.allowedCapabilities } }, taskId, promptSummary);
            await this.recordTimeline({ type: "checkpoint.created", actor: "runtime", projectId: agent.projectId, taskId, payload: { sha: checkpoint.sha } });
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "CHECKPOINT_FAILED") : "CHECKPOINT_FAILED";
            await this.recordTimeline({ type: "agent.error", actor: "runtime", projectId: agent.projectId, taskId, level: "warn", payload: { subsystem: "checkpoint", code } });
            if (code === "NOT_GIT_REPOSITORY") {
              try {
                const snapshot = await this.workspaceSnapshots.createSnapshot(projectRoot, "agent-pre-task");
                await this.recordTimeline({ type: "checkpoint.created", actor: "runtime", projectId: agent.projectId, taskId, payload: { snapshotId: snapshot.id } });
              } catch {
                throw new Error("TASK_CHECKPOINT_REQUIRED");
              }
            } else {
              throw new Error("TASK_CHECKPOINT_REQUIRED");
            }
          }
        }
        await this.recordTimeline({ type: "task.start", actor: "agent", projectId: agent.projectId, taskId, payload: { tool: request.tool } });
        const provider = typeof request.args?.provider === "string" ? request.args.provider : "";
        if (provider) {
          const route = await resolveAgentProviderRoute(provider);
          const proxyConfig = await this.credentialProxy.start(provider, route);
          this.taskProxySessions.set(`${agent.id}:${taskId}`, proxyConfig.sessionId);
          return buildProxySafeEnvironment({}, proxyConfig);
        }
        return buildProxySafeEnvironment({});
      },
      afterTask: async (agent, taskId, result) => {
        const key = `${agent.id}:${taskId}`;
        const sessionId = this.taskProxySessions.get(key);
        this.taskProxySessions.delete(key);
        if (sessionId) { try { await this.credentialProxy.stopSession(sessionId); } catch { /* stop is best effort after task completion */ } }
        await this.recordTimeline({ type: "task.finish", actor: "agent", projectId: agent.projectId, taskId, level: result.ok ? "info" : "error", payload: { ok: result.ok, ...(result.error ? { error: result.error } : {}) } });
        try { if (result.ok) await this.inContainerSupervisor?.afterTask(agent.projectId); } catch (error) {
          const rawCode = error instanceof Error ? error.message : "UNKNOWN";
          const errorCode = /^[A-Z0-9_.:-]{1,80}$/i.test(rawCode) ? rawCode : "REDACTED";
          await this.recordTimeline({ type: "runtime.error", actor: "runtime", projectId: agent.projectId, taskId, level: "warn", payload: { area: "in-container-supervisor", stage: "after-task", errorCode } });
        }
      },
      revertCheckpoint: async (agent, taskId) => {
        if (!agent.projectId) throw new Error("CHECKPOINT_PROJECT_REQUIRED");
        const projectRoot = await this.checkedAgentProjectRoot(agent);
        await this.checkpoints.revertTask({ id: agent.id, projectId: projectRoot, policy: { allowedCapabilities: agent.policy.allowedCapabilities } }, taskId);
        await this.recordTimeline({ type: "task.revert", actor: "agent", projectId: agent.projectId, taskId, payload: {} });
      },
      writeManifest: async (agent, content) => {
        if (!agent.projectId) throw new Error("MANIFEST_PROJECT_REQUIRED");
        const checkpointRoot = await this.checkedAgentProjectRoot(agent);
        const manifestRoot = await this.checkedProjectRoot(agent.projectId);
        if (checkpointRoot !== manifestRoot) throw new ManifestError("APPLY_FAILED", "Manifest target does not match the checkpointed project root");
        await this.applyRuntimeManifest(agent.projectId, parseManifest(content));
      },
    });

    this.registerDefaultRecoveryActions();
    this.registerHealthChecks();
  }

  private async recordTimeline(event: TimelineEventInput): Promise<void> {
    try { await this.timeline.append(event); } catch { /* observability storage is best effort */ }
  }

  private async checkedProjectRoot(projectId: string): Promise<string> {
    const name = validateProjectName(projectId);
    const [homeRoot, projectsRoot, root] = await Promise.all([
      this.environment.resolvePath ? this.environment.resolvePath(this.home.root) : this.home.root,
      this.environment.resolvePath ? this.environment.resolvePath(this.home.projects) : this.home.projects,
      this.environment.resolvePath ? this.environment.resolvePath(`${this.home.projects}/${name}`) : `${this.home.projects}/${name}`,
    ]);
    const expected = `${projectsRoot.replace(/[\\/]+$/, "")}/${name}`;
    const homePrefix = `${homeRoot.replace(/[\\/]+$/, "")}/`;
    if (root !== expected || !projectsRoot.startsWith(homePrefix) || !root.startsWith(`${projectsRoot.replace(/[\\/]+$/, "")}/`)) throw new Error("PROJECT_PATH_INVALID");
    return root;
  }

  private async checkedActiveProjectRoot(pathInput: string): Promise<string> {
    if (!this.environment.resolvePath || typeof pathInput !== "string" || !pathInput.startsWith("/") || pathInput.includes("\0")) {
      throw new Error("PROJECT_PATH_INVALID");
    }
    const [homeRoot, root] = await Promise.all([
      this.environment.resolvePath(this.home.root),
      this.environment.resolvePath(pathInput),
    ]);
    const prefix = `${homeRoot.replace(/[\\/]+$/, "")}/`;
    if (root === homeRoot || !root.startsWith(prefix)) throw new Error("PROJECT_PATH_INVALID");
    return root;
  }

  private async checkedAgentProjectRoot(agent: { projectId?: string; projectRoot?: string }): Promise<string> {
    if (agent.projectRoot) return this.checkedActiveProjectRoot(agent.projectRoot);
    if (agent.projectId) return this.checkedProjectRoot(agent.projectId);
    throw new Error("PROJECT_PATH_INVALID");
  }

  /** Forward React Native AppState changes to the lifecycle policy. */
  setAppLifecycleState(state: AppLifecycleState): void {
    this.sleepWake?.setAppState(state);
    this.runtimeLiveStatus.setAppState(state === "active" ? "active" : "background");
    if (state === "active" && this.portForwardAutoRestore) void this.portForwards.applyAll().catch(() => undefined);
    else void this.portForwards.stopActive("app-background").catch(() => undefined);
    const lifecycle = this.offlineModelServices?.lifecycle;
    if (lifecycle) void lifecycle.onBackground(state !== "active").catch(() => undefined);
  }

  /** Instantiate Android ComponentCallbacks2 only after the app has subscribed to its JS event. */
  async primeMemoryPressureMonitoring(): Promise<boolean> {
    const native = loadNativeMemoryPressureModule();
    if (!native) return false;
    try {
      const available = await native.getAvailableMemoryBytes();
      return Number.isFinite(available) && available >= 0;
    } catch {
      return false;
    }
  }

  /** Forward a host memory-warning event to an already initialized local model; no polling is started. */
  async notifyOfflineMemoryPressure(): Promise<boolean> {
    const lifecycle = this.offlineModelServices?.lifecycle;
    let handled = false;
    if (lifecycle) { try { await lifecycle.onMemoryPressure(); handled = true; } catch { /* continue to independent host pressure handlers */ } }
    if (this.pressureReaper) {
      try {
        const before = await this.sleepWake?.list() ?? [];
        await this.pressureReaper.reap();
        handled = true;
        const after = await this.sleepWake?.list() ?? [];
        for (const record of after) {
          const oldState = before.find((item) => item.containerId === record.containerId)?.state;
          if (oldState === "running" && record.state === "sleeping") await this.recordTimeline({ type: "container.sleep", actor: "runtime", payload: { containerId: record.containerId, reason: record.reason ?? "memory-pressure" } });
          if (oldState !== "quarantined" && record.state === "quarantined") await this.recordTimeline({ type: "container.quarantine", actor: "runtime", level: "warn", payload: { containerId: record.containerId, reason: record.reason ?? "critical-memory-pressure" } });
        }
      } catch { /* host lifecycle remains best effort */ }
    }
    return handled;
  }

  private async getOfflineModelServices(): Promise<RuntimeOfflineModelServices> {
    if (this.offlineModelServices) return this.offlineModelServices;
    if (this.offlineModelServicesPromise) return this.offlineModelServicesPromise;
    const task = (async () => {
      const { localModelEngine } = await import("../lib/local-model");
      const engine = localModelEngine as unknown as RuntimeOfflineModelServices["engine"];
      const lifecycle = new GGUFLifecycle(engine, {
        keepAliveMs: 90_000,
        onEvent: (event) => {
          void this.recordTimeline({ type: "gguf.lifecycle", actor: "runtime", level: event.action.includes("failed") ? "warn" : "info", payload: { action: event.action, state: event.state, ...(event.reason ? { reason: event.reason } : {}), ...(event.mode ? { mode: event.mode } : {}) } });
        },
      });
      await lifecycle.onPerformanceModeChange(this.currentPerformanceMode);
      const services: RuntimeOfflineModelServices = { engine, lifecycle };
      this.offlineModelServices = services;
      return services;
    })();
    this.offlineModelServicesPromise = task;
    try { return await task; }
    finally { if (this.offlineModelServicesPromise === task) this.offlineModelServicesPromise = null; }
  }

  private offlineProjectPath(projectRoot: string, pathInput: unknown): string {
    if (typeof pathInput !== "string" || !pathInput.trim() || pathInput.length > 800 || pathInput.includes("\0") || pathInput.includes("\\")) {
      throw new Error("OFFLINE_TOOL_PATH_INVALID");
    }
    const input = pathInput.trim();
    if (input.split("/").includes("..")) throw new Error("OFFLINE_TOOL_PATH_INVALID");
    const candidate = input.startsWith("/") ? input.replace(/\/+$/, "") || "/" : `${projectRoot.replace(/\/+$/, "")}/${input.replace(/^(?:\.\/)+/, "")}`;
    if (candidate !== projectRoot && !candidate.startsWith(`${projectRoot.replace(/\/+$/, "")}/`)) throw new Error("OFFLINE_TOOL_PATH_OUTSIDE_PROJECT");
    if (/(?:^|\/)\.git(?:\/|$)|(?:^|\/)\.env(?:\.[^/]*)?(?:\/|$)|(?:^|\/)(?:\.ssh|secrets?|credentials?)(?:\.[^/]*)?(?:\/|$)|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key)(?:\.[^/]*)?$/i.test(candidate) || /\.(?:pem|p12|pfx|jks|keystore)$/i.test(candidate)) {
      throw new Error("OFFLINE_TOOL_SENSITIVE_PATH_BLOCKED");
    }
    return candidate;
  }

  private offlineBuildConfigWriteBlocked(projectPath: string): boolean {
    const base = projectPath.slice(projectPath.lastIndexOf("/") + 1).toLowerCase();
    const segments = projectPath.toLowerCase().split("/").filter(Boolean);
    if (segments.some((segment) => segment === "gradle" || segment === ".gradle" || segment === "buildsrc" || segment === "build-logic")) return true;
    return new Set([
      "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
      "app.json", "ai_builder_android_identity.json", "gradle.properties", "gradle-wrapper.properties",
      "settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "local.properties",
      "gradle-wrapper.jar", "gradlew", "gradlew.bat", "libs.versions.toml", "gradle.lockfile",
    ]).has(base) || /\.gradle(?:\.kts)?$/.test(base) || /^app\.config\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(base) || /\.(?:lock|lockfile)$/.test(base);
  }

  private createAndroidToolchainProductionHost(): AndroidToolchainProductionHost {
    if (!this.environment.resolvePath) throw new Error("ANDROID_TOOLCHAIN_CANONICAL_PATH_UNAVAILABLE");
    return {
      resolvePath: (path) => this.environment.resolvePath!(path),
      exists: (path) => this.environment.exists(path),
      readText: (path) => this.environment.read(path),
      build: async (context) => {
        if (context.signal?.aborted) return { ok: false, failureCode: "ABORTED" };
        if (context.preset.variant !== "debug") return { ok: false, failureCode: "OFFLINE_AGENT_RELEASE_BUILD_NOT_ALLOWED" };
        const result = await runAndroidToolchainBuildOnly(context.projectRoot);
        return context.signal?.aborted ? { ok: false, failureCode: "ABORTED" } : result;
      },
      sign: async (context, artifact) => {
        if (context.signal?.aborted) return { ok: false, failureCode: "ABORTED" };
        const signed = await runAndroidToolchainSign(context.projectRoot, artifact.artifactPath);
        if (context.signal?.aborted) return { ok: false, failureCode: "ABORTED" };
        return signed.ok && signed.artifactPath
          ? { ok: true, artifactPath: signed.artifactPath }
          : { ok: false, failureCode: signed.failureCode ?? "APK_V1_V2_V3_SIGNING_FAILED" };
      },
      verify: async (context, artifactPath, requireV123) => {
        if (context.signal?.aborted) return { verified: false, artifactPath, regularFile: false, sha256: "", applicationId: "", errors: ["ABORTED"] };
        const result = await verifyAndroidToolchainArtifact(context.projectRoot, artifactPath, requireV123);
        return context.signal?.aborted ? { ...result, verified: false, errors: [...result.errors, "ABORTED"] } : result;
      },
      install: async (context, artifact) => {
        if (context.signal?.aborted) return { ok: false, failureCode: "ABORTED" };
        if (!this.devicePolicy.isGranted("device.adb")) return { ok: false, failureCode: "DEVICE_ADB_CAPABILITY_REQUIRED" };
        try {
          if (!this.deviceBridgeConfigured) this.useDeviceBridge(this.createTermuxAdbDeviceBridge());
          if (!(await this.device.isAvailable())) return { ok: false, failureCode: "DEVICE_BRIDGE_UNAVAILABLE" };
          if (context.signal?.aborted) return { ok: false, failureCode: "ABORTED" };
          const installed = await this.device.install(artifact.artifactPath);
          return installed.exitCode === 0
            ? { ok: true, installedApplicationId: artifact.applicationId }
            : { ok: false, failureCode: "DEVICE_INSTALL_FAILED" };
        } catch {
          return { ok: false, failureCode: "DEVICE_INSTALL_FAILED" };
        }
      },
    };
  }

  private async runOfflineAndroidToolchain(
    agent: AgentSession,
    args: Record<string, unknown>,
    projectRoot: string,
    signal?: AbortSignal,
  ): Promise<AndroidToolchainResult | Readonly<{ ok: false; error: string }>> {
    const session = this.offlineToolchainSessions.get(agent.id);
    if (!session) return { ok: false, error: "ANDROID_TOOLCHAIN_NOT_AUTHORIZED" };
    if (signal?.aborted) return { ok: false, error: "ABORTED" };
    if (Object.keys(args).some((key) => key !== "variant" && key !== "install")) return { ok: false, error: "ANDROID_TOOLCHAIN_ARGUMENTS_INVALID" };
    const variant = args.variant === undefined ? "debug" : args.variant;
    if (variant !== "debug") return { ok: false, error: "OFFLINE_AGENT_RELEASE_BUILD_NOT_ALLOWED" };
    if (args.install !== undefined && typeof args.install !== "boolean") return { ok: false, error: "ANDROID_TOOLCHAIN_ARGUMENTS_INVALID" };
    const install = args.install === true;
    let installPermission = false;
    let installConsent = false;
    if (install) {
      installPermission = session.allowDeviceInstall && this.devicePolicy.isGranted("device.adb");
      if (!installPermission || !session.confirmDeviceInstall) return { ok: false, error: "INSTALL_REQUIRES_EXPLICIT_PERMISSION_AND_CONSENT" };
      try {
        installConsent = await session.confirmDeviceInstall({ projectId: session.projectId, applicationId: session.expectedIdentity.applicationId, variant: "debug" });
      } catch {
        installConsent = false;
      }
      if (!installConsent || signal?.aborted) return { ok: false, error: installConsent ? "ABORTED" : "INSTALL_CONSENT_DENIED" };
    }
    const adapter = createAndroidToolchainProductionAdapter(this.createAndroidToolchainProductionHost());
    return runAndroidToolchainCoordinator(adapter, {
      projectRoot,
      expectedIdentity: session.expectedIdentity,
      variant: "debug",
      maxRepairAttempts: 0,
      install,
      installPermission,
      installConsent,
      signal,
    });
  }

  /** Run the on-device GGUF agent inside an ephemeral project-isolated AgentManager session. */
  async runOfflineAgent(projectIdInput: string, prompt: string, options: RuntimeOfflineAgentOptions = {}): Promise<string> {
    if (options.signal?.aborted) throw new Error("OFFLINE_AGENT_ABORTED");
    const projectId = validateProjectName(projectIdInput);
    const { loadActiveProject } = await import("../lib/active-project");
    const activeProject = await loadActiveProject();
    if (!activeProject || activeProject.id !== projectId) throw new Error("OFFLINE_AGENT_PROJECT_NOT_ACTIVE");
    const projectRoot = await this.checkedActiveProjectRoot(activeProject.path);
    if (!(await this.environment.exists(projectRoot))) throw new Error("OFFLINE_AGENT_PROJECT_NOT_FOUND");
    const { engine, lifecycle } = await this.getOfflineModelServices();
    const allowWrites = options.allowFileWrites === true;
    let toolchainIdentity: AndroidAppIdentity | null = null;
    if (options.allowAndroidToolchain === true) {
      try { toolchainIdentity = await readAndroidProjectIdentity(projectRoot, this.createAndroidToolchainProductionHost()); }
      catch { toolchainIdentity = null; }
    }
    const allowedCapabilities: AgentCapability[] = ["filesystem"];
    if (allowWrites) allowedCapabilities.push("filesystem.write");
    if (toolchainIdentity) allowedCapabilities.push("android.toolchain");
    const agentId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agent = this.agents.create({
      id: agentId,
      projectId,
      projectRoot,
      policy: {
        allowedCapabilities,
        projectIsolation: true,
        homeIsolation: true,
        maxConcurrentTools: 1,
      },
    });
    if (toolchainIdentity) this.offlineToolchainSessions.set(agent.id, {
      projectId,
      expectedIdentity: toolchainIdentity,
      allowDeviceInstall: options.allowDeviceInstall === true,
      confirmDeviceInstall: options.confirmDeviceInstall,
    });
    const processId = `offline-agent-${agent.id}`;
    this.processRegistry.register({ id: processId, kind: "agent", projectId, startedAt: Date.now(), label: `offline-agent:${projectId}`, metadata: { watchdog: "true" } });
    const abortSession = () => this.agents.stop(agent.id);
    options.signal?.addEventListener("abort", abortSession, { once: true });

    const runTool = async (tool: string, args: Readonly<Record<string, unknown>>, capability: AgentCapability, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("ABORTED");
      const result = await this.agents.execute(agent.id, { tool, args, capability });
      if (signal?.aborted) throw new Error("ABORTED");
      if (!result.ok) throw new Error("OFFLINE_TOOL_BLOCKED");
      return result.output ?? "";
    };
    const pathArg = (args: Readonly<Record<string, unknown>>, allowedKeys: readonly string[]) => {
      if (Object.keys(args).some((key) => !allowedKeys.includes(key))) throw new Error("INVALID_ARGUMENTS");
      return this.offlineProjectPath(projectRoot, args.path);
    };
    const tools: OfflineTool[] = [
      { name: "fs.list", description: "List non-secret regular files at a project path; max depth is four. Use absolute project paths returned by this tool.", execute: (args, context) => {
        const directory = pathArg(args, ["path", "maxDepth"]);
        const maxDepth = args.maxDepth === undefined ? 2 : Number(args.maxDepth);
        if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4) throw new Error("INVALID_ARGUMENTS");
        return runTool("fs.list", { path: directory, maxDepth }, "filesystem", context.signal);
      } },
      { name: "fs.read", description: "Read a non-secret regular file inside the current project; sensitive paths are denied.", execute: (args, context) => {
        const filePath = pathArg(args, ["path"]);
        return runTool("fs.read", { path: filePath }, "filesystem", context.signal);
      } },
      { name: "fs.exists", description: "Check whether a non-secret project path exists.", execute: (args, context) => {
        const filePath = pathArg(args, ["path"]);
        return runTool("fs.exists", { path: filePath }, "filesystem", context.signal);
      } },
    ];
    if (allowWrites) {
      tools.push(
        { name: "fs.mkdir", description: "Create a directory inside the current project; each mutation is checkpointed first.", execute: (args, context) => {
          const directory = pathArg(args, ["path"]);
          if (this.offlineBuildConfigWriteBlocked(directory)) throw new Error("OFFLINE_BUILD_CONFIG_PROTECTED");
          return runTool("fs.mkdir", { path: directory }, "filesystem.write", context.signal);
        } },
        { name: "fs.write", description: "Write at most 32 KB to a non-secret path inside the current project; a private checkpoint or snapshot is required first.", execute: (args, context) => {
          const filePath = pathArg(args, ["path", "content"]);
          if (this.offlineBuildConfigWriteBlocked(filePath)) throw new Error("OFFLINE_BUILD_CONFIG_PROTECTED");
          if (typeof args.content !== "string" || args.content.length > 32_000 || args.content.includes("\0")) throw new Error("INVALID_ARGUMENTS");
          return runTool("fs.write", { path: filePath, content: args.content }, "filesystem.write", context.signal);
        } },
      );
    }
    if (toolchainIdentity) {
      tools.push({
        name: "android.toolchain.run",
        description: "Run a host-controlled, cached/offline Android assembleDebug, verify the APK, and sign with the app-owned debug signer. No shell, network, release signing, or device capability is exposed. Install is omitted unless separately granted and confirmed for this exact package.",
        execute: (args, context) => {
          if (Object.keys(args).some((key) => key !== "variant" && key !== "install") ||
              (args.variant !== undefined && args.variant !== "debug") ||
              (args.install !== undefined && typeof args.install !== "boolean")) throw new Error("INVALID_ARGUMENTS");
          return runTool("android.toolchain.run", { variant: "debug", ...(args.install === true ? { install: true } : {}) }, "android.toolchain", context.signal);
        },
      });
    }

    const hybrid = {
      enabled: true as const,
      credentialProxy: {
        complete: async (request: Readonly<{ messages: readonly OfflineChatTurn[]; signal?: AbortSignal }>) => {
          const response = await this.credentialProxy.forward({
            provider: "openrouter",
            path: "/chat/completions",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "openrouter/free", messages: request.messages, stream: false }),
            model: "openrouter/free",
            signal: request.signal,
          });
          const declaredLength = Number(response.headers.get("content-length") || 0);
          if (!response.ok || declaredLength > 1_000_000) {
            try { await response.body?.cancel(); } catch { /* bounded, best-effort */ }
            throw new Error("HYBRID_PROVIDER_FAILED");
          }
          const body = await response.text();
          if (body.length > 1_000_000) throw new Error("HYBRID_RESPONSE_TOO_LARGE");
          let parsed: any;
          try { parsed = JSON.parse(body); } catch { throw new Error("HYBRID_RESPONSE_INVALID"); }
          const content = parsed?.choices?.[0]?.message?.content;
          if (typeof content !== "string") throw new Error("HYBRID_RESPONSE_INVALID");
          return content;
        },
      },
    };
    const runtime = new OfflineAgentRuntime({
      model: { chat: (history, generation, language, systemPrompt, signal) => engine.chat(history, generation, language, systemPrompt, signal) },
      lifecycle,
      tools,
      limits: { maxToolSteps: toolchainIdentity ? 8 : 4 },
      hybrid,
      language: options.language ?? "en",
      onEvent: (event: OfflineAgentEvent) => {
        void this.recordTimeline({ type: "offline.agent", actor: "agent", projectId, taskId: agent.id, level: event.action === "failed" || event.action === "cancelled" ? "warn" : "info", payload: { action: event.action, ...(event.step !== undefined ? { step: event.step } : {}), ...(event.toolName ? { toolName: event.toolName } : {}) } });
      },
    });
    try {
      return await runtime.run({ prompt, history: options.history, signal: options.signal, allowHybridFallback: options.allowHybridFallback === true });
    } finally {
      options.signal?.removeEventListener("abort", abortSession);
      this.offlineToolchainSessions.delete(agent.id);
      this.agents.remove(agent.id);
      this.processRegistry.unregister(processId);
    }
  }

  /** Run a single one-shot supervisor/pressure pass; the host owns scheduling and AppState cadence. */
  async tickMaintenance() { return this.maintenance.tick(); }

  /** Start an authenticated native proxy session and return only validated dummy client settings. */
  async startAgentCredentialProxy(provider: string): Promise<Record<string, string>> {
    const config = await this.credentialProxy.start(provider);
    return buildProxySafeEnvironment({}, config);
  }

  /** Stop one ephemeral native proxy session, or all sessions when no provider is specified. */
  async stopAgentCredentialProxy(provider?: string): Promise<void> {
    if (provider) await this.credentialProxy.stop(provider);
    else await this.credentialProxy.stopAll();
  }

  /** Persist and apply a validated project manifest through explicit host-supplied process adapters. */
  async applyRuntimeManifest(projectId: string, manifestInput: RuntimeManifest): Promise<readonly string[]> {
    if (!this.inContainerSupervisor) throw new ManifestError("APPLY_FAILED", "No real manifest process adapter is configured");
    const name = validateProjectName(projectId);
    const root = await this.checkedProjectRoot(name);
    if (!(await this.environment.exists(root))) throw new ManifestError("APPLY_FAILED", "Project directory is unavailable");
    const manifest = parseManifest(JSON.stringify(manifestInput));
    const configDir = `${root}/.aib`;
    const configPath = `${configDir}/runtime.yaml`;
    const canonicalConfig = this.environment.resolvePath ? await this.environment.resolvePath(configPath) : configPath;
    if (!canonicalConfig.startsWith(`${root.replace(/[\\/]+$/, "")}/`)) throw new ManifestError("APPLY_FAILED", "Manifest path escaped project root");
    const previousExists = await this.environment.exists(canonicalConfig);
    const previousContents = previousExists ? await this.environment.read(canonicalConfig) : null;
    await this.environment.mkdir(configDir);
    const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    try {
      await this.environment.write(canonicalConfig, `${JSON.stringify(manifest, null, 2)}\n`);
      const ids = await this.userspace.applyManifest(manifest, name);
      await this.recordTimeline({ type: "manifest.applied", actor: "runtime", projectId: name, payload: { processCount: ids.length } });
      return ids;
    } catch (error) {
      try {
        if (previousExists && previousContents !== null) await this.environment.write(canonicalConfig, previousContents);
        else {
          const removed = await this.environment.exec(`rm -f -- ${shellQuote(canonicalConfig)}`, { cwd: root, timeoutMs: 5_000 });
          if (removed.exitCode !== 0) throw new Error("manifest rollback unlink failed");
        }
      } catch {
        throw new ManifestError("APPLY_FAILED", "Manifest apply failed and persisted configuration rollback was unsuccessful");
      }
      throw error;
    }
  }

  /** Load the project's .aib/runtime.yaml (JSON is also accepted) and apply its services. */
  async applyProjectRuntimeManifest(projectId: string): Promise<readonly string[]> {
    const root = await this.checkedProjectRoot(projectId);
    const file = `${root}/.aib/runtime.yaml`;
    if (!(await this.environment.exists(file))) throw new ManifestError("APPLY_FAILED", "Project runtime manifest does not exist");
    if (!this.environment.resolvePath) throw new ManifestError("APPLY_FAILED", "Manifest path containment cannot be verified");
    const canonicalRoot = await this.environment.resolvePath(root);
    const canonicalManifestPath = await this.environment.resolvePath(file);
    if (!canonicalManifestPath.startsWith(`${canonicalRoot.replace(/[\\/]+$/, "")}/`)) throw new ManifestError("APPLY_FAILED", "Manifest path escaped project root");
    return this.applyRuntimeManifest(projectId, parseManifest(await this.environment.read(canonicalManifestPath)));
  }

  /** Seed files from one typed preset and then apply its manifest. */
  async applyRuntimePreset(projectId: string, presetName: RuntimePresetName): Promise<readonly string[]> {
    const name = validateProjectName(projectId);
    const root = await this.checkedProjectRoot(name);
    const preset = getRuntimePreset(presetName);
    const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const previousFiles: Array<{ target: string; existed: boolean; contents: string | null }> = [];
    for (const [relative, content] of Object.entries(preset.seedFiles)) {
      if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").includes("..") || relative.includes("\0")) throw new ManifestError("APPLY_FAILED", "Preset contains an unsafe seed path");
      const target = `${root}/${relative}`;
      const canonical = this.environment.resolvePath ? await this.environment.resolvePath(target) : target;
      if (!canonical.startsWith(`${root.replace(/[\\/]+$/, "")}/`)) throw new ManifestError("APPLY_FAILED", "Preset seed path escaped project root");
      const existed = await this.environment.exists(canonical);
      previousFiles.push({ target: canonical, existed, contents: existed ? await this.environment.read(canonical) : null });
    }
    try {
      for (const [index, [relative, content]] of Object.entries(preset.seedFiles).entries()) {
        const target = previousFiles[index].target;
        const slash = target.lastIndexOf("/");
        if (slash > 0) await this.environment.mkdir(target.slice(0, slash));
        await this.environment.write(target, content);
      }
      return await this.applyRuntimeManifest(name, preset.manifest);
    } catch (error) {
      let rollbackFailed = false;
      for (const previous of [...previousFiles].reverse()) {
        try {
          if (previous.existed && previous.contents !== null) await this.environment.write(previous.target, previous.contents);
          else {
            const removed = await this.environment.exec(`rm -f -- ${shellQuote(previous.target)}`, { cwd: root, timeoutMs: 5_000 });
            if (removed.exitCode !== 0) throw new Error("preset seed rollback unlink failed");
          }
        } catch { rollbackFailed = true; }
      }
      if (rollbackFailed) throw new ManifestError("APPLY_FAILED", "Runtime preset apply failed and one or more seed files could not be rolled back");
      throw error;
    }
  }


  private registerHealthChecks(): void {
    this.health.registerRule(createSelfTestRule());
    this.health.registerRule(createIdentityRule(this.runtimeIdentity));
    this.health.registerRule(createUserspaceRuntimeRule(async () => {
      const s = await this.userspace.status();
      return { ready: s.ready, activeBackend: s.activeBackend, detail: s.probes.map(p => `${p.id}:${p.health}`).join(",") };
    }));

    const termuxExec = async (command: string, opts?: { timeoutMs?: number; cwd?: string }) => {
      const r = await this.environment.exec(command, {
        cwd: opts?.cwd ?? this.home.root,
        timeoutMs: opts?.timeoutMs ?? 15_000,
      });
      return {
        exitCode: normalizedCommandExitCode(r as { exitCode?: unknown; code?: unknown }),
        stdout: (r as { stdout?: string }).stdout ?? "",
        stderr: (r as { stderr?: string }).stderr ?? "",
      };
    };
    this.health.registerRule(createJavaRule(() => probeJava(termuxExec)));
    this.health.registerRule(createGradleRule(() => probeGradle(termuxExec)));
    this.health.registerRule(createNodeRule(() => probeNode(termuxExec)));
    this.health.registerRule(createSdkRule(() => probeSdk(termuxExec)));
    this.health.registerRule(createAdbRule(() => probeAdb(termuxExec)));
    this.health.registerRule(createProotRule(() => probeProotDistro(termuxExec)));
    this.health.registerRule(createTermuxSessionRule(() => probeTermuxSession(termuxExec)));
    this.health.registerRule(createDiskFreeRule(() => probeDiskFree(termuxExec)));
    this.health.registerRule(createGitRule(() => probeGit(termuxExec)));
    this.health.registerRule(createUnzipRule(() => probeUnzip(termuxExec)));
    this.health.registerRule(createDebianDistroRule(() => probeDebianDistro(termuxExec)));
    this.health.registerRule(createHomeLayoutRule(() => probeHomeLayout(termuxExec)));
    this.health.registerRule(createNdkRule(() => probeNdk(termuxExec)));
    this.health.registerRule(createAapt2Rule(() => probeAapt2(termuxExec)));
    this.health.registerRule(createShizukuRule(() => probeShizuku(termuxExec)));
    this.health.registerRule(createSupervisorRule(async () => {
      const s = this.supervisor.snapshot();
      if (s.status === "stopped") {
        return { ok: false, detail: "Supervisor stopped — open Runtime and Start" };
      }
      if (s.status === "quarantined" || s.status === "degraded") {
        return { ok: true, detail: `Supervisor ${s.status} · watched=${s.watched}`, warn: true };
      }
      return { ok: true, detail: `Supervisor ${s.status} · watched=${s.watched}` };
    }));
    this.health.registerRule(createJournalPendingRule(async () => (await this.journal.pending()).length));
    this.health.register({
      id: "home",
      check: async () => ({ level: "ok" as const, id: "home", message: `AI_BUILDER_HOME=${this.home.root}`, repairable: false, checkedAt: Date.now() }),
    });
  }

  /** Recover unfinished journal entries from a previous crash. */
  async recoverPendingTransactions(): Promise<{ recovered: number; failed: number }> {
    return this.transaction.recoverPending(async (entry) => {
      let outcome: "rolled_back" | "failed" = "failed";
      if (entry.operation === "backup:restore") {
        outcome = await this.backups.restoreTx.recoverInterruptedRestore(entry);
      }
      await this.failureJournal.record(
        "JOURNAL_PENDING",
        entry.operation,
        `Recovered stale transaction ${entry.id}: ${outcome}`,
        { transactionId: entry.id, outcome },
      );
      return outcome;
    });
  }

  async runRuntimeTask<T>(owner: string, fn: () => Promise<T> | T): Promise<T> {
    return this.taskGate.run("normal", owner, fn);
  }

  async runMaintenance<T>(owner: string, fn: () => Promise<T> | T): Promise<T> {
    return this.taskGate.run("maintenance", owner, fn);
  }

  async initUserspaceRuntime() {
    return this.userspace.initialize();
  }

  async userspaceStatus() {
    return this.userspace.status();
  }

  async userspaceExec(command: string, opts?: { cwd?: string; timeoutMs?: number }) {
    return this.userspace.exec({ command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
  }


  /** Keep a logical termux-bridge process in registry for supervisor (plan A2/A3). */
  ensureTermuxBridgeWatch(ok: boolean, detail?: string): void {
    const id = "termux-bridge-session";
    if (!ok) {
      // Keep entry so supervisor can see failed health; mark failed
      if (this.processRegistry.get(id)) {
        this.processRegistry.patchMetadata(id, {
          health: "failed",
          detail: (detail || "session-down").slice(0, 120),
        });
      } else {
        this.processRegistry.register({
          id,
          kind: "runtime",
          startedAt: Date.now(),
          label: detail || "termux-session",
          metadata: { watchdog: "true", source: "health", health: "failed" },
        });
      }
      return;
    }
    const existing = this.processRegistry.get(id);
    if (existing) {
      this.processRegistry.patchMetadata(id, {
        health: "ok",
        detail: (detail || "session-ok").slice(0, 120),
      });
      return;
    }
    this.processRegistry.register({
      id,
      kind: "runtime",
      startedAt: Date.now(),
      label: detail || "termux-session",
      metadata: { watchdog: "true", source: "health", health: "ok" },
    });
  }

  startSupervisor(intervalMs = 5000): void {
    this.supervisor.start(intervalMs, async () => {
      const report = await this.maintenance.tick();
      if (!report.supervisorOk || !report.reaperOk) {
        await this.recordTimeline({ type: "runtime.error", actor: "runtime", level: "warn", payload: { subsystem: "maintenance", supervisorOk: report.supervisorOk, reaperOk: report.reaperOk } });
      }
    });
  }
  stopSupervisor(): void { this.supervisor.stop(); }
  clearSupervisorQuarantine(processId?: string): void {
    this.supervisor.clearQuarantine(processId);
  }

  async shizukuSelfCheck(): Promise<{ ok: boolean; message: string }> {
    const { shizukuSelfCheck } = await import("../lib/shizuku-bridge");
    return shizukuSelfCheck();
  }

  async shizukuExec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string; via: string }> {
    const { shizukuExec } = await import("../lib/shizuku-bridge");
    return shizukuExec(command);
  }


  async createBackup(scope: "full" | "projects" | "sessions" | "agent" | "toolchains", destination: string) { return this.backups.create(scope, destination); }
  async restoreBackup(source: string, options?: { preBackupDestination?: string; skipPreBackup?: boolean }) {
    return this.backups.restore(source, options);
  }
  async inspectBackup(source: string) { return this.backups.inspect(source); }
  async listBackups(parentDir?: string) { return this.backups.list(parentDir); }
  async runHealthChecks() {
    const rows = await this.health.run();
    const session = rows.find((r) => r.id === "runtime.termux-session");
    if (session) {
      this.ensureTermuxBridgeWatch(session.level === "ok" || session.level === "info", session.message);
    }
    // Persist non-ok repairable results for later targeting
    for (const r of rows) {
      if (r.level === "error" || (r.level === "warn" && r.repairable)) {
        try {
          await this.failureJournal.record(
            r.level === "error" ? "HEALTH_ERROR" : "HEALTH_WARN",
            r.id,
            r.message,
            { level: r.level, repairable: String(!!r.repairable) },
          );
        } catch {
          /* non-fatal */
        }
      }
    }
    return rows;
  }

  /** Plan B4: export Health snapshot to home.logs/health-*.json */

  /** P2: durable profile zip (metadata/projects) — survive uninstall when stored off-app. */
  async exportProfile(destPath?: string): Promise<{ ok: boolean; path?: string; message: string }> {
    const { exportProfileZip, defaultProfileExportPath } = await import("../lib/profile-transfer");
    const dest =
      (destPath && destPath.trim()) ||
      defaultProfileExportPath(this.home.root);
    return exportProfileZip(dest, this.home.root);
  }

  async importProfile(sourcePath: string): Promise<{ ok: boolean; path?: string; message: string }> {
    const { importProfileZip } = await import("../lib/profile-transfer");
    return importProfileZip(sourcePath, this.home.root);
  }

  async exportHealthReport(): Promise<{ path: string; count: number }> {
    const rows = await this.health.run();
    const session = rows.find((r) => r.id === "runtime.termux-session");
    if (session) {
      this.ensureTermuxBridgeWatch(session.level === "ok" || session.level === "info", session.message);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = this.home.logs;
    const path = `${dir}/health-${stamp}.json`;
    let privileges = null as unknown;
    try {
      privileges = await this.refreshPrivileges();
    } catch {
      privileges = this.getPrivileges();
    }
    let userspace: unknown = null;
    try {
      userspace = await this.userspace.status();
    } catch {
      userspace = null;
    }
    let openFailures: unknown[] = [];
    try {
      openFailures = await this.failureJournal.openFailures();
    } catch {
      openFailures = [];
    }
    const payload = {
      version: 2,
      appVersion: this.runtimeIdentity.appVersion,
      exportedAt: new Date().toISOString(),
      results: rows,
      supervisor: this.supervisor.snapshot(),
      processes: this.processRegistry.list().map((pr) => ({
        id: pr.id,
        kind: pr.kind,
        label: pr.label,
        watchdog: pr.metadata?.watchdog === "true",
      })),
      privileges,
      userspace,
      openFailures: openFailures.slice(0, 30),
      bootstrap: await this.bootstrapPipeline.load().catch(() => null),
    };
    await this.environment.mkdir(dir);
    await this.environment.write(path, JSON.stringify(payload, null, 2));
    try {
      const { persistentLogger } = await import("../lib/persistent-logger");
      persistentLogger.add("info", "Health", `export ${path} rules=${rows.length}`);
    } catch { /* optional */ }
    return { path, count: rows.length };
  }
  async lastStartupFailure() {
    return this.startupTrace.lastFailure();
  }

  async listOpenFailures() {
    return this.failureJournal.openFailures();
  }

  async listRecentFailures(limit = 20) {
    const all = await this.failureJournal.list();
    return all.slice(0, limit);
  }

  /** Bind real Termux stage runner (called once from lib/runtime-facade). */
  bindBootstrapRunner(
    runner: import("./runtime/BootstrapPipeline").StageRunner,
    expectedFingerprintForStage?: (stageId: import("./runtime/BootstrapPipeline").BootstrapStageId) => string | undefined,
  ): void {
    (this as { bootstrapPipeline: BootstrapPipeline }).bootstrapPipeline =
      createBootstrapPipeline(
          new EnvironmentTextStore(
            new AIBuilderTermuxEnvironment(this.home.root),
            `${this.home.metadata}/bootstrap-pipeline.json`,
          ),
          runner,
          expectedFingerprintForStage,
        );
    this.firstRunOrchestrator = this.createFirstRunOrchestrator();
  }

  async bootstrapState(): Promise<BootstrapPipelineState> {
    return this.bootstrapPipeline.load();
  }

  async bootstrapReset(): Promise<BootstrapPipelineState> {
    return this.bootstrapPipeline.reset();
  }

  async bootstrapRun(options?: {
    force?: boolean;
    onProgress?: (e: BootstrapProgressEvent) => void;
  }): Promise<BootstrapPipelineState> {
    return this.runMaintenance("bootstrap-pipeline", () =>
      this.bootstrapPipeline.run(options),
    );
  }

  /** Collects Termux/proot/rootfs/permission/network/storage facts without mutating the host. */
  async collectBootstrapDiagnostics() {
    let runtime: Awaited<ReturnType<AibUserspaceRuntime["status"]>> | null = null;
    try { runtime = await this.userspace.status(); } catch { /* represented as unknown/unavailable below */ }
    const probeFor = (id: string) => runtime?.probes.find((probe) => probe.id === id);
    const backendObservation = (id: string) => async () => {
      const probe = probeFor(id);
      if (!probe) return { status: "unknown" as const, detail: `${id} probe was unavailable.` };
      if (probe.health === "ready") return { status: "ok" as const, detail: `${id} backend passed its health probe.` };
      if (probe.health === "degraded") return { status: "unavailable" as const, detail: `${id} backend is present but not ready.` };
      return { status: "unavailable" as const, detail: `${id} backend is unavailable.` };
    };
    const prootProbe = probeFor("proot-distro");
    const diagnostics = new BootstrapDiagnostics({
      termux: { inspect: backendObservation("termux-native") },
      proot: { inspect: backendObservation("proot-distro") },
      rootfs: { inspect: async () => {
        if (prootProbe?.health === "ready") return { status: "ok", detail: "The configured proot rootfs passed its login probe." };
        if (/mismatch|wrong rootfs/i.test(prootProbe?.detail || "")) return { status: "wrong-rootfs", detail: "The configured rootfs did not match its expected distribution." };
        if (prootProbe) return { status: "unavailable", detail: "The configured proot rootfs is not ready." };
        return { status: "unknown", detail: "Rootfs health could not be checked." };
      } },
      permissions: { inspect: async () => {
        try {
          const { getEmbeddedTermuxRuntimeStatus } = await import("../lib/termux-bridge");
          const runtimeStatus = await getEmbeddedTermuxRuntimeStatus();
          if (!runtimeStatus) return { status: "unavailable", detail: "Bundled native runtime status is unavailable." };
          return runtimeStatus.ready
            ? { status: "ok", detail: "Bundled private bootstrap is present; no external permission is required. Execution still needs a live probe." }
            : { status: "unavailable", detail: "Bundled private bootstrap is missing or incomplete." };
        } catch { return { status: "unknown", detail: "Bundled runtime state could not be read." }; }
      } },
      network: { inspect: async () => {
        const observation = await probeInternetConnectivity();
        this.lastBootstrapOnline = observation.status === "ok" ? true : observation.status === "offline" ? false : "unknown";
        this.lastBootstrapNetworkAt = Date.now();
        return observation;
      } },
      storage: { inspect: async () => {
        try {
          const probe = await this.environment.exec(buildStorageAccessProbeCommand(this.home.root), { timeoutMs: 10_000 });
          const status = classifyStorageAccessProbeExitCode(probe.exitCode);
          if (status === "ok") return { status, detail: "Termux can read, traverse, and write the Android shared storage and AI Builder workspace." };
          if (status === "denied") return { status, detail: "Termux cannot read, traverse, or write the shared AI Builder workspace; check that its storage setup has been granted and the workspace exists." };
          return { status, detail: "Android shared-storage access could not be verified." };
        }
        catch { return { status: "unknown", detail: "Runtime storage accessibility could not be verified." }; }
      } },
    }, { record: async (event) => { await this.timeline.append({ type: "bootstrap.diagnostic", actor: "runtime", level: event.status === "ok" ? "info" : "warn", payload: { name: event.name, status: event.status } }); } });
    return diagnostics.collect();
  }

  /** Runs first-run/major-update bootstrap only when explicitly invoked by the UI or caller. */
  async runFirstRun(options?: Omit<FirstRunOptions, "targetVersion"> & { targetVersion?: string }): Promise<FirstRunResult> {
    const onProgress = (event: FirstRunProgress) => {
      try { options?.onProgress?.(event); } catch { /* UI progress listeners are best-effort */ }
      void this.timeline.append({ type: "bootstrap.progress", actor: "runtime", payload: { stage: event.stage, status: event.status } }).catch(() => undefined);
    };
    return this.runMaintenance("first-run-orchestration", () => this.firstRunOrchestrator.run({ targetVersion: options?.targetVersion || this.runtimeIdentity.appVersion, onProgress }));
  }

  /** Non-mutating startup check; callers must still explicitly invoke runFirstRun(). */
  async firstRunStatus(): Promise<FirstRunCheck> {
    return this.firstRunOrchestrator.inspect(this.runtimeIdentity.appVersion);
  }

  /** Restore only a previously saved user choice; a clean install stays in the safe Balanced default. */
  async initializePerformanceMode(): Promise<PerformanceModeName> {
    const mode = await this.performanceModes.restore();
    this.currentPerformanceMode = mode;
    this.applyLifecycleMode(mode);
    if (this.offlineModelServices) void this.offlineModelServices.lifecycle.onPerformanceModeChange(mode).catch(() => undefined);
    return mode;
  }

  /** Recommends a conservative profile from one-shot device facts; no polling or background mode changes occur. */
  async recommendPerformanceModeFromDevice(): Promise<PerformanceModeName> {
    const [{ getDeviceProfile }, { choosePerformanceMode }] = await Promise.all([
      import("../lib/device-profile"),
      import("./enhancements/performance/PerformanceMode"),
    ]);
    const device = await getDeviceProfile();
    const native = loadNativeMemoryPressureModule();
    let availableMemoryBytes: number | undefined;
    let batteryPercent: number | undefined;
    let pluggedIn: boolean | undefined;
    let lowPowerMode: boolean | undefined;
    if (native) {
      const [availableMemory, power] = await Promise.all([
        native.getAvailableMemoryBytes().catch(() => null),
        native.getDevicePowerState().catch(() => null),
      ]);
      if (typeof availableMemory === "number" && Number.isFinite(availableMemory) && availableMemory >= 0) availableMemoryBytes = Math.floor(availableMemory);
      if (power) {
        if (typeof power.batteryPercent === "number" && Number.isFinite(power.batteryPercent) && power.batteryPercent >= 0 && power.batteryPercent <= 100) batteryPercent = power.batteryPercent;
        if (typeof power.pluggedIn === "boolean") pluggedIn = power.pluggedIn;
        if (typeof power.lowPowerMode === "boolean") lowPowerMode = power.lowPowerMode;
      }
    }
    return choosePerformanceMode(undefined, {
      architectureSupported: device.isArm64Compatible,
      ...(device.totalMemoryBytes !== null ? { totalMemoryBytes: device.totalMemoryBytes } : {}),
      ...(availableMemoryBytes !== undefined ? { availableMemoryBytes } : {}),
      ...(batteryPercent !== undefined ? { batteryPercent } : {}),
      ...(pluggedIn !== undefined ? { pluggedIn } : {}),
      ...(lowPowerMode !== undefined ? { lowPowerMode } : {}),
    }).mode;
  }

  /** Applies a selected backend policy and battery-aware sleep thresholds without polling. */
  async setPerformanceMode(mode: PerformanceModeName) {
    const result = await this.performanceModes.apply(mode);
    if (result.applied) {
      this.currentPerformanceMode = mode;
      this.applyLifecycleMode(mode);
      if (this.offlineModelServices) void this.offlineModelServices.lifecycle.onPerformanceModeChange(mode).catch(() => undefined);
    }
    return result;
  }

  private applyLifecycleMode(mode: PerformanceModeName): void {
    if (!this.sleepWake) return;
    const factor = mode === "Performance" ? 1.5 : mode === "Battery" ? 0.5 : mode === "Compatibility" ? 0.6 : 1;
    this.sleepWake.setPolicy({
      ...this.lifecycleBasePolicy,
      idleThresholdMs: Math.max(30_000, Math.round(this.lifecycleBasePolicy.idleThresholdMs * factor)),
      backgroundIdleThresholdMs: Math.max(15_000, Math.round(this.lifecycleBasePolicy.backgroundIdleThresholdMs * factor)),
    });
  }

  private createFirstRunOrchestrator(): FirstRunOrchestrator {
    return new FirstRunOrchestrator(this.firstRunStore ?? new EnvironmentTextStore(this.environment, `${this.home.metadata}/first-run-state.json`), this.bootstrapPipeline, {
      diagnostics: () => this.collectBootstrapDiagnostics(),
      safeDefaults: async () => {
        const [runtime, model, onlineProviderConfigured] = await Promise.all([
          this.userspace.status().catch(() => null),
          import("../lib/local-model").then((module) => module.localModelEngine.isDownloaded()).catch(() => undefined),
          (async () => {
            try {
              const { hasProviderCredential } = await import("./enhancements/auth/productionProviderTransport.ts");
              const providers = ["openrouter", "opencode", "custom.slot1", "custom.slot2"];
              const configured: Array<boolean | "unknown"> = await Promise.all(providers.map((provider) =>
                hasProviderCredential(provider).then((present) => present, () => "unknown" as const)));
              return summarizeProviderConfiguration(configured);
            } catch { return "unknown"; }
          })(),
        ]);
        let online = this.lastBootstrapOnline;
        if (Date.now() - this.lastBootstrapNetworkAt > 30_000) {
          const observation = await probeInternetConnectivity();
          online = observation.status === "ok" ? true : observation.status === "offline" ? false : "unknown";
          this.lastBootstrapOnline = online;
          this.lastBootstrapNetworkAt = Date.now();
        }
        const recommendation = recommendSmartDefaults({
          backends: (runtime?.probes || []).map((probe) => ({ id: probe.id, healthy: probe.health === "ready", capabilities: probe.capabilities })),
          online,
          onlineProviderConfigured,
          offlineModelAvailable: model,
        });
        const performanceModePath = `${this.home.metadata}/performance-mode.json`;
        let hasSavedPerformanceChoice = true;
        try { hasSavedPerformanceChoice = await this.environment.exists(performanceModePath); } catch { /* if storage is unclear, preserve the user's existing setting */ }
        let performanceModeApplied = false;
        let existingSelectionPreserved = hasSavedPerformanceChoice;
        try {
          const currentMode = await this.performanceModes.restore();
          if (!hasSavedPerformanceChoice && currentMode === "Balanced" && recommendation.backend !== "unavailable") {
            performanceModeApplied = (await this.performanceModes.apply(recommendation.performanceMode)).applied;
          } else if (!hasSavedPerformanceChoice && currentMode !== "Balanced") {
            existingSelectionPreserved = true;
          }
        } catch { /* recommendations remain visible; do not overwrite a possibly unavailable preference store */ }
        const applied = { performanceMode: performanceModeApplied, recommendationPersisted: true, existingSelectionPreserved };
        const persistedRecommendation: SmartDefaultsRecommendation = { ...recommendation, applied };
        await new EnvironmentTextStore(this.environment, `${this.home.metadata}/smart-defaults.json`).write(JSON.stringify({ version: 1, assessedAt: Date.now(), recommendation: persistedRecommendation }));
        await this.recordTimeline({ type: "bootstrap.smart-defaults", actor: "runtime", payload: { backend: recommendation.backend, mode: recommendation.performanceMode, preset: recommendation.preset, performanceModeApplied, existingSelectionPreserved } });
        return persistedRecommendation;
      },
    });
  }

  async recordStartupStage(stage: import("./diagnostics/StartupTrace").StartupStage, status: "started" | "ok" | "warn" | "error", message?: string) {
    this.startupTrace.push(stage, status, message);
    if (status === "error") this.startupTrace.markFailed(stage, message || "error");
  }

  async repairHealth(id: string) {
    try {
      const { persistentLogger } = await import("../lib/persistent-logger");
      persistentLogger.add("info", "Health", `repair start id=${id}`);
    } catch { /* optional */ }
    if (id === "runtime.supervisor") {
      this.startSupervisor();
      try {
        const { persistentLogger } = await import("../lib/persistent-logger");
        persistentLogger.add("info", "Health", "repair supervisor → startSupervisor()");
      } catch { /* optional */ }
      return { id, ok: true, message: "Supervisor started", durationMs: 0 };
    }
    const base = await this.health.repair(id);
    // Best-effort: execute allowlisted DeterministicRepair recipe via Termux
    try {
      const { runRepairForDiagnostic } = await import("../lib/repair-script-runner");
      const shell = await runRepairForDiagnostic(id, { allowMedium: false });
      return { ...base, message: `${(base as { message?: string }).message || ""} | shell: ${shell.message}`.trim() };
    } catch {
      return base;
    }
  }

  /** Explicit UI handlers only should call these grant/revoke controls. */
  getGrantedDeviceCapabilities(): readonly DeviceCapability[] { return this.devicePolicy.listGrants(); }
  grantDeviceCapabilityByUser(capability: "device.accessibility" | "device.adb" | "device.virtualdisplay" | "device.bridge.listen" | "device.metadata.read" | "device.sensors.read"): void { this.devicePolicy.grantByUser(capability); }
  async revokeDeviceCapabilityByUser(capability: "device.accessibility" | "device.adb" | "device.virtualdisplay" | "device.bridge.listen" | "device.metadata.read" | "device.sensors.read"): Promise<void> { await this.deviceBridge.revokeByUser(capability); }
  async openAccessibilitySettingsByUser(): Promise<void> { await this.accessibility.openSettings(); }
  async startDeviceLoopbackByUser(): Promise<{ url: string; token: string }> {
    if (!this.devicePolicy.isGranted("device.accessibility")) throw new Error("[POLICY_BLOCKED] Grant app accessibility capability first.");
    this.devicePolicy.grantByUser("device.bridge.listen");
    try { return await this.deviceBridge.startLoopback(); }
    catch (error) { await this.deviceBridge.revokeByUser("device.bridge.listen"); throw error; }
  }
  async stopDeviceLoopbackByUser(): Promise<void> { await this.deviceBridge.stopLoopback(); await this.revokeDeviceCapabilityByUser("device.bridge.listen"); }

  /** Lazily loads the Termux-backed ADB bridge on Android; core tests stay platform-neutral. */
  createTermuxAdbDeviceBridge(): DeviceAgentBridge {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TermuxAdbDeviceBridge } = require("./device/TermuxAdbDeviceBridge");
    return new TermuxAdbDeviceBridge();
  }

  async runDeviceAppLoop(options: DeviceAppLoopOptions): Promise<DeviceAppLoopResult> {
    return this.runRuntimeTask("device-app-loop", () => runDeviceAppLoop(this.device, options));
  }

  async runDeviceAutomation(options: DeviceAutomationOptions): Promise<DeviceAutomationResult> {
    return this.runRuntimeTask("device-automation", () => this.deviceAutomation.run(options));
  }

  async linuxStatus(profile: LinuxRuntimeProfile = "ubuntu"): Promise<LinuxRuntimeStatus> {
    return this.linux.status(profile);
  }

  async linuxExec(command: string, args: readonly string[] = [], options?: { profile?: LinuxRuntimeProfile; cwd?: string; timeoutMs?: number }): Promise<LinuxExecResult> {
    return this.runRuntimeTask("linux-exec", () => this.linux.exec(command, args, options));
  }

  async linuxBootstrap(profile: LinuxRuntimeProfile = "ubuntu"): Promise<LinuxExecResult> {
    return this.runMaintenance("linux-bootstrap", () => this.linux.bootstrap(profile));
  }

  async containerCreate(input: { imageId: string; name: string; projectId?: string }): Promise<import("./container/ContainerTypes").ContainerInstance> {
    return this.runRuntimeTask("container-create", () => {
      const projectId = input.projectId ? validateProjectName(input.projectId) : undefined;
      return this.containerRuntime.create({
        ...input,
        projectId,
        mounts: projectId ? [{ hostPath: `${this.home.projects}/${projectId}`, containerPath: "/workspace", mode: "rw" }] : [],
        policy: projectId ? "PROJECT_ONLY" : "PROJECT_AND_WORKSPACE",
      });
    });
  }

  async containerStart(instanceId: string): Promise<void> {
    return this.runRuntimeTask("container-start", async () => {
      await this.containerRuntime.start(instanceId);
      await this.sleepWake?.register(instanceId);
    });
  }

  async containerStop(instanceId: string): Promise<void> {
    return this.runRuntimeTask("container-stop", async () => {
      await this.containerRuntime.stop(instanceId);
      await this.sleepWake?.unregister(instanceId);
    });
  }

  async containerRemove(instanceId: string): Promise<void> {
    return this.runRuntimeTask("container-remove", async () => {
      await this.containerRuntime.remove(instanceId);
      await this.sleepWake?.unregister(instanceId);
    });
  }

  async containerExec(instanceId: string, command: string, args: readonly string[] = [], options?: { cwd?: string; timeoutMs?: number }): Promise<ContainerExecResult> {
    return this.runRuntimeTask("container-exec", async () => {
      const instance = await this.containerRuntime.getAsync(instanceId);
      if (!instance) throw new Error("UNKNOWN_CONTAINER");
      let lifecycle = (await this.sleepWake!.list()).find((record) => record.containerId === instanceId);
      if (lifecycle?.state === "quarantined") throw new Error("CONTAINER_QUARANTINED: explicit restart is required");
      if (!lifecycle) {
        if (instance.status !== "running" && instance.status !== "error") throw new Error("CONTAINER_NOT_RUNNING");
        await this.sleepWake!.register(instanceId);
      } else if (lifecycle.state === "sleeping" || (lifecycle.state === "running" && instance.status === "stopped")) {
        if (lifecycle.state === "running") await this.sleepWake!.sleep(instanceId, "runtime-state-reconcile");
        await this.maintenance.wakeContainer(instanceId);
      } else {
        await this.sleepWake!.touch(instanceId);
      }
      if (this.containerRuntime.isExecuting(instanceId)) throw new Error("CONTAINER_BUSY");
      try {
        return await this.containerRuntime.exec(instanceId, command, args, options);
      } finally {
        await this.sleepWake!.touch(instanceId).catch(() => undefined);
      }
    });
  }

  async containerInspect(instanceId: string) {
    return this.containerRuntime.inspect(instanceId);
  }

  async runAIWorkspaceBuild(containerId: string, plan: WorkspaceBuildPlan): Promise<WorkspaceBuildResult> {
    return this.runRuntimeTask("ai-workspace-build", () => this.workspaceBuilder.run(containerId, plan));
  }

  async generateAIProject(containerId: string, request: AIProjectRequest): Promise<AIProjectResult> {
    return this.runRuntimeTask("ai-project-generate", () => this.projectGenerator.generate(containerId, request));
  }

  async runAgenticBuildLoop(request: AgenticBuildLoopRequest): Promise<AgenticBuildLoopResult> {
    return this.runRuntimeTask("agentic-build-loop", () => runAgenticBuildLoop(this, request));
  }

  async runOneClickAppFactory(request: OneClickAppFactoryRequest): Promise<OneClickAppFactoryResult> {
    return this.runRuntimeTask("one-click-app-factory", () => this.oneClickAppFactory.run(request));
  }

  async runRealDeviceIntegration(request: RealDeviceIntegrationRequest = {}): Promise<RealDeviceIntegrationResult> {
    return this.runRuntimeTask("real-device-integration", () => runRealDeviceIntegration(this.device, request));
  }

  async persistentWorkspaceStatus(projectId: string): Promise<PersistentWorkspaceStatus> {
    return this.runRuntimeTask("workspace-status", () => this.persistentWorkspace.status(projectId));
  }

  async persistentWorkspaceDiff(projectId: string): Promise<string> {
    return this.runRuntimeTask("workspace-diff", () => this.persistentWorkspace.diff(projectId));
  }

  async persistentWorkspaceCheckpoint(projectId: string, message = "AI checkpoint"): Promise<WorkspaceGitEntry> {
    return this.runRuntimeTask("workspace-checkpoint", () => this.persistentWorkspace.checkpoint(projectId, message));
  }

  async persistentWorkspaceHistory(projectId: string, limit = 20): Promise<WorkspaceGitEntry[]> {
    return this.runRuntimeTask("workspace-history", () => this.persistentWorkspace.history(projectId, limit));
  }

  async persistentWorkspaceRestore(projectId: string, ref = "HEAD~1"): Promise<void> {
    return this.runRuntimeTask("workspace-restore", () => this.persistentWorkspace.restore(projectId, ref));
  }

  async persistentWorkspaceSnapshot(projectId: string, label = "snapshot"): Promise<PersistentWorkspaceSnapshot> {
    return this.runRuntimeTask("workspace-snapshot", () => this.persistentWorkspace.snapshot(projectId, label));
  }

  async forkWorkspaceProject(projectRoot: string, newProjectName: string): Promise<string> {
    return this.workspaceSnapshots.forkProject(projectRoot, newProjectName);
  }

  async persistentWorkspaceRestoreSnapshot(projectId: string, snapshotId: string): Promise<void> {
    return this.runRuntimeTask("workspace-restore-snapshot", () => this.persistentWorkspace.restoreSnapshot(projectId, snapshotId));
  }

  async projectMemoryGet(projectId: string): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-get", () => this.projectMemory.get(projectId));
  }

  async projectMemorySetArchitecture(projectId: string, architecture: string): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-architecture", () => this.projectMemory.setArchitecture(projectId, architecture));
  }

  async projectMemorySetDependencies(projectId: string, dependencies: readonly string[]): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-dependencies", () => this.projectMemory.setDependencies(projectId, dependencies));
  }

  async projectMemorySetConventions(projectId: string, conventions: readonly string[]): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-conventions", () => this.projectMemory.setConventions(projectId, conventions));
  }

  async projectMemoryRecordBuild(projectId: string, summary: string, detail = ""): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-build", () => this.projectMemory.recordBuild(projectId, summary, detail));
  }

  async projectMemoryRecordError(projectId: string, summary: string, detail = ""): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-error", () => this.projectMemory.recordError(projectId, summary, detail));
  }

  async projectMemoryRecordFix(projectId: string, summary: string, detail = ""): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-fix", () => this.projectMemory.recordFix(projectId, summary, detail));
  }

  async projectMemoryRecordTest(projectId: string, summary: string, detail = ""): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-test", () => this.projectMemory.recordTest(projectId, summary, detail));
  }

  async projectMemoryContext(projectId: string): Promise<string> {
    return this.runRuntimeTask("project-memory-context", () => this.projectMemory.context(projectId));
  }

  async projectMemoryReset(projectId: string): Promise<AIProjectMemory> {
    return this.runRuntimeTask("project-memory-reset", () => this.projectMemory.reset(projectId));
  }

  async runAICodingAgent(containerId: string, request: AICodingAgentRequest): Promise<AICodingAgentResult> {
    return this.runRuntimeTask("ai-coding-agent", async () => {
      const memory = await this.projectMemory.context(request.name);
      const enriched = { ...request, memoryContext: request.memoryContext ?? memory };
      const result = request.planner
        ? await this.codingAgent.run(containerId, enriched)
        : !this.codingBrain.isReady()
          ? await this.codingAgent.run(containerId, enriched)
          : await this.codingAgent.run(containerId, { ...enriched, planner: (ctx) => this.codingBrain.plan(ctx, containerId) });
      await this.projectMemory.recordBuild(request.name, result.ok ? "Coding/build cycle succeeded" : "Coding/build cycle failed", result.error || `${result.iterations.length} iterations`);
      if (result.ok) await this.projectMemory.recordFix(request.name, "Successful coding/build cycle", result.changedFiles.join(", "));
      else await this.projectMemory.recordError(request.name, result.error || "Unknown coding/build failure");
      return result;
    });
  }

  async generateDeviceTestSuite(goal: string, packageName?: string, model?: TestPlanModel): Promise<DeviceTestSuite> {
    return generateDeviceTestSuite(goal, packageName, model);
  }

  async runDeviceTestSuite(options: { apkPath: string; packageName?: string; goal: string; projectPath: string; runId?: string; model?: TestPlanModel; maxActionsPerCase?: number }): Promise<DeviceTestSuiteRun> {
    return this.runRuntimeTask("device-test-suite", async () => {
      const suite = await generateDeviceTestSuite(options.goal, options.packageName, options.model);
      const evidence = new DeviceEvidenceStore(options.projectPath, options.runId || `run-${Date.now()}`);
      return runDeviceTestSuite(this.device, { apkPath: options.apkPath, packageName: options.packageName, suite, evidence, maxActionsPerCase: options.maxActionsPerCase });
    });
  }

  /** Execute device automation through the policy-gated AgentManager path. */
  async runDeviceAutomationAsAgent(
    projectId: string,
    options: DeviceAutomationOptions,
  ): Promise<DeviceAutomationResult> {
    const agent = this.createAgentForProject(projectId);
    try {
      const result = await this.agents.execute(agent.id, {
        tool: "device.automation_loop",
        capability: "adb",
        args: options as unknown as Record<string, unknown>,
      });
      if (!result.ok) throw new Error(result.error || "DEVICE_AUTOMATION_AGENT_FAILED");
      const parsed = JSON.parse(result.output || "{}");
      return parsed as DeviceAutomationResult;
    } finally {
      this.processRegistry.unregister(`agent-${agent.id}`);
      this.agents.remove(agent.id);
    }
  }

  useDeviceBridge(bridge: DeviceAgentBridge): void {
    this.deviceBridgeConfigured = true;
    this.device = new PolicyGatedDeviceAgentBridge(this.devicePolicy, bridge);
    this.deviceTools = new DeviceAgentTools(this.device);
    this.deviceAutomation = new DeviceAutomationAgent(this.device);
  }

  private registerDefaultRecoveryActions(): void {
    this.recovery.register({
      id: "recreate_session",
      kind: "recreate_session",
      description: "Close and recreate builder session",
      run: () => {
        this.sessions.closeAll();
      },
    });
    this.recovery.register({
      id: "clear_process_registry",
      kind: "other",
      description: "Clear registered processes",
      run: () => {
        this.processRegistry.clear();
      },
    });
    this.recovery.register({
      id: "stop_all_containers",
      kind: "container_restart",
      description: "Stop all container instances (projects kept)",
      run: async () => {
        const list = this.containers.listInstances();
        for (const inst of list) {
          try {
            await this.containers.stop(inst.id);
          } catch {
            // ignore
          }
          this.processRegistry.unregister(`container-${inst.id}`);
        }
      },
    });
    this.recovery.register({
      id: "close_all_terminals",
      kind: "restart_terminal",
      description: "Close all terminal sessions",
      run: async () => {
        if (this.terminals) await this.terminals.closeAll();
      },
    });
    this.recovery.register({
      id: "refresh_toolchains",
      kind: "other",
      description: "Refresh toolchain discovery",
      run: async () => {
        await this.refreshToolchains();
      },
    });
    this.recovery.register({
      id: "refresh_privileges",
      kind: "other",
      description: "Re-detect Shizuku/Root/ADB capabilities",
      run: async () => {
        await this.refreshPrivileges();
      },
    });
    this.recovery.register({
      id: "destroy_all_containers",
      kind: "container_restart",
      description: "Destroy all container instances (projects kept)",
      run: async () => {
        const list = this.containers.listInstances();
        for (const inst of list) {
          try {
            await this.containers.remove(inst.id);
          } catch {
            // ignore
          }
          this.processRegistry.unregister(`container-${inst.id}`);
        }
      },
    });
  }

  async refreshPrivileges(): Promise<CapabilityDetection> {
    try {
      this.privilegeSnapshot = await detectDevicePrivileges();
    } catch {
      this.privilegeSnapshot = await detectPrivileges({
        none: this.privileges.none,
        shizuku: this.privileges.shizuku,
        root: this.privileges.root,
      });
    }
    // Rebind providers to live detection (plan P2 Shizuku bridge health)
    const snap = this.privilegeSnapshot;
    (this.privileges as { shizuku: PrivilegeProvider }).shizuku = new ShizukuProvider(
      !!snap.shizuku,
      snap.shizuku
        ? async (command: string) => {
            const { shizukuExec } = await import("../lib/shizuku-bridge");
            const r = await shizukuExec(command, { timeoutMs: 30_000 });
            return { exitCode: r.exitCode, code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
          }
        : undefined,
    );
    (this.privileges as { root: PrivilegeProvider }).root = new RootProvider(!!snap.root);
    return this.privilegeSnapshot;
  }

  getPrivileges(): CapabilityDetection | null {
    return this.privilegeSnapshot;
  }

  async diagnostics(): Promise<DiagnosticReport> {
    const priv = this.privilegeSnapshot ?? (await this.refreshPrivileges());
    const tc = this.toolchains.diagnostics();
    return buildDiagnosticReport([
      {
        area: "home",
        level: "ok",
        message: "AIBuilderTermux HOME",
        details: { path: this.home.root },
      },
      {
        area: "toolchains",
        level: tc.available > 0 ? "ok" : "warn",
        message: `toolchains available=${tc.available}`,
      },
      {
        area: "containers",
        level: "ok",
        message: `images=${this.containers.listImages().length}`,
      },
      {
        area: "privilege",
        level: priv.active === "none" ? "info" : "ok",
        message: `active=${priv.active}`,
        details: {
          shizuku: priv.shizuku,
          root: priv.root,
        },
      },
      {
        area: "native",
        level: this.native.detect().available ? "ok" : "info",
        message: this.native.detect().reason ?? "native optional",
      },
    ]);
  }

  finalValidation(): FinalValidationReport {
    return runFinalValidation({
      homeLayout: this.home,
      executionEnvironment: this.environment,
      projectManager: true,
      terminalSessionManager: this.terminals ?? true,
      toolchainManager: this.toolchains,
      processRegistry: this.processRegistry,
      sessionManager: this.sessions,
      containerManager: this.containers,
      agentManager: this.agents,
      androidBridge: this.bridge,
      privilegeNone: this.privileges.none,
      nativeRuntime: this.native,
    });
  }

  /** Open a builder session bound to a project under HOME/projects. */
  openProjectSession(projectId: string): ReturnType<SessionManager["create"]> {
    const projectRoot = `${this.home.projects}/${projectId}`;
    const session = this.sessions.create({
      projectId,
      projectRoot,
      environmentId: "termux",
      metadata: { home: this.home.root },
    });
    this.processRegistry.register({
      id: `session-proc-${session.id}`,
      kind: "runtime",
      sessionId: session.id,
      projectId,
      startedAt: Date.now(),
      label: `session:${projectId}`,
      metadata: { watchdog: "true" },
    });
    return session;
  }

  /**
   * Launch Ubuntu userspace instance for a project.
   * Mounts project at /workspace; never deletes the project on destroy.
   */
  async launchUbuntu(projectId: string, name?: string) {
    return this.runRuntimeTask(`launch-ubuntu:${projectId}`, async () => {
    const { launchUbuntuForProject } = await import("./ubuntu/UbuntuLifecycle");
    const { buildUbuntuShellSpec, describeUbuntuShell } = await import(
      "./ubuntu/UbuntuShell"
    );
    const projectRoot = `${this.home.projects}/${projectId}`;
    const result = await launchUbuntuForProject(this.containers, this.home, {
      projectId,
      projectRoot,
      name,
    });
    const shell = buildUbuntuShellSpec(this.home, {
      instanceId: result.instance.id,
      projectId,
      projectRoot,
    });
    this.processRegistry.register({
      id: `container-${result.instance.id}`,
      kind: "container",
      projectId,
      startedAt: Date.now(),
      label: result.instance.name,
      metadata: {
        imageId: result.instance.imageId,
        shell: describeUbuntuShell(shell),
        watchdog: "true",
      },
    });
    return { ...result, shell };
    });
  }

  async launchKali(_projectId: string, _name?: string): Promise<never> {
    throw new Error("KALI_REMOVED: only Termux and Ubuntu environments are supported");
  }

  async stopContainer(instanceId: string): Promise<void> {
    await this.runRuntimeTask(`stop-container:${instanceId}`, async () => {
      this.portForwardAutoRestore = false;
      await this.portForwards.stopActive(`container-stopped:${instanceId}`);
      await this.containers.stop(instanceId);
      this.processRegistry.unregister(`container-${instanceId}`);
    });
  }

  /** Create an agent bound to a project with terminal capability enabled. */
  createAgentForProject(projectId: string) {
    projectId = validateProjectName(projectId);
    const agent = this.agents.create({
      projectId,
      policy: {
        allowedCapabilities: ["filesystem", "terminal", "adb", "device.accessibility", "device.adb", "device.virtualdisplay"],
        projectIsolation: true,
        homeIsolation: true,
      },
    });
    this.processRegistry.register({
      id: `agent-${agent.id}`,
      kind: "agent",
      projectId,
      startedAt: Date.now(),
      label: `agent:${projectId}`,
      metadata: { watchdog: "true" },
    });
    return agent;
  }

  /**
   * Open a Termux-backed terminal session for a project (PWD=project; AI_BUILDER_HOME=AIBuilderTermux; preserve Termux HOME).
   */
  private async openTerminalForProjectAtCwd(projectId: string, requestedCwd: string, requestedProjectRoot?: string) {
    projectId = validateProjectName(projectId);
    if (!this.terminals) {
      throw new Error("Terminal session manager unavailable");
    }
    const defaultProjectRoot = `${this.home.projects}/${projectId}`;
    const projectRoot = requestedProjectRoot === undefined ? defaultProjectRoot : normalizeTerminalCwd(requestedProjectRoot);
    if (!projectRoot || !isTerminalCwdWithin(this.home.projects, projectRoot)) throw new Error("TERMINAL_PROJECT_ROOT_OUTSIDE_WORKSPACE");
    const normalizedRoot = normalizeTerminalCwd(projectRoot) ?? projectRoot;
    const normalizedRequested = normalizeTerminalCwd(requestedCwd);
    let cwd = normalizedRequested && isTerminalCwdWithin(normalizedRoot, normalizedRequested) ? normalizedRequested : normalizedRoot;
    if (cwd !== normalizedRoot && this.environment.resolvePath) {
      try {
        const [canonicalRoot, canonicalCwd] = await Promise.all([this.environment.resolvePath(normalizedRoot), this.environment.resolvePath(cwd)]);
        if (!isTerminalCwdWithin(canonicalRoot, canonicalCwd)) cwd = normalizedRoot;
      } catch { cwd = normalizedRoot; }
    }
    if (cwd !== normalizedRoot && !(await this.environment.exists(cwd).catch(() => false))) cwd = normalizedRoot;
    // Project metadata uses its stored path; ensure that exact scoped directory exists before assigning it as ProcessBuilder.directory.
    await this.environment.mkdir(projectRoot);
    const session = await this.terminals.create({
      cwd,
      home: this.home.root,
      projectRoot,
      env: {
        AI_BUILDER_HOME: this.home.root,
        PWD: cwd,
        PROJECT_ROOT: projectRoot,
        AI_BUILDER_PROJECT: projectRoot,
      },
    });
    this.processRegistry.register({
      id: `terminal-${session.id}`,
      kind: "terminal",
      sessionId: session.id,
      projectId,
      startedAt: Date.now(),
      label: `terminal:${projectId}`,
      metadata: { watchdog: "true" },
    });
    return session;
  }

  /** Open a Termux-backed terminal session for a project at its project root. */
  async openTerminalForProject(projectId: string, projectRoot?: string) {
    const validated = validateProjectName(projectId);
    const root = projectRoot ?? `${this.home.projects}/${validated}`;
    return this.openTerminalForProjectAtCwd(validated, root, root);
  }

  /**
   * Build proot launch plan for a running container instance (no execution).
   */
  buildProotPlanForInstance(
    profile: "ubuntu",
    instanceId: string,
    projectId: string,
    rootfsPath?: string,
    credentialProxy?: ProxyClientConfiguration,
  ) {
    projectId = validateProjectName(projectId);
    const projectRoot = `${this.home.projects}/${projectId}`;
    const spec = buildContainerShellSpec(this.home, profile, {
      instanceId,
      projectId,
      projectRoot,
    });
    return buildProotLaunchPlan(spec, { rootfsPath, credentialProxy });
  }

  /**
   * Execute proot plan via ExecutionEnvironment (Termux).
   * If rootfs is missing, runs diagnostic echo only.
   */
  async runProotPlanForInstance(
    profile: "ubuntu",
    instanceId: string,
    projectId: string,
    rootfsPath?: string,
    credentialProxy?: ProxyClientConfiguration,
  ) {
    const plan = this.buildProotPlanForInstance(
      profile,
      instanceId,
      projectId,
      rootfsPath,
      credentialProxy,
    );
    const result = await this.environment.exec(plan.command, {
      cwd: this.home.root,
      env: plan.env,
    });
    return { plan, result };
  }


  getRootfsManifest(profile: "ubuntu") {
    return buildRootfsImageManifest(this.home, profile);
  }

  async markRootfsReady(profile: "ubuntu") {
    const manifest = buildRootfsImageManifest(this.home, profile);
    await this.environment.mkdir(manifest.rootfsPath);
    await this.environment.write(manifest.readyMarker, `ready:${Date.now()}\n`);
    return manifest;
  }

  async isRootfsReady(profile: "ubuntu") {
    const manifest = buildRootfsImageManifest(this.home, profile);
    return isRootfsReady(manifest, (path) => this.environment.exists(path));
  }

  async ensureRootfs(profile: "ubuntu") {
    return ensureRootfsLayout(
      this.home,
      profile,
      (path) => this.environment.mkdir(path),
      (path) => this.environment.exists(path),
    );
  }

  async discoverContainerRootfs(profile: "ubuntu") {
    return discoverRootfsPath(this.home, profile, (path) =>
      this.environment.exists(path),
    );
  }

  /** Run proot plan, auto-discovering rootfs under HOME when not provided. */
  async runProotAuto(
    profile: "ubuntu",
    instanceId: string,
    projectId: string,
  ) {
    const rootfsPath =
      (await this.discoverContainerRootfs(profile)) ?? undefined;
    return this.runProotPlanForInstance(
      profile,
      instanceId,
      projectId,
      rootfsPath,
    );
  }

  async refreshToolchains() {
    this.registerDefaultToolchainSources();
    return this.toolchains.refresh();
  }

  /** Register default read-only HOME toolchain dir probe (no installs). */
  registerDefaultToolchainSources(): void {
    if (this.defaultToolchainSourcesRegistered) return;
    this.defaultToolchainSourcesRegistered = true;
    const root = this.home.toolchains;
    this.toolchains.registerSource({
      discover: async () => {
        const { discoverRuntimeToolchains } = await import("./toolchain/ToolDiscovery");
        const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
        const pathTest = async (flag: "-d" | "-f" | "-s" | "-x", path: string) => {
          try {
            const result = await this.environment.exec(`test ${flag} ${shellQuote(path)}`, { timeoutMs: 5_000 });
            return result.exitCode === 0;
          } catch {
            return false;
          }
        };
        const probe = {
          exists: async (p: string) => {
            try {
              return await this.environment.exists(p);
            } catch {
              return false;
            }
          },
          isDirectory: (p: string) => pathTest("-d", p),
          isFile: (p: string) => pathTest("-f", p),
          isNonEmptyFile: (p: string) => pathTest("-s", p),
          isExecutable: (p: string) => pathTest("-x", p),
          listDirectories: async (p: string) => {
            try {
              const result = await this.environment.exec(
                `find ${shellQuote(p)} -mindepth 1 -maxdepth 1 -type d -print`,
                { timeoutMs: 5_000, preserveOutput: true },
              );
              if (result.exitCode !== 0) return [];
              return result.stdout.split(/\r?\n/).filter(Boolean).map((entry) => {
                const normalized = entry.replace(/\/+$/, "");
                return normalized.slice(normalized.lastIndexOf("/") + 1);
              });
            } catch {
              return [];
            }
          },
          readText: async (p: string) => this.environment.read(p),
        };
        return discoverRuntimeToolchains(probe, root, this.home.sdk);
      },
    });
  }
}

export function createRuntimeFacade(
  options?: RuntimeFacadeOptions,
): RuntimeFacade {
  return new RuntimeFacade(options);
}
