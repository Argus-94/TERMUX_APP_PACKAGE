import type { AgentShellBackend } from "./agent-shell-backend.ts";
import { checkPackageCommand } from "./package-check-outcome.ts";
import {
  PROOT_DISTRO_HOST_TOOL_PROBE_COMMAND,
  type ProotBootstrapCommandResult,
} from "./proot-distro-bootstrap.ts";
import {
  buildProotDistroProbeCommand,
  parseProotDistroProbe,
  type ProotDistroParserOutcome,
  type ProotDistroState,
} from "./proot-distro-state.ts";
import {
  PROOT_RUNTIME_REQUIREMENTS,
  type RuntimePreparationRunOptions,
} from "./runtime-environment-preparation.ts";

export type ProotRuntimeTarget = Extract<AgentShellBackend, "ubuntu-proot" | "ubuntu-proot">;
export type RuntimeReadinessPhase = "host-check" | "rootfs-check" | "guest-baseline" | "ready" | "error";
export type RuntimeReadinessStatus = "ready" | "missing" | "error";
export type RuntimeReadinessReason =
  | "permission" | "timeout" | "truncated-output" | "command-failed" | "bridge-failure"
  | "interrupted" | "unknown-status" | "list-unverified" | "architecture-mismatch"
  | "identity-unverified" | "guest-check" | "unknown";

export type RuntimeEnvironmentReadiness = Readonly<{
  target: ProotRuntimeTarget;
  status: RuntimeReadinessStatus;
  phase: RuntimeReadinessPhase;
  detail: string;
  hostTool: "available" | "missing" | "unknown";
  rootfs: "healthy" | "missing" | "unknown";
  baseline: "ready" | "missing" | "unknown";
  missingItems: readonly string[];
  reason?: RuntimeReadinessReason;
  rootfsState?: ProotDistroState;
}>;

export type RuntimeReadinessRunner = (
  command: string,
  options: RuntimePreparationRunOptions,
) => Promise<ProotBootstrapCommandResult>;

export type RuntimeReadinessOptions = Readonly<{
  run: RuntimeReadinessRunner;
  onProgress?: (phase: RuntimeReadinessPhase, detail: string) => void;
  onRootfsProbeOutcome?: (outcome: ProotDistroParserOutcome) => void;
  traceId?: string;
}>;

const HOST_PROBE_TIMEOUT_MS = 20_000;
const ROOTFS_PROBE_TIMEOUT_MS = 90_000;
const GUEST_CHECK_TIMEOUT_MS = 30_000;

/**
 * Read-only analysis for the selected Linux runtime. A positive Install decision
 * is returned only for a complete marker proving the Termux host prerequisite,
 * selected rootfs, or selected guest baseline component is absent. Every
 * timeout, permission denial, corrupt envelope, unhealthy login or other
 * inconclusive result is an error and must not authorize installation.
 */
export async function inspectProotRuntimeReadiness(
  target: ProotRuntimeTarget,
  options: RuntimeReadinessOptions,
): Promise<RuntimeEnvironmentReadiness> {
  const alias = target === "ubuntu-proot" ? "ubuntu" : "debian";
  const report = (phase: RuntimeReadinessPhase, detail: string) => {
    try { options.onProgress?.(phase, detail); } catch { /* presentation cannot affect diagnosis */ }
  };
  const run = (command: string, runOptions: RuntimePreparationRunOptions) =>
    options.run(command, { ...runOptions, traceId: options.traceId });
  const base = {
    target,
    hostTool: "unknown" as const,
    rootfs: "unknown" as const,
    baseline: "unknown" as const,
    missingItems: [] as readonly string[],
  };
  const error = (phase: RuntimeReadinessPhase, detail: string, fields: Partial<RuntimeEnvironmentReadiness> = {}): RuntimeEnvironmentReadiness => ({
    ...base,
    ...fields,
    target,
    status: "error",
    phase,
    detail,
    missingItems: fields.missingItems ?? [],
  });

  report("host-check", "Checking Termux host prerequisite proot-distro");
  let hostResult: ProotBootstrapCommandResult;
  try {
    hostResult = await run(PROOT_DISTRO_HOST_TOOL_PROBE_COMMAND, {
      timeoutMs: HOST_PROBE_TIMEOUT_MS,
      kind: "check",
      packageId: "proot-distro",
      selectedBackend: "termux",
      honorExplicitTimeout: true,
    });
  } catch (cause: unknown) {
    return error("host-check", `Termux host prerequisite status could not be verified (${classifyProbeException(cause)}); installation is blocked until a fresh check confirms a missing prerequisite.`, {
      reason: classifyProbeExceptionReason(cause),
    });
  }
  const hostOutput = `${hostResult.stdout || ""}\n${hostResult.stderr || ""}`;
  const hostLines = hostOutput.split(/\r?\n/).map((line) => line.trim());
  const availableCount = hostLines.filter((line) => line === "AIB_PROOT_TOOL:AVAILABLE").length;
  const missingCount = hostLines.filter((line) => line === "AIB_PROOT_TOOL:MISSING").length;
  const hostFailure = classifyProbeResult(hostResult);
  if (hostFailure || availableCount + missingCount !== 1) {
    return error("host-check", `Termux host prerequisite status is unknown${hostFailure ? ` (${hostFailure})` : " (status marker missing or ambiguous)"}; installation is blocked until a fresh check confirms a missing prerequisite.`, {
      reason: hostFailure ? classifyProbeResultReason(hostResult) : "unknown-status",
    });
  }
  if (missingCount === 1) {
    return {
      ...base,
      target,
      status: "missing",
      phase: "host-check",
      detail: "The Termux host prerequisite proot-distro is confirmed absent.",
      hostTool: "missing",
      rootfs: "unknown",
      baseline: "unknown",
      missingItems: ["proot-distro (Termux host)"],
    };
  }

  report("rootfs-check", `Checking selected ${alias} rootfs list, login and identity`);
  let rootfsResult: ProotBootstrapCommandResult;
  try {
    rootfsResult = await run(buildProotDistroProbeCommand(alias), {
      timeoutMs: ROOTFS_PROBE_TIMEOUT_MS,
      kind: "check",
      packageId: `${alias}-rootfs`,
      selectedBackend: "termux",
      honorExplicitTimeout: true,
    });
  } catch (cause: unknown) {
    return error("rootfs-check", `Selected ${alias} rootfs state could not be verified because ${classifyProbeException(cause)}; installation is blocked until a fresh check confirms absence.`, {
      hostTool: "available",
      reason: classifyProbeExceptionReason(cause),
    });
  }
  const rootfsOutput = `${rootfsResult.stdout || ""}\n${rootfsResult.stderr || ""}` +
    (rootfsResult.outputTruncated ? "\nTERMUX_RESULT_OUTPUT_TRUNCATED" : "");
  const rootfsState = parseProotDistroProbe(alias, rootfsOutput, rootfsResult.exitCode);
  try { options.onRootfsProbeOutcome?.(rootfsState.parserOutcome); } catch { /* diagnostic observers cannot affect readiness */ }
  const rootfsFailure = classifyProbeResult(rootfsResult);
  // A missing trailing AIB_*_END may be tolerated only when the native bridge
  // did not explicitly report timeout, truncation, or a failed command.
  if (rootfsFailure || (!(rootfsState.healthy === true && rootfsState.osReleaseId === alias) && !rootfsState.toolAvailable)) {
    const explanation = rootfsFailure || "the host tool/probe envelope was incomplete";
    return error("rootfs-check", `Selected ${alias} rootfs check could not be completed (${explanation}); installation is blocked until a fresh check confirms absence.`, {
      hostTool: "available",
      rootfsState,
      reason: rootfsFailure ? classifyProbeResultReason(rootfsResult) : "unknown-status",
    });
  }
  if (rootfsState.installed === false && rootfsState.evidence === "login-not-installed") {
    return {
      ...base,
      target,
      status: "missing",
      phase: "rootfs-check",
      detail: `Selected ${alias} rootfs is confirmed absent by an exact proot-distro login response.`,
      hostTool: "available",
      rootfs: "missing",
      baseline: "unknown",
      missingItems: [`${alias} rootfs`],
      rootfsState,
    };
  }
  if (rootfsState.healthy !== true || rootfsState.osReleaseId !== alias) {
    const reason = rootfsState.diagnostic === "ROOTFS_ARCH_MISMATCH"
      ? "host/guest architecture does not match"
      : rootfsState.diagnostic === "ROOTFS_LIST_UNVERIFIED"
        ? "the installed-distribution list is incomplete or does not confirm the selected alias"
      : "login/OS identity/architecture is not verified";
    return error("rootfs-check", `Selected ${alias} rootfs is present or ambiguous but ${reason}; existing data is preserved and installation is blocked.`, {
      hostTool: "available",
      rootfs: "unknown",
      rootfsState,
      reason: rootfsState.diagnostic === "ROOTFS_ARCH_MISMATCH"
        ? "architecture-mismatch"
        : rootfsState.diagnostic === "ROOTFS_LIST_UNVERIFIED"
          ? "list-unverified"
          : "identity-unverified",
    });
  }

  const missingItems: string[] = [];
  for (const requirement of PROOT_RUNTIME_REQUIREMENTS) {
    report("guest-baseline", `Checking ${requirement.name} in selected ${alias} guest`);
    const outcome = await checkPackageCommand(() => run(requirement.checkCommand, {
      timeoutMs: GUEST_CHECK_TIMEOUT_MS,
      kind: "check",
      packageId: requirement.id,
      selectedBackend: target,
      honorExplicitTimeout: true,
    }));
    if (outcome.status === "error") {
      const reason = /TIMEOUT/i.test(outcome.detail) ? "timed out" : /PERMISSION/i.test(outcome.detail) ? "permission denied" : "could not be verified";
      return error("guest-baseline", `Selected ${alias} baseline check for ${requirement.name} ${reason}; installation is blocked until a fresh check confirms a missing requirement.`, {
        hostTool: "available",
        rootfs: "healthy",
        baseline: "unknown",
        rootfsState,
        reason: /TIMEOUT/i.test(outcome.detail) ? "timeout" : /PERMISSION/i.test(outcome.detail) ? "permission" : "guest-check",
      });
    }
    if (outcome.status === "missing") missingItems.push(requirement.name);
  }

  if (missingItems.length > 0) {
    return {
      ...base,
      target,
      status: "missing",
      phase: "guest-baseline",
      detail: `Selected ${alias} guest baseline is missing: ${missingItems.join(", ")}.`,
      hostTool: "available",
      rootfs: "healthy",
      baseline: "missing",
      missingItems,
      rootfsState,
    };
  }

  report("ready", `Selected ${alias} rootfs/login/identity and all ${PROOT_RUNTIME_REQUIREMENTS.length} baseline guest tools are verified.`);
  return {
    ...base,
    target,
    status: "ready",
    phase: "ready",
    detail: `Selected ${alias} environment, rootfs login/identity and all baseline guest tools are verified.`,
    hostTool: "available",
    rootfs: "healthy",
    baseline: "ready",
    missingItems: [],
    rootfsState,
  };
}

/** Reduce runner failures to safe, actionable categories; never echo command output or raw exception text. */
function classifyProbeResult(result: ProotBootstrapCommandResult): string | null {
  if (result.timedOut) return "Termux command timed out";
  if (result.outputTruncated) return "Termux returned truncated output";
  const transcript = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (isPermissionFailure(transcript)) return "Bundled runtime execution or filesystem access was denied";
  if (result.exitCode !== 0) return `Termux command failed with exit ${Number.isFinite(result.exitCode) ? result.exitCode : "unknown"}`;
  return null;
}

function classifyProbeException(cause: unknown): string {
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause ?? "");
  if (isPermissionFailure(text)) return "Bundled runtime execution or filesystem access was denied";
  if (/BLOCKED_BY_APP:/i.test(text)) return "the application command policy blocked the probe";
  if (/timeout|timed\s*out|deadline/i.test(text)) return "Termux command timed out";
  if (/cancel|interrupt/i.test(text)) return "the check was interrupted";
  return "the Termux command bridge did not return a result";
}

function isPermissionFailure(value: string): boolean {
  return /RUN_COMMAND_PERMISSION|permission\s+denied|securityexception|eacces|eperm/i.test(value);
}

function classifyProbeResultReason(result: ProotBootstrapCommandResult): RuntimeReadinessReason {
  if (result.timedOut) return "timeout";
  if (result.outputTruncated) return "truncated-output";
  if (isPermissionFailure(`${result.stderr || ""}\n${result.stdout || ""}`)) return "permission";
  if (result.exitCode !== 0) return "command-failed";
  return "unknown-status";
}

function classifyProbeExceptionReason(cause: unknown): RuntimeReadinessReason {
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause ?? "");
  if (isPermissionFailure(text)) return "permission";
  if (/BLOCKED_BY_APP:/i.test(text)) return "command-failed";
  if (/timeout|timed\s*out|deadline/i.test(text)) return "timeout";
  if (/cancel|interrupt/i.test(text)) return "interrupted";
  return "bridge-failure";
}
