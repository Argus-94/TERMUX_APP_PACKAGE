/**
 * Unified Intent Router (v64).
 *
 * Replaces scattered isXxxTask + regex chains with:
 *   1) normalizeTask (typos / synonyms / path extraction)
 *   2) resolveIntent → typed Intent + slots
 *   3) playbook stages (model does NOT choose the pipeline)
 *   4) LLM only for generic / patch / name / explain
 *
 * Does NOT touch Gradle / Expo / compile settings.
 */

import { isStrongCreateAppTask, guessAppNameStrong } from "./agent-engine";
import { persistAsyncStorageItem } from "./persistence";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ─── Intent contract ─────────────────────────────────────────────────────────

export type AdbAction =
  | "install"
  | "devices"
  | "pair"
  | "connect"
  | "logcat"
  | "list_packages"
  | "screenshot"
  | "other";

export type BuildVariant = "debug" | "release" | "aab";

export type Intent =
  | { kind: "create_app"; name?: string; needsClarification?: false }
  | {
      kind: "build_from_path";
      path: string;
      variant: BuildVariant;
      needsClarification?: false;
    }
  | {
      kind: "build_from_path";
      path?: undefined;
      variant: BuildVariant;
      needsClarification: true;
      missing: ("path")[];
    }
  | {
      kind: "analyze_sources";
      path?: string;
      needsClarification?: boolean;
      missing?: ("path")[];
    }
  | {
      kind: "analyze_and_fix";
      path?: string;
      until: "apk" | "report";
      needsClarification?: boolean;
      missing?: ("path")[];
    }
  | {
      kind: "adb";
      action: AdbAction;
      target?: string;
      needsClarification?: boolean;
      missing?: string[];
    }
  | { kind: "diagnose"; needsClarification?: false }
  | {
      kind: "reverse_apk";
      path?: string;
      needsClarification?: boolean;
      missing?: ("path")[];
    }
  | { kind: "ndk_install"; needsClarification?: false }
  | { kind: "generic"; needsClarification?: false };

export type IntentKind = Intent["kind"];

// ─── Normalization ───────────────────────────────────────────────────────────

const TYPO_MAP: Array<[RegExp, string]> = [
  [/тправл?яй/gi, "исправляй"],
  [/исправл?яй/gi, "исправляй"],
  // JS \b is ASCII-only — use open Cyrillic boundaries
  [/(^|[^a-zа-яё0-9])апк(?=[^a-zа-яё0-9]|$)/gi, "$1apk"],
  [/(^|[^a-zа-яё0-9])ааб(?=[^a-zа-яё0-9]|$)/gi, "$1aab"],
  [/(^|[^a-zа-яё0-9])збери(?=[^a-zа-яё0-9]|$)/gi, "$1собери"],
  [/(^|[^a-zа-яё0-9])збудуй(?=[^a-zа-яё0-9]|$)/gi, "$1собери"],
  [/зроби\s+мені/gi, "сделай мне"],
  [/створи/gi, "создай"],
  [/розібр[иі]/gi, "разбери"],
  [/проаналізуй/gi, "проанализируй"],
  [/виправ/gi, "исправь"],
  [/перезбери/gi, "пересобери"],
  [/перезбудуй/gi, "пересобери"],
  [/скл[ао]ди/gi, "собери"],
  [/gradlew?/gi, "gradlew"],
];

const SYNONYM_BUILD =
  /(собери|собрать|собрал|\bbuild\b|\bcompile\b|\bassemble\b|\bassemble(?:debug|release)\b|збери|збудуй|пересобери|\brebuild\b|\bre-?build\b)/i;
const SYNONYM_CREATE =
  /(создай|создать|создадим|создайте|сгенерируй|напиши|сделай|разработай|створи|зроби|generate|create|scaffold|make|develop)/i;
const SYNONYM_ANALYZE =
  /(проанализ|анализ|разбер|посмотри|изучи|inspect|analyze|review|обзор|розібр)/i;
const SYNONYM_FIX =
  /(исправ|почин|fix|устран|виправ|до\s+конца|пока\s+не|все\s+ошиб|all\s+errors)/i;

/** Runtime synonym table (phrase → canonical fragment). Filled from feedback offline. */
const DYNAMIC_SYNONYMS: Array<{ from: RegExp; to: string }> = [];

const TRANSLIT_VERBS: Array<[RegExp, string]> = [
  [/\bsozday\b/gi, "создай"],
  [/\bsdelai\b/gi, "сделай"],
  [/\bnapishi\b/gi, "напиши"],
  [/\bsoberi\b/gi, "собери"],
  [/\bproanaliziruy\b/gi, "проанализируй"],
  [/\bispravi\b/gi, "исправь"],
  [/\bprover(?:i)?\b/gi, "проверь"],
  [/\bustanovi\b/gi, "установи"],
  [/\bdekompiliruy\b/gi, "декомпилируй"],
  [/\bpodklyuchis\b/gi, "подключись"],
  [/\brozberi\b/gi, "разбери"],
  [/\bprodolzhi\b/gi, "продолжи"],
];

/** Normalize common transliterated verbs only in request prose, never in a path. */
function normalizeTransliteratedVerbs(raw: string): string {
  const match = raw.match(/(?:^|\s)["']?(?:\/|~\/)[A-Za-z0-9._~-]/);
  const leadingSpace = match ? (match[0].match(/^\s*/) || [""])[0].length : 0;
  const pathStart = match ? match.index! + leadingSpace : raw.length;
  let prose = raw.slice(0, pathStart);
  for (const [from, to] of TRANSLIT_VERBS) prose = prose.replace(from, to);
  return prose + raw.slice(pathStart);
}

/**
 * Register extra synonym (e.g. after reviewing suggestPhrasePatternsFromFeedback).
 * Safe no-op if pattern is empty. Does not touch compile settings.
 */
export function registerDynamicSynonym(fromPhrase: string, toPhrase: string): void {
  const from = String(fromPhrase || "").trim();
  const to = String(toPhrase || "").trim();
  if (from.length < 2 || !to) return;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  DYNAMIC_SYNONYMS.push({ from: new RegExp(escaped, "gi"), to });
}

/**
 * Apply top feedback patterns as soft synonyms when user repeatedly hits generic/fail
 * with a near-identical phrase. Maps known product verbs only — never invents paths.
 */
export function applyFeedbackSynonymsOnce(): number {
  const top = suggestPhrasePatternsFromFeedback(10);
  let added = 0;
  for (const { pattern, count } of top) {
    if (count < 2) continue;
    // Only register if phrase looks like a build/create miss that we can alias
    if (/(сбор|build|созда|create|пересоб|rebuild)/i.test(pattern) && !DYNAMIC_SYNONYMS.some((s) => s.from.source === pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) {
      // Soft: ensure "пересбор" family maps to "пересобери"
      if (/пересоб/i.test(pattern)) {
        registerDynamicSynonym(pattern.slice(0, 40), "пересобери");
        added++;
      }
    }
  }
  return added;
}

/**
 * One-pass normalization: typos → canonical forms, collapse whitespace.
 * Does not invent meaning — only stabilizes regex matching downstream.
 */
export function normalizeTask(raw: string): string {
  let t = String(raw || "").trim();
  if (!t) return "";
  t = normalizeTransliteratedVerbs(t);
  for (const [re, repl] of TYPO_MAP) {
    t = t.replace(re, repl);
  }
  for (const { from, to } of DYNAMIC_SYNONYMS) {
    t = t.replace(from, to);
  }
  // Collapse repeated spaces / newlines that break path extraction
  t = t.replace(/[\u00A0\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return t;
}

// ─── Path / slot extractors ──────────────────────────────────────────────────

function isPlaceholderPath(p: string): boolean {
  return /[<>]|\bName\b|\bPROJECT\b|\bpath\b/i.test(p) && /<|>|\bName\b/i.test(p);
}

/**
 * Extract absolute or relative project/zip/apk path from the phrase.
 * Parity with legacy extractProjectPathFromTask: [FILE_PATH], content://,
 * file://, quotes, /storage|/sdcard, relative Download/Загрузки, bare *.zip.
 */
export function extractPathSlot(task: string): string | null {
  const t = task || "";

  const clean = (p: string): string | null => {
    let x = p
      .replace(/[)\],.;:!?]+$/u, "")
      .replace(/\s+(путь|path|и|and|исправь|fix|errors)$/i, "")
      .trim();
    if (!x || isPlaceholderPath(x)) return null;
    if (/^file:\/\//i.test(x)) {
      x = x.replace(/^file:\/\//i, "");
      try {
        x = decodeURIComponent(x);
      } catch {
        /* keep */
      }
    }
    if (/^content:\/\//i.test(x)) {
      let name = "";
      try {
        const q = x.match(/[?&](?:displayName|name|fileName|title)=([^&]+)/i);
        if (q) name = decodeURIComponent(q[1]);
      } catch {
        /* ignore */
      }
      if (!name) {
        // SAF often encodes path as ...%2FMyApp.zip or last segment after /
        const decoded = (() => {
          try {
            return decodeURIComponent(x);
          } catch {
            return x;
          }
        })();
        const fromSeg =
          decoded.match(/([^\/\?&#]+\.(?:zip|apk|aab))(?:[\?&#]|$)/i) ||
          x.match(/([^\/%]+\.(?:zip|apk|aab))/i);
        if (fromSeg) {
          try {
            name = decodeURIComponent(fromSeg[1].replace(/\+/g, " "));
          } catch {
            name = fromSeg[1];
          }
        }
      }
      if (name && /\.(zip|apk|aab)$/i.test(name)) {
        name = name.replace(/[^A-Za-z0-9._\u0400-\u04FF -]+/g, "_").trim();
        return "/storage/emulated/0/AIBuilderTermux/inbox/" + name;
      }
      return null;
    }
    if (/\/app\/build\/outputs\/apk\//i.test(x) && !/\.zip$/i.test(x)) return null;
    if (/^~\//.test(x)) {
      x = "/storage/emulated/0/" + x.slice(2);
    } else if (
      /^(Download|Downloads|DCIM|Documents|Загрузки|Завантаження|Документы|Документи)\//i.test(x)
    ) {
      x = "/storage/emulated/0/" + x;
    } else if (/^[^/].*\.(zip|apk|aab)$/i.test(x) && !/[:\\]/.test(x)) {
      x = "/storage/emulated/0/Download/" + x;
    }
    return x;
  };

  // content://
  const contentUri = t.match(/(content:\/\/[^\s"'`<>]+)/i);
  if (contentUri) {
    const c = clean(contentUri[1]);
    if (c) return c;
  }

  // [FILE_PATH]
  const filePathMark = t.match(
    /\[FILE_PATH\]\s*(\/(?:storage|data|sdcard)\/[^\n"'`<>]+)/i,
  );
  if (filePathMark) {
    const c = clean(filePathMark[1].replace(/\s+$/, "").trim());
    if (c) return c;
  }
  const bracket = t.match(/\[FILE_PATH\]\s*([^\]]+)/i);
  if (bracket?.[1]) {
    const c = clean(bracket[1].trim());
    if (c) return c;
  }

  // Quoted
  const quoted =
    t.match(/["'](\/(?:storage|data|sdcard)\/[^"']+\.(?:zip|apk|aab))["']/i) ||
    t.match(/["'](\/(?:storage|data|sdcard)\/[^"']+)["']/i) ||
    t.match(
      /["']((?:Download|Downloads|Загрузки|Завантаження|Documents|Документы)\/[^"']+\.(?:zip|apk|aab))["']/i,
    ) ||
    t.match(/["'](~\/[^"']+)["']/i) ||
    t.match(/["'«]([^"'»]+?\.(?:zip|apk|aab))["'»]/i);
  if (quoted) {
    const c = clean(quoted[1]);
    if (c) return c;
  }

  // Absolute storage / sdcard / termux (allow limited spaces in path segment).
  // Prefer archive/project files over workspace roots (e.g. AIBuilderTermux/).
  const absRe =
    /(\/(?:storage\/emulated\/0|storage|sdcard|data\/data\/com\.termux)\/[^\s"'<>]+(?:\s+[^\s"'<>]+)*)/gi;
  {
    const absHits: string[] = [];
    for (const m of t.matchAll(absRe)) {
      if (m[1]) {
        const c = clean(m[1]);
        if (c) absHits.push(c);
      }
    }
    const prefer = absHits.find((c) => /\.(zip|apk|aab)$/i.test(c))
      || absHits.find((c) => !/\/AIBuilderTermux\/?$/i.test(c) && !/\/AIBuilderTermux\/\.aibuilder(\/|$)/i.test(c));
    if (prefer) return prefer;
    if (absHits[0]) return absHits[0];
  }

  // file://
  for (const m of t.matchAll(/file:\/\/([^\s"'<>]+)/gi)) {
    const c = clean("file://" + m[1]);
    if (c) return c;
  }

  // Relative Download/…/file.zip without quotes
  const rel = t.match(
    /(?:^|\s)((?:Download|Downloads|Загрузки|Завантаження|Documents|Документы)\/[^\s"'<>]+\.(?:zip|apk|aab))/i,
  );
  if (rel) {
    const c = clean(rel[1]);
    if (c) return c;
  }

  // Bare filename.zip / app.apk
  const bare = t.match(/(?:^|\s)([A-Za-z0-9._\u0400-\u04FF-]+\.(?:zip|apk|aab))(?:\s|$)/i);
  if (bare) {
    const c = clean(bare[1]);
    if (c) return c;
  }

  return null;
}

function detectVariant(task: string): BuildVariant {
  const t = (task || "").toLowerCase();
  // "собери apk и aab" → aab primary (more specific artifact)
  if (/\b(aab|bundleRelease|bundle\s*release|\.aab|app\s*bundle|бандл)\b/i.test(t)) return "aab";
  if (/\b(release|релиз|assembleRelease)\b/i.test(t)) return "release";
  return "debug";
}

// ─── Offline phrase-table classifier (no ML) ─────────────────────────────────
// Plan item #5: if generic is still large %, match short phrase templates → Intent.
// Static seeds + runtime rows learned from feedback (learnOfflineFromFeedback).

export type OfflinePhraseRule = {
  /** Substring or simple regex source (case-insensitive) */
  pattern: string;
  kind: Exclude<IntentKind, "generic">;
  /** If true, pattern is treated as RegExp source */
  regex?: boolean;
};

const OFFLINE_PHRASE_TABLE: OfflinePhraseRule[] = [
  // create
  { pattern: "hello world", kind: "create_app" },
  { pattern: "хело ворд", kind: "create_app" },
  { pattern: "helloworld", kind: "create_app" },
  { pattern: "калькулятор", kind: "create_app" },
  { pattern: "calculator", kind: "create_app" },
  { pattern: "сделай мне приложение", kind: "create_app" },
  { pattern: "напиши приложение", kind: "create_app" },
  { pattern: "сгенерируй", kind: "create_app" },
  { pattern: "generate", kind: "create_app" },
  { pattern: "игру 2048", kind: "create_app" },
  { pattern: "таймер", kind: "create_app" },
  { pattern: "hello world", kind: "create_app" },
  { pattern: "helloworld", kind: "create_app" },
  // build / rebuild — NOT bare "собери apk" (steals create "Собери apk HelloWorld")
  { pattern: "пересобери", kind: "build_from_path" },
  { pattern: "продолжи", kind: "build_from_path" },
  { pattern: "continue", kind: "build_from_path" },
  { pattern: "продолжи сборку", kind: "build_from_path" },
  { pattern: "rebuild", kind: "build_from_path" },
  { pattern: "assembledebug", kind: "build_from_path" },
  { pattern: "assemblerelease", kind: "build_from_path" },
  { pattern: "assemble release", kind: "build_from_path" },
  { pattern: "из архива", kind: "build_from_path" },
  { pattern: "с исходников", kind: "build_from_path" },
  // analyze
  { pattern: "анализ исход", kind: "analyze_sources" },
  { pattern: "проанализируй исход", kind: "analyze_sources" },
  { pattern: "исправь до конца", kind: "analyze_and_fix" },
  { pattern: "fix all errors", kind: "analyze_and_fix" },
  // reverse / adb / diagnose / ndk
  { pattern: "реверс apk", kind: "reverse_apk" },
  { pattern: "разбери apk", kind: "reverse_apk" },
  { pattern: "decompile", kind: "reverse_apk" },
  { pattern: "jadx", kind: "reverse_apk" },
  { pattern: "установи apk", kind: "adb" },
  { pattern: "install apk", kind: "adb" },
  { pattern: "установи последний", kind: "adb" },
  { pattern: "install last", kind: "adb" },
  { pattern: "скриншот", kind: "adb" },
  { pattern: "screenshot", kind: "adb" },
  { pattern: "adb devices", kind: "adb" },
  { pattern: "adb logcat", kind: "adb" },
  { pattern: "диагностика", kind: "diagnose" },
  { pattern: "проверь sdk", kind: "diagnose" },
  { pattern: "проверь java", kind: "diagnose" },
  { pattern: "check sdk", kind: "diagnose" },
  { pattern: "check java", kind: "diagnose" },
  { pattern: "toolchain status", kind: "diagnose" },
  { pattern: "проверка среды", kind: "diagnose" },
  { pattern: "что установлено", kind: "diagnose" },
  { pattern: "установи ndk", kind: "ndk_install" },
  { pattern: "install ndk", kind: "ndk_install" },
];

/** Runtime rows appended by learnOfflineFromFeedback (persisted with feedback key side-table). */
let offlineLearned: OfflinePhraseRule[] = [];
const OFFLINE_LEARNED_KEY = "aibuilder.intentOffline.v1";

export function getOfflinePhraseTable(): OfflinePhraseRule[] {
  return [...OFFLINE_PHRASE_TABLE, ...offlineLearned];
}

export function matchOfflinePhrase(task: string): Exclude<IntentKind, "generic"> | null {
  const t = (task || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (t.length < 3) return null;
  for (const rule of getOfflinePhraseTable()) {
    if (rule.regex) {
      try {
        if (new RegExp(rule.pattern, "i").test(t)) return rule.kind;
      } catch {
        /* skip bad regex */
      }
    } else if (t.includes(rule.pattern.toLowerCase())) {
      return rule.kind;
    }
  }
  return null;
}

/**
 * Promote repeated generic/fail phrases into offline table (substring → guessed kind).
 * Only maps when phrase clearly contains known verbs; never invents paths.
 */
export function learnOfflineFromFeedback(minCount = 3): number {
  const top = suggestPhrasePatternsFromFeedback(30);
  let added = 0;
  for (const { pattern, count } of top) {
    if (count < minCount) continue;
    const p = pattern.toLowerCase();
    if (offlineLearned.some((r) => r.pattern === p) || OFFLINE_PHRASE_TABLE.some((r) => r.pattern === p)) {
      continue;
    }
    let kind: Exclude<IntentKind, "generic"> | null = null;
    if (/(создай|напиши|scaffold|hello|калькул|приложение)/i.test(p) && !/\.zip|\/storage/i.test(p)) {
      kind = "create_app";
    } else if (/(пересоб|rebuild|собери|assemble|build\s*apk)/i.test(p)) {
      kind = "build_from_path";
    } else if (/(реверс|jadx|декомпил|разбери\s*apk)/i.test(p)) {
      kind = "reverse_apk";
    } else if (/(диагност|проверь\s*sdk|toolchain)/i.test(p)) {
      kind = "diagnose";
    } else if (/(установи\s*apk|install\s*apk|adb\s)/i.test(p)) {
      kind = "adb";
    } else if (/ndk/i.test(p) && /установ|install/i.test(p)) {
      kind = "ndk_install";
    } else if (/(анализ|inspect)/i.test(p) && /(исправ|fix)/i.test(p)) {
      kind = "analyze_and_fix";
    } else if (/(анализ|inspect)/i.test(p) && /(исход|архив|\.zip)/i.test(p)) {
      kind = "analyze_sources";
    }
    if (!kind) continue;
    offlineLearned.push({ pattern: p.slice(0, 60), kind });
    added++;
  }
  if (added > 0) {
    try {
      persistAsyncStorageItem(OFFLINE_LEARNED_KEY, JSON.stringify(offlineLearned.slice(-100)));
    } catch {
      /* fail-open */
    }
  }
  return added;
}

export async function hydrateOfflineLearned(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_LEARNED_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as OfflinePhraseRule[];
    if (Array.isArray(parsed)) {
      offlineLearned = parsed.filter((r) => r && typeof r.pattern === "string" && r.kind);
    }
  } catch {
    /* fail-open */
  }
}

/** Infer adb action from phrase (offline + resolveIntent). */
export function detectAdbAction(task: string): AdbAction {
  if (
    (
      /(install|установи).{0,40}(apk|апк)/i.test(task) ||
      /установи\s+последн/i.test(task) ||
      /install\s+last/i.test(task)
    ) &&
    !/(создай|create|scaffold)/i.test(task)
  ) {
    return "install";
  }
  if (/(devices|list\s+devices|список\s+устройств)/i.test(task)) return "devices";
  if (/(pair|сопряж)/i.test(task)) return "pair";
  if (/(connect|подключ)/i.test(task)) return "connect";
  if (/(logcat|логи)/i.test(task)) return "logcat";
  if (/(list\s+packages|список\s+пакет|пакеты\s+на\s+устрой|pm\s+list)/i.test(task)) return "list_packages";
  if (/(screenshot|скриншот)/i.test(task)) return "screenshot";
  return "other";
}

/** Build Intent shell from offline kind + path + original task (name/variant/action). */
function intentFromOfflineKind(
  kind: Exclude<IntentKind, "generic">,
  path: string | null,
  task: string,
): Intent {
  const variant = detectVariant(task);
  switch (kind) {
    case "create_app": {
      const name = guessAppNameStrong(task) || "HelloWorld";
      return { kind: "create_app", name };
    }
    case "build_from_path":
      return path
        ? { kind: "build_from_path", path, variant }
        : { kind: "build_from_path", variant, needsClarification: true, missing: ["path"] };
    case "analyze_sources":
      return path
        ? { kind: "analyze_sources", path }
        : { kind: "analyze_sources", needsClarification: true, missing: ["path"] };
    case "analyze_and_fix": {
      const until: "apk" | "report" = /(?:apk|сборк|assemble|до\s+конца|until\s+success)/i.test(task)
        ? "apk"
        : "report";
      return path
        ? { kind: "analyze_and_fix", path, until }
        : { kind: "analyze_and_fix", until, needsClarification: true, missing: ["path"] };
    }
    case "adb":
      return { kind: "adb", action: detectAdbAction(task), target: path || undefined };
    case "diagnose":
      return { kind: "diagnose" };
    case "reverse_apk":
      return path
        ? { kind: "reverse_apk", path }
        : { kind: "reverse_apk", needsClarification: true, missing: ["path"] };
    case "ndk_install":
      return { kind: "ndk_install" };
    default:
      return { kind: "generic" };
  }
}

// ─── resolveIntent ───────────────────────────────────────────────────────────

function isInformationalQuery(task: string): boolean {
  return /^(?:what\s+(?:is|does)|how\s+(?:are\s+you|does|do)|why|tell\s+me|explain|что\s+(?:такое|значит)|как\s+дела|поясни|расскажи|що\s+(?:таке|означає)|як\s+справи)/i.test(
    task.trim(),
  );
}

/**
 * Single entry point. Priority order matters — first match wins.
 * When a required slot is empty we return needsClarification instead of guessing.
 */
export function resolveIntent(rawTask: string): Intent {
  const task = normalizeTask(rawTask);
  if (!task || task.length < 2) {
    return { kind: "generic" };
  }

  const path = extractPathSlot(task);
  const lower = task.toLowerCase();

  // Concept questions mentioning an artifact/tool are chat, not a build instruction.
  if (!path && isInformationalQuery(task)) return { kind: "generic" };

  // 0) Offline phrase-table (static + learned) — before heavy regex rules
  const offlineKind = matchOfflinePhrase(task);
  if (offlineKind) {
    // create_app + explicit path → let path rules handle as build
    if (offlineKind === "create_app" && path) {
      /* fall through */
    } else if (
      offlineKind === "build_from_path" &&
      !path &&
      !/(пересоб|rebuild|re-?build)/i.test(task)
    ) {
      // bare "с исходников" without path — fall through to create/build rules
      /* fall through */
    } else {
      return intentFromOfflineKind(offlineKind, path, task);
    }
  }

  // 1) NDK install (narrow)
  if (
    /ndk/.test(lower) &&
    /(установ|install|постав|скач|download|setup|налашту)/i.test(task)
  ) {
    return { kind: "ndk_install" };
  }

  // 2) Diagnostics
  if (
    !SYNONYM_BUILD.test(task) &&
    !SYNONYM_CREATE.test(task) &&
    !/install\s+apk|adb\s+/i.test(task) &&
    (/\b(диагност|diagnostics?|health\s*check|проверка\s+(среды|toolchain)|статус\s+toolchain|toolchain\s+status)\b/i.test(
      task,
    ) ||
      /\b(что\s+установлено|check\s+sdk|check\s+java|проверь\s+sdk|проверь\s+java)\b/i.test(task))
  ) {
    return { kind: "diagnose" };
  }

  // 3) ADB family
  if (
    /\badb\b/i.test(task) ||
    /установи(?:\s+\w+){0,3}\s+(apk|апк)/i.test(task) ||
    /install(?:\s+\w+){0,3}\s+(apk|the\s+apk)/i.test(task) ||
    /установи\s+последн/i.test(task) ||
    /(devices|list\s+devices|список\s+устройств)/i.test(task) ||
    /(logcat|логи\s+adb)/i.test(task) ||
    /(screenshot|скриншот)/i.test(task) ||
    /(pair|сопряж|pairing)/i.test(task) ||
    /(list\s+packages|список\s+пакет|пакеты\s+на\s+устрой|pm\s+list)/i.test(task)
  ) {
    const action = detectAdbAction(task);
    const target = path || undefined;
    // install without path: last built apk resolved later by agent
    return { kind: "adb", action, target };
  }

  // 4) Reverse APK
  if (
    /(реверс|reverse\s*engineer|reverse\s*engineering|декомпил|декомпиляц|decompile|decompil|smali|baksmali|jadx|androguard|apkid|dex2jar|frida|objection|rizin|radare2|native\s+lib|so[- ]?файл|анализ\s+(apk|приложения)|проанализир(уй|овать).*apk|разбер[иь].*apk|разбер[иь]\s+(этот\s+)?apk|что\s+внутри\s+apk|разбери\s+apk|разбор\s+apk|decomp\b|strings\s+.*\.so|inspect\s+apk|analyze\s+apk)/i.test(
      task,
    )
  ) {
    if (path) return { kind: "reverse_apk", path };
    return { kind: "reverse_apk", needsClarification: true, missing: ["path"] };
  }

  // 5) Analyze + fix until APK / report
  const wantsAnalyze = SYNONYM_ANALYZE.test(task);
  const wantsFix = SYNONYM_FIX.test(task);
  const hasSrcHint =
    !!path ||
    /(\.zip|архив|исходн|source|проект|project|папк|folder|\/storage\/)/i.test(task);

  if ((wantsAnalyze && wantsFix) || (wantsFix && hasSrcHint && /(?:ошиб|error)/i.test(task))) {
    const until: "apk" | "report" = /(?:apk|сборк|assemble|до\s+конца|until\s+success)/i.test(task)
      ? "apk"
      : "report";
    if (path) return { kind: "analyze_and_fix", path, until };
    return {
      kind: "analyze_and_fix",
      until,
      needsClarification: true,
      missing: ["path"],
    };
  }

  // 6) Analyze sources only (no fix)
  if (
    wantsAnalyze &&
    hasSrcHint &&
    !SYNONYM_BUILD.test(task) &&
    !SYNONYM_CREATE.test(task)
  ) {
    if (path) return { kind: "analyze_sources", path };
    return { kind: "analyze_sources", needsClarification: true, missing: ["path"] };
  }

  // 7) Create app (strong, from agent-engine — keep parity with existing selftests)
  //    Skip if explicit path/zip + build verb → that is build_from_path
  const isCreate = isStrongCreateAppTask(task);
  const hasBuildPath =
    !!path ||
    /(\.zip|\/storage\/|gradlew|из\s+исход|с\s+исход|исходник|from\s+source|from\s+sources)/i.test(
      task,
    );
  if (isCreate && !hasBuildPath) {
    const name = guessAppNameStrong(task);
    return { kind: "create_app", name: name || "HelloWorld" };
  }

  // 7b) "Собери apk HelloWorld" / "собери калькулятор" without sources → create
  if (
    !path &&
    !/(\.zip|\/storage\/|\/sdcard\/|gradlew|из\s+исход|с\s+исход|исходник)/i.test(task) &&
    /(собери|збери|собрать|build|assemble)/i.test(task) &&
    /(apk|aab|приложен|додат|app\b)/i.test(task) &&
    isStrongCreateAppTask(task)
  ) {
    const name = guessAppNameStrong(task);
    return { kind: "create_app", name: name || "HelloWorld" };
  }

  // 8) Build from path / last project / rebuild
  const isBuildVerb = SYNONYM_BUILD.test(task) || /сборк/i.test(task);
  const isRebuild =
    /(пересобери|rebuild|пересобер|re-?build|продолж|continue|resume|дальше\s+сбор|исправл?яй?.*сбор|исправь.*(?:ошиб|error).*сбор|fix.*(?:error|bug).*build)/i.test(
      task,
    ) && !/(созда[йи]|створи|сгенерируй|новый|new\s+app)/i.test(task);

  if (
    (isBuildVerb && hasBuildPath) ||
    (isBuildVerb && !isCreate) ||
    isRebuild ||
    (path && isBuildVerb)
  ) {
    const variant = detectVariant(task);
    if (path) {
      return { kind: "build_from_path", path, variant };
    }
    // path will be filled from last project by agent — mark clarification optional
    return {
      kind: "build_from_path",
      variant,
      needsClarification: true,
      missing: ["path"],
    };
  }

  // 9) Create with path still present (edge: "создай из zip") — treat as build
  if (isCreate && hasBuildPath && path) {
    return { kind: "build_from_path", path, variant: detectVariant(task) };
  }
  if (isCreate) {
    const name = guessAppNameStrong(task);
    return { kind: "create_app", name: name || "HelloWorld" };
  }

  // 10) Fallback
  return { kind: "generic" };
}

// ─── Playbooks (deterministic stages — model must not invent them) ───────────

export type PlaybookStageId =
  | "prepare"
  | "detect_kind"
  | "ensure_toolchain"
  | "assemble"
  | "classify_error"
  | "apply_recipe"
  | "retry"
  | "collect_artifact"
  | "report"
  | "done";

export interface PlaybookStage {
  id: PlaybookStageId;
  label: string;
}

export const INTENT_PLAYBOOKS: Record<
  Exclude<IntentKind, "generic">,
  PlaybookStage[]
> = {
  create_app: [
    { id: "prepare", label: "Подготовка workspace" },
    { id: "detect_kind", label: "Scaffold (deterministic)" },
    { id: "ensure_toolchain", label: "Toolchain" },
    { id: "assemble", label: "assembleDebug" },
    { id: "classify_error", label: "Classify error" },
    { id: "apply_recipe", label: "Repair recipe" },
    { id: "retry", label: "Retry" },
    { id: "collect_artifact", label: "Collect APK" },
    { id: "done", label: "Done" },
  ],
  build_from_path: [
    { id: "prepare", label: "Prepare / unzip if needed" },
    { id: "detect_kind", label: "Detect gradle/expo" },
    { id: "ensure_toolchain", label: "Toolchain" },
    { id: "assemble", label: "Assemble variant" },
    { id: "classify_error", label: "Classify error" },
    { id: "apply_recipe", label: "Repair recipe" },
    { id: "retry", label: "Retry N" },
    { id: "collect_artifact", label: "Absolute APK path" },
    { id: "done", label: "Done" },
  ],
  analyze_sources: [
    { id: "prepare", label: "Unpack / locate sources" },
    { id: "detect_kind", label: "Project kind" },
    { id: "report", label: "Short report" },
    { id: "done", label: "Done" },
  ],
  analyze_and_fix: [
    { id: "prepare", label: "Unpack / locate" },
    { id: "detect_kind", label: "Detect kind" },
    { id: "assemble", label: "Assemble" },
    { id: "classify_error", label: "Classify" },
    { id: "apply_recipe", label: "Fix" },
    { id: "retry", label: "Until APK or limit" },
    { id: "collect_artifact", label: "APK or report" },
    { id: "done", label: "Done" },
  ],
  adb: [
    { id: "prepare", label: "Resolve device / APK" },
    { id: "report", label: "Run adb action" },
    { id: "done", label: "Done" },
  ],
  diagnose: [
    { id: "prepare", label: "Probe env" },
    { id: "report", label: "Toolchain status" },
    { id: "done", label: "Done" },
  ],
  reverse_apk: [
    { id: "prepare", label: "Input APK" },
    { id: "ensure_toolchain", label: "Reverse tools" },
    { id: "report", label: "Analysis report" },
    { id: "done", label: "Done" },
  ],
  ndk_install: [
    { id: "prepare", label: "Pinned tool-pack" },
    { id: "ensure_toolchain", label: "Install NDK" },
    { id: "done", label: "Done" },
  ],
};

export function getPlaybook(intent: Intent): PlaybookStage[] | null {
  if (intent.kind === "generic") return null;
  return INTENT_PLAYBOOKS[intent.kind] || null;
}

// ─── LLM role policy ─────────────────────────────────────────────────────────

export type LlmRole = "planner" | "patcher" | "namer" | "explainer" | "none";

/**
 * When may the model run, and in which narrow role.
 * build_* / create / adb / diagnose / reverse → none (or patcher only on hard error).
 */
export function llmRoleForIntent(intent: Intent, opts?: { hardError?: boolean }): LlmRole {
  if (intent.kind === "generic") return "planner";
  if (opts?.hardError) return "patcher";
  if (intent.kind === "create_app" && !intent.name) return "namer";
  // After success/fail the agent may ask for a short human explanation
  return "none";
}

/** Short system line injected when role is planner (generic only). */
export const GENERIC_PLANNER_SYSTEM =
  "Сначала AIB_TOOL / TERMUX_RUN, не болтай. Короткие факты только из реального вывода. " +
  "Не придумывай весь gradle pipeline — используй существующие tools.";

/** System line for patcher: log + file only. */
export const PATCHER_SYSTEM =
  "Роль: Patcher. Есть лог + файл. Предложи минимальный diff или TERMUX_RUN патч. " +
  "Не переписывай version Gradle / gradle.properties проекта. Не invent BUILD SUCCESSFUL.";

// ─── Feedback log (lightweight, no ML) ───────────────────────────────────────

export type IntentFeedback = {
  phrase: string;
  normalized: string;
  intent: IntentKind;
  ok: boolean;
  ts: number;
};

const FEEDBACK_KEY = "aibuilder.intentFeedback.v1";
const FEEDBACK_MAX = 200;

/** In-memory ring; persist is optional (AsyncStorage) — fail-open. */
let feedbackRing: IntentFeedback[] = [];

let feedbackHydrated = false;

/** Load ring from AsyncStorage once (fail-open). */
export async function hydrateIntentFeedback(): Promise<void> {
  if (feedbackHydrated) return;
  feedbackHydrated = true;
  try {
    const raw = await AsyncStorage.getItem(FEEDBACK_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as IntentFeedback[];
    if (Array.isArray(parsed)) {
      feedbackRing = parsed
        .filter((e) => e && typeof e.phrase === "string")
        .slice(-FEEDBACK_MAX);
    }
  } catch {
    /* fail-open */
  }
}

export function logIntentFeedback(
  phrase: string,
  intent: Intent,
  ok: boolean,
): void {
  const entry: IntentFeedback = {
    phrase: String(phrase || "").slice(0, 240),
    normalized: normalizeTask(phrase).slice(0, 240),
    intent: intent.kind,
    ok,
    ts: Date.now(),
  };
  feedbackRing.push(entry);
  if (feedbackRing.length > FEEDBACK_MAX) {
    feedbackRing = feedbackRing.slice(-FEEDBACK_MAX);
  }
  try {
    persistAsyncStorageItem(FEEDBACK_KEY, JSON.stringify(feedbackRing));
  } catch {
    /* fail-open */
  }
}

export function getIntentFeedbackTopGeneric(limit = 20): IntentFeedback[] {
  return feedbackRing
    .filter((e) => e.intent === "generic" || !e.ok)
    .slice(-limit)
    .reverse();
}

export function getIntentFeedbackSnapshot(): IntentFeedback[] {
  return feedbackRing.slice();
}

// ─── Compatibility helpers (bridge old isXxx → Intent) ───────────────────────

export function intentIsCreateApp(i: Intent): boolean {
  return i.kind === "create_app";
}

export function intentIsBuild(i: Intent): boolean {
  return i.kind === "build_from_path" || i.kind === "analyze_and_fix";
}

export function intentIsReverse(i: Intent): boolean {
  return i.kind === "reverse_apk";
}

export function intentNeedsPath(i: Intent): boolean {
  return !!(i as { needsClarification?: boolean }).needsClarification;
}

export function intentPath(i: Intent): string | undefined {
  if ("path" in i && typeof i.path === "string") return i.path;
  return undefined;
}

/**
 * Offline-friendly: from failed/generic feedback phrases, extract short templates
 * for future regex/synonym table (no ML). Returns top repeated normalized prefixes.
 */
export function suggestPhrasePatternsFromFeedback(limit = 15): Array<{ pattern: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of feedbackRing) {
    if (e.intent !== "generic" && e.ok) continue;
    const norm = (e.normalized || e.phrase || "")
      .toLowerCase()
      .replace(/\/[^\s]+/g, "<PATH>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (norm.length < 4) continue;
    counts.set(norm, (counts.get(norm) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
