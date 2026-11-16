/**
 * Selftest for unified Intent Router (v65).
 * Run: node scripts/aib-intent-router-selftest.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("OK:", msg);
  }
}

const routerSrc = fs.readFileSync(
  path.join(__dirname, "../lib/intent-router.ts"),
  "utf8",
);
const agentSrc = fs.readFileSync(
  path.join(__dirname, "../lib/termux-agent.ts"),
  "utf8",
);

// Structural
assert(routerSrc.includes("export function resolveIntent"), "resolveIntent exported");
assert(routerSrc.includes("export function normalizeTask"), "normalizeTask exported");
assert(routerSrc.includes("INTENT_PLAYBOOKS"), "playbooks present");
for (const k of [
  "create_app",
  "build_from_path",
  "analyze_and_fix",
  "analyze_sources",
  "adb",
  "reverse_apk",
  "diagnose",
  "ndk_install",
  "generic",
]) {
  assert(routerSrc.includes('"' + k + '"'), "intent " + k);
}
assert(routerSrc.includes("GENERIC_PLANNER_SYSTEM"), "planner system");
assert(routerSrc.includes("PATCHER_SYSTEM"), "patcher system");
assert(routerSrc.includes("logIntentFeedback"), "feedback logger");
assert(routerSrc.includes("suggestPhrasePatternsFromFeedback"), "offline phrase patterns from feedback");
assert(routerSrc.includes("hydrateIntentFeedback"), "feedback hydrate from AsyncStorage");
assert(agentSrc.includes("extractPathSlot"), "path extract prefers extractPathSlot");
assert(agentSrc.includes("hydrateIntentFeedback"), "agent hydrates feedback");
assert(agentSrc.includes("resolveIntent(task).kind"), "isXxx prefer resolveIntent");
assert(routerSrc.includes("llmRoleForIntent"), "llm role policy");
assert(routerSrc.includes("TYPO_MAP"), "typo normalization");
assert(!/compileSdk|targetSdkVersion|minSdkVersion/i.test(routerSrc), "no compile settings touched");

assert(agentSrc.includes('from "./intent-router"'), "termux-agent imports intent-router");
assert(agentSrc.includes("resolveIntent(userTask)"), "resolveIntent called");
assert(agentSrc.includes("INTENT_ROLE"), "intent role injected");
assert(agentSrc.includes("logIntentFeedback"), "feedback logged from agent");
assert(agentSrc.includes('resolvedIntent.kind === "diagnose"'), "diagnose gated by intent");
assert(agentSrc.includes('resolvedIntent.kind === "analyze_sources"'), "analyze_sources gated by intent");
assert(agentSrc.includes('resolvedIntent.kind === "reverse_apk"'), "reverse gated by intent");
assert(agentSrc.includes('resolvedIntent.kind === "build_from_path"'), "build gated by intent");
assert(agentSrc.includes('resolvedIntent.kind === "ndk_install"'), "ndk gated by intent");
assert(agentSrc.includes('resolvedIntent.kind === "adb"'), "adb install gated by intent");
assert(agentSrc.includes("intentPath(resolvedIntent)"), "intent path used for src");

assert(agentSrc.includes("Нужен абсолютный путь"), "hard path clarification message");
assert(agentSrc.includes("intentPlaybook"), "playbook published");
assert(agentSrc.includes("intentKindToTaskPromptKind"), "task-prompt maps from intent");


function normalizeTask(raw) {
  const TYPO_MAP = [
    [/тправл?яй/gi, "исправляй"],
    [/(^|[^a-zа-яё0-9])апк(?=[^a-zа-яё0-9]|$)/gi, "$1apk"],
    [/(^|[^a-zа-яё0-9])ааб(?=[^a-zа-яё0-9]|$)/gi, "$1aab"],
    [/(^|[^a-zа-яё0-9])збери(?=[^a-zа-яё0-9]|$)/gi, "$1собери"],
    [/(^|[^a-zа-яё0-9])збудуй(?=[^a-zа-яё0-9]|$)/gi, "$1собери"],
    [/створи/gi, "создай"],
    [/виправ/gi, "исправь"],
    [/перезбери/gi, "пересобери"],
  ];
  let t = String(raw || "").trim();
  for (const [re, repl] of TYPO_MAP) t = t.replace(re, repl);
  return t.replace(/[\u00A0\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

assert(normalizeTask("тправляй апк") === "исправляй apk", "typo: тправляй + апк");
assert(normalizeTask("збери hello") === "собери hello", "synonym збери");
assert(normalizeTask("створи калькулятор") === "создай калькулятор", "synonym створи");
assert(normalizeTask("перезбери") === "пересобери", "synonym перезбери");
assert(normalizeTask("Разбери apk").startsWith("Разбери") || normalizeTask("Разбери apk").toLowerCase().startsWith("разбери"), "разбери stays (not расобери)");
assert(
  extractPathSlot("собери Download/MyApp.zip") &&
    extractPathSlot("собери Download/MyApp.zip").includes("Download/MyApp.zip"),
  "path relative Download/",
);
assert(
  extractPathSlot("поставь app-debug.apk") &&
    extractPathSlot("поставь app-debug.apk").includes("app-debug.apk"),
  "path bare apk name",
);
assert(routerSrc.includes("registerDynamicSynonym"), "dynamic synonym API");
assert(routerSrc.includes("applyFeedbackSynonymsOnce"), "feedback synonym apply");
assert(agentSrc.includes("applyFeedbackSynonymsOnce"), "agent applies feedback synonyms");
assert(routerSrc.includes("matchOfflinePhrase"), "offline phrase matcher");
assert(routerSrc.includes("OFFLINE_PHRASE_TABLE") || routerSrc.includes("OfflinePhraseRule"), "offline phrase table");
assert(routerSrc.includes("learnOfflineFromFeedback"), "learn offline from feedback");
assert(agentSrc.includes("hydrateOfflineLearned"), "agent hydrates offline table");
assert(agentSrc.includes("learnOfflineFromFeedback"), "agent learns offline rules");
assert(routerSrc.includes("export function detectAdbAction") || routerSrc.includes("detectAdbAction(task)"), "detectAdbAction unified");
assert(agentSrc.includes('action === "devices"'), "adb devices prefers intent");
assert(agentSrc.includes('action === "logcat"'), "adb logcat prefers intent");
assert(agentSrc.includes('iv === "aab"') || agentSrc.includes("resolvedIntent as { variant"), "assemble uses intent.variant");
assert(agentSrc.includes("распакуй") || agentSrc.includes("unzip"), "file_ops includes unzip");
assert(agentSrc.includes("isPrematureApkDone"), "premature DONE gate");
assert(agentSrc.includes('resolvedIntent.kind === "build_from_path"') && agentSrc.includes("requireApk"), "requireApk uses intent");
assert(agentSrc.includes("expo prebuild"), "expo prebuild path in agent");
assert(agentSrc.includes("LAST_PROJ"), "last project rebuild probe");
assert(agentSrc.includes('resolvedIntent.kind === "build_from_path"') && agentSrc.includes("LAST_PROJ"), "last proj for build intent");
assert(agentSrc.includes("NDK fast-path") || agentSrc.includes("ndk_install"), "NDK fast-path");
assert(routerSrc.includes("content://") && routerSrc.includes("inbox"), "content:// → inbox");
assert(agentSrc.includes("shouldAbort"), "user stop shouldAbort");
assert(routerSrc.includes("app\s*bundle") || routerSrc.includes("бандл"), "aab dual-aware variant");
assert(agentSrc.includes("getWeakPhoneGradleFlags"), "weak-phone gradle flags");
assert(agentSrc.includes("buildApkAssembleOfflineCmd") && agentSrc.includes("Online"), "offline then online assemble");
assert(agentSrc.includes("продолж") || agentSrc.includes("continue"), "continue refine");
assert(agentSrc.includes("AGENT_WALL_MS"), "wall-clock limit");
assert(agentSrc.includes("invalidStreak"), "invalid reply streak");
assert(agentSrc.includes("ensureAndroidToolchain"), "toolchain ensure");
assert(agentSrc.includes("prepHasProj") || agentSrc.includes("treating as success"), "prepare success without PREPARE_OK marker");
assert(agentSrc.includes("PREPARE_PROGRESS") || agentSrc.includes("exit 0"), "prepare always exits 0 on PROJ");


function extractPathSlot(task) {
  const t = task || "";
  const clean = (p) => {
    let x = p.replace(/[)\],.;:!?]+$/u, "").trim();
    if (!x) return null;
    if (/^(Download|Downloads|Загрузки)\//i.test(x)) x = "/storage/emulated/0/" + x;
    else if (/^[^/].*\.(zip|apk|aab)$/i.test(x) && !/[:\\]/.test(x)) x = "/storage/emulated/0/Download/" + x;
    return x;
  };
  const bracket = t.match(/\[FILE_PATH\]\s*([^\]]+)/i);
  if (bracket && bracket[1]) {
    const c = clean(bracket[1].trim());
    if (c) return c;
  }
  const re = /(\/(?:storage\/emulated\/0|sdcard|data\/data\/com\.termux)\/[^\s"'<>]+)/gi;
  let m;
  while ((m = re.exec(t))) {
    if (m[1]) {
      const c = clean(m[1]);
      if (c) return c;
    }
  }
  const rel = t.match(/(?:^|\s)((?:Download|Downloads|Загрузки)\/[^\s"'<>]+\.(?:zip|apk|aab))/i);
  if (rel) {
    const c = clean(rel[1]);
    if (c) return c;
  }
  const bare = t.match(/(?:^|\s)([A-Za-z0-9._\u0400-\u04FF-]+\.(?:zip|apk|aab))(?:\s|$)/i);
  if (bare) {
    const c = clean(bare[1]);
    if (c) return c;
  }
  return null;
}

function smokeKind(raw) {
  const task = normalizeTask(raw);
  const path = extractPathSlot(task);
  const lower = task.toLowerCase();
  if (/ndk/.test(lower) && /(установ|install)/i.test(task)) return "ndk_install";
  if (
    /(диагност|diagnostics?|проверь\s+sdk|проверь\s+java|check\s+sdk|check\s+java|toolchain\s+status)/i.test(task) &&
    !/(собери|создай|установи\s+apk)/i.test(task)
  )
    return "diagnose";
  if (/\badb\b|установи.{0,40}apk|install.{0,40}apk|установи\s+последн|adb\s+devices|скриншот|screenshot|список\s+пакет|pm\s+list|pair\s+\d/i.test(task)) return "adb";
  // reverse before build — "Разбери apk /path.apk"
  if (
    /(реверс|jadx|декомпил|разбер[иь].*apk|разбери\s+apk|analyze\s+apk|inspect\s+apk)/i.test(
      task,
    )
  )
    return "reverse_apk";
  // analyze+fix OR fix errors on sources
  if (
    (/(проанализ|анализ)/i.test(task) && /(исправ|почин|fix|до\s+конца)/i.test(task)) ||
    (/(исправ|fix)/i.test(task) &&
      (path || /(\.zip|архив|исходн)/i.test(task)) &&
      /ошиб|error/i.test(task))
  )
    return "analyze_and_fix";
  if (
    /(проанализ|анализ)/i.test(task) &&
    /(\.zip|исходн|архив)/i.test(task) &&
    !/(собери|создай)/i.test(task)
  )
    return "analyze_sources";
  // create: explicit OR "собери apk HelloWorld" without path/sources
  const product =
    /(hello\s*world|helloworld|калькул|calculator|таймер|приложен|app\b|\bapk\b|2048|игр)/i.test(task);
  if (
    !path &&
    !/(\.zip|\/storage\/|\/sdcard\/|исходник|из\s+архив)/i.test(task) &&
    product &&
    (/(создай|напиши|сделай|create|scaffold|сгенерируй|generate)/i.test(task) ||
      /(собери|build|assemble)/i.test(task))
  )
    return "create_app";
  if (
    /(пересобери|rebuild|продолж|continue|исправл?яй?.*сбор)/i.test(task) ||
    (/(собери|build|assemble|сборк)/i.test(task) &&
      (path || /(\.zip|gradle|проект|исходн|архив)/i.test(task)))
  )
    return "build_from_path";
  if (/(создай|напиши).{0,40}(приложен|app|калькул|apk)/i.test(task)) return "create_app";
  return "generic";
}

const cases = [
  ["создай калькулятор", "create_app"],
  ["напиши hello world приложение", "create_app"],
  ["собери /storage/emulated/0/AIBuilderTermux/Foo.zip", "build_from_path"],
  ["пересобери", "build_from_path"],
  ["проанализируй исходники в архиве /sdcard/a.zip и исправь до конца", "analyze_and_fix"],
  ["проанализируй исходники foo.zip", "analyze_sources"],
  ["реверс engineering /sdcard/app.apk", "reverse_apk"],
  ["установи apk /sdcard/app.apk", "adb"],
  ["adb devices", "adb"],
  ["диагностика среды", "diagnose"],
  ["установи ndk", "ndk_install"],
  ["какая погода завтра", "generic"],
  ["Собери мне apk HelloWorld", "create_app"],
  ["Создай apk Калькулятор", "create_app"],
  ["Собери /storage/emulated/0/Download/MyApp.zip", "build_from_path"],
  ["Собери apk из архива /sdcard/src.zip и исправь все ошибки до конца", "analyze_and_fix"],
  ["Проанализируй все исходники в архиве /storage/emulated/0/Download/code.zip", "analyze_sources"],
  ["Разбери apk /sdcard/app.apk", "reverse_apk"],
  ["тправляй сборку апк", "build_from_path"],
  ["Скопируй apk в Download", "generic"],
  ["Установи последний apk", "adb"],
  ["Скриншот экрана", "adb"],
  ["Проверь java и sdk", "diagnose"],
  ["Сгенерируй hello world на android", "create_app"],
  ["Напиши игру 2048", "create_app"],
  ["Исправь ошибки сборки в /sdcard/proj.zip до конца", "analyze_and_fix"],
  ["Реверс apk", "reverse_apk"],
  ["Пересобери release", "build_from_path"],
  ["Список пакетов на устройстве", "adb"],
  ["Собери aab /storage/emulated/0/Download/app.zip", "build_from_path"],
  ["adb pair 192.168.0.1:37123", "adb"],
  ["продолжи", "build_from_path"],
  ["continue build", "build_from_path"],
];


for (const [phrase, expected] of cases) {
  const got = smokeKind(phrase);
  assert(got === expected, 'smoke "' + phrase + '" → ' + got + " (want " + expected + ")");
}

console.log("\nIntent router selftest done. exit=" + (process.exitCode || 0));
process.exit(process.exitCode || 0);
