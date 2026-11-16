/**
 * LiveProbes — Termux/environment probes for DiagnosticRule.
 * Returns structured results; never throws to callers.
 */
export type ExecFn = (
  command: string,
  opts?: { timeoutMs?: number; cwd?: string },
) => Promise<{ exitCode?: number; code?: number; stdout?: string; stderr?: string }>;

function codeOf(r: { exitCode?: number; code?: number }): number {
  return r.exitCode ?? r.code ?? 1;
}

export async function probeCommand(
  exec: ExecFn,
  command: string,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  try {
    const r = await exec(command, { timeoutMs });
    const exitCode = codeOf(r);
    return {
      ok: exitCode === 0,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
      exitCode,
    };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      exitCode: 1,
    };
  }
}

export async function probeJava(exec: ExecFn) {
  const r = await probeCommand(exec, "command -v java >/dev/null 2>&1 && java -version 2>&1 | head -1");
  if (!r.ok && !r.stdout) return { ok: false as const, error: r.stderr || "java missing" };
  const version = r.stdout || r.stderr;
  if (!version || /not found|No such/i.test(version)) return { ok: false as const, error: "java missing" };
  return { ok: true as const, version: version.slice(0, 120) };
}

export async function probeGradle(exec: ExecFn) {
  // Prefer wrapper-less version; Termux gradle often breaks --version
  const which = await probeCommand(exec, "command -v gradle; command -v gradlew");
  const pathLine = which.stdout.split("\n").filter(Boolean)[0];
  if (!pathLine) return { ok: false as const, error: "gradle not on PATH", path: undefined };
  const ver = await probeCommand(exec, "gradle --version 2>&1 | head -3", 20_000);
  if (ver.ok && ver.stdout) {
    return { ok: true as const, path: pathLine, version: ver.stdout.split("\n")[0]?.slice(0, 80) };
  }
  // Binary exists but --version broken (seen on device logs)
  return {
    ok: false as const,
    error: "gradle present but --version failed (use project gradlew)",
    path: pathLine,
  };
}

export async function probeNode(exec: ExecFn) {
  const r = await probeCommand(exec, "command -v node >/dev/null 2>&1 && node -v");
  if (!r.ok || !r.stdout) return { ok: false as const };
  return { ok: true as const, version: r.stdout.slice(0, 40) };
}

export async function probeAdb(exec: ExecFn) {
  const r = await probeCommand(exec, "command -v adb >/dev/null 2>&1; echo $?");
  if (r.stdout.trim() === "0") return { ok: true as const, detail: "adb on PATH" };
  return { ok: false as const, detail: "adb not found" };
}

export async function probeSdk(exec: ExecFn) {
  const r = await probeCommand(
    exec,
    `for d in "$ANDROID_HOME" "$ANDROID_SDK_ROOT" "$PREFIX/opt/android-sdk" "$PREFIX/share/android-sdk"; do
      [ -n "$d" ] && [ -d "$d" ] && echo "$d" && break
    done`,
  );
  const path = r.stdout.split("\n").filter(Boolean)[0];
  if (!path) return { ok: false as const, error: "SDK directory not found" };
  return { ok: true as const, path };
}

export async function probeProotDistro(exec: ExecFn) {
  const r = await probeCommand(exec, "command -v proot-distro >/dev/null 2>&1; echo $?");
  if (r.stdout.trim() === "0") return { ok: true as const, detail: "proot-distro installed" };
  return { ok: false as const, detail: "proot-distro not installed (optional)" };
}

/** Live shell session: can we run a trivial command right now? */
export async function probeTermuxSession(exec: ExecFn) {
  const r = await probeCommand(exec, "echo AIB_SESSION_OK", 12_000);
  if (r.ok && r.stdout.includes("AIB_SESSION_OK")) {
    return { ok: true as const, detail: "Termux session responds" };
  }
  return {
    ok: false as const,
    detail: r.stderr || r.stdout || "Termux session not responding (bridge/permission?)",
  };
}

/** Free space under $HOME-ish path (MB). Soft warn under 500MB. */
export async function probeDiskFree(exec: ExecFn) {
  const r = await probeCommand(
    exec,
    `df -Pk "$HOME" 2>/dev/null | tail -1 | awk '{print $4}'`,
    10_000,
  );
  const kb = Number((r.stdout || "").trim());
  if (!Number.isFinite(kb) || kb <= 0) {
    return { ok: true as const, detail: "disk free unknown", mb: undefined as number | undefined };
  }
  const mb = Math.floor(kb / 1024);
  if (mb < 300) {
    return { ok: false as const, detail: `Low disk: ~${mb} MB free`, mb };
  }
  if (mb < 800) {
    return { ok: true as const, detail: `Disk tight: ~${mb} MB free`, mb, warn: true as const };
  }
  return { ok: true as const, detail: `Disk OK: ~${mb} MB free`, mb };
}

export async function probeGit(exec: ExecFn) {
  const r = await probeCommand(exec, "command -v git >/dev/null 2>&1 && git --version | head -1");
  if (!r.ok && !r.stdout) return { ok: false as const, error: r.stderr || "git missing" };
  return { ok: true as const, version: r.stdout || "git" };
}

export async function probeUnzip(exec: ExecFn) {
  const r = await probeCommand(exec, "command -v unzip >/dev/null 2>&1; echo $?");
  if (r.stdout.trim() === "0") return { ok: true as const, detail: "unzip on PATH" };
  return { ok: false as const, detail: "unzip not found" };
}

export async function probeDebianDistro(exec: ExecFn) {
  const r = await probeCommand(
    exec,
    `proot-distro list 2>/dev/null | grep -qiE 'debian' && echo YES || echo NO`,
    15_000,
  );
  if ((r.stdout || "").includes("YES")) return { ok: true as const, detail: "Debian registered in proot-distro" };
  return { ok: false as const, detail: "Debian not installed (optional userspace)" };
}

/** HOME layout: expected AI Builder durable paths under storage/Termux home. */
export async function probeHomeLayout(exec: ExecFn) {
  const r = await probeCommand(
    exec,
    `missing=""; for p in "$HOME" "$HOME/.aibuilder" "$HOME/AIBuilderTermux" "$HOME/projects"; do
      if [ ! -e "$p" ] && [ "$p" != "$HOME" ]; then missing="$missing $p"; fi
    done
    if [ -d "$HOME" ]; then echo "HOME_OK $HOME$missing"; else echo HOME_MISSING; fi`,
    10_000,
  );
  const out = (r.stdout || "").trim();
  if (!out.includes("HOME_OK")) {
    return { ok: false as const, detail: out || "HOME missing" };
  }
  const rest = out.replace(/^HOME_OK\s+\S+\s*/, "").trim();
  if (rest) {
    return { ok: true as const, detail: `HOME OK; optional missing:${rest}`, warn: true as const };
  }
  return { ok: true as const, detail: "HOME layout OK" };
}

/** NDK aarch64 under Termux opt path (not Google x86_64 host NDK). */
export async function probeNdk(exec: ExecFn) {
  const r = await probeCommand(
    exec,
    `for d in "$ANDROID_NDK_HOME" "$PREFIX/opt/android-ndk" "$HOME/android-ndk"; do
      [ -n "$d" ] && [ -d "$d" ] && [ -x "$d/ndk-build" -o -f "$d/source.properties" ] && echo "$d" && break
    done`,
    10_000,
  );
  const path = (r.stdout || "").split("\n").filter(Boolean)[0];
  if (!path) return { ok: false as const, error: "NDK not found (optional for pure Java/Kotlin)" };
  return { ok: true as const, path, version: path };
}

/** aapt2 from SDK build-tools. */
export async function probeAapt2(exec: ExecFn) {
  const r = await probeCommand(
    exec,
    `command -v aapt2 2>/dev/null || find "$PREFIX/opt/android-sdk/build-tools" -name aapt2 -type f 2>/dev/null | head -1`,
    12_000,
  );
  const path = (r.stdout || "").split("\n").filter(Boolean)[0];
  if (!path) return { ok: false as const, detail: "aapt2 not found" };
  return { ok: true as const, detail: path.slice(0, 120) };
}

/** Optional Shizuku via lib/shizuku-bridge (package + rish). */
export async function probeShizuku(_exec: ExecFn) {
  try {
    const { probeShizukuBridge } = await import("../../lib/shizuku-bridge");
    const st = await probeShizukuBridge();
    if (st.ready) return { ok: true as const, detail: st.detail };
    if (st.packagePresent || st.rishPresent) {
      return { ok: true as const, detail: st.detail, warn: true as const };
    }
    return { ok: false as const, detail: st.detail };
  } catch {
    return { ok: false as const, detail: "Shizuku probe failed (optional)" };
  }
}
