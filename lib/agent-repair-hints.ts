/**
 * Map live [ENV] / health probes to DeterministicRepair recipe hints.
 * Injected into agent transcript so the model picks fixed recipes, not invented shell.
 */
import { createDeterministicRepair, type RepairRecipe } from "../core/recovery/DeterministicRepair";
import { getBuildBackend, type AgentShellBackend } from "./agent-shell-backend";
import { APK_BUILD_SAFETY_POLICY } from "./apk-build-safety-policy";

const repair = createDeterministicRepair();

/** Return only recipes whose commands match the selected host/guest backend. */
function recipeForBackend(id: string, backend: AgentShellBackend): RepairRecipe | undefined {
  if (backend === "termux") {
    const recipe = repair.get(id);
    if (!recipe) return undefined;
    if (["java-install", "gradle-pkg", "aapt2-sdk"].includes(id)) {
      return { ...recipe, termuxHint: id };
    }
    return recipe;
  }
  if (id === "gradle-pkg") {
    const recipe = repair.get("gradle-wrapper");
    return recipe && { ...recipe, termuxHint: "gradle-wrapper" };
  }
  if (id === "java-install") {
    const recipe = repair.get(id);
    return recipe && {
      ...recipe,
      description: "Ensure Java 17+ using the selected Linux proot backend; preserve a working newer JDK",
      termuxHint: "java-install",
    };
  }
  // These recipes encode Termux-only SDK paths or package names that have no
  // verified mapping for Debian/Ubuntu. Hide them rather than send pkg commands
  // into a proot shell and imply that the wrong backend can repair the issue.
  if (["local-properties", "aapt2-sdk", "android-tools", "nodejs", "git", "unzip", "expo-cli", "expo-deps", "ndk-path"].includes(id)) return undefined;
  const recipe = repair.get(id);
  if (recipe && /\bpkg\s+install\b|\$PREFIX\/opt\/android-sdk/.test(recipe.termuxHint)) return undefined;
  return recipe;
}

export type EnvRepairHint = Readonly<{
  code: string;
  recipe: RepairRecipe;
  envLine: string;
}>;

/** Parse lines like gradle=BROKEN:... or java=MISSING */
export function collectEnvRepairHints(envSnapshot: string, backend: AgentShellBackend = getBuildBackend()): EnvRepairHint[] {
  const hints: EnvRepairHint[] = [];
  const lines = (envSnapshot || "").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (/^gradle=(BROKEN|MISSING)/i.test(s)) {
      const recipe = recipeForBackend(backend === "termux" ? "gradle-pkg" : "gradle-wrapper", backend);
      if (recipe) hints.push({ code: "toolchain.gradle", recipe, envLine: s });
    } else if (/^java=(BROKEN|MISSING)/i.test(s)) {
      const recipe = recipeForBackend("java-install", backend);
      if (recipe) hints.push({ code: "toolchain.java", recipe, envLine: s });
    } else if (/^node=(BROKEN|MISSING)/i.test(s)) {
      const recipe = recipeForBackend("nodejs", backend);
      if (recipe) hints.push({ code: "toolchain.node", recipe, envLine: s });
    } else if (/^aapt2=MISSING/i.test(s)) {
      const recipe = recipeForBackend("aapt2-sdk", backend);
      if (recipe) hints.push({ code: "toolchain.android-sdk", recipe, envLine: s });
    } else if (/^git=(BROKEN|MISSING)/i.test(s) || /\bgit: not found\b/i.test(s)) {
      const recipe = recipeForBackend("git", backend);
      if (recipe) hints.push({ code: "toolchain.git", recipe, envLine: s });
    } else if (/^unzip=(BROKEN|MISSING)/i.test(s) || /\bunzip: not found\b/i.test(s)) {
      const recipe = recipeForBackend("unzip", backend);
      if (recipe) hints.push({ code: "toolchain.unzip", recipe, envLine: s });
    } else if (/^adb=(BROKEN|MISSING)/i.test(s)) {
      const recipe = recipeForBackend("android-tools", backend);
      if (recipe) hints.push({ code: "device.adb", recipe, envLine: s });
    } else if (/^proot-distro=(BROKEN|MISSING)/i.test(s) || /proot-distro.*not found/i.test(s)) {
      const recipe = recipeForBackend("proot-distro-pkg", backend);
      if (recipe) hints.push({ code: "runtime.proot", recipe, envLine: s });
    }
  }
  const seen = new Set<string>();
  return hints.filter((h) => {
    if (seen.has(h.recipe.id)) return false;
    seen.add(h.recipe.id);
    return true;
  });
}

/** From RuntimeHealth rows (id + level + message). */
export function collectHealthRepairHints(
  rows: Array<{ id: string; level: string; message?: string }>,
  backend: AgentShellBackend = getBuildBackend(),
): EnvRepairHint[] {
  const hints: EnvRepairHint[] = [];
  for (const row of rows || []) {
    if (row.level !== "error" && row.level !== "warn") continue;
    const recipeId = repair.forDiagnostic(row.id)?.id;
    const recipe = recipeId ? recipeForBackend(recipeId, backend) : undefined;
    if (!recipe) continue;
    hints.push({
      code: row.id,
      recipe,
      envLine: `${row.id}=${row.level}:${(row.message || "").slice(0, 80)}`,
    });
  }
  const seen = new Set<string>();
  return hints.filter((h) => {
    if (seen.has(h.recipe.id)) return false;
    seen.add(h.recipe.id);
    return true;
  });
}

export function formatRepairHintsBlock(hints: EnvRepairHint[]): string {
  if (!hints.length) return "";
  const lines = [
    `\n\n[DETERMINISTIC_REPAIR backend=${getBuildBackend()}] Tools flagged MISSING/BROKEN. Use ONLY these recipes (do not invent shell):`,
    `APK toolchain boundary (authoritative): ${APK_BUILD_SAFETY_POLICY}`,
  ];
  for (const h of hints) {
    lines.push(
      `- ${h.code} (${h.envLine}) → recipe=${h.recipe.id} risk=${h.recipe.risk}`,
      `  hint: ${h.recipe.termuxHint}`,
      `  title: ${h.recipe.title}`,
    );
  }
  lines.push(
    "Reply with EXACTLY one of:",
  );
  for (const h of hints) {
    const shell = (h.recipe.termuxHint || "").startsWith("AIB_INTERNAL:")
      ? `echo recipe ${h.recipe.id}`
      : h.recipe.termuxHint;
    lines.push(`  TERMUX_RUN:\n${shell}`);
  }
  lines.push(
    "Do NOT paste recipe=id or 'risk=medium' as the command — that is not bash.",
    "Never invent destructive shell. After install, re-probe ENV until OK.",
  );
  return lines.join("\n");
}

/** Soft postscript for protocol abort (model ignored TERMUX_RUN). */
export function formatProtocolAbortHint(language: "ru" | "uk" | "en" = "ru"): string {
  const m = {
    ru: "\n→ Настройки: смените модель на более сильную (не free nano), сократите задачу, Termux ON.",
    uk: "\n→ Налаштування: сильніша модель, коротше завдання, Termux ON.",
    en: "\n→ Settings: switch to a stronger model (not free nano), shorten the task, Termux ON.",
  };
  return m[language] || m.en;
}


/** Map assemble/prepare log text → ordered recipe ids (deterministic). */
export function suggestRepairFromBuildLog(log: string): string[] {
  const t = log || "";
  const out: string[] = [];
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  if (/NO_VERIFIED_GRADLE_WRAPPER|gradle-wrapper\.jar.*missing|Could not find or load main class org\.gradle\.wrapper/i.test(t)) {
    add("gradle-wrapper");
  }
  if (/Could not resolve|Could not get resource|Could not download|No cached version|Connection refused|Unknown host|Failed to download|SSLHandshake|Network is unreachable/i.test(t)) {
    add("gradle-cache");
  }
  if (/SDK location not found|sdk\.dir|ANDROID_HOME|local\.properties|SDK_MISSING|no Android platform/i.test(t)) {
    add("local-properties");
  }
  if (/aapt2|AAPT2|AAPT error|error: resource/i.test(t)) {
    add("aapt2-sdk");
  }
  if (/JAVA_HOME|java=MISSING|JAVA_MISSING|Could not determine java|invalid source release/i.test(t)) {
    add("java-install");
  }
  if (/Unable to load class|cannot find symbol|package .+ does not exist|Unresolved reference|Compilation error/i.test(t)) {
    // source/deps: try expo-deps then maven-deps then flutter-pub
    if (/node_modules|expo|react-native|package\.json/i.test(t)) add("expo-deps");
    if (/pom\.xml|\[ERROR\].*mvn|Could not resolve dependencies/i.test(t)) add("maven-deps");
    if (/pubspec|flutter|dart/i.test(t)) add("flutter-pub");
  }
  if (/pub get|pubspec\.yaml|Flutter|dart pub/i.test(t) && /error|failed|ERR/i.test(t)) {
    add("flutter-pub");
  }
  if (/node_modules|Cannot find module|expo-module|ERR!|NODE_MODULES_INSTALL_FAILED|NO_PACKAGE_JSON|NO_NPM/i.test(t) && /expo|react-native|npm|pnpm|yarn|package\.json/i.test(t)) {
    add("expo-deps");
    add("expo-cli");
  }
  if (/NODE_MODULES_INSTALL_FAILED|NO_PACKAGE_JSON/i.test(t)) {
    add("expo-deps");
  }
  if (/CAP_ANDROID_MISSING|cap add android/i.test(t)) {
    add("expo-cli");
    add("expo-deps");
  }
  if (/CORDOVA_ANDROID_MISSING|cordova platform add/i.test(t)) {
    add("expo-deps");
    add("nodejs");
  }
  if (/pom\.xml|\[ERROR\] Failed to execute goal|Could not resolve dependencies/i.test(t)) {
    add("maven-deps");
  }
  if (/NO_FLUTTER|flutter: not found|Flutter is not available/i.test(t)) {
    add("flutter-pub");
  }
  if (/NO_MAVEN|mvn: not found|Maven not found/i.test(t)) {
    add("maven-deps");
  }
  if (/NO_NDK|NO_NDK_CMAKE_TOOLCHAIN|NO_NDK_BUILD|ndk-path/i.test(t)) {
    add("ndk-path");
  }
    if (/ndk|ANDROID_NDK|ndk-build|CMake Error|cmake/i.test(t)) {
    add("ndk-path");
  }
  if (/BUILD_LOCK|STALE_BUILD_LOCK|Timeout waiting/i.test(t)) {
    add("build-lock");
  }
  if (/No space left|ENOSPC|Disk full/i.test(t)) {
    add("disk-cleanup");
  }
  return out.slice(0, 4);
}
