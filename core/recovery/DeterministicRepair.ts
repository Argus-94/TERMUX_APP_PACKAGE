/**
 * DeterministicRepair — maps failure codes to fixed repair recipes.
 * LLM may choose a code; it must never generate arbitrary shell for repair.
 */
export type RepairRecipe = Readonly<{
  id: string;
  title: string;
  description: string;
  /** Hint for Script Runner / Termux — not executed automatically without allowlist */
  termuxHint: string;
  risk: "low" | "medium" | "high";
}>;

const RECIPES: RepairRecipe[] = [
  {
    id: "gradle-wrapper",
    title: "Restore verified Gradle wrapper JAR",
    description: "Copy only the missing wrapper JAR from the selected backend's verified tool-pack/private cache; do not alter wrapper scripts or properties",
    termuxHint: "test -s gradle/wrapper/gradle-wrapper.jar || echo NEED_VERIFIED_WRAPPER_REPAIR",
    risk: "low",
  },
  {
    id: "gradle-cache",
    title: "Clear Gradle cache",
    description: "Remove corrupted Gradle caches under GRADLE_USER_HOME",
    termuxHint: "rm -rf \"$HOME/.aibuilder-gradle/caches\" 2>/dev/null; echo GRADLE_CACHE_CLEARED",
    risk: "medium",
  },
  {
    id: "local-properties",
    title: "Fix local.properties",
    description: "Rewrite sdk.dir to Termux Android SDK path",
    termuxHint: "echo \"sdk.dir=$PREFIX/opt/android-sdk\" > local.properties",
    risk: "low",
  },
  {
    id: "java-install",
    title: "Check embedded OpenJDK availability",
    description: "Use only a verified embedded toolchain; installation is unavailable until a compatible signed feed is configured",
    termuxHint: "echo EMBEDDED_SIGNED_FEED_REQUIRED; exit 78",
    risk: "medium",
  },
  {
    id: "gradle-pkg",
    title: "Restore verified Termux wrapper JAR",
    description: "Copy only a missing wrapper JAR from the exact verified Termux tool-pack/private cache; never synthesize project wrapper files",
    termuxHint: "gradle-wrapper",
    risk: "low",
  },
  {
    id: "android-tools",
    title: "Install embedded android-tools (adb)",
    description: "Install only from a verified compatible signed embedded feed",
    termuxHint: "echo EMBEDDED_SIGNED_FEED_REQUIRED; exit 78",
    risk: "low",
  },
  {
    id: "nodejs",
    title: "Install embedded Node.js",
    description: "Install only from a verified compatible signed embedded feed",
    termuxHint: "echo EMBEDDED_SIGNED_FEED_REQUIRED; exit 78",
    risk: "low",
  },
  {
    id: "proot-distro-pkg",
    title: "Embedded userspace unavailable",
    description: "Do not use a separately installed Termux or proot-distro; a compatible signed embedded feed is required",
    termuxHint: "echo EMBEDDED_SIGNED_FEED_REQUIRED; exit 78",
    risk: "low",
  },
  {
    id: "unzip",
    title: "Install embedded unzip",
    description: "Install only from a verified compatible signed embedded feed",
    termuxHint: "echo EMBEDDED_SIGNED_FEED_REQUIRED; exit 78",
    risk: "low",
  },
  {
    id: "git",
    title: "Install embedded git",
    description: "Install only from a verified compatible signed embedded feed",
    termuxHint: "echo EMBEDDED_SIGNED_FEED_REQUIRED; exit 78",
    risk: "low",
  },
  {
    id: "wget-curl",
    title: "Install embedded network tools",
    description: "Install only from a verified compatible signed embedded feed",
    termuxHint: "echo EMBEDDED_SIGNED_FEED_REQUIRED; exit 78",
    risk: "low",
  },
  {
    id: "journal-recovery",
    title: "Recover pending journal",
    description: "Mark crashed maintenance transactions as rolled_back",
    termuxHint: "AIB_INTERNAL:journal-recover",
    risk: "low",
  },
  {
    id: "home-layout",
    title: "Ensure HOME layout",
    description: "Create durable AI Builder directories under HOME",
    termuxHint: "mkdir -p /storage/emulated/0/AIBuilderTermux/projects && echo REPAIR_OK:home-layout",
    risk: "low",
  },
  {
    id: "ndk-path",
    title: "Check NDK path",
    description: "Verify aarch64 NDK under PREFIX/opt/android-ndk",
    termuxHint: "test -d \"$PREFIX/opt/android-ndk\" && echo REPAIR_OK:ndk || echo NDK_MISSING",
    risk: "low",
  },
  {
    id: "aapt2-sdk",
    title: "Locate aapt2",
    description: "Find aapt2 in SDK build-tools",
    termuxHint: "command -v aapt2 || find \"$PREFIX/opt/android-sdk/build-tools\" -name aapt2 2>/dev/null | head -1; echo REPAIR_OK:aapt2",
    risk: "low",
  },
  {
    id: "adb-server",
    title: "Restart adb server",
    description: "Kill and start adb server",
    termuxHint: "adb kill-server 2>/dev/null; adb start-server && echo REPAIR_OK:adb-server",
    risk: "low",
  },
  {
    id: "build-lock",
    title: "Clear stale build lock",
    description: "Remove .aib-build.lockdir when no Gradle process is alive or lock is old",
    termuxHint:
      'LOCKDIR="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}/.aib-build.lockdir"; if [ -d "$LOCKDIR" ]; then LA=$(( $(date +%s) - $(stat -c %Y "$LOCKDIR" 2>/dev/null || echo 0) )); GA=0; pgrep -f "[Gg]radle|GradleDaemon" >/dev/null 2>&1 && GA=1; if [ "$LA" -gt 300 ] || [ "$GA" -eq 0 ]; then rm -rf "$LOCKDIR" && echo REPAIR_OK:build-lock cleared; else echo BUILD_LOCK_HELD age=$LA; fi; else echo REPAIR_OK:build-lock none; fi',
    risk: "low",
  },
  {
    id: "disk-cache",
    title: "Clear Gradle/disk caches",
    description: "Free space: Gradle transforms, build-cache, daemon, expo-src, deps cache, tmp",
    termuxHint:
      'GH="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"; rm -rf "$GH/caches/transforms-"* "$GH/caches/build-cache-"* "$GH/daemon" 2>/dev/null; rm -rf "$AIB_PRIVATE_ROOT/expo-src" "$AIB_PRIVATE_ROOT/cache/deps" "$AIB_PRIVATE_ROOT"/tmp/* 2>/dev/null; echo REPAIR_OK:disk-cache',
    risk: "medium",
  },
  {
    id: "expo-deps",
    title: "Repair Expo/RN node_modules",
    description: "Clear pnpm locks, reinstall deps (pnpm→npm fallback)",
    termuxHint: "cd $PROJ; rm -rf node_modules; pnpm/npm install",
    risk: "medium",
  },
  {
    id: "expo-cli",
    title: "Repair Expo CLI / prebuild tree",
    description: "Run Expo prebuild; preserve incomplete android/ in a rollback backup until output is verified",
    termuxHint: "test -f package.json && test -x node_modules/.bin/expo && echo EXPO_PREBUILD_READY; existing android/ is backed up and restored if prebuild fails",
    risk: "medium",
  },
  {
    id: "signing-tools",
    title: "Restore APK signing tools",
    description: "Ensure keytool/apksigner/zipalign and debug keystore",
    termuxHint: "openjdk + build-tools; gen aib-debug.keystore",
    risk: "low",
  },
];

export class DeterministicRepair {
  private readonly byId = new Map(RECIPES.map((r) => [r.id, r]));

  list(): RepairRecipe[] {
    return [...RECIPES];
  }

  get(id: string): RepairRecipe | undefined {
    return this.byId.get(id);
  }

  /** Map diagnostic rule id → preferred recipe */
  forDiagnostic(diagnosticId: string): RepairRecipe | undefined {
    const map: Record<string, string> = {
      "toolchain.gradle": "gradle-pkg",
      "toolchain.java": "java-install",
      "toolchain.android-sdk": "local-properties",
      "toolchain.node": "nodejs",
      "toolchain.git": "git",
      "toolchain.unzip": "unzip",
      "device.adb": "android-tools",
      "runtime.journal-pending": "journal-recovery",
      "runtime.proot": "proot-distro-pkg",
      "runtime.userspace": "proot-distro-pkg",
      "runtime.debian": "proot-distro-pkg",
      "runtime.termux-session": "journal-recovery",
      "runtime.home-layout": "home-layout",
      "toolchain.ndk": "ndk-path",
      "toolchain.aapt2": "aapt2-sdk",
      "toolchain.expo": "expo-cli",
      "toolchain.expo-deps": "expo-deps",
      "toolchain.signing": "signing-tools",
    };
    const rid = map[diagnosticId];
    return rid ? this.byId.get(rid) : undefined;
  }

  /** Safe: only returns recipe metadata, never executes */
  plan(id: string): { ok: true; recipe: RepairRecipe } | { ok: false; error: string } {
    const recipe = this.byId.get(id);
    if (!recipe) return { ok: false, error: `Unknown recipe: ${id}` };
    return { ok: true, recipe };
  }
}

export function createDeterministicRepair(): DeterministicRepair {
  return new DeterministicRepair();
}
