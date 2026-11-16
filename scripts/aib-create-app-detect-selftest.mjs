#!/usr/bin/env node
/**
 * Selftest: create-app / apk-build / aab detection + Cyrillic name guessing.
 */
const SOFT_APP_PRODUCT =
  /(игр[уаы]|утилит|виджет|программ[уаы]|таймер|timer|заметк|notes?|счётчик|счетчик|counter|трекер|tracker|чат|chat|бот|bot|клиент|reader|плеер|player|конвертер|converter|переводчик|flashlight|фонарик|погод|weather|калькул|todo|список\s+дел)/i;

function isStrongCreateAppTask(task) {
  const m = (task || "").toLowerCase();
  if (/CREATE_APP_PIPELINE/i.test(task)) return true;
  const create =
    /(создай|создать|создадим|создайте|создал|создам|сгенерируй|зроби|створи|напиши|сделай|разработай|\bgenerate\b|\bcreate\b|\bscaffold\b|\bmake\b|\bdevelop\b|new\s+app)/i.test(
      m,
    );
  const buildAsCreate =
    !create &&
    /(собери|збери|собрать|build|compile|assemble)/i.test(m) &&
    !/(\.zip|\/storage\/|\/sdcard\/|gradlew|из\s+исход|с\s+исход|исходник|from\s+source|from\s+sources)/i.test(m) &&
    (SOFT_APP_PRODUCT.test(m) ||
      /(hello\s*world|хело|helloworld|калькул|\bcalculator\b|\btodo\b|игр[аыу]|\b2048\b|мини.?app|mini.?app)/i.test(m));
  if (!create && !buildAsCreate) return false;
  if (buildAsCreate) return true;
  const app =
    /(приложен|додат(ок|ка)|\bapps?\b|\bapplication\b|\bprojects?\b|про[еє]кт|\bapk\b|\bandroid\b|калькул|конкул|\bcalculator\b|\bcalc\b|\btodo\b|\bgames?\b|игр[аыу]|\b2048\b|\btictactoe\b|\bsnake\b|hello\s*world|хело|helloworld|мини.?app|mini.?app)/i.test(
      m,
    );
  if (app) return true;
  if (SOFT_APP_PRODUCT.test(m)) return true;
  if (/(на|под|for)\s+android|\bmobile\b/i.test(m)) return true;
  if (m.length >= 24 && /(экран|кнопк|activity|layout|material|ui\b)/i.test(m)) return true;
  return false;
}

function guessAppNameStrong(task) {
  const m = task.match(
    /(?:^|[^\p{L}\p{N}_])(калькулятор|конкулятор|calculator|2048|todo|snake|tictactoe|game|hello\s*world|хело\s*ворд|helloworld|hello|мини.?app|mini.?app|тест(?:овое)?\s*app|test\s*app|таймер|timer|заметк\w*|notes?|трекер|tracker)(?=$|[^\p{L}\p{N}_])/iu,
  );
  if (m) {
    const x = m[1].toLowerCase().replace(/\s+/g, "");
    if (x.includes("кальк") || x.includes("конкул") || x === "calculator") return "Calculator";
    if (x === "2048") return "Game2048";
    if (x.includes("hello") || x.includes("хело")) return "HelloWorld";
    if (x.includes("todo")) return "TodoApp";
    if (x.includes("snake")) return "Snake";
    if (x.includes("tictactoe")) return "TicTacToe";
    if (/тест|test/.test(x)) return "TestApp";
    if (/мини|mini/.test(x)) return "MiniApp";
    if (/таймер|timer/.test(x)) return "Timer";
    if (/заметк|note/.test(x)) return "Notes";
    if (/трекер|tracker/.test(x)) return "Tracker";
    return x.charAt(0).toUpperCase() + x.slice(1).replace(/[^a-zA-Z0-9]/g, "");
  }
  return "MiniApp";
}

function isApkOrAppBuildTask(task) {
  if (isStrongCreateAppTask(task)) return true;
  const s = task || "";
  return /(?:^|[^\p{L}\p{N}_])(apk|апк|aab|gradlew|assemble(?:Debug|Release)?|bundleRelease|android\s*(?:app|project)|app\s*bundle|созда(?:й|ть|дим|йте).{0,40}(?:apk|aab|приложен|игр)|зроб[иі].{0,40}(?:apk|aab|додаток|гр)|build\s*(?:apk|aab|app|release)|make\s*(?:apk|aab|app)|игра|game|2048|калькулятор|calculator|hello\s*world|хело\s*ворд|релиз)(?=$|[^\p{L}\p{N}_])/iu.test(
    s,
  );
}

function extractProjectPathFromTask(task) {
  const t = task || "";
  const clean = (p) => {
    let x = p.replace(/[)\],.]+$/, "").trim();
    if (/content:\/\//i.test(x)) return null;
    if (/\/app\/build\/outputs\/apk\//i.test(x) && !/\.zip$/i.test(x)) return null;
    if (/^(?:Download|Downloads|Загрузки|Documents|Документы)\//i.test(x)) {
      x = "/storage/emulated/0/" + x;
    } else if (/^[^/].*\.zip$/i.test(x) && !/[:\\]/.test(x)) {
      x = "/storage/emulated/0/Download/" + x;
    }
    return x;
  };
  const quoted =
    t.match(/["'](\/(?:storage|data|sdcard)\/[^"']+\.zip)["']/i) ||
    t.match(/["'](\/(?:storage|data|sdcard)\/[^"']+)["']/i) ||
    t.match(/["']((?:Download|Downloads|Загрузки)\/[^"']+\.zip)["']/i);
  if (quoted) { const c = clean(quoted[1]); if (c) return c; }
  const fromZip = t.match(/(?:из|from)\s+(\/(?:storage|data|sdcard)\/[^\s"'`<>]+(?:\s+[^\s"'`<>]+)*?\.zip)/i);
  if (fromZip) { const c = clean(fromZip[1]); if (c) return c; }
  const fromRelZip = t.match(/(?:из|from)\s+((?:~\/)?(?:Download|Downloads|Загрузки)\/[^\s"'`<>]+(?:\s+[^\s"'`<>]+)*?\.zip)/i);
  if (fromRelZip) { const c = clean(fromRelZip[1]); if (c) return c; }
  const anyZip = t.match(/(\/(?:storage|data|sdcard)\/[^\s"'`<>]+(?:\s+[^\s"'`<>]+)*?\.zip)/i);
  if (anyZip) { const c = clean(anyZip[1]); if (c) return c; }
  const fromDir = t.match(/(?:из|from)\s+(\/(?:storage|data|sdcard)\/[^\s"'`<>]+(?:\s+[^\s"'`<>]+)*)(?:\s*$|[.,;!]|\s+(?:и|and)\s)/i);
  if (fromDir) { const c = clean(fromDir[1]); if (c) return c; }
  const bare = t.match(/(\/(?:storage|data|sdcard)\/[^\s"'`<>]+)/i);
  if (bare) {
    const c = clean(bare[1]);
    if (c && (c.endsWith(".zip") || c.startsWith("/storage/") || c.startsWith("/sdcard/") || c.startsWith("/data/"))) return c;
  }
  return null;
}

const cases = [
  { t: "Собери мне апк хело ворд", strong: true, name: "HelloWorld", apkOr: true },
  { t: "Собери мне apk hello world", strong: true, name: "HelloWorld", apkOr: true },
  { t: "создай приложение калькулятор", strong: true, name: "Calculator", apkOr: true },
  { t: "build calculator apk", strong: true, name: "Calculator", apkOr: true },
  { t: "Собери мне апк с исходников в архиве /storage/emulated/0/Download/MyApp.zip", strong: false, path: "/storage/emulated/0/Download/MyApp.zip", apkOr: true },
  { t: "Собери мне апк с исходников проекта по пути /storage/emulated/0/AIBuilderTermux/Calc", strong: false, path: "/storage/emulated/0/AIBuilderTermux/Calc", apkOr: true },
  { t: "собери aab из /storage/emulated/0/AIBuilderTermux/Calc", strong: false, path: "/storage/emulated/0/AIBuilderTermux/Calc", apkOr: true },
  { t: "bundleRelease", strong: false, apkOr: true },
  { t: "assembleRelease", strong: false, apkOr: true },
  { t: "что такое android?", strong: false, apkOr: false },
  { t: "сделай таймер", strong: true, name: "Timer", apkOr: true },
  { t: "собери apk из Download/foo bar.zip", strong: false, path: "/storage/emulated/0/Download/foo bar.zip", apkOr: true },
];

let failed = 0;
for (const c of cases) {
  const s = isStrongCreateAppTask(c.t);
  const n = guessAppNameStrong(c.t);
  const a = isApkOrAppBuildTask(c.t);
  const p = extractProjectPathFromTask(c.t);
  if (s !== c.strong) { console.error("STRONG_MISMATCH", c.t, s, c.strong); failed++; }
  if (c.name != null && n !== c.name) { console.error("NAME_MISMATCH", c.t, n, c.name); failed++; }
  if (c.apkOr != null && a !== c.apkOr) { console.error("APKOR_MISMATCH", c.t, a, c.apkOr); failed++; }
  if (c.path != null && p !== c.path) { console.error("PATH_MISMATCH", c.t, p, c.path); failed++; }
}
if (failed) {
  console.error("AIB_CREATE_APP_DETECT_SELFTEST_FAIL count=" + failed);
  process.exit(1);
}
console.log("AIB_CREATE_APP_DETECT_SELFTEST_OK cases=" + cases.length);

// --- hasVerifiedApkPath (mirrors lib/termux-agent.ts) ---
function hasVerifiedApkPath(msg) {
  return /(?:^|[\s"'`=])(\/(?:storage|data|sdcard)[^"'`\n]*?\.(?:apk|aab))(?=$|[\s"'`,;!?)])/i.test(msg) ||
    /(?:^|[\s"'`=])(\/[\w./+\- ]+\.(?:apk|aab))(?=$|[\s"'`,;!?)])/i.test(msg) ||
    /(?:^|[\s"'`=])(\$HOME\/[^"'`\n]+\.(?:apk|aab))(?=$|[\s"'`,;!?)])/i.test(msg) ||
    /(?:^|[\s"'`=])(\$PREFIX\/[^"'`\n]+\.(?:apk|aab))(?=$|[\s"'`,;!?)])/i.test(msg) ||
    /APK_PATH=([^\n]+?\.(?:apk|aab))/i.test(msg) ||
    /AIB_DETERMINISTIC_APK=([^\n]+?\.(?:apk|aab))/i.test(msg) ||
    /AAB_OK=([^\n]+?\.aab)/i.test(msg);
}
const pathCases = [
  ["APK_PATH=/storage/emulated/0/x/app-debug.apk", true],
  ["DONE /storage/emulated/0/Download/My App/app-debug.apk", true],
  ["AIB_DETERMINISTIC_APK=/storage/emulated/0/Hello World/app.apk", true],
  ["AAB_OK=/storage/emulated/0/x/app-release.aab", true],
  ["check app/build/outputs/apk/", false],
  ["BUILD SUCCESSFUL", false],
];
for (const [m, want] of pathCases) {
  const got = hasVerifiedApkPath(m);
  if (got !== want) {
    console.error("PATH_VERIFY_MISMATCH", m, got, want);
    process.exit(1);
  }
}
console.log("AIB_APK_PATH_VERIFY_OK cases=" + pathCases.length);
