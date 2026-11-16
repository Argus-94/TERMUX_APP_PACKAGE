/**
 * Native Priority / Fast Path policy (antigravity-inspired).
 *
 * Prefer host Termux (no proot overhead) for simple toolchain tasks.
 * Fall back to ubuntu-proot only when a full Linux userspace is required.
 *
 * Storage key is independent of build backend so the user can keep
 * ubuntu-proot as default backend but still allow auto host fast-path.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AgentShellBackend } from "./agent-shell-backend";

export type NativePriorityMode = "auto" | "prefer-termux" | "force-proot";

const STORAGE_KEY = "aibuilder.nativePriority.v1";

let currentMode: NativePriorityMode = "auto";

export function getNativePriorityMode(): NativePriorityMode {
  return currentMode;
}

export function setNativePriorityMode(mode: NativePriorityMode): void {
  if (mode === "prefer-termux" || mode === "force-proot" || mode === "auto") {
    currentMode = mode;
  } else {
    currentMode = "auto";
  }
}

export function parseNativePriorityMode(raw: unknown): NativePriorityMode {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "prefer-termux" || s === "prefer_termux" || s === "termux") return "prefer-termux";
  if (s === "force-proot" || s === "force_proot" || s === "proot") return "force-proot";
  return "auto";
}

export async function loadNativePriorityMode(): Promise<NativePriorityMode> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const mode = parseNativePriorityMode(raw);
    setNativePriorityMode(mode);
    return mode;
  } catch {
    return getNativePriorityMode();
  }
}

export async function saveNativePriorityMode(mode: NativePriorityMode): Promise<NativePriorityMode> {
  setNativePriorityMode(mode);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // non-fatal
  }
  return mode;
}

export const NATIVE_PRIORITY_STORAGE_KEY = STORAGE_KEY;

/** Command classes that are safe/fast on host Termux without proot. */
const HOST_SAFE_PATTERNS: RegExp[] = [
  /^\s*(pkg|termux-)\b/i,
  /^\s*(git|gh)\b/i,
  /^\s*(python3?|pip3?|node|npm|npx|yarn|pnpm)\b/i,
  /^\s*(clang|clang\+\+|gcc|g\+\+|make|cmake|ninja)\b/i,
  /^\s*(ls|cat|head|tail|grep|rg|find|sed|awk|cut|sort|uniq|wc|cp|mv|rm|mkdir|touch|chmod|ln|tar|unzip|zip|curl|wget|ssh|scp)\b/i,
  /^\s*(echo|printf|true|false|test|\[|which|command|type|pwd|cd|export|env)\b/i,
  /^\s*(bash|sh)\s+-c\b/i,
];

/** Patterns that strongly suggest a full Linux guest is needed. */
const PROOT_HINT_PATTERNS: RegExp[] = [
  /^\s*(apt|apt-get|dpkg)\b/i,
  /\b(ubuntu|debian|proot-distro)\b/i,
  /\b(systemctl|systemd|service)\b/i,
  /\b(\/usr\/bin\/python3|\/usr\/lib)\b/i,
];

export function commandLooksHostSafe(command: string): boolean {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (PROOT_HINT_PATTERNS.some((re) => re.test(cmd))) return false;
  return HOST_SAFE_PATTERNS.some((re) => re.test(cmd));
}

export function commandLooksProotRequired(command: string): boolean {
  return PROOT_HINT_PATTERNS.some((re) => re.test(String(command || "")));
}

/**
 * Resolve effective backend for a single command under the current policy.
 * Does not mutate the global build backend.
 */
export function resolveBackendForCommand(
  command: string,
  configuredBackend: AgentShellBackend,
  mode: NativePriorityMode = getNativePriorityMode(),
): AgentShellBackend {
  if (mode === "force-proot") {
    return "ubuntu-proot";
  }
  if (mode === "prefer-termux") {
    if (commandLooksProotRequired(command)) return "ubuntu-proot";
    return "termux";
  }
  // auto
  if (configuredBackend === "termux") return "termux";
  if (commandLooksHostSafe(command) && !commandLooksProotRequired(command)) {
    return "termux";
  }
  return configuredBackend;
}

export function nativePriorityLabel(mode: NativePriorityMode, language: "ru" | "uk" | "en" = "en"): string {
  const map: Record<NativePriorityMode, Record<"ru" | "uk" | "en", string>> = {
    auto: {
      ru: "Авто (Termux для простых задач)",
      uk: "Авто (Termux для простих задач)",
      en: "Auto (Termux for simple tasks)",
    },
    "prefer-termux": {
      ru: "Всегда предпочитать Termux",
      uk: "Завжди віддавати перевагу Termux",
      en: "Always prefer Termux",
    },
    "force-proot": {
      ru: "Всегда Ubuntu proot",
      uk: "Завжди Ubuntu proot",
      en: "Always Ubuntu proot",
    },
  };
  return map[mode][language];
}

/** Compact block for ENV_STATE / system prompt. */
export function formatNativePriorityBlock(mode: NativePriorityMode = getNativePriorityMode()): string {
  return [
    "[NATIVE_PRIORITY]",
    `mode=${mode}`,
    "policy=prefer host Termux (pkg, $PREFIX) for git/python/node/clang/simple shell; use ubuntu-proot only when apt/full Linux userspace is required",
    "override=user can set auto|prefer-termux|force-proot in Settings",
  ].join("\n");
}
