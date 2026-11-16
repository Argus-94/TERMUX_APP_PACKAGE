/**
 * Единый движок запуска user-скриптов / preflight сборки APK.
 * Используют: Script Runner, script-runner-agent, (логика чата — те же проверки).
 *
 * Фиксы Termux:
 *  - GRADLE_USER_HOME не на /storage (noexec)
 *  - aapt2 из SDK через android.aapt2FromMavenOverride
 *  - gradle-wrapper.jar на месте
 *  - materialize .sh кусками (не huge base64 в одном embedded bridge вызове)
 *  - детектор TERMUX_NO_OUTPUT
 */

import { persistentLogger } from "./persistent-logger";
import { getDeviceProfile, getWeakPhoneGradleFlags } from "./device-profile";
import { type TermuxCommandResult } from "./termux-bridge";
import { executeGuardedTermuxCommand } from "./termux-executor";
import {
  AIB_USER_SCRIPT_PATH,
  buildTermuxLaunchCommand,
  materializeUserScript,
  shellPathExpr,
  type MaterializeProgress,
} from "./builtin-build-script";

export const AIB_GRADLE_HOME_DEFAULT = "${HOME}/.aibuilder-gradle";

export interface PreflightIssue {
  id: string;
  severity: "error" | "warn";
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
  log: string;
}


/** Cache preflight results so we don't re-probe jadx/SDK every run (priority #7). */
type PreflightCacheEntry = { result: PreflightResult; at: number };
const PREFLIGHT_TTL_MS = 10 * 60 * 1000; // 10 min
let preflightCache: PreflightCacheEntry | null = null;
const toolPresenceCache = new Map<string, { present: boolean; at: number }>();
const TOOL_CACHE_TTL_MS = 30 * 60 * 1000;

export function invalidatePreflightCache(): void {
  preflightCache = null;
  toolPresenceCache.clear();
}

export async function isToolCachedPresent(tool: string, probeCmd?: string): Promise<boolean> {
  const key = tool.toLowerCase();
  const hit = toolPresenceCache.get(key);
  if (hit && Date.now() - hit.at < TOOL_CACHE_TTL_MS) return hit.present;
  if (!probeCmd) return hit?.present ?? false;
  try {
    const r = await executeGuardedTermuxCommand(probeCmd, { timeoutMs: 12_000, trustedInternal: true });
    const present = r.exitCode === 0 && !/not found|missing/i.test(r.stdout + r.stderr);
    // Only cache positives — negatives would block after user installs the tool
    if (present) toolPresenceCache.set(key, { present: true, at: Date.now() });
    else toolPresenceCache.delete(key);
    return present;
  } catch {
    return false;
  }
}



/** exit≠0 и оба потока пусты, либо уже помечено TERMUX_NO_OUTPUT (bridge). */
export function isTermuxNoOutput(r: TermuxCommandResult): boolean {
  if (/TERMUX_NO_OUTPUT/i.test(r.stderr || "") || /TERMUX_NO_OUTPUT/i.test(r.stdout || "")) {
    return true;
  }
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  // Empty streams + non-zero exit (historical bridge output loss) OR timed-out with zero payload
  if (out.length === 0 && err.length === 0) {
    if (r.exitCode !== 0) return true;
    if (r.timedOut) return true;
  }
  return false;
}

export function annotateTermuxResult(r: TermuxCommandResult, context: string): TermuxCommandResult {
  if (!isTermuxNoOutput(r)) return r;
  if (/TERMUX_NO_OUTPUT/i.test(r.stderr || "")) return r; // already annotated by bridge
  const msg =
    `TERMUX_NO_OUTPUT: exit=${r.exitCode} context=${context}. ` +
    `Пустой stdout/stderr — команда не дошла до вывода (лимит длины, set -e, embedded bridge). ` +
    `Для длинных скриптов используйте materialize → bash /path.`;
  persistentLogger.add("error", "ApkBuildEngine", msg, "termux");
  return { ...r, stderr: msg };
}

/**
 * Префлайт окружения сборки в Termux (короткие probe-команды).
 */
export async function runBuildPreflight(opts?: { force?: boolean }): Promise<PreflightResult> {
  if (!opts?.force && preflightCache && Date.now() - preflightCache.at < PREFLIGHT_TTL_MS) {
    persistentLogger.add("debug", "ApkBuildEngine", "preflight cache hit");
    return preflightCache.result;
  }
  const issues: PreflightIssue[] = [];
  const lines: string[] = [];

  const probe = async (label: string, cmd: string, timeoutMs = 20_000) => {
    const r = await executeGuardedTermuxCommand(cmd, { timeoutMs, trustedInternal: true });
    lines.push(`[${label}] exit=${r.exitCode} ${(r.stdout || r.stderr || "").trim().slice(0, 300)}`);
    return r;
  };

  // Java
  {
    const r = await probe(
      "java",
      `JH=""; for d in "$PREFIX/lib/jvm/java-17-openjdk" "$JAVA_HOME" "$PREFIX/lib/jvm/java-21-openjdk"; do [ -x "$d/bin/java" ] && JH="$d" && break; done; if [ -n "$JH" ]; then echo "JAVA_OK $JH"; "$JH/bin/java" -version 2>&1 | head -1; else echo JAVA_MISSING; exit 1; fi`,
    );
    if (r.exitCode !== 0 || /JAVA_MISSING/.test(r.stdout || "")) {
      issues.push({
        id: "java",
        severity: "warn",
        message: "Java не найдена — для APK recovery используйте только backend-aware allowlisted recipe java-install",
      });
    }
  }

  // SDK + aapt2 executable
  {
    const r = await probe(
      "sdk-aapt2",
      `SDK=""; for d in "$ANDROID_HOME" "$ANDROID_SDK_ROOT" "$PREFIX/opt/android-sdk" "$PREFIX/share/android-sdk"; do [ -d "$d" ] && SDK="$d" && break; done; if [ -z "$SDK" ]; then echo SDK_MISSING; exit 1; fi; AAPT2=$(ls "$SDK/build-tools"/*/aapt2 2>/dev/null | tail -1); echo "SDK=$SDK"; if [ -z "$AAPT2" ]; then echo AAPT2_MISSING; exit 1; fi; chmod +x "$AAPT2" 2>/dev/null || true; if "$AAPT2" version >/dev/null 2>&1; then echo "AAPT2_OK $AAPT2"; else echo "AAPT2_NOT_EXEC $AAPT2"; exit 1; fi`,
    );
    if (r.exitCode !== 0 || /SDK_MISSING|AAPT2_MISSING|AAPT2_NOT_EXEC/.test(r.stdout || "")) {
      issues.push({
        id: "aapt2",
        severity: "warn",
        message:
          "Android SDK / aapt2 недоступны или не исполняются (build-tools, arch, noexec)",
      });
    }
  }

  // GRADLE_USER_HOME must not be on /storage (noexec)
  {
    const r = await probe(
      "gradle-home",
      `GH="\${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"; case "$GH" in /storage/*|/sdcard/*) echo "GRADLE_ON_STORAGE $GH"; exit 1;; *) echo "GRADLE_HOME_OK $GH"; mkdir -p "$GH"; esac`,
    );
    if (r.exitCode !== 0 || /GRADLE_ON_STORAGE/.test(r.stdout || "")) {
      issues.push({
        id: "gradle_home",
        severity: "error",
        message:
          "GRADLE_USER_HOME на /storage (noexec) → Permission denied на aapt2 в transforms. Нужен $HOME/.aibuilder-gradle",
      });
    }
  }

  // free disk (warn only)
  {
    const r = await probe(
      "disk",
      `df -P "$HOME" 2>/dev/null | tail -1 | awk '{print "free_kb="$4}'; df -P /storage/emulated/0 2>/dev/null | tail -1 | awk '{print "storage_free_kb="$4}'`,
    );
    const m = /free_kb=(\d+)/.exec(r.stdout || "");
    if (m && Number(m[1]) < 500_000) {
      issues.push({
        id: "disk",
        severity: "warn",
        message: `Мало места в $HOME (~${Math.round(Number(m[1]) / 1024)} MB free)`,
      });
    }
  }

  const ok = !issues.some((i) => i.severity === "error");
  const log = lines.join("\n");
  persistentLogger.add(ok ? "info" : "warn", "ApkBuildEngine", `preflight ok=${ok}\n${log}`);
  const result: PreflightResult = { ok, issues, log };
  // Only cache successful preflights — failures must be re-checked after user fixes env
  if (ok) {
    preflightCache = { result, at: Date.now() };
    if (!issues.some((i) => i.id === "java")) toolPresenceCache.set("java", { present: true, at: Date.now() });
    if (!issues.some((i) => i.id === "aapt2")) toolPresenceCache.set("aapt2", { present: true, at: Date.now() });
  } else {
    preflightCache = null;
  }
  return result;
}

export interface RunUserScriptOptions {
  scriptBody: string;
  zipPath?: string;
  /** Уже существующий путь — пропустить materialize, только bash */
  existingScriptPath?: string;
  timeoutMs?: number;
  skipPreflight?: boolean;
  onProgress?: (p: MaterializeProgress | { phase: "preflight" | "launch"; detail: string }) => void;
  shouldAbort?: () => boolean;
}

export interface RunUserScriptResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  log: string;
  scriptPath: string;
  preflight?: PreflightResult;
  noOutput?: boolean;
}

/**
 * Полный цикл: preflight → materialize (или existing path) → короткий bash launch.
 */
export async function runUserScript(opts: RunUserScriptOptions): Promise<RunUserScriptResult> {
  let preflight: PreflightResult | undefined;
  if (!opts.skipPreflight) {
    opts.onProgress?.({ phase: "preflight", detail: "preflight…" });
    preflight = await runBuildPreflight();
    if (!preflight.ok) {
      const msg = preflight.issues
        .filter((i) => i.severity === "error")
        .map((i) => i.message)
        .join("\n");
      return {
        ok: false,
        exitCode: 20,
        timedOut: false,
        log: `PREFLIGHT_FAILED\n${msg}\n${preflight.log}`,
        scriptPath: opts.existingScriptPath || AIB_USER_SCRIPT_PATH,
        preflight,
      };
    }
  }

  if (opts.shouldAbort?.()) {
    return {
      ok: false,
      exitCode: 130,
      timedOut: false,
      log: "ABORTED",
      scriptPath: AIB_USER_SCRIPT_PATH,
      preflight,
    };
  }

  let scriptPath = opts.existingScriptPath || AIB_USER_SCRIPT_PATH;

  if (!opts.existingScriptPath) {
    scriptPath = await materializeUserScript(
      opts.scriptBody,
      (cmd, o) => executeGuardedTermuxCommand(cmd, { timeoutMs: o?.timeoutMs ?? 20_000, trustedInternal: true }),
      {
        onProgress: (p) => opts.onProgress?.(p),
      },
    );
  } else {
    const sp = shellPathExpr(scriptPath);
    const v = await executeGuardedTermuxCommand(
      `test -s ${sp} && echo EXIST_OK || echo MISSING`,
      { timeoutMs: 15_000 },
    );
    if (!/EXIST_OK/.test(`${v.stdout || ""}\n${v.stderr || ""}`)) {
      return {
        ok: false,
        exitCode: 9,
        timedOut: false,
        log: `SCRIPT_MISSING: ${scriptPath}`,
        scriptPath,
        preflight,
      };
    }
  }

  if (opts.shouldAbort?.()) {
    return {
      ok: false,
      exitCode: 130,
      timedOut: false,
      log: "ABORTED",
      scriptPath,
      preflight,
    };
  }

  opts.onProgress?.({ phase: "launch", detail: `bash ${scriptPath}` });
  let cmd = buildTermuxLaunchCommand(opts.zipPath, scriptPath);
  try {
    const profile = await getDeviceProfile();
    const flags = getWeakPhoneGradleFlags(profile);
    if (flags.length) {
      const joined = flags.map((f) => f.replace(/'/g, `'"'"'`)).join(" ");
      cmd = `export AIB_GRADLE_EXTRA_FLAGS='${joined}'\n` + cmd;
      persistentLogger.add("info", "ApkBuildEngine", `weak-phone flags: ${joined}`);
    }
  } catch {
    /* ignore profile errors */
  }
  persistentLogger.add(
    "info",
    "ApkBuildEngine",
    `launch cmdLen=${cmd.length} script=${scriptPath}`,
  );

  let result = await executeGuardedTermuxCommand(cmd, {
    timeoutMs: opts.timeoutMs ?? 45 * 60 * 1000,
    isBuild: true,
    trustedInternal: true,
  });
  result = annotateTermuxResult(result, "runUserScript");

  let log = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const noOutput = isTermuxNoOutput(result);
  // Empty channel with non-zero exit is failure; exit 0 + empty can be valid
  const ok = result.exitCode === 0 && !result.timedOut && !noOutput;

  // After successful run: if APK path in log, append aapt dump + size (priority #9)
  if (ok) {
    const apkM = /APK_PATH=(\/[^\s]+)/.exec(log) || /APK:\s*(\/[^\s]+)/.exec(log);
    if (apkM?.[1]) {
      try {
        const ident = await dumpApkIdentity(apkM[1]);
        log = `${log}\n\n=== APK identity ===\n${ident}`;
      } catch { /* best-effort */ }
    }
  }

  return {
    ok,
    exitCode: result.exitCode,
    timedOut: !!result.timedOut,
    log,
    scriptPath,
    preflight,
    noOutput,
  };
}

/** Shell-фрагмент префлайта для встраивания в генерируемые .sh (чат/агент). */
export function buildPreflightShellSnippet(): string {
  return `
# --- AIB preflight (noexec / aapt2 / java) ---
export GRADLE_USER_HOME="\${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"
mkdir -p "$GRADLE_USER_HOME"
case "$GRADLE_USER_HOME" in
  /storage/*|/sdcard/*)
    echo "ERROR: GRADLE_USER_HOME on noexec storage: $GRADLE_USER_HOME" >&2
    export GRADLE_USER_HOME="$HOME/.aibuilder-gradle"
    mkdir -p "$GRADLE_USER_HOME"
    echo "Fixed GRADLE_USER_HOME=$GRADLE_USER_HOME"
    ;;
esac
SDK=""
for d in "$ANDROID_HOME" "$ANDROID_SDK_ROOT" "$PREFIX/opt/android-sdk" "$PREFIX/share/android-sdk"; do
  [ -d "$d" ] && SDK="$d" && break
done
if [ -n "$SDK" ]; then
  AAPT2=$(ls "$SDK/build-tools"/*/aapt2 2>/dev/null | tail -1)
  if [ -n "$AAPT2" ]; then
    chmod +x "$AAPT2" 2>/dev/null || true
    for gp in gradle.properties android/gradle.properties; do
      [ -d "$(dirname "$gp")" ] || continue
      if [ -f "$gp" ] && grep -q '^android.aapt2FromMavenOverride=' "$gp" 2>/dev/null; then
        sed -i "s|^android.aapt2FromMavenOverride=.*|android.aapt2FromMavenOverride=$AAPT2|" "$gp"
      else
        printf '\\nandroid.aapt2FromMavenOverride=%s\\n' "$AAPT2" >> "$gp" 2>/dev/null || true
      fi
    done
  fi
fi
# --- end preflight ---
`.trim();
}


/**
 * After successful APK: aapt dump badging + size for chat visibility (priority #9).
 */
export async function dumpApkIdentity(apkPath: string): Promise<string> {
  const safe = apkPath.replace(/'/g, `'"'"'`);
  const cmd = (
    `APK='${safe}'; ` +
    `test -f "$APK" || { echo "APK_MISSING"; exit 1; }; ` +
    `SIZE=$(ls -lh "$APK" | awk '{print $5}'); ` +
    `echo "APK_PATH=$APK"; echo "APK_SIZE=$SIZE"; ` +
    `case "$APK" in *.aab) echo "ARTIFACT=AAB"; unzip -l "$APK" 2>/dev/null | head -30; exit 0;; esac; ` +
    `if command -v aapt >/dev/null 2>&1; then aapt dump badging "$APK" 2>/dev/null | head -25; ` +
    `elif command -v aapt2 >/dev/null 2>&1; then aapt2 dump badging "$APK" 2>/dev/null | head -25; ` +
    `else echo "aapt not available"; fi`
  );
  try {
    const r = await executeGuardedTermuxCommand(cmd, { timeoutMs: 30_000, trustedInternal: true });
    return [r.stdout, r.stderr].filter(Boolean).join("\n").trim() || "(no identity output)";
  } catch (e: unknown) {
    return `identity failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
