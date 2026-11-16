import type { AgentShellBackend } from "./agent-shell-backend";
import { packageBackendTarget } from "./package-command-routing";
import {
  getNativePriorityMode,
  resolveBackendForCommand,
} from "./native-priority";

export type ProotDistroName = "ubuntu" | "debian";
export type RuntimeCommandPurpose = "host" | "proot-distro" | "package" | "shell";

/** Resolve the one Linux image that matches the user's selected environment. */
export function rootfsDistroForBackend(backend: AgentShellBackend): ProotDistroName | null {
  if (backend === "ubuntu-proot") return "ubuntu";
  return null;
}

/**
 * proot-distro is a Termux-host tool even when the selected runtime is Linux.
 * Ordinary package operations use the selected guest, except host-only catalog
 * packages (for example proot-distro and rootfs bootstrap packages).
 *
 * v389: purpose "shell" applies Native Priority fast-path when a command string
 * is provided via routeShellCommand().
 */
export function routeRuntimeCommand(
  selectedBackend: AgentShellBackend,
  purpose: RuntimeCommandPurpose,
  packageId?: string,
): AgentShellBackend {
  if (purpose === "host" || purpose === "proot-distro") return "termux";
  return packageBackendTarget(selectedBackend, packageId) === "termux"
    ? "termux"
    : selectedBackend;
}

/**
 * Route a concrete shell command under Native Priority policy.
 * Does not change the global build backend — only the effective target for this command.
 */
export function routeShellCommand(
  selectedBackend: AgentShellBackend,
  command: string,
): AgentShellBackend {
  return resolveBackendForCommand(command, selectedBackend, getNativePriorityMode());
}

/** Persisted fingerprint makes a changed environment invalidate only its image stage. */
export function bootstrapImageFingerprint(backend: AgentShellBackend): string {
  const distro = rootfsDistroForBackend(backend);
  return distro ? `image:${distro}` : "image:none:termux";
}
