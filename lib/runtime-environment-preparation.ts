import type { AgentShellBackend } from "./agent-shell-backend.ts";
import { checkPackageCommand, type PackageCheckOutcome } from "./package-check-outcome.ts";
import type { ProotBootstrapCommandResult, ProotBootstrapRunOptions } from "./proot-distro-bootstrap.ts";
import type { ProotDistroAlias } from "./proot-distro-state.ts";
import {
  buildProotAptFallbackInstallCommand,
  buildProotAptInstallCommand,
  buildProotAptSourceUpdateCommand,
  classifyProotAptSourceUpdate,
  parseProotAptFallbackResult,
} from "./proot-apt-mirror-fallback.ts";

export interface RuntimePreparationRunOptions extends ProotBootstrapRunOptions {
  selectedBackend?: AgentShellBackend;
}

export type RuntimePreparationRunner = (
  command: string,
  options: RuntimePreparationRunOptions,
) => Promise<ProotBootstrapCommandResult>;

export type RuntimePreparationProgress = (percent: number, stage: string, detail: string) => void;
export type RuntimeRootfsEnsurer = (
  alias: ProotDistroAlias,
  run: RuntimePreparationRunner,
  onProgress: (percent: number, detail: string) => void,
  shouldAbort: () => boolean,
) => Promise<{ ok: boolean; error?: string }>;

export interface RuntimePreparationOptions {
  run: RuntimePreparationRunner;
  ensureRootfs: RuntimeRootfsEnsurer;
  onProgress?: RuntimePreparationProgress;
  shouldAbort?: () => boolean;
  traceId?: string;
}

export interface GuestRuntimeRequirement {
  /** Matches the shared package catalog id where possible. */
  id: "openjdk-17" | "zip-unzip" | "git" | "wget" | "curl";
  name: string;
  aptPackage: string;
  checkCommand: string;
}

/**
 * Narrow baseline derived from buildTermuxToolsBaseInstallCommand and the
 * shared compile catalog: JDK 17+, unzip, git, wget and curl. SDK/NDK, Node,
 * Python, editors, reverse-engineering tools and other task-specific packages
 * remain opt-in and are deliberately not prepared here.
 */
export const PROOT_RUNTIME_REQUIREMENTS: readonly GuestRuntimeRequirement[] = [
  {
    id: "openjdk-17",
    name: "OpenJDK 17+",
    aptPackage: "openjdk-17-jdk",
    checkCommand: `command -v java >/dev/null 2>&1 && java -version 2>&1 | head -1 | grep -Eq '"(1[7-9]|[2-9][0-9])([.]|\")'`,
  },
  { id: "zip-unzip", name: "unzip", aptPackage: "unzip", checkCommand: "command -v unzip >/dev/null 2>&1" },
  { id: "git", name: "git", aptPackage: "git", checkCommand: "command -v git >/dev/null 2>&1" },
  { id: "wget", name: "wget", aptPackage: "wget", checkCommand: "command -v wget >/dev/null 2>&1" },
  { id: "curl", name: "curl", aptPackage: "curl", checkCommand: "command -v curl >/dev/null 2>&1" },
];

const REQUIREMENT_CHECK_TIMEOUT_MS = 30_000;
const REQUIREMENT_INDEX_UPDATE_TIMEOUT_MS = 5 * 60_000;
const REQUIREMENT_INSTALL_TIMEOUT_MS = 15 * 60_000;
const REQUIREMENT_BATCH_PACKAGE_ID = "runtime-guest-requirements";
let activePreparation: { alias: ProotDistroAlias; promise: Promise<RuntimePreparationResult> } | null = null;

export type RuntimePreparationResult =
  | {
      ok: true;
      alias: ProotDistroAlias;
      installed: readonly string[];
      alreadyPresent: readonly string[];
    }
  | {
      ok: false;
      alias: ProotDistroAlias | null;
      stage: string;
      error: string;
      cancelled?: boolean;
      installed: readonly string[];
      alreadyPresent: readonly string[];
    };

/**
 * Called only by an explicit runtime-environment action. Fresh checks are
 * authoritative; unknown/timeout/permission errors stop before installation.
 * Existing packages are skipped. When anything is missing, the selected guest
 * apt indexes are refreshed, missing baseline packages are installed in one
 * transaction, then the complete baseline is verified again.
 */
export function prepareProotRuntimeEnvironment(
  backend: AgentShellBackend,
  options: RuntimePreparationOptions,
): Promise<RuntimePreparationResult> {
  const alias = backend === "ubuntu-proot" ? "ubuntu" : null;
  if (!alias) {
    return Promise.resolve({
      ok: false,
      alias: null,
      stage: "preflight",
      error: "RUNTIME_PREPARATION_UNSUPPORTED_TARGET: Termux is already the host runtime.",
      installed: [],
      alreadyPresent: [],
    });
  }

  if (activePreparation) {
    if (activePreparation.alias === alias) return activePreparation.promise;
    return Promise.resolve({
      ok: false,
      alias,
      stage: "lock",
      error: `RUNTIME_PREPARATION_BUSY: ${activePreparation.alias} preparation is already running; ${alias} was not started.`,
      installed: [],
      alreadyPresent: [],
    });
  }

  const work = Promise.resolve().then(() => runPreparation(alias, backend, options));
  activePreparation = { alias, promise: work };
  const cleanup = () => {
    if (activePreparation?.promise === work) activePreparation = null;
  };
  void work.then(cleanup, cleanup);
  return work;
}

export function isRuntimePreparationInFlight(alias: ProotDistroAlias): boolean {
  return activePreparation?.alias === alias;
}

async function runPreparation(
  alias: ProotDistroAlias,
  backend: AgentShellBackend,
  options: RuntimePreparationOptions,
): Promise<RuntimePreparationResult> {
  const shouldAbort = options.shouldAbort ?? (() => false);
  const onProgress = options.onProgress ?? (() => undefined);
  const installed: string[] = [];
  const alreadyPresent: string[] = [];
  const cancelled = (stage: string): RuntimePreparationResult => ({
    ok: false,
    alias,
    stage,
    error: "RUNTIME_PREPARATION_CANCELLED: current command has finished; later stages were not started.",
    cancelled: true,
    installed,
    alreadyPresent,
  });
  const failed = (stage: string, error: string): RuntimePreparationResult => ({
    ok: false,
    alias,
    stage,
    error,
    installed,
    alreadyPresent,
  });
  const emit = (percent: number, stage: string, detail: string) => {
    try { onProgress(percent, stage, detail); } catch { /* UI callbacks do not control installation. */ }
  };
  const aborted = () => {
    try { return shouldAbort(); } catch { return true; }
  };
  const runForGuest = (command: string, optionsForRun: ProotBootstrapRunOptions) =>
    options.run(command, { ...optionsForRun, selectedBackend: backend, traceId: options.traceId });

  if (aborted()) return cancelled("before-rootfs");
  emit(3, "rootfs", `Проверка host proot-distro в Termux и состояния ${alias} rootfs…`);
  let rootfs: { ok: boolean; error?: string };
  try {
    rootfs = await options.ensureRootfs(
      alias,
      runForGuest,
      (percent, detail) => emit(Math.max(3, Math.min(72, percent * 0.72)), "rootfs", detail),
      aborted,
    );
  } catch (error: unknown) {
    return failed("rootfs", `RUNTIME_ROOTFS_STAGE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (aborted() || rootfs.error === "aborted") return cancelled("rootfs");
  if (!rootfs.ok) return failed("rootfs", rootfs.error || `RUNTIME_ROOTFS_NOT_VERIFIED: ${alias}`);

  const missing: GuestRuntimeRequirement[] = [];
  for (let index = 0; index < PROOT_RUNTIME_REQUIREMENTS.length; index += 1) {
    if (aborted()) return cancelled("guest-preflight");
    const requirement = PROOT_RUNTIME_REQUIREMENTS[index];
    emit(74 + Math.floor((index / PROOT_RUNTIME_REQUIREMENTS.length) * 10), "guest-preflight", `Проверка ${requirement.name} внутри ${alias}…`);
    const outcome = await checkPackageCommand(() => runForGuest(requirement.checkCommand, {
      timeoutMs: REQUIREMENT_CHECK_TIMEOUT_MS,
      kind: "check",
      packageId: requirement.id,
    }));
    if (outcome.status === "error") return failed("guest-preflight", `${requirement.name}: ${outcome.detail}`);
    if (outcome.status === "installed") alreadyPresent.push(requirement.name);
    else missing.push(requirement);
  }

  if (aborted()) return cancelled("guest-install");
  if (missing.length > 0) {
    const packages = missing.map((requirement) => requirement.aptPackage);
    emit(84, "guest-index-update", `Обновление индексов пакетов ${alias} перед установкой…`);
    let indexUpdate: ProotBootstrapCommandResult;
    try {
      indexUpdate = await runForGuest(buildProotAptSourceUpdateCommand(alias), {
        timeoutMs: REQUIREMENT_INDEX_UPDATE_TIMEOUT_MS,
        kind: "update",
        packageId: REQUIREMENT_BATCH_PACKAGE_ID,
        isBuild: true,
        honorExplicitTimeout: true,
      });
    } catch (error: unknown) {
      return failed("guest-index-update", `RUNTIME_GUEST_INDEX_UPDATE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (aborted()) return cancelled("guest-index-update");
    const indexError = guestIndexUpdateFailure(indexUpdate);
    if (indexError) {
      if (classifyProotAptSourceUpdate(indexUpdate) !== "transport") return failed("guest-index-update", indexError);
      emit(85, "guest-mirror-fallback", `Only a transient network failure was classified; attempting one fixed official ${alias} endpoint with apt-secure enabled.`);
      let fallbackInstall: ProotBootstrapCommandResult;
      try {
        fallbackInstall = await runForGuest(buildProotAptFallbackInstallCommand(alias, packages), {
          timeoutMs: REQUIREMENT_INSTALL_TIMEOUT_MS,
          kind: "install",
          packageId: REQUIREMENT_BATCH_PACKAGE_ID,
          isBuild: true,
          honorExplicitTimeout: true,
        });
      } catch (error: unknown) {
        return failed("guest-mirror-fallback", `RUNTIME_GUEST_APT_FALLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (aborted()) return cancelled("guest-mirror-fallback");
      if (fallbackInstall.timedOut) return failed("guest-mirror-fallback", "RUNTIME_GUEST_APT_FALLBACK_TIMEOUT; the native command completed or timed out, and later stages were not started.");
      if (fallbackInstall.outputTruncated) return failed("guest-mirror-fallback", "RUNTIME_GUEST_APT_FALLBACK_OUTPUT_INCOMPLETE; final state is unknown.");
      const fallbackResult = parseProotAptFallbackResult(fallbackInstall);
      if (fallbackResult !== "installed") return failed("guest-mirror-fallback", `RUNTIME_GUEST_APT_FALLBACK_${fallbackResult.toUpperCase()}; no later install/recheck stage was started.`);
      emit(90, "guest-install", `Official same-family signed Release accepted and missing baseline transaction completed for ${alias}.`);
      installed.push(...missing.map((item) => item.name));
    } else {
      emit(86, "guest-install", `Установка недостающих guest-пакетов в ${alias}: ${missing.map((item) => item.name).join(", ")}`);
      let install: ProotBootstrapCommandResult;
      try {
        install = await runForGuest(buildProotAptInstallCommand(packages), {
          timeoutMs: REQUIREMENT_INSTALL_TIMEOUT_MS,
          kind: "install",
          packageId: REQUIREMENT_BATCH_PACKAGE_ID,
          isBuild: true,
          honorExplicitTimeout: true,
        });
      } catch (error: unknown) {
        return failed("guest-install", `RUNTIME_GUEST_INSTALL_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (aborted()) return cancelled("guest-install");
      if (install.timedOut) return failed("guest-install", "RUNTIME_GUEST_INSTALL_TIMEOUT; final status is unknown and must be checked on retry.");
      if (install.outputTruncated) return failed("guest-install", "RUNTIME_GUEST_INSTALL_OUTPUT_INCOMPLETE; success cannot be confirmed.");
      if (install.exitCode !== 0) return failed("guest-install", installFailureDetail(install));
      installed.push(...missing.map((item) => item.name));
    }
  }

  for (let index = 0; index < PROOT_RUNTIME_REQUIREMENTS.length; index += 1) {
    if (aborted()) return cancelled("guest-verification");
    const requirement = PROOT_RUNTIME_REQUIREMENTS[index];
    emit(92 + Math.floor((index / PROOT_RUNTIME_REQUIREMENTS.length) * 7), "guest-verification", `Подтверждение ${requirement.name} в ${alias}…`);
    const outcome: PackageCheckOutcome = await checkPackageCommand(() => runForGuest(requirement.checkCommand, {
      timeoutMs: REQUIREMENT_CHECK_TIMEOUT_MS,
      kind: "check",
      packageId: requirement.id,
    }));
    if (outcome.status === "error") return failed("guest-verification", `${requirement.name}: ${outcome.detail}`);
    if (outcome.status === "missing") return failed("guest-verification", `RUNTIME_REQUIREMENT_NOT_CONFIRMED: ${requirement.name} is still missing in ${alias}.`);
  }

  emit(100, "ready", `${alias}: rootfs login verified; all ${PROOT_RUNTIME_REQUIREMENTS.length} baseline guest requirements verified.`);
  return { ok: true, alias, installed, alreadyPresent };
}

function installFailureDetail(result: ProotBootstrapCommandResult): string {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const marker = output.match(/^AIB_APT_GUEST_INSTALL_CLASS:([a-z-]+)$/m)?.[1] || "unknown";
  return `RUNTIME_GUEST_INSTALL_FAILED class=${marker} exit=${result.exitCode}; raw apt output was suppressed to protect configured source credentials.`;
}

function guestIndexUpdateFailure(result: ProotBootstrapCommandResult): string | null {
  if (result.timedOut) return "RUNTIME_GUEST_INDEX_UPDATE_TIMEOUT; guest package installation was not started.";
  if (result.outputTruncated) return "RUNTIME_GUEST_INDEX_UPDATE_OUTPUT_INCOMPLETE; guest package installation was not started.";
  const failureClass = classifyProotAptSourceUpdate(result);
  if (failureClass === "success" && result.exitCode === 0) return null;
  return `RUNTIME_GUEST_INDEX_UPDATE_FAILED class=${failureClass} exit=${result.exitCode}; installation starts only after successful, classified index validation.`;
}
