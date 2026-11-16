/**
 * Central ToolDefinition / ToolHealth registry (PACK-006, Patch 2).
 * Single source of truth for presence + functional health checks used by
 * pack installer, toolchain matrix, and recovery probes.
 */

export type ToolHealthStatus =
  | "MISSING"
  | "BROKEN_ARCH"
  | "BROKEN_RUNTIME"
  | "READY"
  | "DEGRADED"
  | "SKIP";

export interface ToolDefinition {
  id: string;
  /** Human label (often matches InstallStep.label) */
  label?: string;
  presenceCmd: string;
  healthCmd: string;
  versionCmd?: string;
  architectureSensitive?: boolean;
  expectedArch?: "aarch64" | "any";
  required?: boolean;
  /** Capability tags for reverse / build */
  capabilities?: string[];
}

/** Shared Android SDK / JDK policy (PACK-007, PACK-008). */
export const ANDROID_SDK_POLICY = {
  /** Preferred compile/target SDK; discovery may use any installed platform. */
  preferredCompileSdk: 34,
  preferredBuildTools: "34.0.0",
  /** JDK: prefer 17 for AGP/RN compatibility; 21 accepted if 17 missing. */
  preferredJdk: 17,
  acceptedJdks: [17, 21] as number[],
};

/** Canonical health definitions for critical tools. */
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  java: {
    id: "java",
    presenceCmd: "command -v java >/dev/null 2>&1",
    healthCmd: "java -version >/dev/null 2>&1",
    versionCmd: "java -version 2>&1 | head -1",
    required: true,
    capabilities: ["jdk"],
  },
  javac: {
    id: "javac",
    presenceCmd: "command -v javac >/dev/null 2>&1",
    healthCmd: "javac -version >/dev/null 2>&1",
    required: true,
  },
  gradle: {
    id: "gradle",
    presenceCmd: "command -v gradle >/dev/null 2>&1",
    healthCmd: "gradle --version >/dev/null 2>&1",
    required: true,
  },
  aapt2: {
    id: "aapt2",
    presenceCmd:
      "(command -v aapt2 >/dev/null 2>&1) || ls \"$PREFIX/opt/android-sdk/build-tools\"/*/aapt2 >/dev/null 2>&1",
    healthCmd:
      'A=$(command -v aapt2 2>/dev/null || ls "$PREFIX/opt/android-sdk/build-tools"/*/aapt2 2>/dev/null | head -1); test -n "$A" && "$A" version >/dev/null 2>&1',
    architectureSensitive: true,
    expectedArch: "aarch64",
    required: true,
    capabilities: ["android-build-tools-host"],
  },
  aapt: {
    id: "aapt",
    presenceCmd:
      "(command -v aapt >/dev/null 2>&1) || ls \"$PREFIX/opt/android-sdk/build-tools\"/*/aapt >/dev/null 2>&1",
    healthCmd:
      'A=$(command -v aapt 2>/dev/null || ls "$PREFIX/opt/android-sdk/build-tools"/*/aapt 2>/dev/null | head -1); test -n "$A" && "$A" version >/dev/null 2>&1',
    architectureSensitive: true,
    required: true,
  },
  zipalign: {
    id: "zipalign",
    presenceCmd: "command -v zipalign >/dev/null 2>&1",
    healthCmd: 'command -v zipalign >/dev/null 2>&1 && test -x "$(command -v zipalign)"',
    required: true,
  },
  apksigner: {
    id: "apksigner",
    presenceCmd: "command -v apksigner >/dev/null 2>&1",
    healthCmd:
      "command -v apksigner >/dev/null 2>&1 && (apksigner --version >/dev/null 2>&1 || apksigner --help >/dev/null 2>&1)",
    required: true,
  },
  adb: {
    id: "adb",
    presenceCmd: 'test -x "$PREFIX/opt/android-sdk/platform-tools/adb"',
    healthCmd:
      'ADB="$PREFIX/opt/android-sdk/platform-tools/adb"; test -x "$ADB" && "$ADB" version >/dev/null 2>&1',
    architectureSensitive: true,
    expectedArch: "aarch64",
    required: true,
  },
  "platform-jar": {
    id: "platform-jar",
    presenceCmd:
      'test -f "$PREFIX/opt/android-sdk/platforms/android-34/android.jar" || find "$PREFIX/opt/android-sdk/platforms" -name android.jar 2>/dev/null | grep -q .',
    healthCmd:
      'test -f "$PREFIX/opt/android-sdk/platforms/android-34/android.jar" || find "$PREFIX/opt/android-sdk/platforms" -name android.jar 2>/dev/null | grep -q .',
    required: true,
  },
  frida_cli: {
    id: "frida_cli",
    presenceCmd: "command -v frida >/dev/null 2>&1",
    healthCmd: "command -v frida >/dev/null 2>&1 && frida --version >/dev/null 2>&1",
    required: false,
    capabilities: ["frida-cli"],
  },
  frida_server: {
    id: "frida_server",
    /** Server/root capability is separate from CLI (REV-002). */
    presenceCmd: "command -v frida-server >/dev/null 2>&1 || true",
    healthCmd:
      'echo "FRIDA_SERVER_CAPABILITY=unknown_non_root_device"; command -v frida >/dev/null 2>&1',
    required: false,
    capabilities: ["frida-server-or-root"],
  },
  objection: {
    id: "objection",
    presenceCmd: "command -v objection >/dev/null 2>&1",
    healthCmd: "command -v objection >/dev/null 2>&1 && objection --help >/dev/null 2>&1",
    required: false,
  },
  androguard: {
    id: "androguard",
    presenceCmd: "command -v androguard >/dev/null 2>&1 || python -c 'import androguard' 2>/dev/null",
    healthCmd:
      "(command -v androguard >/dev/null 2>&1 && androguard --help >/dev/null 2>&1) || python -c 'import androguard' 2>/dev/null",
    required: false,
  },
  apkid: {
    id: "apkid",
    presenceCmd: "command -v apkid >/dev/null 2>&1",
    healthCmd: "command -v apkid >/dev/null 2>&1 && apkid --help >/dev/null 2>&1",
    required: false,
  },
};

/** Structured installer error (PACK-016). */
export interface InstallerError {
  packId?: string;
  toolId: string;
  phase: "download" | "install" | "verify" | "remove" | "preflight" | "unknown";
  hostArch?: string;
  source?: string;
  command?: string;
  exitCode?: number;
  detectedFile?: string;
  expectedCapability?: string;
  stderrTail?: string;
  stdoutTail?: string;
  timestamp: string;
  message: string;
}

export function makeInstallerError(
  partial: Omit<InstallerError, "timestamp"> & { timestamp?: string }
): InstallerError {
  return {
    timestamp: partial.timestamp || new Date().toISOString(),
    ...partial,
  };
}

export function formatInstallerError(err: InstallerError): string {
  const parts = [
    `[${err.phase}] ${err.toolId}: ${err.message}`,
    err.hostArch ? `arch=${err.hostArch}` : "",
    err.exitCode != null ? `exit=${err.exitCode}` : "",
    err.command ? `cmd=${err.command.slice(0, 80)}` : "",
    err.stderrTail ? `stderr=${err.stderrTail.slice(0, 120)}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

export function installerErrorToJson(err: InstallerError): string {
  return JSON.stringify(err, null, 2);
}

/** Shell snippet: resolve preferred JDK (17 first, then 21). PACK-008 */
export function resolveJdkShell(): string {
  return [
    'JH=""',
    'J17="$PREFIX/lib/jvm/java-17-openjdk"',
    'J21="$PREFIX/lib/jvm/java-21-openjdk"',
    'for d in "$J17" "$JAVA_HOME" "$J21" "$PREFIX/lib/jvm/"*; do',
    '  if [ -x "$d/bin/java" ]; then JH="$d"; break; fi',
    "done",
    'if [ -z "$JH" ] && command -v java >/dev/null 2>&1; then',
    '  JH=$(dirname "$(dirname "$(readlink -f "$(command -v java)" 2>/dev/null || command -v java)")")',
    "fi",
    'if [ -z "$JH" ] || [ ! -x "$JH/bin/java" ]; then echo "JAVA_NOT_FOUND" >&2; exit 21; fi',
    'export JAVA_HOME="$JH"',
    // Soft version probe (do not fail hard on 21-only environments)
    'java -version >/dev/null 2>&1 || { echo "JAVA_RUNTIME_BROKEN" >&2; exit 21; }',
  ].join("; ");
}

/** Shell: discover any usable platform android.jar (PACK-007). */
export function resolvePlatformJarShell(): string {
  return [
    'PLAT_JAR=""',
    'if [ -f "$PREFIX/opt/android-sdk/platforms/android-34/android.jar" ]; then',
    '  PLAT_JAR="$PREFIX/opt/android-sdk/platforms/android-34/android.jar"',
    "else",
    '  PLAT_JAR=$(find "$PREFIX/opt/android-sdk/platforms" -name android.jar 2>/dev/null | head -1)',
    "fi",
    'test -n "$PLAT_JAR" && test -f "$PLAT_JAR"',
  ].join("; ");
}

/** Combined health command for a registry tool. */
export function registryHealthCmd(id: string): string | undefined {
  const t = TOOL_REGISTRY[id];
  if (!t) return undefined;
  return `(${t.presenceCmd}) && (${t.healthCmd})`;
}


/** Reverse-engineering prerequisites matrix (REV-001). */
export const REVERSE_PREREQUISITES: Record<
  string,
  { needs: string[]; arch?: string; note?: string }
> = {
  jadx: { needs: ["java"], note: "dex decompiler" },
  "frida-tools": { needs: ["python", "pip"], arch: "any", note: "CLI only on non-root" },
  objection: { needs: ["python", "frida-tools"], note: "depends on frida CLI" },
  androguard: { needs: ["python"], note: "static analysis" },
  apkid: { needs: ["python"], note: "packer id" },
  "r2frida (r2pm)": { needs: ["radare2", "rizin"], note: "optional plugin" },
  "apk-mitm": { needs: ["nodejs", "npm"], note: "optional" },
};

/** Map InstallStep label → registry id when known. */
export const LABEL_TO_REGISTRY: Record<string, string> = {
  "openjdk-17": "java",
  aapt: "aapt",
  apksigner: "apksigner",
  zipalign: "zipalign",
  gradle: "gradle",
  "android platform-tools": "adb",
  "android build-tools": "aapt2",
  "android platform-34": "platform-jar",
  "frida-tools": "frida_cli",
  objection: "objection",
  androguard: "androguard",
  apkid: "apkid",
};

export function statusLabel(
  status: ToolHealthStatus,
  lang: "ru" | "uk" | "en" = "ru"
): string {
  const map: Record<ToolHealthStatus, Record<string, string>> = {
    READY: { ru: "Готов", uk: "Готовий", en: "Ready" },
    MISSING: { ru: "Не установлен", uk: "Не встановлено", en: "Missing" },
    BROKEN_ARCH: { ru: "Неверная архитектура", uk: "Невірна архітектура", en: "Wrong architecture" },
    BROKEN_RUNTIME: { ru: "Не запускается", uk: "Не запускається", en: "Runtime broken" },
    DEGRADED: { ru: "Ограничен", uk: "Обмежено", en: "Degraded" },
    SKIP: { ru: "Пропущен", uk: "Пропущено", en: "Skipped" },
  };
  return map[status]?.[lang] || status;
}

/**
 * Shell: diagnose a binary path — arch + runnable (PACK-016).
 * Prints lines DIAG_ARCH=... DIAG_FILE=... DIAG_RUN=ok|fail
 */
export function diagnoseBinaryShell(binExpr: string): string {
  return (
    `BIN=${binExpr}; ` +
    `echo "DIAG_HOST=$(uname -m)"; ` +
    `if [ -z "$BIN" ] || [ ! -e "$BIN" ]; then echo DIAG_FILE=missing; echo DIAG_RUN=fail; exit 0; fi; ` +
    `echo "DIAG_FILE=$(file -b \"$BIN\" 2>/dev/null || echo unknown)"; ` +
    `if file -b "$BIN" 2>/dev/null | grep -qiE 'x86-64|x86_64|Intel 80386'; then echo DIAG_ARCH=x86_host; ` +
    `elif file -b "$BIN" 2>/dev/null | grep -qiE 'ARM aarch64|ARM64|aarch64'; then echo DIAG_ARCH=aarch64; ` +
    `else echo DIAG_ARCH=other; fi; ` +
    `if [ -x "$BIN" ] && "$BIN" version >/dev/null 2>&1 || "$BIN" --version >/dev/null 2>&1 || "$BIN" -h >/dev/null 2>&1; then echo DIAG_RUN=ok; else echo DIAG_RUN=fail; fi`
  );
}

/** Destructive remove labels that need explicit UI confirmation (PACK-015). */
export const DESTRUCTIVE_REMOVE_LABELS = [
  "android-sdk termux (aarch64)",
  "android build-tools",
  "android platform-tools",
  "android-ndk",
];

export function isDestructiveRemove(label: string): boolean {
  const L = label.toLowerCase();
  return DESTRUCTIVE_REMOVE_LABELS.some((d) => L.includes(d.toLowerCase()) || d.toLowerCase().includes(L));
}


/**
 * Ownership manifest: files/dirs created by a step (PACK-015).
 * Used for safe remove + impact preview — never wipe unrelated SDK trees.
 */
export const TOOL_OWNERSHIP: Record<string, string[]> = {
  "bundletool": ["$PREFIX/bin/bundletool", "$PREFIX/lib/bundletool"],
  "android-sdk cmdline": ["$PREFIX/opt/android-sdk/cmdline-tools", "$AIB_PRIVATE_ROOT/tmp/cmdtools.zip"],
  "android platform-tools": ["$PREFIX/opt/android-sdk/platform-tools", "$AIB_PRIVATE_ROOT/tmp/platform-tools.zip"],
  "android platform-34": ["$PREFIX/opt/android-sdk/platforms/android-34", "$AIB_PRIVATE_ROOT/tmp/platform-34.zip"],
  "android build-tools": ["$PREFIX/opt/android-sdk/build-tools/34.0.0", "$AIB_PRIVATE_ROOT/tmp/build-tools.zip"],
  "android-ndk": ["$PREFIX/opt/android-ndk", "$PREFIX/opt/android-ndk-r29", "$AIB_PRIVATE_ROOT/tmp/ndk"],
  "android-sdk termux (aarch64)": [],
  "dex2jar": ["$PREFIX/share/java/dex-tools", "$PREFIX/share/java/dex2jar", "$PREFIX/bin/d2j-dex2jar", "$PREFIX/bin/d2j-dex2jar.sh"],
  "smali": ["$PREFIX/bin/smali", "$PREFIX/bin/baksmali", "$PREFIX/share/java/smali.jar", "$PREFIX/share/java/baksmali.jar"],
  "apk-mitm": ["$PREFIX/bin/apk-mitm"],
};

/** Human impact preview before remove */
export function removeImpactPreview(label: string, lang: "ru" | "uk" | "en" = "ru"): string {
  const L = label.toLowerCase();
  if (L.includes("android-sdk termux")) {
    return lang === "en"
      ? "Aggregate SDK remove is disabled. Remove platform-tools / build-tools / ndk individually."
      : lang === "uk"
        ? "Видалення всього SDK вимкнено. Видаляйте platform-tools / build-tools / ndk окремо."
        : "Удаление всего SDK отключено. Удаляйте platform-tools / build-tools / ndk по отдельности.";
  }
  const paths = TOOL_OWNERSHIP[label] || [];
  if (!paths.length) {
    return lang === "en"
      ? `Will uninstall package/tool: ${label}`
      : lang === "uk"
        ? `Буде видалено пакет/інструмент: ${label}`
        : `Будет удалён пакет/инструмент: ${label}`;
  }
  const list = paths.slice(0, 6).join("\n");
  return lang === "en"
    ? `Will remove:\n${list}`
    : lang === "uk"
      ? `Буде видалено:\n${list}`
      : `Будет удалено:\n${list}`;
}

/** Virtual Frida capability rows for UI (REV-002). */
export const FRIDA_UI_ROWS = [
  {
    id: "frida_cli",
    label: "frida CLI",
    healthCmd: "command -v frida >/dev/null 2>&1 && frida --version >/dev/null 2>&1",
    note: {
      ru: "Клиент Frida (frida --version)",
      uk: "Клієнт Frida (frida --version)",
      en: "Frida client CLI",
    },
  },
  {
    id: "frida_server_cap",
    label: "frida server/root",
    healthCmd: "command -v frida-server >/dev/null 2>&1",
    note: {
      ru: "Server/root: на non-root обычно недоступно — это не ошибка установки CLI",
      uk: "Server/root: на non-root зазвичай недоступно — це не помилка CLI",
      en: "Server/root usually unavailable on non-root — not a CLI install failure",
    },
  },
] as const;

/** Shell snippet: host arch + optional binary file type for diagnostics. */
export function diagArchShell(binaryPath?: string): string {
  const parts = ['echo "DIAG_HOST=$(uname -m)"'];
  if (binaryPath) {
    parts.push(
      `B="${binaryPath}"; if [ -e "$B" ]; then echo "DIAG_FILE=$(file -b \"$B\" 2>/dev/null || echo unknown)"; ` +
        `file -b "$B" 2>/dev/null | grep -qiE 'x86-64|x86_64|Intel' && echo DIAG_ARCH=wrong_x86; ` +
        `file -b "$B" 2>/dev/null | grep -qiE 'aarch64|ARM64' && echo DIAG_ARCH=aarch64; fi`
    );
  }
  return parts.join("; ");
}
