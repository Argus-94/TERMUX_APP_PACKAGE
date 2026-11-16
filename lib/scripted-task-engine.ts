/**
 * Универсальный pipeline: план → .sh на диск → Termux → при ошибке патч → повтор.
 * Меньше round-trip в LLM, стабильнее длинные задачи (реверс, install, анализ).
 */

import { persistentLogger } from "./persistent-logger";
import { type TermuxCommandResult } from "./termux-bridge";
import { executeGuardedTermuxCommand } from "./termux-executor";
import {
  materializeUserScript,
  buildTermuxLaunchCommand,
} from "./builtin-build-script";
import { classifyRecoveryFailure } from "./agent-recovery";
import { annotateTermuxResult, isTermuxNoOutput } from "./apk-build-engine";
import {
  notifyAgentStarted,
  notifyAgentDone,
  notifyAgentFailed,
  notifyBuildProgress,
} from "./app-notifications";

export type ScriptedTaskKind =
  | "reverse_apk"
  | "build_apk"
  | "install_tools"
  | "generic";

export interface ScriptedTaskOptions {
  task: string;
  maxAttempts?: number;
  timeoutMs?: number;
  shouldAbort?: () => boolean;
  /** Optional LLM for complex patches; receives (script, log, attempt) → new script or empty to skip */
  patchWithLlm?: (script: string, log: string, attempt: number) => Promise<string>;
  onProgress?: (msg: string) => void;
  /** Не слать notify* (родитель useLLM уже шлёт start/done). */
  quiet?: boolean;
}

export interface ScriptedTaskResult {
  /** true = pipeline fully handled (success or exhausted); caller may return message */
  handled: boolean;
  ok: boolean;
  message: string;
  attempts: number;
  scriptPath: string;
  log: string;
}

const SCRIPT_PATH = "$HOME/aibuilder-scripts/aib-scripted-task.sh";
const FAILED_SCRIPT_PATH = "$HOME/aibuilder-scripts/aib-last-failed.sh";
const FAILED_LOG_PATH = "$HOME/aibuilder-scripts/aib-last-failed.log";

function extractPath(task: string, ext?: string): string | null {
  const t = task || "";
  if (ext) {
    const re = new RegExp(
      `(\\/(?:storage|data)\\/[\\w./ \\-()[\\]]+?\\.${ext.replace(".", "\\.")})`,
      "i",
    );
    const m = t.match(re);
    if (m) return m[1].trim();
  }
  const quoted = t.match(/["'](\/(?:storage|data)\/[^"']+)["']/i);
  if (quoted) return quoted[1].trim();
  const bare = t.match(/(\/storage\/[^\s"'`]+)/i);
  return bare ? bare[1].replace(/[)\\],.]+$/, "").trim() : null;
}

export function classifyScriptedTask(task: string): ScriptedTaskKind {
  const t = (task || "").toLowerCase();
  // install раньше reverse: «установи jadx» ≠ анализ APK
  if (
    /(установи|install)\s+.+/i.test(t) ||
    /(пакет|package|sdk|ndk|openjdk|инструмент|toolchain).{0,40}(установи|install)/i.test(t) ||
    /(установи|install).{0,40}(пакет|package|sdk|ndk|openjdk|jadx|инструмент|toolchain)/i.test(t)
  ) {
    return "install_tools";
  }
  if (
    /(реверс|reverse|декомпил|decompile|smali|анализ\s+(apk|приложения)|проанализир.*apk|analyze.*apk)/i.test(
      t,
    ) ||
    (/\bjadx\b/i.test(t) && /apk|анализ|декомпил|reverse|реверс/i.test(t))
  ) {
    return "reverse_apk";
  }
  if (
    /(apk|assemble|сборк)/i.test(t) &&
    /(\.zip|gradle|gradlew|проект|project|из\s+\/|from\s+\/)/i.test(t)
  ) {
    return "build_apk";
  }
  return "generic";
}

/** Стоит ли пробовать scripted pipeline до пошагового агента. */
export function shouldUseScriptedPipeline(task: string): boolean {
  const kind = classifyScriptedTask(task);
  // build — отдельный fast-path в termux-agent
  if (kind === "build_apk") return false;
  // Только реверс и установка инструментов: шаблоны делают реальную работу.
  // generic НЕ перехватываем — иначе «успех» GENERIC_OK без выполнения задачи пользователя.
  if (kind === "reverse_apk" || kind === "install_tools") return true;
  return false;
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function buildReverseApkScript(task: string): string {
  const apk = extractPath(task, "apk") || extractPath(task) || "";
  const out = "$HOME/aibuilder-reverse";
  return `#!/usr/bin/env bash
set -e
TASK=${shellQuote(task)}
APK=${shellQuote(apk)}
OUT="${out}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
log() { echo "[$(date +%H:%M:%S)] $*"; }

log "=== REVERSE APK ==="
log "TASK: $TASK"
if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  # поиск apk в типовых местах, если путь не передан
  APK=$(find /storage/emulated/0/AIBuilderTermux -maxdepth 3 -name '*.apk' -type f 2>/dev/null | head -1 || true)
fi
[ -n "$APK" ] && [ -f "$APK" ] || { log "ERROR: APK not found"; exit 10; }
log "APK: $APK"
ls -lh "$APK" | tee "$OUT/ls.txt"

log "=== identity (aapt/apkid) ==="
if command -v aapt >/dev/null 2>&1; then aapt dump badging "$APK" 2>/dev/null | head -40 | tee "$OUT/aapt.txt" || true; fi
if command -v aapt2 >/dev/null 2>&1; then aapt2 dump badging "$APK" 2>/dev/null | head -40 | tee -a "$OUT/aapt.txt" || true; fi
if command -v apkid >/dev/null 2>&1; then apkid "$APK" 2>/dev/null | tee "$OUT/apkid.txt" || true; fi

log "=== unzip listing ==="
unzip -l "$APK" 2>/dev/null | head -80 | tee "$OUT/zip-list.txt" || true

log "=== jadx (if available) ==="
if command -v jadx >/dev/null 2>&1; then
  jadx -d "$OUT/jadx" --show-bad-code -q "$APK" 2>&1 | tail -30 | tee "$OUT/jadx.log" || true
  find "$OUT/jadx" -name 'AndroidManifest.xml' 2>/dev/null | head -3 | tee "$OUT/manifest-paths.txt" || true
  MAN=$(find "$OUT/jadx" -name 'AndroidManifest.xml' 2>/dev/null | head -1 || true)
  if [ -n "$MAN" ]; then head -80 "$MAN" | tee "$OUT/manifest-head.txt"; fi
else
  log "jadx missing — pkg install jadx (or install reverse pack)"
  unzip -p "$APK" AndroidManifest.xml 2>/dev/null | head -c 2000 | xxd | head -20 | tee "$OUT/manifest-bin.txt" || true
fi

log "=== strings / urls sample ==="
if command -v strings >/dev/null 2>&1; then
  strings "$APK" 2>/dev/null | grep -EIo 'https?://[^"[:space:]]+' | sort -u | head -40 | tee "$OUT/urls.txt" || true
fi

log "=== SUMMARY ==="
log "OUT=$OUT"
log "REVERSE_OK"
cat <<EOF
REVERSE_REPORT
apk=$APK
out=$OUT
files=$(find "$OUT" -type f 2>/dev/null | wc -l)
EOF
`;
}

function buildInstallToolsScript(task: string): string {
  return `#!/usr/bin/env bash
set -e
TASK=${shellQuote(task)}
log() { echo "[$(date +%H:%M:%S)] $*"; }
log "=== INSTALL / TOOLS ==="
log "TASK: $TASK"

# Базовые пакеты (не использовать grep&& при set -e — grep=1 валит скрипт)
NEED_JAVA=0; NEED_SDK=0; NEED_JADX=0; NEED_NODE=0
echo "$TASK" | grep -qiE 'java|jdk|gradle|apk|сборк' && NEED_JAVA=1 || true
echo "$TASK" | grep -qiE 'sdk|android|сборк|apk' && NEED_SDK=1 || true
echo "$TASK" | grep -qiE 'jadx|реверс|reverse|декомпил' && NEED_JADX=1 || true
echo "$TASK" | grep -qiE 'node|npm|expo|pnpm' && NEED_NODE=1 || true

pkg update -y 2>&1 | tail -5 || true
[ "$NEED_JAVA" = 1 ] && pkg install -y openjdk-17 2>&1 | tail -10 || true
[ "$NEED_NODE" = 1 ] && pkg install -y nodejs 2>&1 | tail -10 || true
[ "$NEED_JADX" = 1 ] && pkg install -y jadx 2>&1 | tail -10 || true
# android-sdk часто через aibuilder pack — только probe
if [ "$NEED_SDK" = 1 ]; then
  if [ -d "$PREFIX/opt/android-sdk" ]; then log "SDK ok: $PREFIX/opt/android-sdk"; else log "SDK missing: install via AI Builder packages"; fi
fi

log "=== PROBE ==="
command -v java >/dev/null && java -version 2>&1 | head -1 || log "java: missing"
command -v jadx >/dev/null && jadx --version 2>&1 | head -1 || log "jadx: missing"
command -v node >/dev/null && node -v || log "node: missing"
log "INSTALL_OK"
`;
}

function buildGenericScript(task: string): string {
  const path = extractPath(task) || "";
  return `#!/usr/bin/env bash
set -e
TASK=${shellQuote(task)}
PATH_HINT=${shellQuote(path)}
log() { echo "[$(date +%H:%M:%S)] $*"; }
log "=== GENERIC TASK ==="
log "TASK: $TASK"
[ -n "$PATH_HINT" ] && log "PATH: $PATH_HINT" && ls -la "$PATH_HINT" 2>/dev/null | head -20 || true

# Безопасные разведданные — без rm -rf /
uname -a | tee /tmp/aib-generic-uname.txt
df -h "$HOME" 2>/dev/null | tail -2 || true
command -v pkg >/dev/null && log "pkg: ok" || log "pkg: missing"

if [ -n "$PATH_HINT" ] && [ -f "$PATH_HINT" ]; then
  if command -v file >/dev/null 2>&1; then
    file "$PATH_HINT" 2>/dev/null || true
  else
    log "file utility unavailable (optional); using format-specific checks"
  fi
  case "$PATH_HINT" in
    *.apk) log "Detected APK — basic identity"; command -v aapt >/dev/null && aapt dump badging "$PATH_HINT" 2>/dev/null | head -20 || true ;;
    *.zip) log "Detected ZIP"; if command -v unzip >/dev/null 2>&1; then if unzip -tq "$PATH_HINT" >/dev/null 2>&1; then log "ZIP_ARCHIVE_INTEGRITY_OK"; unzip -l "$PATH_HINT" 2>/dev/null | head -30 || true; else log "ZIP_ARCHIVE_INVALID"; fi; else log "ZIP_INSPECTOR_MISSING (unzip) — check/install in the selected backend"; fi ;;
  esac
fi

log "GENERIC_OK"
log "NOTE: complex actions may need agent follow-up"
`;
}

export function buildScriptForTask(task: string): { kind: ScriptedTaskKind; script: string } {
  const kind = classifyScriptedTask(task);
  if (kind === "reverse_apk") return { kind, script: buildReverseApkScript(task) };
  if (kind === "install_tools") return { kind, script: buildInstallToolsScript(task) };
  if (kind === "build_apk") {
    // не должен вызываться — build в termux-agent
    return { kind, script: buildGenericScript(task) };
  }
  return { kind, script: buildGenericScript(task) };
}

/** Детерминированные патчи без LLM. */
export function applyDeterministicScriptPatches(script: string, log: string): { body: string; notes: string[] } {
  let body = script;
  const notes: string[] = [];
  const l = (log || "").toLowerCase();

  if (/jadx.*not found|jadx: missing|command not found.*jadx/i.test(log)) {
    if (!/pkg install -y jadx/.test(body)) {
      body = body.replace(
        /^(set -e\s*\n)/m,
        `$1pkg install -y jadx 2>&1 | tail -15 || true\n`,
      );
      notes.push("pre-install jadx");
    }
  }
  if (/permission denied|eacces|not permitted/i.test(l) && /\/storage\//i.test(log)) {
    if (!/HOME\/aibuilder/.test(body)) {
      body = body.replace(/\/storage\/emulated\/0\/AIBuilderTermux\/\.aibuilder\/tmp/g, "$HOME/aibuilder-tmp");
      notes.push("prefer $HOME over /storage for writes");
    }
  }
  if (/no such file|not found/i.test(l) && /\.apk/i.test(log)) {
    if (!/find \/storage\/emulated\/0\/Download/.test(body)) {
      body = body.replace(
        /^APK=.*/m,
        `APK=\${APK:-}; [ -f "$APK" ] || APK=$(find /storage/emulated/0/AIBuilderTermux -maxdepth 3 -name '*.apk' -type f 2>/dev/null | head -1)`,
      );
      notes.push("apk search fallback");
    }
  }
  if (/network|could not resolve|unable to fetch|503|502/i.test(l)) {
    if (!/pkg update/.test(body.split("\n").slice(0, 15).join("\n"))) {
      body = body.replace(/^(set -e\s*\n)/m, `$1sleep 2\npkg update -y 2>&1 | tail -5 || true\n`);
      notes.push("pkg update before install");
    }
  }
  return { body, notes };
}

async function runScriptOnce(
  scriptBody: string,
  timeoutMs: number,
): Promise<TermuxCommandResult> {
  const path = await materializeUserScript(
    scriptBody,
    (cmd, o) => executeGuardedTermuxCommand(cmd, { timeoutMs: o?.timeoutMs ?? 20_000, trustedInternal: true }),
    { scriptPath: SCRIPT_PATH },
  );
  const cmd = buildTermuxLaunchCommand(undefined, path);
  let r = await executeGuardedTermuxCommand(cmd, { timeoutMs, isBuild: true, trustedInternal: true });
  r = annotateTermuxResult(r, "scripted-task");
  return r;
}

/**
 * Главный цикл: script → run → patch → retry.
 */
/** Short human-readable failure reason for UI (priority #3). */
export function summarizeFailure(log: string, exitCode: number, kind?: string): string {
  const l = (log || "").toLowerCase();
  if (/securityexception/i.test(l) && (/run_command|allow-external/i.test(l))) {
    return "Встроенное выполнение отклонено. Проверьте bootstrap, native bridge и доступ к рабочему пространству AIBuilderTermux.";
  }
  if (/termux_no_output/i.test(log)) return "Встроенный исполнитель вернул пустой вывод";
  if (/permission denied|eacces/i.test(l) && !/run_command|allow-external/i.test(l)) {
    return "Нет прав на файл/каталог";
  }
  if (/allow-external|unable to start service|run_command/i.test(l)) {
    return "Встроенная среда: проверьте bootstrap и native execution; внешнее разрешение команд не используется.";
  }
  if (/timeout|timed out/i.test(l)) return "Таймаут команды";
  if (/jadx.*not found|jadx: missing/i.test(l)) return "jadx не установлен";
  if (/java.*not found|java_missing|jdk/i.test(l)) return "Java/JDK не найдена";
  if (
    /configurecmake|cmake\s+error|no cmake_android_ndk|unable to locate ndk|externalnativebuild/i.test(l) ||
    (/\[cxx\d+\]/i.test(l) && /ndk|failed/i.test(l))
  ) {
    return "Ошибка NDK/CMake (native-модули)";
  }
  if (/sdk_missing|SDK_MISSING|android sdk не найден|sdkmanager:\s*command not found/i.test(l)) {
    return "Android SDK не найден";
  }
  if (/gradle|build failed|assemble/i.test(l) && exitCode !== 0) return "Ошибка Gradle/сборки";
  if (/network|could not resolve|unable to fetch|503|502/i.test(l)) return "Сетевая ошибка (pkg/npm)";
  if (/no space|enospc/i.test(l)) return "Недостаточно места на диске";
  if (/apk not found|error: apk/i.test(l)) return "APK не найден";
  if (exitCode !== 0) return `exit=${exitCode}` + (kind ? ` (${kind})` : "");
  return "Неизвестная ошибка";
}

/** True when the log is a Termux setup/permission issue, not a build crash. */
export function isTermuxSetupFailure(log: string): boolean {
  const l = (log || "").toLowerCase();
  return (
    /securityexception/i.test(l) ||
    /allow-external-apps/i.test(l) ||
    (/run_command/i.test(l) && /permission|not allowed|unable to start/i.test(l))
  );
}

export async function runScriptedTaskPipeline(
  opts: ScriptedTaskOptions,
): Promise<ScriptedTaskResult> {
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 4, 8));
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  const { kind, script: initial } = buildScriptForTask(opts.task);
  let body = initial;
  let lastLog = "";
  let lastExit = 1;
  const allNotes: string[] = [];

  persistentLogger.add("info", "ScriptedTask", `kind=${kind} attempts<=${maxAttempts}`);
  opts.onProgress?.(`scripted:${kind}`);
  if (!opts.quiet) notifyAgentStarted(opts.task.slice(0, 80));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.shouldAbort?.()) {
      if (!opts.quiet) notifyAgentFailed("aborted");
      return {
        handled: true,
        ok: false,
        message: "Задача остановлена",
        attempts: attempt,
        scriptPath: SCRIPT_PATH,
        log: lastLog,
      };
    }

    if (!opts.quiet) notifyBuildProgress(`Попытка ${attempt}/${maxAttempts} (${kind})`);
    opts.onProgress?.(`attempt ${attempt}/${maxAttempts}`);

    const result = await runScriptOnce(body, timeoutMs);
    lastExit = result.exitCode;
    lastLog = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const hasMarker = /REVERSE_OK|INSTALL_OK|GENERIC_OK|BUILD SUCCESSFUL|УСПЕШНО/i.test(lastLog);
    // Для reverse/install требуем маркер; иначе exit 0 от пустого скрипта = ложный успех
    const okMarker =
      kind === "reverse_apk" || kind === "install_tools"
        ? hasMarker && result.exitCode === 0
        : hasMarker || (result.exitCode === 0 && !isTermuxNoOutput(result) && lastLog.trim().length > 20);

    if (okMarker) {
      const summary = lastLog.split("\n").slice(-30).join("\n");
      if (!opts.quiet) notifyAgentDone(kind);
      return {
        handled: true,
        ok: true,
        message: `✅ Задача выполнена (scripted, attempt ${attempt}/${maxAttempts}, kind=${kind})\n\n${summary}`,
        attempts: attempt,
        scriptPath: SCRIPT_PATH,
        log: lastLog,
      };
    }

    // патчи: сначала детерминизм, при отсутствии сдвига — LLM
    const det = applyDeterministicScriptPatches(body, lastLog);
    if (det.notes.length) {
      body = det.body;
      allNotes.push(...det.notes);
      persistentLogger.add("info", "ScriptedTask", `det-patch: ${det.notes.join("; ")}`);
    }
    if (opts.patchWithLlm && attempt < maxAttempts && (!det.notes.length || attempt >= 2)) {
      try {
        const state = classifyRecoveryFailure(lastLog);
        opts.onProgress?.(`llm-patch:${state.category}`);
        const patched = await opts.patchWithLlm(body, lastLog.slice(-8000), attempt);
        if (patched && patched.length > 50 && patched !== body) {
          body = patched;
          allNotes.push(`llm:${state.category}`);
        }
      } catch (e: unknown) {
        persistentLogger.add("warn", "ScriptedTask", `llm patch fail: ${e}`);
      }
    }

    if (attempt === maxAttempts) break;
  }

  if (!opts.quiet) notifyAgentFailed(`exit=${lastExit}`);
  // Persist last failed script + log for open/edit/retry (priority #3)
  try {
    await executeGuardedTermuxCommand(
      'mkdir -p "$HOME/aibuilder-scripts" && cp -f "$HOME/aibuilder-scripts/aib-scripted-task.sh" "$HOME/aibuilder-scripts/aib-last-failed.sh" 2>/dev/null; echo FAILED_SAVED',
      { timeoutMs: 15_000 },
    );
  } catch { /* best-effort */ }
  const whyFailed = summarizeFailure(lastLog, lastExit, kind);
  const tail = lastLog.split("\n").slice(-40).join("\n");
  return {
    handled: true,
    ok: false,
    message:
      `⚠ Scripted pipeline не завершил задачу за ${maxAttempts} попыток (kind=${kind}, exit=${lastExit}).\n` +
      `Почему: ${whyFailed}\n` +
      (allNotes.length ? `Патчи: ${allNotes.join("; ")}\n` : "") +
      `Failed script: ${FAILED_SCRIPT_PATH}\n` +
      `Лог (хвост):\n${tail}\n\nПродолжаю обычным агентом при необходимости.`,
    attempts: maxAttempts,
    scriptPath: SCRIPT_PATH,
    log: lastLog,
  };
}
