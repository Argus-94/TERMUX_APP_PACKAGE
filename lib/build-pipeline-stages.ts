/**
 * Full build/create pipeline stages for the upper progress indicator.
 * Irrelevant steps stay visible but marked "skipped" (like CI UIs).
 */
import type { BuildStage, BuildStageStatus } from "../components/TermuxContext";

export type PipelineKind = "create_app" | "build_source" | "reverse" | "generic";

const L = {
  ru: {
    plan: "Планирование задачи",
    writeCode: "Написание кода проекта",
    writeManifest: "Манифест и ресурсы",
    env: "Проверка окружения (Java / SDK)",
    installTools: "Установка недостающих инструментов",
    flutter: "Настройка Flutter",
    node: "Node.js / зависимости (npm/pnpm)",
    expoPrebuild: "Expo prebuild (Android)",
    sdk: "Android SDK / build-tools",
    licenses: "Лицензии Android SDK",
    ndk: "NDK (если нужен)",
    wrapper: "Gradle wrapper",
    cacheGradle: "Кэш Gradle",
    compile: "Сборка assembleDebug",
    findApk: "Поиск APK",
    sign: "Подпись APK (v1+v2+v3)",
    verify: "Проверка подписи",
    done: "Готово",
  },
  uk: {
    plan: "Планування задачі",
    writeCode: "Написання коду проєкту",
    writeManifest: "Маніфест і ресурси",
    env: "Перевірка середовища (Java / SDK)",
    installTools: "Встановлення відсутніх інструментів",
    flutter: "Налаштування Flutter",
    node: "Node.js / залежності (npm/pnpm)",
    expoPrebuild: "Expo prebuild (Android)",
    sdk: "Android SDK / build-tools",
    licenses: "Ліцензії Android SDK",
    ndk: "NDK (якщо потрібен)",
    wrapper: "Gradle wrapper",
    cacheGradle: "Кеш Gradle",
    compile: "Збірка assembleDebug",
    findApk: "Пошук APK",
    sign: "Підпис APK (v1+v2+v3)",
    verify: "Перевірка підпису",
    done: "Готово",
  },
  en: {
    plan: "Plan task",
    writeCode: "Write project code",
    writeManifest: "Manifest and resources",
    env: "Check environment (Java / SDK)",
    installTools: "Install missing tools",
    flutter: "Set up Flutter",
    node: "Node.js / dependencies (npm/pnpm)",
    expoPrebuild: "Expo prebuild (Android)",
    sdk: "Android SDK / build-tools",
    licenses: "Accept Android licenses",
    ndk: "NDK (if required)",
    wrapper: "Gradle wrapper",
    cacheGradle: "Cache Gradle packages",
    compile: "assembleDebug",
    findApk: "Find APK",
    sign: "Sign APK (v1+v2+v3)",
    verify: "Verify signature",
    done: "Done",
  },
} as const;

type Lang = keyof typeof L;
type Key = keyof typeof L["ru"];

function t(lang: string | undefined, key: Key): string {
  const pack = L[(lang as Lang) || "ru"] || L.ru;
  return pack[key] || L.ru[key];
}

function stage(id: string, label: string, status: BuildStageStatus = "pending"): BuildStage {
  return { id, label, status };
}

/** Create-from-scratch APK (calculator, game, etc.). */
export function createAppPipelineStages(lang?: string): BuildStage[] {
  return [
    stage("plan", t(lang, "plan")),
    stage("writeCode", t(lang, "writeCode")),
    stage("writeManifest", t(lang, "writeManifest")),
    stage("env", t(lang, "env")),
    stage("installTools", t(lang, "installTools")),
    stage("flutter", t(lang, "flutter"), "skipped"),
    stage("node", t(lang, "node"), "skipped"),
    stage("expoPrebuild", t(lang, "expoPrebuild"), "skipped"),
    stage("sdk", t(lang, "sdk")),
    stage("licenses", t(lang, "licenses"), "skipped"),
    stage("ndk", t(lang, "ndk"), "skipped"),
    stage("wrapper", t(lang, "wrapper")),
    stage("cacheGradle", t(lang, "cacheGradle"), "skipped"),
    stage("compile", t(lang, "compile")),
    stage("findApk", t(lang, "findApk")),
    stage("sign", t(lang, "sign")),
    stage("verify", t(lang, "verify")),
    stage("done", t(lang, "done")),
  ];
}

/** Build APK from existing sources (folder/zip, Expo/RN/native). */
export function buildSourcePipelineStages(lang?: string, hints?: { flutter?: boolean; expo?: boolean; native?: boolean }): BuildStage[] {
  const flutter = !!hints?.flutter;
  const expo = !!hints?.expo;
  const native = !!hints?.native || (!flutter && !expo);
  return [
    stage("plan", t(lang, "plan")),
    stage("writeCode", t(lang, "writeCode"), "skipped"), // sources already exist
    stage("writeManifest", t(lang, "writeManifest"), "skipped"),
    stage("env", t(lang, "env")),
    stage("installTools", t(lang, "installTools")),
    stage("flutter", t(lang, "flutter"), flutter ? "pending" : "skipped"),
    stage("node", t(lang, "node"), expo || !native ? "pending" : "skipped"),
    stage("expoPrebuild", t(lang, "expoPrebuild"), expo ? "pending" : "skipped"),
    stage("sdk", t(lang, "sdk")),
    stage("licenses", t(lang, "licenses")),
    stage("ndk", t(lang, "ndk"), "pending"),
    stage("wrapper", t(lang, "wrapper")),
    stage("cacheGradle", t(lang, "cacheGradle")),
    stage("compile", t(lang, "compile")),
    stage("findApk", t(lang, "findApk")),
    stage("sign", t(lang, "sign")),
    stage("verify", t(lang, "verify")),
    stage("done", t(lang, "done")),
  ];
}

export function genericAgentStages(lang?: string): BuildStage[] {
  return [
    stage("plan", t(lang, "plan")),
    stage("env", t(lang, "env")),
    stage("installTools", t(lang, "installTools")),
    stage("compile", t(lang, "compile")),
    stage("done", t(lang, "done")),
  ];
}

/** Map shell command / activity detail to the active stage id. */
export function inferStageIdFromCommand(cmd: string): string | null {
  const c = (cmd || "").toLowerCase();
  if (!c.trim()) return null;
  if (/CREATE_APP_PIPELINE|план|plan task/i.test(c)) return "plan";
  if (/cat\s*>|heredoc|<<\s*'|mkdir.*aibuildertermux|mainactivity|build\.gradle/i.test(c) && !/gradlew|assemble/i.test(c)) {
    if (/androidmanifest|strings\.xml|activity_main|res\//i.test(c)) return "writeManifest";
    return "writeCode";
  }
  if (/pkg\s+install|apt\s+install|sdkmanager|ndk/i.test(c)) return "installTools";
  if (/flutter/i.test(c)) return "flutter";
  if (/npm\s|pnpm\s|yarn\s|node\s+.*expo/i.test(c)) return "node";
  if (/expo\s+prebuild|prebuild\s+--platform/i.test(c)) return "expoPrebuild";
  if (/sdkmanager|android-sdk|build-tools|platforms\/android/i.test(c) && !/assemble/i.test(c)) return "sdk";
  if (/licenses|sdkmanager\s+--licenses/i.test(c)) return "licenses";
  if (/\bndk\b|ndk-build|ANDROID_NDK/i.test(c)) return "ndk";
  if (/gradle-wrapper|gradlew\s+wrapper|NO_WRAPPER/i.test(c)) return "wrapper";
  if (/gradle.*--offline|GRADLE_USER_HOME|cache/i.test(c) && !/assemble/i.test(c)) return "cacheGradle";
  if (/assembledebug|assemblerelease|gradlew|gradle\s+assemble/i.test(c)) return "compile";
  if (/find\s+.*\.apk|outputs\/apk|AIB_DETERMINISTIC_APK/i.test(c)) return "findApk";
  if (/apksigner|jarsigner|zipalign|keytool/i.test(c)) return "sign";
  if (/apksigner\s+verify|verify\s+-v/i.test(c)) return "verify";
  if (/java\s+-version|command\s+-v\s+java|uname\s+-m|ENV probe/i.test(c)) return "env";
  if (/TERMUX_DONE|готово|build complete/i.test(c)) return "done";
  return null;
}

/**
 * Advance pipeline: mark target active, previous pending→done (skip skipped), keep skipped.
 */
export function advancePipelineStages(
  stages: BuildStage[],
  activeId: string | null,
  opts?: { forceDoneIds?: string[]; errorId?: string },
): BuildStage[] {
  if (!stages.length) return stages;
  const ids = stages.map((s) => s.id);
  const activeIdx = activeId ? ids.indexOf(activeId) : -1;
  const forceDone = new Set(opts?.forceDoneIds || []);
  const errorId = opts?.errorId;

  return stages.map((s, i) => {
    if (s.status === "skipped") return s;
    if (errorId && s.id === errorId) return { ...s, status: "error" as const };
    if (forceDone.has(s.id)) return { ...s, status: "done" as const, detail: s.detail };
    if (activeIdx < 0) return s;
    if (i < activeIdx) {
      // mark earlier non-skipped as done
      return { ...s, status: "done" as const };
    }
    if (i === activeIdx) return { ...s, status: "active" as const };
    // later: keep pending (or done if already)
    if (s.status === "done") return s;
    return { ...s, status: "pending" as const };
  });
}

export function markStageDetail(stages: BuildStage[], id: string, detail: string): BuildStage[] {
  return stages.map((s) => (s.id === id ? { ...s, detail } : s));
}

export function countActivePipeline(stages: BuildStage[]): { done: number; total: number; current?: BuildStage } {
  const visible = stages.filter((s) => s.status !== "skipped");
  const done = visible.filter((s) => s.status === "done").length;
  const current = stages.find((s) => s.status === "active") || stages.find((s) => s.status === "error");
  return { done, total: visible.length || stages.length, current };
}
