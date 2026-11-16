/**
 * Unified system rules for the agent (antigravity-inspired environment awareness).
 * Injected into RUNTIME_CONTEXT / ENV_STATE so the model knows Android paths,
 * pkg vs apt, and must not fall into desktop-sandbox traps.
 */

import type { AgentShellBackend } from "./agent-shell-backend";
import { getNativePriorityMode, type NativePriorityMode } from "./native-priority";

export const SHARED_APP_ROOT = "/storage/emulated/0/AIBuilderTermux";
export const TERMUX_HOME = "/data/data/com.karat.aibuilder/files/home";
export const TERMUX_PREFIX = "/data/data/com.karat.aibuilder/files/usr";

export function buildAgentSystemRules(opts?: {
  backend?: AgentShellBackend;
  nativePriority?: NativePriorityMode;
}): string {
  const backend = opts?.backend ?? "termux";
  const priority = opts?.nativePriority ?? getNativePriorityMode();
  const isUbuntu = backend === "ubuntu-proot";

  const lines: string[] = [
    "[SYSTEM_RULES]",
    "platform=Android (ARM64). Not Linux desktop, not PC, not WSL.",
    `shared_root=${SHARED_APP_ROOT}`,
    `termux_home=${TERMUX_HOME}`,
    `termux_prefix=${TERMUX_PREFIX}`,
    `active_backend=${backend}`,
    `native_priority=${priority}`,
    "",
    "paths:",
    `- User projects and outputs live ONLY under /storage/emulated/0/AIBuilderTermux.`,
    `- Project knowledge/sessions/skills: ${SHARED_APP_ROOT}/{knowledge,sessions,fixtures,skills,workspace}`,
    `- Termux packages and $PREFIX tools: ${TERMUX_PREFIX}`,
    "",
    "Runtime: bundled app-private only; do not discover or open an external terminal app.",
    "Private package feed, toolchain installation and project build are blocked until qualified; do not bypass these gates with shell commands.",
    "package managers:",
    "- backend=termux → use `pkg` only (never apt/apt-get).",
    "- backend=ubuntu-proot → use `apt-get` / `apt` inside the guest (never pkg).",
    "",
    "native priority:",
    "- auto / prefer-termux: run simple tasks (git, python, node, clang, make, coreutils) on host Termux even if default backend is ubuntu-proot.",
    "- force-proot: always route shell through ubuntu-proot.",
    "- Prefer host Termux to avoid proot overhead when the task does not need a full Debian userspace.",
    "",
    "forbidden assumptions:",
    "- Do NOT assume /home/user, brew, choco, systemd, or linux-x86_64/amd64 binaries.",
    "- Do NOT download Google NDK linux.zip or desktop Gradle distributions meant for x86_64.",
    "- Do NOT claim BUILD SUCCESSFUL or TERMUX_DONE without verified tool output.",
    "- Do NOT invent GitHub/API availability; use registered tools.",
    "",
    "shell markers:",
    isUbuntu
      ? "- Use UBUNTU_RUN / UBUNTU_DONE semantics inside the guest."
      : "- Use TERMUX_RUN / TERMUX_DONE semantics on the host.",
    "",
    "privileges:",
    "- Standard app user by default. Shizuku (uid=2000) may be available for elevated ADB-style ops without root.",
    "- Never assume root. Request only what the task needs.",
  ];

  return lines.join("\n");
}

/** Short one-liner for dense prompts. */
export function systemRulesOneLiner(backend: AgentShellBackend, priority: NativePriorityMode): string {
  return `rules=Android ARM64; shared=${SHARED_APP_ROOT}; backend=${backend}; native_priority=${priority}; pkg-on-termux apt-on-ubuntu-proot; no desktop/x86_64/brew; prefer host Termux for simple tasks when priority allows.`;
}
