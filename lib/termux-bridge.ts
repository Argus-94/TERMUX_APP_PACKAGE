import { embeddedCwdRejectionDetails, embeddedFailureCode, embeddedStatusDiagnostic } from "./embedded-runtime-diagnostics";
import { NativeModules, NativeEventEmitter, Platform, EmitterSubscription, Linking } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { persistentLogger } from "./persistent-logger";
import { enqueueTermuxCommand, type TermuxQueuePriority , clearPendingTermuxQueue } from "./termux-command-queue";
import { getBuildBackend, backendLabel, type AgentShellBackend } from "./agent-shell-backend";
import { classifyCommandForDiagnostics, redactCommandForLogs, redactCommandOutputForLogs, summarizeCommandOutputForLogs } from "./command-log-redaction";
import { classifyDiagnosticError, createTraceCorrelationId, isExplicitTermuxExternalAppsFalse } from "./diagnostic-trace";
import { isAndroidRunCommandPermissionDenied, runCommandPermissionStatus, RunCommandPermissionGate } from "./termux-permission-gate";
import { runWithEmbeddedAbort } from "./embedded-exec-cancellation";
import { buildTermuxPackageWorkflowInputs, type TermuxPackageWorkflowInputs } from "./termux-package-workflow-inputs";
import type { OfflineBundleInspection, OfflineBundleOptions } from "./offline-package-bundle";
import {
  AI_BUILDER_WORKSPACE_ROOT,
  aiBuilderWorkspaceChildPath,
  isCanonicalAIBuilderWorkspacePath,
  isSafeAIBuilderWorkspaceChildName,
  isSafeAIBuilderWorkspaceRelativePath,
  AI_BUILDER_WORKSPACE_MAX_BYTES,
  isAllowedEmbeddedWorkdir,
} from "./private-workspace-policy";

/**
 * JS-обвязка над единственным app-private TermuxBridge и ограниченной SAF
 * выдачу метаданных папки AIBuilderTermux; отсутствие capability не означает
 * fallback. Агентная политика остаётся в lib/termux-agent.ts.
 */

export interface TermuxCommandResult {
  commandId?: string;
  /** Native UUID retained separately from the caller-visible JS correlation ID. */
  nativeCommandId?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** RUN_COMMAND did not return its completion callback; process outcome is unknown. */
  callbackMissing?: boolean;
  /** Android RUN_COMMAND may truncate callback bundles; such output is not probe evidence. */
  outputTruncated?: boolean;
}

export interface EmbeddedTermuxCommandResult {
  commandId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
  backendId: "embedded-termux";
}

export interface EmbeddedTermuxPackageQueryResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface TermuxCommandOutputEvent {
  stream?: "stdout" | "stderr" | "lifecycle" | "heartbeat" | string;
  chunk?: string;
  event?: string;
  cmdId?: string;
  nativeCmdId?: string;
  elapsedSec?: number;
  stdoutBytes?: number;
}

export type TermuxOutputListener = (event: TermuxCommandOutputEvent & { cmdId?: string }) => void;

export interface OfflinePackageBundlePackage {
  name: string;
  version: string;
  architecture: "aarch64" | "all";
  sizeBytes: number;
}

export type OfflinePackageBundleStageResult = {
  status: "ready" | "rejected" | "blocked";
  code: string;
  stageId?: string;
  packageCount?: number;
  totalBytes?: number;
  packages?: Array<OfflinePackageBundlePackage>;
};

export type OfflinePackageBundleInstallResult = {
  status: "installed" | "partial" | "rejected" | "blocked";
  code: string;
  installed?: Array<{ name: string; version: string }>;
};

export type OfflinePackageBundlePlanResult = {
  status: "ready" | "rejected" | "blocked";
  code: string;
  planId?: string;
  packages?: Array<OfflinePackageBundlePackage>;
};

export interface OfflineBundleProgressEvent {
  requestId: string;
  phase: string;
  percent: number;
}

export type OfflineBundleProgressListener = (event: OfflineBundleProgressEvent) => void;

const OFFLINE_BUNDLE_UNAVAILABLE = "AIB_OFFLINE_BUNDLE_NATIVE_FLOW_UNAVAILABLE";
const OFFLINE_BUNDLE_INVALID_RESULT = "AIB_OFFLINE_BUNDLE_NATIVE_RESULT_INVALID";
const OFFLINE_BUNDLE_REQUEST_ID = /^[A-Za-z0-9._-]{1,96}$/;
const OFFLINE_BUNDLE_STAGE_ID = /^[A-Za-z0-9_-]{16,128}$/;
type OfflineBundleNativeResult = Pick<EmbeddedTermuxCommandResult, "stdout" | "stderr" | "exitCode" | "timedOut" | "outputTruncated">;
interface JsOfflineBundleRequest { controller: AbortController; stageId: string }
interface JsOfflineBundleStage { ownerRequestId: string; stageDirectoryUri: string; packages: OfflinePackageBundlePackage[]; totalBytes: number; requiresPlan: boolean }
interface JsOfflineBundlePlan { stageId: string; requestId: string; roots: string[]; packages: OfflinePackageBundlePackage[] }
const jsOfflineBundleListeners = new Set<OfflineBundleProgressListener>();
const jsOfflineBundleRequests = new Map<string, JsOfflineBundleRequest>();
const jsOfflineBundleStages = new Map<string, JsOfflineBundleStage>();
const jsOfflineBundlePlans = new Map<string, JsOfflineBundlePlan>();

function emitJsOfflineBundleProgress(event: OfflineBundleProgressEvent): void {
  for (const listener of jsOfflineBundleListeners) {
    try { listener(event); } catch { /* listener isolation */ }
  }
}

function offlineBundleCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z0-9_]{1,80}$/.test(value)
    ? value
    : OFFLINE_BUNDLE_INVALID_RESULT;
}

function parseOfflineBundleStageResult(value: unknown, maxTotalBytes = 150 * 1024 * 1024): OfflinePackageBundleStageResult {
  if (!value || typeof value !== "object") return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
  const item = value as Record<string, unknown>;
  const code = offlineBundleCode(item.code);
  if (item.status === "rejected" || item.status === "blocked") return { status: item.status, code };
  if (item.status !== "ready" || typeof item.stageId !== "string" || !OFFLINE_BUNDLE_STAGE_ID.test(item.stageId) ||
    !Number.isSafeInteger(item.packageCount) || (item.packageCount as number) < 1 || (item.packageCount as number) > 258 ||
    !Number.isSafeInteger(item.totalBytes) || (item.totalBytes as number) < 1 || (item.totalBytes as number) > maxTotalBytes ||
    !Array.isArray(item.packages) || item.packages.length !== item.packageCount) {
    return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
  }
  const packages: OfflinePackageBundlePackage[] = [];
  for (const candidate of item.packages) {
    if (!candidate || typeof candidate !== "object") return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
    const pkg = candidate as Record<string, unknown>;
    if (typeof pkg.name !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(pkg.name) ||
      typeof pkg.version !== "string" || pkg.version.length < 1 || pkg.version.length > 256 || /[\u0000-\u001f\u007f]/.test(pkg.version) ||
      (pkg.architecture !== "aarch64" && pkg.architecture !== "all") || !Number.isSafeInteger(pkg.sizeBytes) || (pkg.sizeBytes as number) < 1 || (pkg.sizeBytes as number) > 100 * 1024 * 1024) {
      return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
    }
    packages.push({ name: pkg.name, version: pkg.version, architecture: pkg.architecture, sizeBytes: pkg.sizeBytes as number });
  }
  return { status: "ready", code, stageId: item.stageId, packageCount: item.packageCount as number, totalBytes: item.totalBytes as number, packages };
}

function parseOfflineBundleInstallResult(value: unknown): OfflinePackageBundleInstallResult {
  if (!value || typeof value !== "object") return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
  const item = value as Record<string, unknown>;
  const code = offlineBundleCode(item.code);
  if (!["installed", "partial", "rejected", "blocked"].includes(String(item.status))) return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
  const installed: Array<{ name: string; version: string }> = [];
  if (item.installed !== undefined) {
    if (!Array.isArray(item.installed)) return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
    for (const candidate of item.installed) {
      if (!candidate || typeof candidate !== "object") return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
      const pkg = candidate as Record<string, unknown>;
      if (typeof pkg.name !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(pkg.name) ||
        typeof pkg.version !== "string" || pkg.version.length < 1 || pkg.version.length > 256 || /[\u0000-\u001f\u007f]/.test(pkg.version)) {
        return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
      }
      installed.push({ name: pkg.name, version: pkg.version });
    }
  }
  if (item.status === "installed" && !Array.isArray(item.installed)) return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
  return { status: item.status as OfflinePackageBundleInstallResult["status"], code, ...(item.installed === undefined ? {} : { installed }) };
}

/**
 * JS-side fan-out for console UI. Native DeviceEventEmitter is best-effort
 * (can miss stdout when the app is backgrounded or when live am-broadcast
 * fails). Every runShellCommandNow also posts start/final events here so the
 * Termux console panel always shows `$ command` + final stdout/stderr for
 * BOTH manual console runs and AI-agent TERMUX_RUN commands.
 */
const jsConsoleListeners = new Set<TermuxOutputListener>();

export function emitJsConsoleEvent(event: TermuxCommandOutputEvent & { cmdId?: string }): void {
  for (const listener of jsConsoleListeners) {
    try {
      listener(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

let liveEmitter: NativeEventEmitter | null = null;
export function subscribeTermuxOutput(listener: TermuxOutputListener): () => void {
  jsConsoleListeners.add(listener);
  let nativeUnsub: (() => void) | null = null;
  if (Platform.OS === "android" && getNative()) {
    try {
      liveEmitter ||= new NativeEventEmitter(NativeModules.TermuxBridge);
      const sub = liveEmitter.addListener("TermuxCommandOutput", listener);
      nativeUnsub = () => {
        try {
          sub.remove();
        } catch {
          /* ignore */
        }
      };
    } catch {
      nativeUnsub = null;
    }
  }
  return () => {
    jsConsoleListeners.delete(listener);
    nativeUnsub?.();
  };
}

/** Native events and genuine JS extraction progress share this isolated channel. */
export function subscribeOfflineBundleProgress(listener: OfflineBundleProgressListener): () => void {
  jsOfflineBundleListeners.add(listener);
  let sub: EmitterSubscription | null = null;
  if (Platform.OS === "android" && getNative()) {
    try {
      liveEmitter ||= new NativeEventEmitter(NativeModules.TermuxBridge);
      sub = liveEmitter.addListener("offlineBundleProgress", (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const event = value as Record<string, unknown>;
        if (typeof event.requestId !== "string" || !OFFLINE_BUNDLE_REQUEST_ID.test(event.requestId) ||
          typeof event.phase !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(event.phase) ||
          typeof event.percent !== "number" || !Number.isFinite(event.percent) || event.percent < 0 || event.percent > 100) return;
        try { listener({ requestId: event.requestId, phase: event.phase, percent: event.percent }); } catch { /* listener isolation */ }
      });
    } catch { sub = null; }
  }
  return () => {
    jsOfflineBundleListeners.delete(listener);
    try { sub?.remove(); } catch { /* ignore */ }
  };
}

/** Compatibility name used by the validation-only package menu. */
export function onOfflineBundleProgress(listener: OfflineBundleProgressListener): () => void {
  return subscribeOfflineBundleProgress(listener);
}

/** Native evidence for the app-private bootstrap, separate from external RUN_COMMAND readiness. */
export interface EmbeddedTermuxRuntimeStatus {
  prefixPresent: boolean;
  homePresent: boolean;
  shellPresent: boolean;
  packageManagerPresent: boolean;
  dpkgPresent: boolean;
  termuxConfigPresent: boolean;
  aptSourcesPresent: boolean;
  dpkgDatabasePresent: boolean;
  prefixWritable: boolean;
  bootstrapManifestPresent: boolean;
  bootstrapManifestValid: boolean;
  bootstrapVersion: string;
  bootstrapArchiveSha256: string;
  applicationId: string;
  architecture: string;
  applicationDataDir: string;
  filesDir: string;
  termuxPrefix: string;
  packageFeedUrl: string;
  packageFeedStatus: string;
  packageFeedEnabled: boolean;
  packageFeedKeyFingerprint: string;
  ready: boolean;
  status: "embedded_prefix_ready" | "bootstrap_missing_or_incomplete";
}

export interface AIBuilderWorkspaceGrantStatus {
  granted: boolean;
  reason: string | null;
}

export interface AIBuilderAllFilesAccessStatus {
  supported: boolean;
  granted: boolean;
  reason: string | null;
}

export interface AIBuilderWorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "unknown";
  sizeBytes?: number;
  lastModifiedMs?: number;
}

export interface AIBuilderWorkspaceListing {
  rootPath: typeof AI_BUILDER_WORKSPACE_ROOT;
  readOnly: true;
  entries: AIBuilderWorkspaceEntry[];
  truncated: boolean;
}

export interface AIBuilderWorkspaceFileCapabilities { rootPath: typeof AI_BUILDER_WORKSPACE_ROOT; transport: "procfd-nofollow"; read: true; write: true; maxBytes: typeof AI_BUILDER_WORKSPACE_MAX_BYTES; nested: true; }
export interface AIBuilderWorkspaceFileRead { rootPath: typeof AI_BUILDER_WORKSPACE_ROOT; relativePath: string; content: string; byteLength: number; }
export interface AIBuilderWorkspaceFileWrite { rootPath: typeof AI_BUILDER_WORKSPACE_ROOT; relativePath: string; byteLength: number; written: true; }

let embeddedPreparation: Promise<boolean> | null = null;
/** One shared install/retry, including commands started without opening the PTY. */
export async function prepareEmbeddedTermuxRuntime(): Promise<boolean> {
  if (Platform.OS !== "android") throw new Error("EMBEDDED_BOOTSTRAP_UNAVAILABLE");
  const native = getNative();
  if (!native?.prepareEmbeddedTermuxRuntime) throw new Error("EMBEDDED_BOOTSTRAP_UNAVAILABLE");
  if (embeddedPreparation) return embeddedPreparation;
  const pending = native.prepareEmbeddedTermuxRuntime().then((ready) => {
    if (ready !== true) throw new Error("EMBEDDED_BOOTSTRAP_NOT_READY");
    return true;
  }).catch((error: unknown) => {
    const raw = (error as { code?: unknown })?.code;
    const code = typeof raw === "string" && /^EMBEDDED_BOOTSTRAP_[A-Z0-9_]{1,80}$/.test(raw) ? raw : "EMBEDDED_BOOTSTRAP_FAILED";
    persistentLogger.add("warn", "EmbeddedBootstrapDiagnostic", JSON.stringify({ outcome: "failed", code }), "app");
    throw Object.assign(new Error(code), { code });
  });
  embeddedPreparation = pending;
  try { return await pending; }
  finally { if (embeddedPreparation === pending) embeddedPreparation = null; }
}

export async function getEmbeddedTermuxRuntimeStatus(): Promise<EmbeddedTermuxRuntimeStatus | null> {
  if (Platform.OS !== "android") return null;
  const native = getNative();
  if (!native?.getEmbeddedTermuxRuntimeStatus) return null;
  try {
    const value = await native.getEmbeddedTermuxRuntimeStatus();
    if (!value || typeof value.ready !== "boolean" || typeof value.prefixPresent !== "boolean" ||
      typeof value.homePresent !== "boolean" || typeof value.shellPresent !== "boolean" ||
      typeof value.packageManagerPresent !== "boolean" || typeof value.dpkgPresent !== "boolean" ||
      typeof value.termuxConfigPresent !== "boolean" || typeof value.aptSourcesPresent !== "boolean" ||
      typeof value.dpkgDatabasePresent !== "boolean" || typeof value.prefixWritable !== "boolean" ||
      typeof value.bootstrapManifestPresent !== "boolean" || typeof value.bootstrapManifestValid !== "boolean" ||
      typeof value.bootstrapVersion !== "string" || typeof value.bootstrapArchiveSha256 !== "string" ||
      value.applicationId !== "com.karat.aibuilder" || value.architecture !== "aarch64" ||
      typeof value.applicationDataDir !== "string" || typeof value.filesDir !== "string" || typeof value.termuxPrefix !== "string" ||
      value.packageFeedUrl !== "https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main" ||
      typeof value.packageFeedStatus !== "string" || !/^[a-z0-9_]{1,80}$/.test(value.packageFeedStatus) ||
      typeof value.packageFeedEnabled !== "boolean" || typeof value.packageFeedKeyFingerprint !== "string" ||
      !(value.packageFeedKeyFingerprint === "" || /^[a-f0-9]{40}$/i.test(value.packageFeedKeyFingerprint)) ||
      !["embedded_prefix_ready", "bootstrap_missing_or_incomplete"].includes(value.status)) {
      persistentLogger.add("warn", "EmbeddedRuntimeDiagnostic", JSON.stringify({ operation: "status", outcome: "invalid_result", ...embeddedStatusDiagnostic(value) }), "app");
      return null;
    }
    // Fail closed: all required probes must be true before reporting readiness.
    const ready = value.prefixPresent && value.homePresent && value.shellPresent && value.packageManagerPresent &&
      value.dpkgPresent && value.termuxConfigPresent && value.aptSourcesPresent &&
      value.dpkgDatabasePresent && value.prefixWritable && value.bootstrapManifestPresent && value.bootstrapManifestValid &&
      /^[a-f0-9]{64}$/i.test(value.bootstrapArchiveSha256) && value.ready;
    persistentLogger.add("info", "EmbeddedRuntimeDiagnostic", JSON.stringify({ operation: "status", outcome: ready ? "ready" : "not_ready", ...embeddedStatusDiagnostic({ ...value, ready }) }), "app");
    return { ...value, ready, status: ready ? "embedded_prefix_ready" : "bootstrap_missing_or_incomplete" };
  } catch (error) {
    persistentLogger.add("warn", "EmbeddedRuntimeDiagnostic", JSON.stringify({ operation: "status", outcome: "native_rejected", code: embeddedFailureCode(error) }), "app");
    return null;
  }
}

/** Return exact workflow_dispatch fields from runtime-measured layout; this does not dispatch a workflow. */
export async function getEmbeddedTermuxPackageWorkflowInputs(): Promise<TermuxPackageWorkflowInputs> {
  const runtime = await getEmbeddedTermuxRuntimeStatus();
  return buildTermuxPackageWorkflowInputs(runtime);
}

export interface TermuxReadiness {
  ready: boolean;
  // Список конкретных причин, почему НЕ готово — используется, чтобы
  // показать пользователю понятную инструкцию, а не общее "не работает".
  reasons: Array<
    | "not_android"
    | "native_module_missing"
    | "termux_not_installed"
    | "termux_install_check_failed"
    | "run_command_permission_missing"
    | "run_command_permission_check_failed"
    | "run_command_probe_failed"
  >;
  /** true if a live echo probe was executed */
  probed?: boolean;
  /** detail from probe failure (stderr/timeout) */
  probeDetail?: string;
}

export interface OfflineArchivePickerResult {
  canceled: boolean;
  uri?: string | null;
}

function getNative() {
  return NativeModules.TermuxBridge as
    | {
        isTermuxInstalled(): Promise<boolean>;
        getEmbeddedTermuxRuntimeStatus(): Promise<EmbeddedTermuxRuntimeStatus>;
        prepareEmbeddedTermuxRuntime?(): Promise<boolean>;
        stageEmbeddedCandidateFeedProbe?(): Promise<string>;
        stageEmbeddedCandidateFullFeed?(): Promise<string>;
        runEmbeddedCandidateFullTransaction?(action: string, packages: readonly string[], requestId: string): Promise<EmbeddedTermuxCommandResult>;
        readEmbeddedCandidateApplyLog?(transactionId: string): Promise<unknown>;
        getReleaseIntegrityEvidence?(): Promise<unknown>;
        pickOfflinePackageArchive?(): Promise<OfflineArchivePickerResult>;
        runEmbeddedTermuxCommand(
          command: string,
          workdir: string | null,
          timeoutMs: number,
          requestId: string,
        ): Promise<EmbeddedTermuxCommandResult>;
        runEmbeddedTermuxBuildCommand?(
          command: string,
          workdir: string | null,
          timeoutMs: number,
          requestId: string,
        ): Promise<EmbeddedTermuxCommandResult>;
        queryEmbeddedTermuxPackages(name: string | null, limit: number): Promise<EmbeddedTermuxPackageQueryResult>;
        verifyOfflinePackageManifest?(rawManifest: number[], detachedSignature: number[]): Promise<boolean>;
        verifyOnlinePackageCatalog?(rawManifest: number[], detachedSignature: number[]): Promise<boolean>;
        stageOfflinePackageBundle?(stageDirectoryUri: string, stageId: string, requestId: string): Promise<EmbeddedTermuxCommandResult>;
        planOfflinePackageBundle?(stageId: string, requestId: string, selectedPackageNames: readonly string[]): Promise<unknown>;
        installOfflinePackageBundle?(stageId: string, requestId: string, selectedPackageNames: readonly string[], planId: string | null): Promise<EmbeddedTermuxCommandResult>;
        cancelOfflinePackageBundle?(requestId: string): Promise<boolean>;
        cancelEmbeddedTermuxCommand?(requestId: string): Promise<boolean>;
        getAIBuilderAllFilesAccessStatus?(): Promise<AIBuilderAllFilesAccessStatus>;
        getAIBuilderAllFilesAccessStatus?(): Promise<AIBuilderAllFilesAccessStatus>;
        openAIBuilderAllFilesAccessSettings?(): Promise<boolean>;
        getAIBuilderWorkspaceGrantStatus?(): Promise<AIBuilderWorkspaceGrantStatus>;
        requestAIBuilderWorkspaceGrant?(): Promise<AIBuilderWorkspaceGrantStatus>;
        listAIBuilderWorkspace?(): Promise<Omit<AIBuilderWorkspaceListing, "entries"> & { entries: Array<Omit<AIBuilderWorkspaceEntry, "path">> }>;
        getAIBuilderWorkspaceFileCapabilities?(): Promise<unknown>;
        readAIBuilderWorkspaceFile?(relativePath: string): Promise<unknown>;
        writeAIBuilderWorkspaceFile?(relativePath: string, content: string): Promise<unknown>;
        hasRunCommandPermission(): Promise<boolean>;
        runCommand(
          command: string,
          workdir: string | null,
          timeoutMs: number,
          backendLabel?: string,
          clientCommandId?: string,
        ): Promise<TermuxCommandResult>;
        getSupportedAbis(): Promise<string[]>;
        getPackageVersion(packageName: string): Promise<string | null>;
        getRuntimeDiagnosticPaths?(): Promise<{
          applicationId: string;
          appDataDir: string;
          filesDir: string;
          embeddedTermuxPrefix: string;
        }>;
        sha256File(fileUri: string): Promise<string>;
        canInstallPackages(): Promise<boolean>;
        openUnknownSourcesSettings(): Promise<boolean>;
        installApk(fileUri: string): Promise<boolean>;
        openPackage(packageName: string): Promise<boolean>;
        getContentUriSize(sourceUri: string): Promise<number>;
        importModelFile(
          sourceUri: string,
          destinationUri: string
        ): Promise<boolean>;
        exportModelToDirectory(
          llmUri: string,
          llmName: string,
          mmprojUri: string,
          mmprojName: string
        ): Promise<boolean>;
      }
    | undefined;
}

export function getTermuxNative() { return getNative(); }

/** Opens the Android system file chooser through the native activity-result bridge. */
export async function pickOfflinePackageArchive(): Promise<OfflineArchivePickerResult> {
  if (Platform.OS !== "android") throw new Error("AIB_OFFLINE_PACKAGE_ANDROID_ONLY");
  const native = getNative();
  if (!native?.pickOfflinePackageArchive) throw new Error("AIB_OFFLINE_PACKAGE_PICKER_UNAVAILABLE");
  const result = await native.pickOfflinePackageArchive();
  if (!result || typeof result.canceled !== "boolean" || (!result.canceled && typeof result.uri !== "string")) {
    throw new Error("AIB_OFFLINE_PACKAGE_PICKER_RESULT_INVALID");
  }
  return result;
}

/** Whether native certificate-pinned Karat manifest verification is available. */
export function isOfflinePackageSignatureVerifierAvailable(): boolean {
  return Platform.OS === "android" && typeof getNative()?.verifyOfflinePackageManifest === "function";
}

/** Native-only trust decision: the feed signer is pinned to an embedded Karat public certificate, not a mutable JS key. */
export async function verifyOfflinePackageManifestSignature(rawManifest: Uint8Array, detachedSignature: Uint8Array): Promise<boolean> {
  if (Platform.OS !== "android" || rawManifest.byteLength < 1 || rawManifest.byteLength > 192 * 1024 || detachedSignature.byteLength !== 256) return false;
  const native = getNative();
  if (!native?.verifyOfflinePackageManifest) return false;
  try {
    return (await native.verifyOfflinePackageManifest(Array.from(rawManifest), Array.from(detachedSignature))) === true;
  } catch {
    return false;
  }
}

/** Native verifies Karat signature, freshness, unused sequence and clock rollback before any feed asset is requested; durable acceptance waits for full stage validation. */
export async function verifyOnlinePackageCatalog(rawManifest: Uint8Array, detachedSignature: Uint8Array): Promise<boolean> {
  if (Platform.OS !== "android" || rawManifest.byteLength < 1 || rawManifest.byteLength > 192 * 1024 || detachedSignature.byteLength !== 256) return false;
  const native = getNative();
  if (!native?.verifyOnlinePackageCatalog) return false;
  try { return (await native.verifyOnlinePackageCatalog(Array.from(rawManifest), Array.from(detachedSignature))) === true; }
  catch { return false; }
}

/** Native streaming SHA-256 for a staged offline-feed file; no JS hash fallback is permitted. */
export async function getOfflineBundleFileSha256(fileUri: string): Promise<string> {
  if (Platform.OS !== "android") throw new Error("AIB_OFFLINE_PACKAGE_HASH_UNAVAILABLE");
  const native = getNative();
  if (!native?.sha256File) throw new Error("AIB_OFFLINE_PACKAGE_HASH_UNAVAILABLE");
  const hash = await native.sha256File(fileUri);
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error("AIB_OFFLINE_PACKAGE_HASH_INVALID");
  return hash;
}

function newOfflineBundleStageId(): string {
  const bytes = new Uint8Array(18);
  try { globalThis.crypto?.getRandomValues(bytes); }
  catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  if (bytes.every(byte => byte === 0)) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function nativeBundleResultIsClean(value: unknown, marker: string): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<OfflineBundleNativeResult>;
  return result.exitCode === 0 && result.timedOut === false && result.outputTruncated === false &&
    typeof result.stdout === "string" && result.stdout.split(/\r?\n/).includes(marker);
}

function deleteOfflineBundleDirectory(stageId: string): void {
  if (!OFFLINE_BUNDLE_STAGE_ID.test(stageId)) return;
  try {
    const directory = new Directory(Paths.cache, `offline-bundle-${stageId}`);
    if (directory.exists) directory.delete();
  } catch { /* best-effort private cache cleanup */ }
}

function isAllowedOfflineBundleInputUri(uri: string): boolean {
  if (/^content:\/\/[A-Za-z0-9._-]+(?:\/[^\u0000-\u001f\u007f]*)?$/.test(uri)) return true;
  try {
    const source = new URL(uri);
    const cache = new URL(Paths.cache.uri);
    if (source.protocol !== "file:" || source.host || source.search || source.hash ||
        cache.protocol !== "file:" || cache.host || cache.search || cache.hash) return false;
    const sourcePath = decodeURIComponent(source.pathname).replace(/\/+$/, "");
    const cachePath = decodeURIComponent(cache.pathname).replace(/\/+$/, "");
    const prefix = `${cachePath}/DocumentPicker/`;
    if (!cachePath || !sourcePath.startsWith(prefix) || sourcePath.includes("\0") || sourcePath.includes("\\")) return false;
    const fileName = sourcePath.slice(prefix.length);
    return fileName.length > 0 && !fileName.includes("/") && fileName !== "." && fileName !== "..";
  } catch {
    return false;
  }
}

function deleteOfflineBundlePickerCopy(uri: string): void {
  if (!uri.startsWith("file://")) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch { /* private cache cleanup is best-effort */ }
}

/** Verifies and extracts the signed data in JS, then asks native to revalidate and simulate local-only APT. */
export async function stageOfflinePackageBundle(uri: string, requestId: string): Promise<OfflinePackageBundleStageResult> {
  if (typeof requestId !== "string" || !OFFLINE_BUNDLE_REQUEST_ID.test(requestId)) {
    return { status: "rejected", code: "AIB_OFFLINE_BUNDLE_REQUEST_ID_INVALID" };
  }
  if (typeof uri !== "string" || uri.length > 8192 || !isAllowedOfflineBundleInputUri(uri)) {
    return { status: "rejected", code: "AIB_OFFLINE_BUNDLE_URI_INVALID" };
  }
  if (Platform.OS !== "android") {
    deleteOfflineBundlePickerCopy(uri);
    return { status: "blocked", code: "AIB_OFFLINE_BUNDLE_ANDROID_ONLY" };
  }
  const native = getNative();
  if (!native?.stageOfflinePackageBundle || !native.sha256File) {
    deleteOfflineBundlePickerCopy(uri);
    return { status: "blocked", code: OFFLINE_BUNDLE_UNAVAILABLE };
  }
  const prior = jsOfflineBundleRequests.get(requestId);
  if (prior) prior.controller.abort();
  const stageId = newOfflineBundleStageId();
  const controller = new AbortController();
  jsOfflineBundleRequests.set(requestId, { controller, stageId });
  let progress = 0;
  try {
    const bundle = await import("./offline-package-bundle");
    const prepared = await bundle.prepareOfflinePackageBundleStage(uri, stageId, controller.signal, event => {
      if (controller.signal.aborted) return;
      progress = Math.max(progress, Math.min(98, event.percent));
      emitJsOfflineBundleProgress({ requestId, phase: event.phase, percent: progress });
    });
    if (controller.signal.aborted || prepared.status === "cancelled") {
      deleteOfflineBundleDirectory(stageId);
      return { status: "blocked", code: "AIB_OFFLINE_PACKAGE_CANCELLED" };
    }
    if (prepared.status !== "ready" || !prepared.stageDirectoryUri || !prepared.packages || !prepared.packageCount || !prepared.totalBytes) {
      deleteOfflineBundleDirectory(stageId);
      return { status: prepared.status === "rejected" ? "rejected" : "blocked", code: prepared.code };
    }
    const nativeResult = await native.stageOfflinePackageBundle(prepared.stageDirectoryUri, stageId, requestId);
    if (controller.signal.aborted) {
      deleteOfflineBundleDirectory(stageId);
      return { status: "blocked", code: "AIB_OFFLINE_PACKAGE_CANCELLED" };
    }
    if (!nativeBundleResultIsClean(nativeResult, "AIB_OFFLINE_APT_SIMULATION_OK")) {
      deleteOfflineBundleDirectory(stageId);
      return { status: "blocked", code: "AIB_OFFLINE_PACKAGE_NATIVE_STAGE_NOT_READY" };
    }
    const packages = prepared.packages.map(pkg => ({ ...pkg }));
    jsOfflineBundleStages.set(stageId, { ownerRequestId: requestId, stageDirectoryUri: prepared.stageDirectoryUri, packages, totalBytes: prepared.totalBytes, requiresPlan: false });
    progress = 99;
    emitJsOfflineBundleProgress({ requestId, phase: "native_stage", percent: progress });
    return { status: "ready", code: "AIB_OFFLINE_PACKAGE_READY", stageId, packageCount: prepared.packageCount,
      totalBytes: prepared.totalBytes, packages };
  } catch {
    deleteOfflineBundleDirectory(stageId);
    return { status: "blocked", code: controller.signal.aborted ? "AIB_OFFLINE_PACKAGE_CANCELLED" : "AIB_OFFLINE_PACKAGE_STAGE_FAILED" };
  } finally {
    deleteOfflineBundlePickerCopy(uri);
    if (jsOfflineBundleRequests.get(requestId)?.controller === controller) jsOfflineBundleRequests.delete(requestId);
  }
}

/** Stage an already-downloaded online catalog in the exact app-private path; native reparses its signed manifest and rehashes every byte. */
export async function stagePreparedOnlinePackageDirectory(
  stageDirectoryUri: string,
  stageId: string,
  packages: readonly OfflinePackageBundlePackage[],
  totalBytes: number,
  requestId: string,
): Promise<OfflinePackageBundleStageResult> {
  if (!OFFLINE_BUNDLE_REQUEST_ID.test(requestId) || !OFFLINE_BUNDLE_STAGE_ID.test(stageId)) return { status: "rejected", code: "AIB_OFFLINE_BUNDLE_ARGUMENT_INVALID" };
  const expected = new Directory(Paths.cache, `offline-bundle-${stageId}`);
  if (typeof stageDirectoryUri !== "string" || stageDirectoryUri !== expected.uri || packages.length < 1 || packages.length > 258 ||
      !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > 200 * 1024 * 1024) {
    deleteOfflineBundleDirectory(stageId);
    return { status: "rejected", code: "AIB_ONLINE_PACKAGE_STAGE_PATH_INVALID" };
  }
  const cleanPackages = packages.map(pkg => ({ ...pkg }));
  const validated = parseOfflineBundleStageResult({ status: "ready", code: "AIB_ONLINE_PACKAGE_READY", stageId,
    packageCount: cleanPackages.length, totalBytes, packages: cleanPackages }, 200 * 1024 * 1024);
  if (validated.status !== "ready") { deleteOfflineBundleDirectory(stageId); return validated; }
  const native = getNative();
  if (Platform.OS !== "android" || !native?.stageOfflinePackageBundle) {
    deleteOfflineBundleDirectory(stageId);
    return { status: "blocked", code: OFFLINE_BUNDLE_UNAVAILABLE };
  }
  const prior = jsOfflineBundleRequests.get(requestId);
  if (prior) prior.controller.abort();
  const controller = new AbortController();
  jsOfflineBundleRequests.set(requestId, { controller, stageId });
  try {
    if (!expected.exists) return { status: "blocked", code: "AIB_ONLINE_PACKAGE_STAGE_DIRECTORY_MISSING" };
    const result = await native.stageOfflinePackageBundle(stageDirectoryUri, stageId, requestId);
    if (controller.signal.aborted) { deleteOfflineBundleDirectory(stageId); return { status: "blocked", code: "AIB_OFFLINE_PACKAGE_CANCELLED" }; }
    if (!nativeBundleResultIsClean(result, "AIB_OFFLINE_APT_SIMULATION_OK")) {
      deleteOfflineBundleDirectory(stageId);
      return { status: "blocked", code: "AIB_ONLINE_PACKAGE_NATIVE_STAGE_NOT_READY" };
    }
    jsOfflineBundleStages.set(stageId, { ownerRequestId: requestId, stageDirectoryUri, packages: cleanPackages, totalBytes, requiresPlan: true });
    emitJsOfflineBundleProgress({ requestId, phase: "native_stage", percent: 99 });
    return { status: "ready", code: "AIB_ONLINE_PACKAGE_READY", stageId, packageCount: cleanPackages.length, totalBytes, packages: cleanPackages };
  } catch {
    deleteOfflineBundleDirectory(stageId);
    return { status: "blocked", code: controller.signal.aborted ? "AIB_OFFLINE_PACKAGE_CANCELLED" : "AIB_ONLINE_PACKAGE_STAGE_FAILED" };
  } finally {
    if (jsOfflineBundleRequests.get(requestId)?.controller === controller) jsOfflineBundleRequests.delete(requestId);
  }
}

/** Simulates selected online roots locally and returns the exact package/version set before user confirmation. */
export async function planOfflinePackageBundle(stageId: string, requestId: string, selectedPackageNames: readonly string[]): Promise<OfflinePackageBundlePlanResult> {
  if (typeof requestId !== "string" || !OFFLINE_BUNDLE_REQUEST_ID.test(requestId) || typeof stageId !== "string" || !OFFLINE_BUNDLE_STAGE_ID.test(stageId)) return { status: "rejected", code: "AIB_OFFLINE_BUNDLE_ARGUMENT_INVALID" };
  const stage = jsOfflineBundleStages.get(stageId);
  if (!stage || !stage.requiresPlan) return { status: "blocked", code: "AIB_OFFLINE_APT_PLAN_STAGE_NOT_OWNED" };
  const availableNames = [...new Set(stage.packages.map(pkg => pkg.name))];
  const roots = [...selectedPackageNames];
  if (roots.length < 1 || roots.length > 256 || new Set(roots).size !== roots.length || roots.some(name => typeof name !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(name) || !availableNames.includes(name))) return { status: "rejected", code: "AIB_OFFLINE_PACKAGE_SELECTION_INVALID" };
  const native = getNative();
  if (Platform.OS !== "android" || !native?.planOfflinePackageBundle) return { status: "blocked", code: OFFLINE_BUNDLE_UNAVAILABLE };
  try {
    const raw = await native.planOfflinePackageBundle(stageId, requestId, roots);
    if (!raw || typeof raw !== "object") return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
    const item = raw as Record<string, unknown>;
    const code = offlineBundleCode(item.code);
    if (item.status === "blocked" || item.status === "rejected") return { status: item.status, code };
    if (item.status !== "ready" || typeof item.planId !== "string" || !/^[A-Fa-f0-9]{32}$/.test(item.planId) || !Array.isArray(item.packages) || item.packages.length < 1 || item.packages.length > 256) return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
    const planned: OfflinePackageBundlePackage[] = [];
    for (const candidate of item.packages) {
      if (!candidate || typeof candidate !== "object") return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
      const row = candidate as Record<string, unknown>;
      if (typeof row.name !== "string" || typeof row.version !== "string" || typeof row.architecture !== "string" || !Number.isSafeInteger(row.sizeBytes)) return { status: "blocked", code: OFFLINE_BUNDLE_INVALID_RESULT };
      const signed = stage.packages.find(pkg => pkg.name === row.name && pkg.version === row.version && pkg.architecture === row.architecture && pkg.sizeBytes === row.sizeBytes);
      if (!signed || planned.some(pkg => pkg.name === signed.name)) return { status: "blocked", code: "AIB_OFFLINE_APT_PLAN_NOT_IN_SIGNED_CATALOG" };
      planned.push({ ...signed });
    }
    if (roots.some(name => !planned.some(pkg => pkg.name === name))) return { status: "blocked", code: "AIB_OFFLINE_APT_PLAN_ROOT_MISSING" };
    jsOfflineBundlePlans.set(item.planId, { stageId, requestId, roots, packages: planned });
    return { status: "ready", code, planId: item.planId, packages: planned };
  } catch { return { status: "blocked", code: "AIB_OFFLINE_APT_PLAN_RESULT_UNAVAILABLE" }; }
}

/** Installs only a known JS-owned stage and, for online feeds, its exact native-held simulation plan. */
export async function installOfflinePackageBundle(stageId: string, requestId: string, selectedPackageNames?: readonly string[], planId?: string): Promise<OfflinePackageBundleInstallResult> {
  if (typeof requestId !== "string" || !OFFLINE_BUNDLE_REQUEST_ID.test(requestId)) return { status: "rejected", code: "AIB_OFFLINE_BUNDLE_REQUEST_ID_INVALID" };
  if (typeof stageId !== "string" || !OFFLINE_BUNDLE_STAGE_ID.test(stageId)) return { status: "rejected", code: "AIB_OFFLINE_BUNDLE_STAGE_ID_INVALID" };
  const stage = jsOfflineBundleStages.get(stageId);
  if (!stage) return { status: "blocked", code: "AIB_OFFLINE_PACKAGE_STAGE_NOT_OWNED" };
  const availableNames = [...new Set(stage.packages.map(pkg => pkg.name))];
  const selected = selectedPackageNames === undefined ? availableNames : [...selectedPackageNames];
  if (selected.length < 1 || selected.length > 256 || new Set(selected).size !== selected.length ||
      selected.some(name => typeof name !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(name) || !availableNames.includes(name))) {
    return { status: "rejected", code: "AIB_OFFLINE_PACKAGE_SELECTION_INVALID" };
  }
  const plan = planId ? jsOfflineBundlePlans.get(planId) : undefined;
  if (stage.requiresPlan && (!plan || plan.stageId !== stageId || JSON.stringify(plan.roots) !== JSON.stringify(selected))) return { status: "blocked", code: "AIB_OFFLINE_APT_PLAN_REQUIRED" };
  if (!stage.requiresPlan && planId !== undefined) return { status: "rejected", code: "AIB_OFFLINE_APT_PLAN_NOT_APPLICABLE" };
  const native = getNative();
  if (Platform.OS !== "android" || !native?.installOfflinePackageBundle) return { status: "blocked", code: OFFLINE_BUNDLE_UNAVAILABLE };
  try {
    const result = await native.installOfflinePackageBundle(stageId, requestId, selected, planId ?? null);
    if (nativeBundleResultIsClean(result, "AIB_OFFLINE_INSTALL_VERIFIED")) {
      return { status: "installed", code: "AIB_OFFLINE_PACKAGE_INSTALLED_VERIFIED",
        installed: selected.map(name => { const pkg = plan?.packages.find(row => row.name === name) ?? stage.packages.find(row => row.name === name)!; return { name, version: pkg.version }; }) };
    }
    const failed = !!result && typeof result === "object" && typeof (result as OfflineBundleNativeResult).exitCode === "number" &&
      (result as OfflineBundleNativeResult).exitCode !== 0;
    return { status: failed ? "partial" : "blocked", code: failed ? "AIB_OFFLINE_PACKAGE_INSTALL_PARTIAL" : "AIB_OFFLINE_PACKAGE_INSTALL_NOT_VERIFIED" };
  } catch {
    return { status: "partial", code: "AIB_OFFLINE_PACKAGE_INSTALL_RESULT_UNKNOWN" };
  } finally {
    jsOfflineBundleStages.delete(stageId);
    if (planId) jsOfflineBundlePlans.delete(planId);
    deleteOfflineBundleDirectory(stageId);
  }
}

/** Cancels JS/native work; an active operation owns cleanup until its promise settles. */
export async function cancelOfflinePackageBundle(requestId: string): Promise<boolean> {
  if (typeof requestId !== "string" || !OFFLINE_BUNDLE_REQUEST_ID.test(requestId)) return false;
  const active = jsOfflineBundleRequests.get(requestId);
  if (active) active.controller.abort();
  const ownedStages = [...jsOfflineBundleStages.entries()].filter(([, stage]) => stage.ownerRequestId === requestId);
  for (const [planId, plan] of jsOfflineBundlePlans.entries()) {
    if (plan.requestId === requestId || ownedStages.some(([stageId]) => stageId === plan.stageId)) jsOfflineBundlePlans.delete(planId);
  }
  let nativeAcknowledged = false;
  if (Platform.OS === "android") {
    const native = getNative();
    if (native?.cancelOfflinePackageBundle) {
      try { nativeAcknowledged = (await native.cancelOfflinePackageBundle(requestId)) === true; } catch { /* cancellation is best-effort */ }
    }
  }
  for (const [stageId] of ownedStages) {
    jsOfflineBundleStages.delete(stageId);
    deleteOfflineBundleDirectory(stageId);
  }
  // The active stage method removes its directory in its own finally path after native work settles.
  return nativeAcknowledged;
}

/** Existing JavaScript v2 preflight remains validation-only and never stages or installs packages. */
export async function inspectOfflinePackageBundle(uri: string, options: OfflineBundleOptions = {}): Promise<OfflineBundleInspection> {
  try {
    const preflight = await import("./offline-package-bundle");
    return await preflight.inspectOfflinePackageBundle(uri, options);
  } catch {
    return { status: "blocked", code: "AIB_OFFLINE_PACKAGE_NATIVE_PREFLIGHT_UNAVAILABLE" };
  }
}

/** Read native signer/hook evidence for the UI warning; Kotlin independently enforces the same policy. */
export async function getReleaseIntegrityEvidence(): Promise<unknown> {
  if (Platform.OS !== "android") return null;
  const native = getNative();
  if (!native?.getReleaseIntegrityEvidence) return null;
  try {
    return await native.getReleaseIntegrityEvidence();
  } catch {
    persistentLogger.add("warn", "AppIntegrity", JSON.stringify({ outcome: "blocked", reason: "probe_unavailable" }), "app");
    return null;
  }
}

/** Checks Android's broad All files access special permission; it never opens Settings. */
export async function getAIBuilderAllFilesAccessStatus(): Promise<AIBuilderAllFilesAccessStatus> {
  if (Platform.OS !== "android") return { supported: false, granted: false, reason: "AIB_ALL_FILES_ACCESS_ANDROID_ONLY" };
  const native = getNative();
  if (!native?.getAIBuilderAllFilesAccessStatus) {
    return { supported: false, granted: false, reason: "AIB_ALL_FILES_ACCESS_STATUS_UNAVAILABLE" };
  }
  try {
    const value = await native.getAIBuilderAllFilesAccessStatus();
    if (!value || typeof value.supported !== "boolean" || typeof value.granted !== "boolean" ||
      !(value.reason === null || typeof value.reason === "string") || (value.granted && !value.supported)) {
      return { supported: false, granted: false, reason: "AIB_ALL_FILES_ACCESS_STATUS_INVALID" };
    }
    return value;
  } catch {
    return { supported: false, granted: false, reason: "AIB_ALL_FILES_ACCESS_STATUS_UNAVAILABLE" };
  }
}

/** Opens the Android special-access page only after a direct user action. */
export async function openAIBuilderAllFilesAccessSettings(): Promise<boolean> {
  if (Platform.OS !== "android") throw new Error("AIB_ALL_FILES_ACCESS_ANDROID_ONLY");
  const native = getNative();
  if (!native?.openAIBuilderAllFilesAccessSettings) throw new Error("AIB_ALL_FILES_ACCESS_SETTINGS_UNAVAILABLE");
  return native.openAIBuilderAllFilesAccessSettings();
}

/** Current exact-root SAF read grant status; no broad Android storage permission is queried. */
export async function getAIBuilderWorkspaceGrantStatus(): Promise<AIBuilderWorkspaceGrantStatus> {
  if (Platform.OS !== "android") return { granted: false, reason: "AIB_WORKSPACE_ANDROID_ONLY" };
  const native = getNative();
  if (!native?.getAIBuilderWorkspaceGrantStatus) return { granted: false, reason: "AIB_WORKSPACE_GRANT_STATUS_UNAVAILABLE" };
  try {
    const value = await native.getAIBuilderWorkspaceGrantStatus();
    if (!value || typeof value.granted !== "boolean" || !(value.reason === null || typeof value.reason === "string")) {
      return { granted: false, reason: "AIB_WORKSPACE_GRANT_STATUS_INVALID" };
    }
    return value;
  } catch {
    return { granted: false, reason: "AIB_WORKSPACE_GRANT_STATUS_UNAVAILABLE" };
  }
}

/** Opens Android's system folder picker; only the exact AIBuilderTermux tree is accepted natively. */
export async function requestAIBuilderWorkspaceGrant(): Promise<AIBuilderWorkspaceGrantStatus> {
  if (Platform.OS !== "android") throw new Error("AIB_WORKSPACE_ANDROID_ONLY");
  const access = await getAIBuilderAllFilesAccessStatus();
  if (!access.granted) throw new Error(access.reason || "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED");
  const native = getNative();
  if (!native?.requestAIBuilderWorkspaceGrant) throw new Error("AIB_WORKSPACE_GRANT_UNAVAILABLE");
  const value = await native.requestAIBuilderWorkspaceGrant();
  if (!value || typeof value.granted !== "boolean" || !(value.reason === null || typeof value.reason === "string")) {
    throw new Error("AIB_WORKSPACE_GRANT_RESULT_INVALID");
  }
  return value;
}

/** Reads bounded, direct-child metadata through ContentResolver; it never opens file contents. */
export async function listAIBuilderWorkspace(): Promise<AIBuilderWorkspaceListing> {
  if (Platform.OS !== "android") throw new Error("AIB_WORKSPACE_ANDROID_ONLY");
  const access = await getAIBuilderAllFilesAccessStatus();
  if (!access.granted) throw new Error(access.reason || "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED");
  const native = getNative();
  if (!native?.listAIBuilderWorkspace) throw new Error("AIB_WORKSPACE_LIST_UNAVAILABLE");
  const value = await native.listAIBuilderWorkspace();
  if (!value || value.rootPath !== AI_BUILDER_WORKSPACE_ROOT || !isCanonicalAIBuilderWorkspacePath(value.rootPath) ||
    value.readOnly !== true || !Array.isArray(value.entries) || typeof value.truncated !== "boolean") {
    throw new Error("AIB_WORKSPACE_LIST_RESULT_INVALID");
  }
  const entries = value.entries.map((entry) => {
    if (!entry || !isSafeAIBuilderWorkspaceChildName(entry.name) ||
      !["directory", "file", "unknown"].includes(entry.kind) ||
      (entry.sizeBytes !== undefined && (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)) ||
      (entry.lastModifiedMs !== undefined && (!Number.isSafeInteger(entry.lastModifiedMs) || entry.lastModifiedMs < 0))) {
      throw new Error("AIB_WORKSPACE_LIST_ENTRY_INVALID");
    }
    return { ...entry, path: aiBuilderWorkspaceChildPath(value.rootPath, entry.name) } as AIBuilderWorkspaceEntry;
  });
  return { rootPath: AI_BUILDER_WORKSPACE_ROOT, readOnly: true, entries, truncated: value.truncated };
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) { const point = character.codePointAt(0) ?? 0; if (point >= 0xd800 && point <= 0xdfff) return Infinity; bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return bytes;
}
function workspaceCapabilityMatches(value: unknown): value is AIBuilderWorkspaceFileCapabilities {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return c.rootPath === AI_BUILDER_WORKSPACE_ROOT && c.transport === "procfd-nofollow" && c.read === true && c.write === true && c.maxBytes === AI_BUILDER_WORKSPACE_MAX_BYTES && c.nested === true;
}
/** Native returns capabilities only after verifying all-files access and opening the trusted root. */
export async function getAIBuilderWorkspaceFileCapabilities(): Promise<AIBuilderWorkspaceFileCapabilities> {
  if (Platform.OS !== "android") throw new Error("AIB_WORKSPACE_ANDROID_ONLY");
  const access = await getAIBuilderAllFilesAccessStatus();
  if (!access.granted) throw new Error(access.reason || "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED");
  const native = getNative();
  if (!native?.getAIBuilderWorkspaceFileCapabilities) throw new Error("AIB_WORKSPACE_FILE_API_UNAVAILABLE");
  let value: unknown;
  try { value = await native.getAIBuilderWorkspaceFileCapabilities(); } catch { throw new Error("AIB_WORKSPACE_FILE_CAPABILITY_UNAVAILABLE"); }
  if (!workspaceCapabilityMatches(value)) throw new Error("AIB_WORKSPACE_FILE_CAPABILITY_INVALID");
  return value;
}
export async function readAIBuilderWorkspaceFile(relativePath: string): Promise<AIBuilderWorkspaceFileRead> {
  if (!isSafeAIBuilderWorkspaceRelativePath(relativePath)) throw new Error("AIB_WORKSPACE_RELATIVE_PATH_INVALID");
  const c = await getAIBuilderWorkspaceFileCapabilities();
  if (!c.read) throw new Error("AIB_WORKSPACE_READ_UNAVAILABLE");
  const native = getNative();
  if (!native?.readAIBuilderWorkspaceFile) throw new Error("AIB_WORKSPACE_FILE_API_UNAVAILABLE");
  let value: unknown;
  try { value = await native.readAIBuilderWorkspaceFile(relativePath); } catch { throw new Error("AIB_WORKSPACE_READ_FAILED"); }
  if (!value || typeof value !== "object") throw new Error("AIB_WORKSPACE_READ_RESULT_INVALID");
  const r = value as Record<string, unknown>;
  if (r.rootPath !== AI_BUILDER_WORKSPACE_ROOT || r.relativePath !== relativePath || typeof r.content !== "string" || !Number.isSafeInteger(r.byteLength) || r.byteLength !== utf8ByteLength(r.content) || (r.byteLength as number) > AI_BUILDER_WORKSPACE_MAX_BYTES) throw new Error("AIB_WORKSPACE_READ_RESULT_INVALID");
  return { rootPath: AI_BUILDER_WORKSPACE_ROOT, relativePath, content: r.content, byteLength: r.byteLength as number };
}
export async function writeAIBuilderWorkspaceFile(relativePath: string, content: string): Promise<AIBuilderWorkspaceFileWrite> {
  if (!isSafeAIBuilderWorkspaceRelativePath(relativePath)) throw new Error("AIB_WORKSPACE_RELATIVE_PATH_INVALID");
  if (typeof content !== "string" || content.includes("\0")) throw new Error("AIB_WORKSPACE_CONTENT_INVALID");
  const byteLength = utf8ByteLength(content);
  if (!Number.isFinite(byteLength)) throw new Error("AIB_WORKSPACE_CONTENT_INVALID");
  if (byteLength > AI_BUILDER_WORKSPACE_MAX_BYTES) throw new Error("AIB_WORKSPACE_CONTENT_TOO_LARGE");
  const c = await getAIBuilderWorkspaceFileCapabilities();
  if (!c.write) throw new Error("AIB_WORKSPACE_WRITE_UNAVAILABLE");
  const native = getNative();
  if (!native?.writeAIBuilderWorkspaceFile) throw new Error("AIB_WORKSPACE_FILE_API_UNAVAILABLE");
  let value: unknown;
  try { value = await native.writeAIBuilderWorkspaceFile(relativePath, content); } catch { throw new Error("AIB_WORKSPACE_WRITE_FAILED"); }
  if (!value || typeof value !== "object") throw new Error("AIB_WORKSPACE_WRITE_RESULT_INVALID");
  const r = value as Record<string, unknown>;
  if (r.rootPath !== AI_BUILDER_WORKSPACE_ROOT || r.relativePath !== relativePath || r.byteLength !== byteLength || r.written !== true) throw new Error("AIB_WORKSPACE_WRITE_RESULT_INVALID");
  return { rootPath: AI_BUILDER_WORKSPACE_ROOT, relativePath, byteLength, written: true };
}

/** Executes only inside the app-private embedded runtime. Missing capability is an error, never a Termux fallback. */
export async function runEmbeddedTermuxCommand(
  command: string,
  options: { workdir?: string; timeoutMs?: number; signal?: AbortSignal; offlineBuild?: boolean } = {},
): Promise<EmbeddedTermuxCommandResult> {
  return enqueueTermuxCommand(() => runEmbeddedTermuxCommandNow(command, options, options.offlineBuild ? "offline-build" : "direct-api"));
}

/** Internal dispatch for runShellCommand, which already owns the shared queue slot. */
async function runEmbeddedTermuxCommandNow(
  command: string,
  options: { workdir?: string; timeoutMs?: number; signal?: AbortSignal; offlineBuild?: boolean } = {},
  requestOrigin = "shell-queue",
): Promise<EmbeddedTermuxCommandResult> {
  if (Platform.OS !== "android") throw new Error("EMBEDDED_RUNTIME_ANDROID_ONLY");
  if (typeof command !== "string" || !command.trim() || command.length > 128 * 1024 || command.includes("\0")) {
    throw new Error("EMBEDDED_EXEC_COMMAND_INVALID");
  }
  const native = getNative();
  if (options.offlineBuild) {
    const approved = command.includes("AIB_PRIVATE_OFFLINE_BUILD_V1=1") &&
      command.includes("AIB_ASSEMBLE_TASK=assembleDebug") && command.includes("AIB_GRADLE_EXTRA_FLAGS=--offline");
    if (!approved) throw new Error("AIB_OFFLINE_BUILD_COMMAND_INVALID");
    if (!native?.runEmbeddedTermuxBuildCommand) throw new Error("EMBEDDED_BUILD_UNAVAILABLE");
  } else if (!native?.runEmbeddedTermuxCommand) throw new Error("EMBEDDED_EXEC_UNAVAILABLE");
  if (options.signal && !native.cancelEmbeddedTermuxCommand) throw new Error("EMBEDDED_CANCEL_UNAVAILABLE");
  const requestId = `private-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const requestedTimeout = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(requestedTimeout)) throw new Error("EMBEDDED_EXEC_TIMEOUT_INVALID");
  const timeoutCap = options.offlineBuild ? 900_000 : 120_000;
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("EMBEDDED_EXEC_CANCELLED");
  if (native.prepareEmbeddedTermuxRuntime) await prepareEmbeddedTermuxRuntime();
  const value = await runWithEmbeddedAbort(
    options.signal,
    () => options.offlineBuild
      ? native.runEmbeddedTermuxBuildCommand!(command, options.workdir ?? null, Math.max(1_000, Math.min(timeoutCap, requestedTimeout)), requestId)
      : native.runEmbeddedTermuxCommand!(command, options.workdir ?? null, Math.max(1_000, Math.min(timeoutCap, requestedTimeout)), requestId),
    () => native.cancelEmbeddedTermuxCommand!(requestId),
  ).catch((error: unknown) => {
    const code = embeddedFailureCode(error);
    const cwdDetails = embeddedCwdRejectionDetails(error);
    persistentLogger.add("warn", "EmbeddedExecDiagnostic", JSON.stringify({ operation: "execute", requestOrigin, outcome: "native_rejected", code, ...(cwdDetails ?? {}) }), "app");
    throw error;
  });
  if (!value || value.commandId !== requestId || typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" || !Number.isInteger(value.exitCode) ||
    typeof value.timedOut !== "boolean" || typeof value.outputTruncated !== "boolean" ||
    typeof value.durationMs !== "number" || value.backendId !== "embedded-termux") {
    throw new Error("EMBEDDED_EXEC_RESULT_INVALID");
  }
  return value;
}

/** Fixed native catalog actions only; the ordinary arbitrary-shell API keeps its 120-second limit. */
export async function runEmbeddedFullCandidateTransaction(
  action: "verify" | "install" | "reinstall" | "remove" | "check",
  packages: readonly string[],
  signal?: AbortSignal,
): Promise<EmbeddedTermuxCommandResult> {
  if (Platform.OS !== "android") throw new Error("EMBEDDED_RUNTIME_ANDROID_ONLY");
  if (!["verify", "install", "reinstall", "remove", "check"].includes(action) ||
      !Array.isArray(packages) || packages.length > 82 || packages.some((name) => typeof name !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(name))) {
    throw new Error("AIB_FULL_CANDIDATE_ARGUMENT_INVALID");
  }
  const native = getNative();
  if (!native?.runEmbeddedCandidateFullTransaction) throw new Error("AIB_FULL_CANDIDATE_UNAVAILABLE");
  if (signal && !native.cancelEmbeddedTermuxCommand) throw new Error("EMBEDDED_CANCEL_UNAVAILABLE");
  if (signal?.aborted) throw signal.reason ?? new Error("EMBEDDED_EXEC_CANCELLED");
  const requestId = `candidate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  // Fixed catalog transactions share the same exclusive slot as shell commands.
  // runWithEmbeddedAbort stays inside the job so queued aborts never start native work.
  const value = await enqueueTermuxCommand(() => runWithEmbeddedAbort(signal,
    () => native.runEmbeddedCandidateFullTransaction!(action, packages, requestId),
    () => native.cancelEmbeddedTermuxCommand!(requestId),
  ));
  if (!value || value.commandId !== requestId || typeof value.stdout !== "string" || typeof value.stderr !== "string" ||
      !Number.isInteger(value.exitCode) || typeof value.timedOut !== "boolean" || typeof value.outputTruncated !== "boolean" ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.backendId !== "embedded-termux") {
    throw new Error("EMBEDDED_EXEC_RESULT_INVALID");
  }
  return value;
}

/** Reads one bounded app-private apply.log by transaction ID; it never runs a shell command. */
export async function readEmbeddedCandidateApplyLog(transactionId: string): Promise<{
  transactionId: string; content: string; byteLength: number; truncated: boolean;
}> {
  if (Platform.OS !== "android") throw new Error("AIB_CANDIDATE_APPLY_LOG_ANDROID_ONLY");
  if (typeof transactionId !== "string" || !/^tx-[A-Za-z0-9-]{12,80}$/.test(transactionId)) {
    throw new Error("AIB_CANDIDATE_APPLY_LOG_TRANSACTION_INVALID");
  }
  const native = getNative();
  if (!native?.readEmbeddedCandidateApplyLog) throw new Error("AIB_CANDIDATE_APPLY_LOG_UNAVAILABLE");
  const value = await native.readEmbeddedCandidateApplyLog(transactionId);
  if (!value || typeof value !== "object") throw new Error("AIB_CANDIDATE_APPLY_LOG_RESULT_INVALID");
  const result = value as Record<string, unknown>;
  if (typeof result.transactionId !== "string" || !/^tx-[A-Za-z0-9-]{12,80}$/.test(result.transactionId) ||
      typeof result.content !== "string" || !Number.isSafeInteger(result.byteLength) ||
      (result.byteLength as number) < 0 || (result.byteLength as number) > 64 * 1024 ||
      typeof result.truncated !== "boolean") {
    throw new Error("AIB_CANDIDATE_APPLY_LOG_RESULT_INVALID");
  }
  return { transactionId: result.transactionId, content: result.content, byteLength: result.byteLength as number, truncated: result.truncated };
}

/** Query only the embedded app-private dpkg registry through a dedicated native fixed-argv method. */
export async function queryEmbeddedTermuxPackages(
  name: string | null,
  limit: number,
): Promise<EmbeddedTermuxPackageQueryResult> {
  if (Platform.OS !== "android") throw new Error("AIB_PRIVATE_PACKAGE_QUERY_ANDROID_ONLY");
  if (name !== null && (typeof name !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(name))) {
    throw new Error("AIB_PRIVATE_PACKAGE_NAME_INVALID");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("AIB_PRIVATE_PACKAGE_LIMIT_INVALID");
  }
  const native = getNative();
  if (!native?.queryEmbeddedTermuxPackages) throw new Error("AIB_PRIVATE_PACKAGE_QUERY_UNAVAILABLE");
  if (native.prepareEmbeddedTermuxRuntime) await prepareEmbeddedTermuxRuntime();
  const value = await native.queryEmbeddedTermuxPackages(name, limit);
  if (!value || typeof value.stdout !== "string" || typeof value.stderr !== "string" ||
    !Number.isInteger(value.exitCode) || typeof value.timedOut !== "boolean" ||
    typeof value.outputTruncated !== "boolean" ||
    utf8ByteLength(value.stdout) > 32 * 1024 || utf8ByteLength(value.stderr) > 4 * 1024) {
    throw new Error("AIB_PRIVATE_PACKAGE_QUERY_RESULT_INVALID");
  }
  return value;
}


/** Reject malformed or absent native callback payloads instead of letting an
 * accidental `null` become a success-shaped empty result or an opaque TypeError. */
export function normalizeNativeCommandResult(value: unknown, clientCommandId: string): TermuxCommandResult {
  if (!value || typeof value !== "object") {
    throw new Error("TERMUX_NATIVE_RESULT_MISSING: private execution returned no result object");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    typeof result.exitCode !== "number" || !Number.isFinite(result.exitCode) ||
    typeof result.timedOut !== "boolean" ||
    (result.callbackMissing !== undefined && typeof result.callbackMissing !== "boolean")
  ) {
    throw new Error("TERMUX_NATIVE_RESULT_INVALID: private execution omitted required result fields");
  }
  const returnedCommandId = typeof result.commandId === "string" && result.commandId ? result.commandId : undefined;
  if (returnedCommandId && /^(?:js|tr)-/.test(returnedCommandId) && returnedCommandId !== clientCommandId) {
    throw new Error("TERMUX_NATIVE_RESULT_ID_MISMATCH: callback belongs to a different JavaScript command");
  }
  if (result.nativeCommandId !== undefined && (typeof result.nativeCommandId !== "string" || !/^[a-f0-9]{32}$/.test(result.nativeCommandId))) {
    throw new Error("TERMUX_NATIVE_RESULT_NATIVE_ID_INVALID: callback UUID is malformed");
  }
  const nativeCommandId = typeof result.nativeCommandId === "string" && result.nativeCommandId
    ? result.nativeCommandId
    : returnedCommandId && returnedCommandId !== clientCommandId ? returnedCommandId : undefined;
  return {
    commandId: clientCommandId,
    ...(nativeCommandId ? { nativeCommandId } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...(result.callbackMissing === true ? { callbackMissing: true } : {}),
    ...(result.outputTruncated === true ? { outputTruncated: true } : {}),
  };
}

async function invokeNativeRunCommand(
  native: NonNullable<ReturnType<typeof getNative>>,
  command: string,
  workdir: string | null,
  timeoutMs: number,
  backendLabel: string,
  clientCommandId: string,
): Promise<TermuxCommandResult> {
  if (!native.runEmbeddedTermuxCommand) throw new Error("EMBEDDED_EXEC_UNAVAILABLE");
  const embedded = await runEmbeddedTermuxCommandNow(command, { workdir: workdir ?? undefined, timeoutMs }, "shell-queue");
  const raw = { ...embedded, commandId: clientCommandId };
  const result = normalizeNativeCommandResult(raw, clientCommandId);
  if ((result.stderr || "").includes("AIB_COMMAND_CANCELLED")) {
    throw new Error("ABORTED");
  }
  return result;
}

const runCommandPermissionGate = new RunCommandPermissionGate();
let lastPermissionGateWarningAt = 0;
let lastPermissionBlockedTraceAt = 0;
let deepReadinessProbePending: Promise<TermuxReadiness> | null = null;
let deepReadinessProbeCache: { value: TermuxReadiness; checkedAt: number } | null = null;
const DEEP_READINESS_READY_TTL_MS = 3_000;
const DEEP_READINESS_FAILURE_TTL_MS = 30_000;



export function isNativeModuleAvailable(): boolean {
  return Platform.OS === "android" && !!getNative();
}

/** Подписка на живой stdout/stderr Termux → лог приложения (как окно Termux). */
let streamSub: EmitterSubscription | null = null;
let streamRefCount = 0;
/** Correlates native live output with the command/backend that produced it. */
const commandContexts = new Map<string, { backend: string; label: string; startedAt: number; command: string }>();
const commandStreamBuffers = new Map<string, { kind: "stdout" | "stderr"; buf: string }>();
const commandStreamSummaries = new Map<string, { stdoutChars: number; stderrChars: number; stdoutBytes: number; stderrBytes: number; markers: Set<string> }>();
let lastUnmatchedOutputTraceAt = 0;

function addStreamSummary(cmdId: string, kind: "stdout" | "stderr", text: string) {
  const summary = commandStreamSummaries.get(cmdId) || { stdoutChars: 0, stderrChars: 0, stdoutBytes: 0, stderrBytes: 0, markers: new Set<string>() };
  if (kind === "stdout") { summary.stdoutChars += text.length; summary.stdoutBytes += utf8ByteLength(text); }
  else { summary.stderrChars += text.length; summary.stderrBytes += utf8ByteLength(text); }
  const safe = summarizeCommandOutputForLogs("", text);
  const match = safe.match(/\[SAFE_MARKERS ([^\]]+)\]/);
  if (match) for (const marker of match[1].split(" ")) summary.markers.add(marker);
  commandStreamSummaries.set(cmdId, summary);
}

function persistCommandStreamSummary(cmdId: string) {
  const summary = commandStreamSummaries.get(cmdId);
  commandStreamSummaries.delete(cmdId);
  if (!summary) return;
  const ctx = commandContexts.get(cmdId);
  const isLinux = !!ctx && ctx.backend !== "termux";
  const tag = isLinux ? `Linux:${ctx!.label}:${cmdId}:stream-summary` : `Termux:${cmdId}:stream-summary`;
  const markers = [...summary.markers].slice(0, 32);
  persistentLogger.add(summary.stderrChars ? "warn" : "info", tag,
    `metricSource=live-stream-transport stdoutStreamChars=${summary.stdoutChars} stdoutStreamUtf8Bytes=${summary.stdoutBytes} stderrStreamChars=${summary.stderrChars} stderrStreamUtf8Bytes=${summary.stderrBytes}${markers.length ? ` safeMarkers=${markers.join(",")}` : ""}`,
    isLinux ? "linux" : "termux");
}

function flushCommandStream(cmdId: string, force = false) {
  const state = commandStreamBuffers.get(cmdId);
  if (!state || !state.buf) return;
  const parts = state.buf.split("\n");
  if (!force) state.buf = parts.pop() || ""; else state.buf = "";
  for (const line of parts) {
    const t = line.replace(/\r$/, "");
    if (t) addStreamSummary(cmdId, state.kind, t);
  }
  if (force && state.buf.trim()) {
    addStreamSummary(cmdId, state.kind, state.buf.replace(/\r$/, ""));
    state.buf = "";
  }
}

function flushAllCommandStreams(force = false) {
  for (const cmdId of commandStreamBuffers.keys()) flushCommandStream(cmdId, force);
}

function ensureTermuxStreamListener() {
  if (streamSub || Platform.OS !== "android") return;
  const native = getNative();
  if (!native) return;
  try {
    const emitter = new NativeEventEmitter(NativeModules.TermuxBridge);
    streamSub = emitter.addListener("TermuxCommandOutput", (ev: TermuxCommandOutputEvent) => {
      const stream = String(ev?.stream || "");
      const chunk = String(ev?.chunk || "");
      if (!chunk) return;
      const cmdId = ev?.cmdId ? String(ev.cmdId) : undefined;
      const ctx = cmdId ? commandContexts.get(cmdId) : undefined;
      if (stream === "lifecycle") {
        const evName = String(ev?.event || "event");
        // Everything the host/guest shell does is logged. Linux proot gets its
        // own namespace so Debian/Ubuntu diagnostics are not indistinguishable
        // from native Termux output.
        const level =
          evName === "exception" || evName === "timeout"
            ? "error"
            : evName === "exit" || evName === "dispatch"
              ? "info"
              : "debug";
        const backend = ctx?.backend ?? "termux";
        const commandKind = classifyCommandForDiagnostics(ctx?.command ?? "");
        const exitCode = Number(chunk.match(/\bexit=(-?\d+)\b/)?.[1]);
        const timeoutMs = Number(chunk.match(/\btimeoutMs=(\d+)\b/)?.[1]);
        const safeEvent = ["dispatch", "started", "timeout", "callback-error", "finished", "exception", "exit"].includes(evName) ? evName : "event";
        const exceptionCategory = safeEvent === "exception" ? classifyDiagnosticError(chunk) : undefined;
        persistentLogger.trace({
          correlationId: cmdId || "unknown",
          commandId: cmdId,
          nativeCommandId: ev?.nativeCmdId,
          action: `command.${commandKind}`,
          step: `native.${safeEvent}`,
          status: safeEvent === "timeout" ? "timed_out" : safeEvent === "exception" || safeEvent === "callback-error" ? "failed" : safeEvent === "dispatch" || safeEvent === "started" ? "started" : "progress",
          backend: backend === "ubuntu-proot" ? backend : "termux",
          target: backend === "ubuntu-proot" ? "ubuntu" : "termux",
          screen: commandKind === "rootfs-probe" || commandKind === "rootfs-install" ? "runtime" : "termux",
          ...(Number.isFinite(exitCode) ? { exitCode } : {}),
          ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
          ...(typeof ev?.elapsedSec === "number" ? { durationMs: ev.elapsedSec * 1000 } : {}),
          ...(typeof ev?.stdoutBytes === "number" ? { stdoutBytes: ev.stdoutBytes } : {}),
          ...(exceptionCategory ? { errorCategory: exceptionCategory } : {}),
        });
        persistentLogger.add(level as any, backend !== "termux" ? `Linux:${ctx!.label}:lifecycle` : "Termux:lifecycle", `event=${safeEvent} cmdId=${cmdId || "?"}${exceptionCategory ? ` errorCategory=${exceptionCategory}` : ""}${Number.isFinite(exitCode) ? ` exitCode=${exitCode}` : ""}${Number.isFinite(timeoutMs) && timeoutMs > 0 ? ` timeoutMs=${timeoutMs}` : ""}`, backend !== "termux" ? "linux" : "termux");
        return;
      }
      if (stream === "heartbeat") {
        const backend = ctx?.backend ?? "termux";
        const isLinux = backend === "ubuntu-proot";
        const commandKind = classifyCommandForDiagnostics(ctx?.command ?? "");
        persistentLogger.trace({
          correlationId: cmdId || "unknown",
          commandId: cmdId,
          action: "command.progress",
          step: "native.heartbeat",
          status: "progress",
          backend: isLinux ? backend : "termux",
          target: isLinux ? "ubuntu" : "termux",
          screen: commandKind === "rootfs-probe" || commandKind === "rootfs-install" ? "runtime" : "termux",
          ...(typeof ev?.elapsedSec === "number" ? { durationMs: ev.elapsedSec * 1000 } : {}),
          ...(typeof ev?.stdoutBytes === "number" ? { stdoutBytes: ev.stdoutBytes } : {}),
        });
        return;
      }
      // stdout/stderr — сохраняем построчно и привязываем к конкретной
      // команде. Для Debian/Ubuntu это позволяет отличить guest output от
      // host Termux и не смешивать параллельные команды.
      if (stream === "stdout" || stream === "stderr") {
        if (!cmdId) {
          const now = Date.now();
          if (now - lastUnmatchedOutputTraceAt > 60_000) {
            lastUnmatchedOutputTraceAt = now;
            persistentLogger.trace({ correlationId: createTraceCorrelationId("unmatched"), action: "command.output", step: "native.unmatched-stream", status: "progress", backend: "native", target: "termux", screen: "termux" });
          }
          return;
        }
        const state = commandStreamBuffers.get(cmdId) || { kind: stream, buf: "" };
        if (state.kind !== stream) {
          flushCommandStream(cmdId, true);
          state.kind = stream;
          state.buf = "";
        }
        state.buf += chunk;
        commandStreamBuffers.set(cmdId, state);
        if (state.buf.includes("\n") || state.buf.length > 4000) flushCommandStream(cmdId, false);
      }
    });
  } catch (e: unknown) {
    persistentLogger.add("warn", "TermuxBridge", `stream listener unavailable errorCategory=${classifyDiagnosticError(e)}`);
  }
}

function retainTermuxStream() {
  streamRefCount++;
  ensureTermuxStreamListener();
}

function releaseTermuxStream() {
  streamRefCount = Math.max(0, streamRefCount - 1);
  flushAllCommandStreams(true);
  if (streamRefCount === 0 && streamSub) {
    try { streamSub.remove(); } catch { /* ignore */ }
    streamSub = null;
  }
}


/**
 * Проверяет всё, что нужно для реальной работы Termux-сессии.
 * Проверяет только встроенный bootstrap; deep запускает безопасную private echo-пробу.
 */
export async function checkTermuxReadiness(
  opts?: { deep?: boolean; refreshPermission?: boolean }
): Promise<TermuxReadiness> {
  if (opts?.deep !== true) return checkTermuxReadinessOnce(opts);
  const forceRefresh = opts.refreshPermission === true;
  if (forceRefresh) deepReadinessProbeCache = null;
  if (!forceRefresh && deepReadinessProbeCache) {
    const ttl = deepReadinessProbeCache.value.ready ? DEEP_READINESS_READY_TTL_MS : DEEP_READINESS_FAILURE_TTL_MS;
    if (Date.now() - deepReadinessProbeCache.checkedAt < ttl) return deepReadinessProbeCache.value;
  }
  if (deepReadinessProbePending) return deepReadinessProbePending;
  const pending = checkTermuxReadinessOnce(opts);
  deepReadinessProbePending = pending;
  try {
    const value = await pending;
    deepReadinessProbeCache = { value, checkedAt: Date.now() };
    return value;
  } finally {
    if (deepReadinessProbePending === pending) deepReadinessProbePending = null;
  }
}

async function checkTermuxReadinessOnce(
  opts?: { deep?: boolean; refreshPermission?: boolean }
): Promise<TermuxReadiness> {
  if (Platform.OS !== "android") return { ready: false, reasons: ["not_android"], probed: false };
  const native = getNative();
  if (!native?.getEmbeddedTermuxRuntimeStatus || !native.runEmbeddedTermuxCommand) {
    return { ready: false, reasons: ["native_module_missing"], probed: false };
  }
  let runtime = await getEmbeddedTermuxRuntimeStatus();
  if (!runtime?.ready && opts?.deep === true && native.prepareEmbeddedTermuxRuntime) {
    try {
      await prepareEmbeddedTermuxRuntime();
      runtime = await getEmbeddedTermuxRuntimeStatus();
    } catch (error: unknown) {
      const raw = (error as { code?: unknown })?.code;
      const code = typeof raw === "string" && /^EMBEDDED_BOOTSTRAP_[A-Z0-9_]{1,80}$/.test(raw) ? raw : "EMBEDDED_BOOTSTRAP_FAILED";
      persistentLogger.add("warn", "EmbeddedBootstrapDiagnostic", JSON.stringify({ outcome: "failed", code }), "app");
      return { ready: false, reasons: ["run_command_probe_failed"], probed: false, probeDetail: code };
    }
  }
  if (!runtime?.ready) return {
    ready: false, reasons: [runtime ? "termux_not_installed" : "termux_install_check_failed"], probed: false,
    probeDetail: "Bundled private bootstrap is missing, incomplete or its status could not be validated. No external runtime is used.",
  };
  if (opts?.deep !== true) return { ready: true, reasons: [], probed: false,
    probeDetail: "Bundled bootstrap filesystem checks passed; execution has not been probed." };
  const startedAt = Date.now();
  try {
    const result = await runEmbeddedTermuxCommand("printf 'AIB_PRIVATE_EXEC_OK\\n'", { timeoutMs: 15_000 });
    const ok = !result.timedOut && !result.outputTruncated && result.exitCode === 0 && result.stdout.trim() === "AIB_PRIVATE_EXEC_OK";
    persistentLogger.add(ok ? "info" : "warn", "TermuxSmoke",
      `phase=result target=embedded-private status=${ok ? "passed" : "failed"} exitCode=${result.exitCode} timedOut=${result.timedOut} outputTruncated=${result.outputTruncated} stdoutBytes=${utf8ByteLength(result.stdout)} stderrBytes=${utf8ByteLength(result.stderr)} durationMs=${Date.now() - startedAt} workspaceRootAccess=not-performed externalTermuxPrivateData=not-accessed`, "app");
    return ok ? { ready: true, reasons: [], probed: true } : {
      ready: false, reasons: ["run_command_probe_failed"], probed: true,
      probeDetail: result.timedOut ? "Bundled private execution probe timed out." : result.outputTruncated
        ? "Bundled private execution probe output was truncated." : `Bundled private execution probe failed (exit=${result.exitCode}); expected marker was not received.`,
    };
  } catch (error) {
    const category = classifyDiagnosticError(error);
    persistentLogger.add("warn", "TermuxSmoke", `phase=result target=embedded-private status=failed errorCategory=${category} durationMs=${Date.now() - startedAt} externalTermuxPrivateData=not-accessed`, "app");
    return { ready: false, reasons: ["run_command_probe_failed"], probed: true,
      probeDetail: `Bundled private execution probe could not complete (${category}).` };
  }
}

/** Compatibility API: there is no external command permission to grant. */
export async function openRunCommandPermissionSettings(): Promise<boolean> {
  deepReadinessProbeCache = null;
  return false;
}

// Таймауты для разных типов операций (учитываем большие проекты):
// - Быстрая проверка (echo, ls): 15 секунд
// - Обычная команда: 600 секунд (10 минут)
// - Сборка APK / gradle / npm install больших деревьев: 1800 секунд (30 минут)
const DEFAULT_TIMEOUT_MS = 600_000;   // 10 минут для обычных команд
const QUICK_TIMEOUT_MS = 15_000;      // 15 секунд для проверок
const BUILD_TIMEOUT_MS = 9_300_000;   // v389: 155 минут — самолечащийся build-скрипт делает до 10 попыток + докачку SDK внутри одной команды
const MAX_COMMAND_TIMEOUT_MS = 10_800_000; // v389: hard cap 3 h (autobuild wall budget is 150 min)

/** Эвристика: команда похожа на долгую сборку / установку зависимостей. */
function looksLikeLongRunningCommand(command: string): boolean {
  const c = (command || "").toLowerCase().trim();
  // Проверки идемпотентности / probe — всегда короткие
  if (
    /\baib_installed\b/.test(c) ||
    /\baibuilder_ok\b/.test(c) ||
    /\baib_missing\b/.test(c) ||
    /^command\s+-v\b/.test(c) ||
    /\(command\s+-v\b/.test(c) ||
    /^test\s+-[a-z]/.test(c) ||
    /\(test\s+-[a-z]/.test(c) ||
    /\bdpkg\s+-s\b/.test(c) ||
    /\becho\s+aib/i.test(c) ||
    /\bpreflight_ok\b/.test(c) ||
    /\bfree_mb=/.test(c)
  ) {
    return false;
  }
  return (
    /\b(gradlew|gradle)\b/.test(c) ||
    /\bassemble(debug|release)?\b/.test(c) ||
    /\bnpm\s+(i|install|ci|run)\b/.test(c) ||
    /\byarn\s+(install|add)\b/.test(c) ||
    /\bpnpm\s+(i|install|run)\b/.test(c) ||
    /\b(expo|npx)\s+(prebuild|run:android|run)\b/.test(c) ||
    /\bsdkmanager\b/.test(c) ||
    /\b(kotlinc|javac)\b/.test(c) ||
    /\bmvn\b/.test(c) ||
    /\bcargo\s+build\b/.test(c) ||
    /\bpkg\s+install\b/.test(c) ||
    /\bapt-get\b/.test(c)
  );
}

/**
 * Выполняет одну shell-команду в Termux и ждёт результат.
 * Бросает исключение с понятным кодом в message, если Termux-сессия не
 * готова (см. checkTermuxReadiness) — вызывающая сторона (lib/termux-agent)
 * сама решает, как показать это пользователю/модели.
 */

/** Short, terminal-like prompt for the console panel (hide huge scripts). */
function formatConsolePrompt(command: string): string {
  // Full command, no truncation — user must see exactly what Termux runs.
  const raw = String(command || "").replace(/\r/g, "");
  const lines = raw.split("\n");
  if (lines.length <= 1) return `$ ${raw}`;
  return lines.map((l, i) => (i === 0 ? `$ ${l}` : l)).join("\n");
}

/**
 * Commands longer than this are written to $HOME and executed via bash path.
 * Rootfs probes sit just under 1200 chars; on-device direct RUN_COMMAND still
 * drops trailing AIB_*_END markers (~87–103 B callbacks). Always stage those.
 */
const LONG_COMMAND_THRESHOLD = 1200;
const LONG_CMD_SCRIPT = "$HOME/aibuilder-scripts/aib-long-cmd.sh";

/** Force file staging so multi-marker proot probes and long installs keep full stdout. */
function shouldStageCommandViaFile(command: string, commandKind: string): boolean {
  if (command.length > LONG_COMMAND_THRESHOLD) return true;
  if (command.length > 800 && command.includes("\n")) return true;
  if (commandKind === "rootfs-probe" || commandKind === "rootfs-install") return true;
  // Package-menu rootfs check embeds the probe; identity markers alone are not a full envelope.
  if (command.includes("AIB_PROBE_BEGIN") || command.includes("AIB_LOGIN_BEGIN")) return true;
  if (/\bproot-distro\s+login\b/.test(command) && command.length > 400) return true;
  return false;
}

async function runLongCommandViaFile(
  command: string,
  native: NonNullable<ReturnType<typeof getNative>>,
  timeout: number,
  workdir: string | null,
  commandId: string,
  backendLabel?: string,
): Promise<TermuxCommandResult> {
  // Write via short chunks of base64 to avoid binder limits
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(command, "utf8").toString("base64")
      : (() => {
          const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
          const bytes = unescape(encodeURIComponent(command));
          let out = "";
          for (let i = 0; i < bytes.length; i += 3) {
            const a = bytes.charCodeAt(i);
            const b = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : 0;
            const c = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : 0;
            out += chars[a >> 2];
            out += chars[((a & 3) << 4) | (b >> 4)];
            out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
            out += i + 2 < bytes.length ? chars[c & 63] : "=";
          }
          return out;
        })();
  const chunkSize = 2400;
  // Unique per commandId — concurrent builds must not clobber the same script file
  const safeId = String(commandId || "x").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "x";
  const scriptPath = `$HOME/aibuilder-scripts/aib-long-cmd-${safeId}.sh`;
  const prep = await invokeNativeRunCommand(
    native,
    `mkdir -p "$HOME/aibuilder-scripts" && : > "${scriptPath}" && echo PREP_OK`,
    null,
    15_000,
    backendLabel || "Termux",
    `${commandId}-prep`,
  );
  if (prep.exitCode !== 0 && !(prep.stdout || "").includes("PREP_OK")) {
    persistentLogger.add("warn", "TermuxBridge", `long-cmd prep failed ${summarizeCommandOutputForLogs(command, prep.stderr || prep.stdout)}`);
    // fall through to direct execution
    return invokeNativeRunCommand(native, command, workdir, timeout, backendLabel || "Termux", commandId);
  }
  for (let i = 0; i < b64.length; i += chunkSize) {
    const c = b64.slice(i, i + chunkSize);
    const r = await invokeNativeRunCommand(
      native,
      `printf '%s' '${c}' | base64 -d >> "${scriptPath}"`,
      null,
      15_000,
      backendLabel || "Termux",
      `${commandId}-chunk-${i}`,
    );
    if (r.exitCode !== 0) {
      persistentLogger.add("error", "TermuxBridge", `long-cmd chunk fail at ${i}`);
      return invokeNativeRunCommand(native, command, workdir, timeout, backendLabel || "Termux", commandId);
    }
  }
  await invokeNativeRunCommand(
    native,
    `chmod +x "${scriptPath}" 2>/dev/null || true`,
    null,
    10_000,
    backendLabel || "Termux",
    `${commandId}-chmod`,
  );
  // Построчный stdout — иначе heartbeat «stdout 0 байт» при живом Gradle
  // Cleanup script after run (best-effort) to avoid filling $HOME
  const launch =
    `if command -v stdbuf >/dev/null 2>&1; then stdbuf -oL -eL bash "${scriptPath}"; ` +
    `else bash "${scriptPath}"; fi; EC=$?; rm -f "${scriptPath}" 2>/dev/null || true; exit $EC`;
  persistentLogger.add("info", "TermuxBridge", `long-cmd via file id=${commandId} commandChars=${command.length} workdir=default`);
  return invokeNativeRunCommand(native, launch, workdir, timeout, backendLabel || "Termux", commandId);
}

async function runShellCommandNow(
  command: string,
  opts?: { workdir?: string; timeoutMs?: number; isBuild?: boolean; honorExplicitTimeout?: boolean; traceId?: string; backend?: AgentShellBackend }
): Promise<TermuxCommandResult> {
  const t0 = Date.now();
  const commandId = `js-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const traceId = opts?.traceId || commandId;
  const backend = opts?.backend ?? getBuildBackend();
  const label = backendLabel(backend);
  const commandKind = classifyCommandForDiagnostics(command);
  const target = backend === "ubuntu-proot" ? "ubuntu" : "termux";
  const screen = commandKind === "rootfs-probe" || commandKind === "rootfs-install" ? "runtime"
    : commandKind === "build-tool" ? "build" : commandKind === "git" ? "github" : "termux";
  const traceBase = { correlationId: traceId, commandId, action: `command.${commandKind}`, backend, target, screen } as const;
  const native = getNative();
  if (!native) {
    persistentLogger.trace({ ...traceBase, step: "native-module-check", status: "failed", errorCategory: "native-module-missing", resultCode: "unavailable" });
    persistentLogger.add("error", "TermuxBridge", "TERMUX_NATIVE_MODULE_MISSING");
    throw new Error("TERMUX_NATIVE_MODULE_MISSING");
  }

  if (!native.runEmbeddedTermuxCommand) throw new Error("EMBEDDED_EXEC_UNAVAILABLE");
  // There is no package lookup, external version floor or Android command grant.
  const cmd = String(command || "").trim();
  if (!cmd) {
    throw new Error("TERMUX_EMPTY_COMMAND");
  }
  // Soft workdir allowlist (null/empty = Termux default HOME)
  if (opts?.workdir) {
    const wd = String(opts.workdir);
    if (!isAllowedEmbeddedWorkdir(wd)) {
      throw new Error("TERMUX_WORKDIR_NOT_ALLOWED");
    }
  }

  // Автоматическое определение таймаута по типу команды
  let timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (opts?.honorExplicitTimeout !== true && (opts?.isBuild === true || looksLikeLongRunningCommand(cmd))) {
    timeout = Math.max(timeout, BUILD_TIMEOUT_MS);
  }
  // Preserve explicit long-operation budgets (for example proot-distro rootfs
  // bootstrap) while retaining a finite cap against accidental unbounded waits.
  timeout = Math.min(Math.max(1_000, timeout), 120_000); // Same bounded one-shot contract as the native private runner.

  const safeCommand = redactCommandForLogs(command);
  // Persistent diagnostics keep IDs/categories, not shell commands or private paths.
  persistentLogger.add(
    "info",
    backend === "termux" ? "Termux" : `Linux:${label}:command`,
    `commandKind=${commandKind} id=${commandId} traceId=${traceId} chars=${command.length}`,
    backend === "termux" ? "termux" : "agent"
  );
  // Plain-language progress so the user is not left staring at a silent chat
  // while a multi-minute rootfs download/unpack runs.
  if (commandKind === "rootfs-install") {
    const distroHint = /ubuntu/i.test(label) || /ubuntu/i.test(command)
      ? "Ubuntu"
      : /debian/i.test(label) || /debian/i.test(command)
        ? "Debian"
        : "Linux";
    const minutes = Math.max(1, Math.round(timeout / 60_000));
    persistentLogger.add(
      "info",
      "Runtime",
      `Начата установка ${distroHint} rootfs (до ~${minutes} мин). Не закрывайте приложение; прогресс идёт в фоне. Это не создание обычного файла.`,
      "app",
    );
  } else if (commandKind === "rootfs-probe") {
    persistentLogger.add(
      "info",
      "Runtime",
      `Проверка ${label || backend} rootfs/login…`,
      "app",
    );
  }
  commandContexts.set(commandId, { backend, label, startedAt: t0, command });
  const workdirLabel = opts?.workdir ? "(custom)" : "(default)";

  persistentLogger.add(
    "debug",
    backend === "termux" ? "TermuxBridge" : `Linux:${label}:bridge`,
    `→ start id=${commandId} traceId=${traceId} backend=${backend} commandKind=${commandKind} timeout=${timeout}ms workdir=${workdirLabel}`
  );
  persistentLogger.trace({ ...traceBase, step: "bridge.command-dispatch", status: "started", timeoutMs: timeout, termuxExternalApps: "not-observed" });
  if (backend !== "termux") {
    persistentLogger.add(
      "info",
      `Linux:${label}:command`,
      `guest command id=${commandId} traceId=${traceId} commandKind=${commandKind} cwd=${workdirLabel}`,
      "agent"
    );
  }

  // Terminal-style prompt: full command, no truncation.
  emitJsConsoleEvent({
    stream: "lifecycle",
    event: "dispatch",
    chunk: formatConsolePrompt(safeCommand),
    cmdId: commandId,
  });

  retainTermuxStream();
  try {
    // Stage rootfs probes and long/multi-line installs via file so framed
    // AIB_* markers are not truncated by the direct RUN_COMMAND binder path.
    const useFile = false; // Private native runner accepts a bounded command directly; no external Binder callback staging.
    const result = useFile
      ? await runLongCommandViaFile(command, native, timeout, opts?.workdir || null, commandId, label)
      : await invokeNativeRunCommand(
          native,
          command,
          opts?.workdir || null,
          timeout,
          label,
          commandId,
        );
    // The native callback is authoritative. Keep full output transient for the
    // caller/console, while persistent diagnostics retain only allowlisted markers.
    const stdout = redactCommandOutputForLogs(command, String(result.stdout || ""));
    const stderr = redactCommandOutputForLogs(command, String(result.stderr || ""));
    if (stdout) {
      persistentLogger.add("info", backend === "termux" ? `Termux:${commandId}:stdout` : `Linux:${label}:${commandId}:stdout`, summarizeCommandOutputForLogs(command, stdout), backend === "termux" ? "termux" : "agent");
    } else {
      persistentLogger.add("info", backend === "termux" ? `Termux:${commandId}:stdout` : `Linux:${label}:${commandId}:stdout`, "[OUTPUT_EMPTY]", backend === "termux" ? "termux" : "agent");
    }
    if (stderr) {
      persistentLogger.add("warn", backend === "termux" ? `Termux:${commandId}:stderr` : `Linux:${label}:${commandId}:stderr`, summarizeCommandOutputForLogs(command, stderr), backend === "termux" ? "termux" : "agent");
    }
    flushCommandStream(commandId, true);
    persistCommandStreamSummary(commandId);

    // Authoritative final mirror into console UI (covers missing live am-broadcast).
    // Use a distinct lifecycle marker so ConsoleContext can flush buffers first.
    // Flush lifecycle "finished" silently — console only shows real stdout/stderr.
    emitJsConsoleEvent({
      stream: "lifecycle",
      event: "finished",
      chunk: "",
      cmdId: commandId,
    });
    if (stdout) {
      emitJsConsoleEvent({
        stream: "stdout",
        chunk: stdout.endsWith("\n") ? stdout : stdout + "\n",
        cmdId: commandId,
      });
    }
    if (stderr) {
      emitJsConsoleEvent({
        stream: "stderr",
        chunk: stderr.endsWith("\n") ? stderr : stderr + "\n",
        cmdId: commandId,
      });
    }
    // Always show exit status like a real shell (full visibility).
    emitJsConsoleEvent({
      stream: "lifecycle",
      event: "exit",
      chunk: result.callbackMissing
        ? `result callback missing (completion unknown)`
        : result.timedOut
        ? `exit ${result.exitCode} (timeout)`
        : `exit ${result.exitCode}`,
      cmdId: commandId,
    });

    const ms = Date.now() - t0;
    // exit>=1 + empty stdout/stderr is normal for probes like `command -v missing`
    // (shell returns 1 with no text). Only treat as channel failure when exitCode < 0
    // (service/start failure) or when a successful command produced zero bytes unexpectedly.
    // exit>=1 + empty stdout/stderr is normal for probes (e.g. `command -v missing`).
    // exit==0 + empty output is also normal (true, mkdir -p, etc.).
    // Only exitCode < 0 indicates service/start/channel failure.
    const channelFailure = result.callbackMissing === true || (
      !result.timedOut &&
      stdout.length === 0 &&
      stderr.length === 0 &&
      result.exitCode < 0
    );
    persistentLogger.trace({
      ...traceBase,
      step: "bridge.command-result",
      nativeCommandId: result.nativeCommandId,
      status: result.callbackMissing ? "failed" : result.timedOut ? "timed_out" : result.exitCode === 0 ? "succeeded" : "failed",
      durationMs: ms,
      timeoutMs: timeout,
      exitCode: result.exitCode,
      stdoutBytes: utf8ByteLength(stdout),
      stderrBytes: utf8ByteLength(stderr),
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
      outputMetricSource: "normalized-callback-redacted",
      resultCode: result.callbackMissing ? "missing" : result.outputTruncated ? "truncated" : stdout.length === 0 && stderr.length === 0 ? "empty" : "valid",
      ...(result.callbackMissing ? { errorCategory: "callback-missing" as const } : result.timedOut ? { errorCategory: "timeout" as const } : result.outputTruncated ? { errorCategory: "output-truncated" as const } : result.exitCode !== 0 ? { errorCategory: "command-failed" as const } : {}),
      termuxExternalApps: "not-observed",
    });
    if (channelFailure) {
      persistentLogger.add(
        "error",
        backend === "termux" ? "Termux" : `Linux:${label}:result`,
        `TERMUX_NO_OUTPUT id=${commandId} backend=${backend} commandKind=${commandKind} exit=${result.exitCode} (${ms}ms) commandChars=${command.length}`,
        backend === "termux" ? "termux" : "agent"
      );
    }
    persistentLogger.add(
      result.exitCode === 0 && !result.timedOut ? "info" : "warn",
      backend === "termux" ? "Termux" : `Linux:${label}:result`,
      `← end id=${commandId} traceId=${traceId} backend=${backend} exit=${result.exitCode}` +
        (result.callbackMissing ? " CALLBACK_MISSING (completion unknown)" : "") +
        (result.timedOut ? " TIMEOUT" : "") +
        (channelFailure ? " TERMUX_NO_OUTPUT" : "") +
        ` (${ms}ms, out=${utf8ByteLength(stdout)}B/${stdout.length}chars err=${utf8ByteLength(stderr)}B/${stderr.length}chars, cmdLen=${command.length})`,
      backend === "termux" ? "termux" : "agent"
    );
    commandContexts.delete(commandId);
    commandStreamBuffers.delete(commandId);
    return {
      ...result,
      commandId,
      stdout,
      // Do not rewrite stderr for normal non-zero exits (package probes, etc.).
      stderr: channelFailure
        ? `TERMUX_NO_OUTPUT: exit=${result.exitCode}, empty stdout/stderr, cmdLen=${command.length}. ` +
          `Канал Termux не вернул вывод (сервис не стартовал / лимит длины команды / ранняя ошибка).`
        : stderr,
    };
  } catch (e: unknown) {
    flushCommandStream(commandId, true);
    persistCommandStreamSummary(commandId);
    const ms = Date.now() - t0;
    const msg = redactCommandOutputForLogs(command, e instanceof Error ? e.message : String(e));
    if (isAndroidRunCommandPermissionDenied(msg)) {
      runCommandPermissionGate.remember(false);
      deepReadinessProbeCache = null;
      const now = Date.now();
      if (now - lastPermissionGateWarningAt > 30_000) {
        lastPermissionGateWarningAt = now;
        persistentLogger.add("warn", "TermuxPermission", runCommandPermissionStatus(msg));
      }
    }
    emitJsConsoleEvent({
      stream: "lifecycle",
      event: "exception",
      chunk: msg,
      cmdId: commandId,
    });
    // Warn only on an explicit app-scoped Android denial or an explicit Termux false value.
    const isSetup = isAndroidRunCommandPermissionDenied(msg) || isExplicitTermuxExternalAppsFalse(msg);
    persistentLogger.add(
      isSetup ? "warn" : "error",
      backend === "termux" ? "Termux" : `Linux:${label}:result`,
      `← exception id=${commandId} traceId=${traceId} backend=${backend} ${ms}ms errorCategory=${classifyDiagnosticError(msg)}`,
      backend === "termux" ? "termux" : "agent"
    );
    persistentLogger.trace({
      ...traceBase,
      step: "bridge.command-result",
      status: isSetup ? "blocked" : /timeout|timed\s*out/i.test(msg) ? "timed_out" : /cancel|abort/i.test(msg) ? "cancelled" : "failed",
      durationMs: ms,
      timeoutMs: timeout,
      errorCategory: classifyDiagnosticError(msg),
      resultCode: "unavailable",
      termuxExternalApps: isExplicitTermuxExternalAppsFalse(msg) ? "blocked" : "not-observed",
    });
    commandContexts.delete(commandId);
    commandStreamBuffers.delete(commandId);
    throw e;
  } finally {
    commandContexts.delete(commandId);
    commandStreamBuffers.delete(commandId);
    releaseTermuxStream();
  }
}


/**
 * User pressed Stop: unblock all native RUN_COMMAND waiters and drop queued jobs.
 * Termux host and Ubuntu/Debian proot share this bridge.
 */
export async function cancelAllRunningTermuxCommands(): Promise<{ cancelledWaiters: number; clearedQueue: number }> {
  const clearedQueue = clearPendingTermuxQueue("ABORTED");
  let cancelledWaiters = 0;
  try {
    const native = getNative() as null | { cancelAllCommands?: () => Promise<number> };
    if (native && typeof native.cancelAllCommands === "function") {
      const n = await native.cancelAllCommands();
      cancelledWaiters = typeof n === "number" ? n : Number(n) || 0;
    }
  } catch (e: unknown) {
    persistentLogger.add(
      "warn",
      "TermuxBridge",
      `cancelAllCommands failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  persistentLogger.add(
    "warn",
    "TermuxBridge",
    `Stop: cancelledWaiters=${cancelledWaiters} clearedQueue=${clearedQueue}`,
  );
  return { cancelledWaiters, clearedQueue };
}

export function runShellCommand(
  command: string,
  opts?: {
    workdir?: string;
    timeoutMs?: number;
    isBuild?: boolean;
    /** Keep a caller-supplied finite phase budget instead of the generic long-command floor. */
    honorExplicitTimeout?: boolean;
    /** high = interactive Termux panel; runs before pending agent/script jobs */
    priority?: TermuxQueuePriority;
    traceId?: string;
    /** Explicit host or guest label paired with the router's execution target. */
    backend?: AgentShellBackend;
  }
): Promise<TermuxCommandResult> {
  return enqueueTermuxCommand(
    () => runShellCommandNow(command, opts),
    { priority: opts?.priority }
  );
}

/**
 * Проверяет, что реально можно выполнить команду в Termux (не только permissions).
 * Возвращает null при успехе или текст понятной ошибки.
 */
export async function probeTermuxCommand(): Promise<string | null> {
  try {
    const r = await runShellCommand("echo AIBUILDER_OK", { timeoutMs: QUICK_TIMEOUT_MS });
    if (r.timedOut) {
      return "timeout";
    }
    if ((r.stdout || "").includes("AIBUILDER_OK") && r.exitCode === 0) {
      return null;
    }
    const detail = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim();
    return detail || "empty_result";
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Короткая классификация типичных сбоев RUN_COMMAND для UI. */
export function classifyTermuxFailure(raw: string): {
  code:
    | "permission"
    | "allow_external"
    | "not_installed"
    | "service"
    | "timeout"
    | "unknown";
  hintKey: string;
} {
  const m = (raw || "").toLowerCase();
  if (isAndroidRunCommandPermissionDenied(raw)) {
    return { code: "permission", hintKey: "termuxReasonPermissionMissing" };
  }
  if (isExplicitTermuxExternalAppsFalse(raw)) {
    return { code: "allow_external", hintKey: "termuxReasonExternalAppsDisabled" };
  }
  if (m.includes("not_android") || m.includes("termux_native_module_missing")) {
    return { code: "not_installed", hintKey: "packTermuxNotReady" };
  }
  if (m.includes("securityexception")) {
    return { code: "service", hintKey: "termuxReasonUnknown" };
  }
  if (m.includes("permission denial") || m.includes("permission denied")) {
    return { code: "unknown", hintKey: "termuxReasonUnknown" };
  }
  if (
    m.includes("unable to start service") ||
    m.includes("run_command") ||
    m.includes("illegalstateexception")
  ) {
    return { code: "service", hintKey: "termuxReasonUnknown" };
  }
  if (m.includes("permission")) {
    return { code: "unknown", hintKey: "termuxReasonUnknown" };
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return { code: "timeout", hintKey: "termuxReasonUnknown" };
  }
  return { code: "unknown", hintKey: "termuxReasonUnknown" };
}
