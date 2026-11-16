/**
 * Always-on agent context: Termux / Ubuntu only + tool-first policy.
 * v389: native priority + system rules (antigravity-inspired).
 */
import type { AgentShellBackend } from "./agent-shell-backend";
import type { AgentIntelligenceSettings } from "./agent-intelligence";
import { getNativePriorityMode } from "./native-priority";
import { buildAgentSystemRules } from "./agent-system-rules";
import { formatPrivilegeBlock } from "./privilege-awareness";

export function formatAgentRuntimeContext(
  backend: AgentShellBackend,
  intelligence?: Partial<AgentIntelligenceSettings> | null,
): string {
  const isUbuntu = backend === "ubuntu-proot";
  const active = isUbuntu ? "Ubuntu proot" : "Termux";
  const pkgMgr = isUbuntu ? "apt-get / apt (guest)" : "pkg (Termux $PREFIX)";
  const shellNote = isUbuntu
    ? "Shell inside Ubuntu (proot-distro login). /storage and /sdcard bound. Use apt-get, never pkg."
    : "Shell on Termux host ($PREFIX, pkg). /storage/emulated/0 and /sdcard are native.";
  const priority = getNativePriorityMode();

  const githubOn = intelligence?.github !== false;
  const lines: string[] = [
    "[RUNTIME_CONTEXT]",
    "active_environment=" + backend + " (" + active + ")",
    "package_manager=" + pkgMgr,
    "native_priority=" + priority,
    "all_environments:",
    "  termux - host Termux, pkg, $PREFIX (prefer for simple tasks when native_priority allows)",
    "  ubuntu-proot - Ubuntu userspace, apt-get (use when full Linux guest is required)",
    "shell: " + shellNote,
    "behavior:",
    "- Understand the task in any language; map intent to tools. No fixed phrases required.",
    "- Side effects (create/modify/delete/build/GitHub/interceptor/shell) REQUIRE AIB_TOOL and/or TERMUX_RUN. Chat-only is wrong when a tool can do the work.",
    "- Never invent success. Never claim GitHub API is unavailable when github.* tools are enabled.",
    "- Use ACTIVE environment for shell/build. If Ubuntu rootfs is broken, same absolute paths may run on host Termux.",
    "- Match package manager to environment (pkg vs apt-get).",
    "- Native Priority: for git/python/node/clang/coreutils prefer host Termux (fast path) unless mode is force-proot or the command needs apt/full guest.",
  ];
  if (githubOn) {
    lines.push(
      "github: token from vault; tools include github.repoCreate, github.repo, github.tree, github.read, github.write, github.apply, github.branch, github.prCreate, github.materialize, github.pack, github.parse",
      "github.repoCreate: { name, private?, description?, autoInit? } - private=true for private repositories.",
    );
  } else {
    lines.push("github: DISABLED - do not call github.*");
  }

  lines.push("");
  lines.push(buildAgentSystemRules({ backend, nativePriority: priority }));
  lines.push("");
  lines.push(formatPrivilegeBlock());

  return lines.join("\n");
}
