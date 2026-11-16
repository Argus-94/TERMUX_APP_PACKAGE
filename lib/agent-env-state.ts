/**
 * Compact environment state injected into every agent turn.
 * Source of truth for backend, rootfs, cwd, last result — not model memory.
 *
 * v389: native_priority + stronger environment rules (antigravity-inspired).
 */
import {
  getBuildBackend,
  backendLabel,
  isLinuxProotBackend,
  type AgentShellBackend,
} from "./agent-shell-backend";
import {
  getNativePriorityMode,
  type NativePriorityMode,
} from "./native-priority";
import { systemRulesOneLiner } from "./agent-system-rules";

export type AgentEnvState = Readonly<{
  backend: AgentShellBackend;
  backendLabel: string;
  isLinuxProot: boolean;
  pkgManager: "pkg" | "apt";
  shellMarkers: { run: string; done: string };
  cwdHint: string;
  sharedRoot: string;
  nativePriority: NativePriorityMode;
  lastExit: number | null;
  lastErrorFingerprint: string | null;
  lastCommandBrief: string | null;
  goalArtifact: string | null;
  notes: string[];
}>;

const SHARED = "/storage/emulated/0/AIBuilderTermux";

export function buildAgentEnvState(partial?: Partial<{
  lastExit: number | null;
  lastErrorFingerprint: string | null;
  lastCommandBrief: string | null;
  goalArtifact: string | null;
  cwdHint: string;
  notes: string[];
  nativePriority: NativePriorityMode;
}>): AgentEnvState {
  const backend = getBuildBackend();
  const isLinux = isLinuxProotBackend();
  const nativePriority = partial?.nativePriority ?? getNativePriorityMode();
  return {
    backend,
    backendLabel: backendLabel(backend),
    isLinuxProot: isLinux,
    pkgManager: isLinux ? "apt" : "pkg",
    shellMarkers: {
      run: isLinux ? "UBUNTU_RUN" : "TERMUX_RUN",
      done: isLinux ? "UBUNTU_DONE" : "TERMUX_DONE",
    },
    cwdHint: partial?.cwdHint || `${SHARED}/workspace`,
    sharedRoot: SHARED,
    nativePriority,
    lastExit: partial?.lastExit ?? null,
    lastErrorFingerprint: partial?.lastErrorFingerprint ?? null,
    lastCommandBrief: partial?.lastCommandBrief ?? null,
    goalArtifact: partial?.goalArtifact ?? null,
    notes: partial?.notes ?? [],
  };
}

/** One compact block for the model transcript. */
export function formatEnvStateBlock(state: AgentEnvState): string {
  const baseRules = state.isLinuxProot
    ? "USER_VISIBLE_FILES under /storage/emulated/0 (Download,Documents,Pictures,DCIM,Music,Movies,AIBuilderTermux,…); ACTIVE backend is the Ubuntu guest; use apt-get only and keep all package/build work here; only the guarded runner may retry eligible shared-storage commands on Termux after a verified Ubuntu/proot startup failure."
    : "USER_VISIBLE_FILES under /storage/emulated/0 (Download,Documents,Pictures,DCIM,Music,Movies,AIBuilderTermux,…); ACTIVE backend is the Termux host; use pkg only; do not use apt/Ubuntu or move this task to another backend.";

  const priorityHint =
    state.nativePriority === "force-proot"
      ? "native_priority=force-proot (always ubuntu-proot)."
      : state.nativePriority === "prefer-termux"
        ? "native_priority=prefer-termux (run simple git/python/node/clang/shell on host Termux)."
        : "native_priority=auto (prefer host Termux for simple tasks even when default backend is ubuntu-proot).";

  const environmentRules = `rules=${baseRules} ${priorityHint} ${systemRulesOneLiner(state.backend, state.nativePriority)}`;

  const lines = [
    "[ENV_STATE]",
    `backend=${state.backend}`,
    "backends_supported=termux|ubuntu-proot",
    `label=${state.backendLabel}`,
    `pkg=${state.pkgManager}`,
    `native_priority=${state.nativePriority}`,
    `markers=${state.shellMarkers.run}: / ${state.shellMarkers.done}:`,
    `cwd_hint=${state.cwdHint}`,
    `shared_root=${state.sharedRoot}`,
    `last_exit=${state.lastExit === null ? "none" : state.lastExit}`,
    `last_error_fp=${state.lastErrorFingerprint || "none"}`,
    `last_cmd=${state.lastCommandBrief || "none"}`,
    `goal_artifact=${state.goalArtifact || "none"}`,
    environmentRules,
  ];
  if (state.notes.length) lines.push(`notes=${state.notes.join(" | ")}`);
  return lines.join("\n");
}
