import { withCheckEnvironment } from "./termux-installer-env";
import { getBuildBackend, type AgentShellBackend } from "./agent-shell-backend";
import { executeGuardedTermuxCommand } from "./termux-executor";
import type { TermuxCommandResult } from "./termux-bridge";
import {
  adaptPackageCommandForBackend,
  isPackageSupportedOnBackend,
  packageBackendTarget,
  type PackageCommandKind,
} from "./package-command-routing";
import { assertPrivatePackageMutationAllowed } from "./private-package-install-policy";

export type { PackageBackendTarget, PackageCommandKind } from "./package-command-routing";

/** Legacy command adaptation is pure; it never selects a physical execution target. */
export function adaptPackageCommand(command: string, kind: PackageCommandKind, forceHost = false): string {
  const selected = getBuildBackend();
  const target = forceHost ? "termux" : packageBackendTarget(selected);
  return adaptPackageCommandForBackend(command, kind, target);
}

export async function runPackageCommand(
  command: string,
  options: { timeoutMs?: number; isBuild?: boolean; honorExplicitTimeout?: boolean; kind: PackageCommandKind; packageId?: string; selectedBackend?: AgentShellBackend; traceId?: string },
): Promise<TermuxCommandResult> {
  // Fail before building a shell wrapper, initializing native runtime, probing,
  // downloading or issuing any package operation. No UI toggle can bypass this.
  if (options.kind !== "check") assertPrivatePackageMutationAllowed();

  const selectedBackend = options.selectedBackend ?? getBuildBackend();
  const targetBackend = packageBackendTarget(selectedBackend, options.packageId);
  if (!isPackageSupportedOnBackend(options.packageId, targetBackend)) {
    throw new Error("EMBEDDED_PRIVATE_PACKAGE_UNSUPPORTED: this tool has no qualified private Android artifact");
  }
  if (selectedBackend !== "termux" || targetBackend !== "termux") {
    throw new Error("EMBEDDED_PRIVATE_PACKAGE_BACKEND_REQUIRED: external/guest package execution is not available");
  }

  const adapted = adaptPackageCommandForBackend(command, "check", "termux");
  const prepared = withCheckEnvironment(adapted, "termux");
  return executeGuardedTermuxCommand(prepared, {
    timeoutMs: options.timeoutMs,
    isBuild: options.isBuild,
    honorExplicitTimeout: options.honorExplicitTimeout,
    trustedInternal: true,
    executionTarget: "embedded-private",
    traceId: options.traceId,
  });
}
