/**
 * Built-in DiagnosticRules — pure/checkable without full Termux where possible.
 * Repair actions are deterministic stubs that signal what Script Runner should run;
 * they never invent free-form shell from an LLM.
 */
import {
  type DiagnosticRule,
  okResult,
  warnResult,
  errorResult,
  type RepairResult,
} from "../DiagnosticRule";
import type { RuntimeIdentity } from "../../runtime/RuntimeIdentity";
import { identityKey } from "../../runtime/RuntimeIdentity";

export function createIdentityRule(current: RuntimeIdentity): DiagnosticRule {
  return {
    id: "runtime.identity",
    title: "Runtime identity",
    category: "runtime",
    check: () => {
      if (!current.appVersion || !current.schemaVersion) {
        return errorResult("runtime.identity", "Identity incomplete", true, { key: identityKey(current) });
      }
      return okResult("runtime.identity", `Identity ${identityKey(current)}`, { key: identityKey(current) });
    },
  };
}

export function createJournalPendingRule(pendingCount: () => Promise<number>): DiagnosticRule {
  return {
    id: "runtime.journal-pending",
    title: "Pending journal entries",
    category: "runtime",
    async check() {
      const n = await pendingCount();
      if (n > 0) {
        return warnResult(
          "runtime.journal-pending",
          `${n} unfinished transaction(s) — will recover on next maintenance`,
          true,
          { pending: n },
        );
      }
      return okResult("runtime.journal-pending", "No pending transactions");
    },
    async repair(): Promise<RepairResult> {
      // Actual recovery is RuntimeTransaction.recoverPending — signal only
      return { id: "runtime.journal-pending", ok: true, message: "Recovery scheduled via RuntimeTransaction", durationMs: 0 };
    },
  };
}

export function createTermuxPresenceRule(probe: () => Promise<{ available: boolean; detail?: string }>): DiagnosticRule {
  return {
    id: "runtime.termux",
    title: "Termux bridge",
    category: "runtime",
    async check() {
      const r = await probe();
      if (!r.available) {
        return errorResult("runtime.termux", r.detail || "Termux not available", true);
      }
      return okResult("runtime.termux", r.detail || "Termux available");
    },
  };
}

export function createGradleRule(probe: () => Promise<{ ok: boolean; path?: string; version?: string; error?: string }>): DiagnosticRule {
  return {
    id: "toolchain.gradle",
    title: "Gradle",
    category: "toolchain",
    async check() {
      const r = await probe();
      if (!r.ok) {
        return errorResult("toolchain.gradle", r.error || "Gradle broken or missing", true, { path: r.path });
      }
      return okResult("toolchain.gradle", `Gradle OK ${r.version || ""}`.trim(), { path: r.path, version: r.version });
    },
    async repair(): Promise<RepairResult> {
      return {
        id: "toolchain.gradle",
        ok: false,
        message: "EMBEDDED_SIGNED_FEED_REQUIRED: Gradle installation is unavailable; use only a verified embedded toolchain or project wrapper",
        durationMs: 0,
      };
    },
  };
}

export function createJavaRule(probe: () => Promise<{ ok: boolean; version?: string; error?: string }>): DiagnosticRule {
  return {
    id: "toolchain.java",
    title: "Java / OpenJDK",
    category: "toolchain",
    async check() {
      const r = await probe();
      if (!r.ok) return errorResult("toolchain.java", r.error || "Java missing", true);
      return okResult("toolchain.java", r.version || "Java OK");
    },
    async repair(): Promise<RepairResult> {
      return { id: "toolchain.java", ok: false, message: "EMBEDDED_SIGNED_FEED_REQUIRED: Java installation is unavailable", durationMs: 0 };
    },
  };
}

export function createSdkRule(probe: () => Promise<{ ok: boolean; path?: string; error?: string }>): DiagnosticRule {
  return {
    id: "toolchain.android-sdk",
    title: "Android SDK",
    category: "toolchain",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("toolchain.android-sdk", r.error || "SDK not configured", true, { path: r.path });
      return okResult("toolchain.android-sdk", `SDK ${r.path || "OK"}`, { path: r.path });
    },
    async repair(): Promise<RepairResult> {
      return { id: "toolchain.android-sdk", ok: false, message: "EMBEDDED_SIGNED_FEED_REQUIRED: Android SDK installation is unavailable", durationMs: 0 };
    },
  };
}

export function createAdbRule(probe: () => Promise<{ ok: boolean; detail?: string }>): DiagnosticRule {
  return {
    id: "device.adb",
    title: "ADB",
    category: "device",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("device.adb", r.detail || "ADB not found", true);
      return okResult("device.adb", r.detail || "ADB available");
    },
    async repair(): Promise<RepairResult> {
      return { id: "device.adb", ok: false, message: "EMBEDDED_SIGNED_FEED_REQUIRED: embedded ADB installation is unavailable", durationMs: 0 };
    },
  };
}

export function createProotRule(probe: () => Promise<{ ok: boolean; detail?: string }>): DiagnosticRule {
  return {
    id: "runtime.proot",
    title: "proot / containers",
    category: "runtime",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("runtime.proot", r.detail || "proot-distro not installed (optional)", false);
      return okResult("runtime.proot", r.detail || "proot available");
    },
  };
}

export function createNodeRule(probe: () => Promise<{ ok: boolean; version?: string }>): DiagnosticRule {
  return {
    id: "toolchain.node",
    title: "Node.js",
    category: "toolchain",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("toolchain.node", "Node missing", true);
      return okResult("toolchain.node", r.version || "Node OK");
    },
    async repair(): Promise<RepairResult> {
      return { id: "toolchain.node", ok: false, message: "EMBEDDED_SIGNED_FEED_REQUIRED: Node.js installation is unavailable", durationMs: 0 };
    },
  };
}

/** Static always-ok rule for wiring tests */
export function createSelfTestRule(): DiagnosticRule {
  return {
    id: "meta.selftest",
    title: "Diagnostics self-test",
    category: "runtime",
    check: () => okResult("meta.selftest", "Diagnostics pipeline operational"),
  };
}

export function createUserspaceRuntimeRule(
  statusFn: () => Promise<{ ready: boolean; activeBackend: string | null; detail?: string }>,
): DiagnosticRule {
  return {
    id: "runtime.userspace",
    title: "Userspace runtime router",
    category: "runtime",
    async check() {
      try {
        const s = await statusFn();
        if (!s.ready) {
          return errorResult(
            "runtime.userspace",
            s.detail || "No userspace backend ready (Termux / proot-distro)",
            true,
            { active: s.activeBackend },
          );
        }
        return okResult(
          "runtime.userspace",
          `Active backend: ${s.activeBackend || "unknown"}`,
          { active: s.activeBackend },
        );
      } catch (e) {
        return errorResult(
          "runtime.userspace",
          e instanceof Error ? e.message : String(e),
          true,
        );
      }
    },
    async repair() {
      return {
        id: "runtime.userspace",
        ok: true,
        message: "REPAIR_HINT:ensure Termux is available; inspect `proot-distro list` and a real login for the selected alias; install only if the alias is confirmed absent using the guarded Environment/Packages action; never reset/remove or reinstall an installed/unknown rootfs",
        durationMs: 0,
      };
    },
  };
}

export function createTermuxSessionRule(
  probe: () => Promise<{ ok: boolean; detail?: string }>,
): DiagnosticRule {
  return {
    id: "runtime.termux-session",
    title: "Termux live session",
    category: "runtime",
    async check() {
      const r = await probe();
      if (!r.ok) {
        return errorResult(
          "runtime.termux-session",
          r.detail || "Termux session not responding",
          true,
        );
      }
      return okResult("runtime.termux-session", r.detail || "Session OK");
    },
    async repair(): Promise<RepairResult> {
      return {
        id: "runtime.termux-session",
        ok: true,
        message:
          "REPAIR_HINT:inspect the AI Builder bundled bootstrap and native runtime status; no external terminal or permission is used",
        durationMs: 0,
      };
    },
  };
}

export function createDiskFreeRule(
  probe: () => Promise<{ ok: boolean; detail?: string; mb?: number; warn?: boolean }>,
): DiagnosticRule {
  return {
    id: "runtime.disk",
    title: "Free disk space",
    category: "runtime",
    async check() {
      const r = await probe();
      if (!r.ok) {
        return errorResult("runtime.disk", r.detail || "Disk critically low", true, { mb: r.mb });
      }
      if (r.warn) {
        return warnResult("runtime.disk", r.detail || "Disk space low", false, { mb: r.mb });
      }
      return okResult("runtime.disk", r.detail || "Disk OK", { mb: r.mb });
    },
  };
}

export function createGitRule(
  probe: () => Promise<{ ok: boolean; version?: string; error?: string }>,
): DiagnosticRule {
  return {
    id: "toolchain.git",
    title: "Git",
    category: "toolchain",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("toolchain.git", r.error || "git missing", true);
      return okResult("toolchain.git", r.version || "git OK");
    },
    async repair() {
      return { id: "toolchain.git", ok: false, message: "EMBEDDED_SIGNED_FEED_REQUIRED: Git installation is unavailable", durationMs: 0 };
    },
  };
}

export function createUnzipRule(
  probe: () => Promise<{ ok: boolean; detail?: string }>,
): DiagnosticRule {
  return {
    id: "toolchain.unzip",
    title: "unzip",
    category: "toolchain",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("toolchain.unzip", r.detail || "unzip missing", true);
      return okResult("toolchain.unzip", r.detail || "unzip OK");
    },
    async repair() {
      return { id: "toolchain.unzip", ok: false, message: "EMBEDDED_SIGNED_FEED_REQUIRED: unzip installation is unavailable", durationMs: 0 };
    },
  };
}

export function createDebianDistroRule(
  probe: () => Promise<{ ok: boolean; detail?: string }>,
): DiagnosticRule {
  return {
    id: "runtime.debian",
    title: "Debian userspace image",
    category: "runtime",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("runtime.debian", r.detail || "Debian not installed", true);
      return okResult("runtime.debian", r.detail || "Debian OK");
    },
    async repair() {
      return {
        id: "runtime.debian",
        ok: true,
        message: "EMBEDDED_SIGNED_FEED_REQUIRED: Debian userspace is unavailable; external proot-distro is not used and existing rootfs data was not changed",
        durationMs: 0,
      };
    },
  };
}

export function createHomeLayoutRule(
  probe: () => Promise<{ ok: boolean; detail?: string; warn?: boolean }>,
): DiagnosticRule {
  return {
    id: "runtime.home-layout",
    title: "HOME layout",
    category: "runtime",
    async check() {
      const r = await probe();
      if (!r.ok) return errorResult("runtime.home-layout", r.detail || "HOME layout broken", true);
      if (r.warn) return warnResult("runtime.home-layout", r.detail || "HOME partial", true);
      return okResult("runtime.home-layout", r.detail || "HOME layout OK");
    },
    async repair() {
      return {
        id: "runtime.home-layout",
        ok: true,
        message: "REPAIR_HINT:mkdir -p /storage/emulated/0/AIBuilderTermux/projects",
        durationMs: 0,
      };
    },
  };
}

export function createNdkRule(
  probe: () => Promise<{ ok: boolean; path?: string; version?: string; error?: string }>,
): DiagnosticRule {
  return {
    id: "toolchain.ndk",
    title: "Android NDK",
    category: "toolchain",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("toolchain.ndk", r.error || "NDK missing (optional)", true);
      return okResult("toolchain.ndk", r.path || r.version || "NDK OK");
    },
    async repair() {
      return {
        id: "toolchain.ndk",
        ok: true,
        message: "REPAIR_HINT:ensure aarch64 NDK under $PREFIX/opt/android-ndk",
        durationMs: 0,
      };
    },
  };
}

export function createAapt2Rule(
  probe: () => Promise<{ ok: boolean; detail?: string }>,
): DiagnosticRule {
  return {
    id: "toolchain.aapt2",
    title: "aapt2",
    category: "toolchain",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("toolchain.aapt2", r.detail || "aapt2 missing", true);
      return okResult("toolchain.aapt2", r.detail || "aapt2 OK");
    },
    async repair() {
      return {
        id: "toolchain.aapt2",
        ok: true,
        message: "REPAIR_HINT:install SDK build-tools; ensure aapt2 on PATH",
        durationMs: 0,
      };
    },
  };
}

export function createShizukuRule(
  probe: () => Promise<{ ok: boolean; detail?: string; warn?: boolean }>,
): DiagnosticRule {
  return {
    id: "privilege.shizuku",
    title: "Shizuku",
    category: "runtime",
    async check() {
      const r = await probe();
      if (!r.ok) {
        return warnResult(
          "privilege.shizuku",
          (r.detail || "Shizuku not available") +
            " (optional: install Shizuku, start via Wireless debugging, export rish)",
          false,
        );
      }
      if (r.warn) {
        return warnResult("privilege.shizuku", r.detail || "Shizuku partial", false);
      }
      return okResult("privilege.shizuku", r.detail || "Shizuku available");
    },
  };
}

export function createSupervisorRule(
  probe: () => Promise<{ ok: boolean; detail?: string; warn?: boolean }>,
): DiagnosticRule {
  return {
    id: "runtime.supervisor",
    title: "Process supervisor",
    category: "runtime",
    async check() {
      const r = await probe();
      if (!r.ok) return warnResult("runtime.supervisor", r.detail || "Supervisor stopped", true);
      if (r.warn) return warnResult("runtime.supervisor", r.detail || "Supervisor degraded", false);
      return okResult("runtime.supervisor", r.detail || "Supervisor OK");
    },
    async repair() {
      return {
        id: "runtime.supervisor",
        ok: true,
        message: "REPAIR_HINT:startSupervisor()",
        durationMs: 0,
      };
    },
  };
}


/** Package id used when probing Shizuku privilege path (P2 profile transfer). */
export const SHIZUKU_MANAGER_PACKAGE = "moe.shizuku.manager.Shizuku";
