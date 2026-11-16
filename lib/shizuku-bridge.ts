/**
 * Shizuku bridge via Termux `rish` (plan P2 — practical elevated shell).
 * Full Java binder client would need a separate Android library;
 * on-device path used by AI Builder is: Shizuku app + rish in $PREFIX.
 */
import { Platform } from "react-native";
import { runShellCommand, isNativeModuleAvailable } from "./termux-bridge";
import { persistentLogger } from "./persistent-logger";
import { assertCommandAllowed } from "./security-policy";

export type ShizukuBridgeStatus = {
  platformOk: boolean;
  packagePresent: boolean;
  rishPresent: boolean;
  ready: boolean;
  detail: string;
};

function codeOf(r: { exitCode?: number; code?: number }): number {
  return r.exitCode ?? r.code ?? 1;
}

function shellQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

/** Detect Shizuku APK + rish binary. */
export async function probeShizukuBridge(): Promise<ShizukuBridgeStatus> {
  if (Platform.OS !== "android" || !isNativeModuleAvailable()) {
    return {
      platformOk: false,
      packagePresent: false,
      rishPresent: false,
      ready: false,
      detail: "Shizuku bridge only on Android + Termux bridge",
    };
  }
  try {
    persistentLogger.add("info", "Shizuku", "probe start");
    const r = await runShellCommand(
      [
        "PKG=0; RISH=0",
        "pm path moe.shizuku.manager.workarounds >/dev/null 2>&1 && PKG=1",
        "pm path moe.shizuku.privileged.api >/dev/null 2>&1 && PKG=1",
        "pm path moe.shizuku.manager >/dev/null 2>&1 && PKG=1",
        "command -v rish >/dev/null 2>&1 && RISH=1",
        'echo "PKG=$PKG RISH=$RISH"',
      ].join("; "),
      { timeoutMs: 15_000 },
    );
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    const packagePresent = /PKG=1/.test(out);
    const rishPresent = /RISH=1/.test(out);
    const ready = packagePresent && rishPresent;
    const detail = ready
      ? "Shizuku + rish ready"
      : !packagePresent
        ? "Install Shizuku APK (moe.shizuku.manager) and start via Wireless debugging"
        : "Shizuku installed but rish not on PATH — open Shizuku app → use Termux integration / export rish";
    persistentLogger.add("info", "Shizuku", `probe pkg=${packagePresent} rish=${rishPresent} ready=${ready}`);
    return {
      platformOk: true,
      packagePresent,
      rishPresent,
      ready,
      detail,
    };
  } catch (e) {
    return {
      platformOk: true,
      packagePresent: false,
      rishPresent: false,
      ready: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Run command through rish when available.
 * Falls back to normal Termux shell with a clear error if rish missing.
 */
export async function shizukuExec(
  command: string,
  opts?: { timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string; via: "rish" | "none" }> {
  assertCommandAllowed(command, "shizuku");
  const st = await probeShizukuBridge();
  if (!st.ready) {
    persistentLogger.add("warn", "Shizuku", `exec skipped: ${st.detail}`);
    return {
      exitCode: 1,
      stdout: "",
      stderr: st.detail,
      via: "none",
    };
  }
  // Preserve the command as one literal shell argument; JSON double quotes still
  // permit host-side $() and backtick expansion before rish receives it.
  const wrapped = `rish -c ${shellQuote(command)}`;
  try {
    persistentLogger.add("info", "Shizuku", `rish exec: ${command.slice(0, 200)}`);
    const r = await runShellCommand(wrapped, { timeoutMs: opts?.timeoutMs ?? 60_000 });
    persistentLogger.add(
      codeOf(r) === 0 ? "info" : "warn",
      "Shizuku",
      `rish exit=${codeOf(r)} out=${(r.stdout || "").slice(0, 120)}`,
    );
    return {
      exitCode: codeOf(r),
      stdout: r.stdout || "",
      stderr: r.stderr || "",
      via: "rish",
    };
  } catch (e) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      via: "rish",
    };
  }
}

/** Lightweight self-check: id/uname through rish */
export async function shizukuSelfCheck(): Promise<{ ok: boolean; message: string }> {
  const r = await shizukuExec("id", { timeoutMs: 20_000 });
  if (r.via === "none") return { ok: false, message: r.stderr };
  const ok = r.exitCode === 0 && /uid=/.test(r.stdout);
  return {
    ok,
    message: ok
      ? `rish OK: ${r.stdout.trim().split("\n")[0]}`
      : `rish failed: ${(r.stderr || r.stdout).slice(0, 300)}`,
  };
}
