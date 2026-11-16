/** Bounded recovery state machine for Android/Termux builds.
 * Classify the first real root cause, stop on blockers/repeated fingerprints,
 * and use one backend-aware toolchain safety policy.
 */
import { getRecoverySkill } from "./agent-skills";
import { APK_BUILD_SAFETY_POLICY } from "./apk-build-safety-policy";

export type RecoveryPhase = "prepare" | "compile" | "dependencies" | "toolchain" | "signing" | "network" | "verification" | "unknown";

export interface RecoveryState {
  phase: RecoveryPhase;
  category: string;
  fingerprint: string;
  strategy: string;
  evidence: string;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 360);
}

/** Prefer Gradle's first structured failure section over a noisy log tail. */
export function extractFirstRootCause(log: string): string {
  const lines = String(log || "").split(/\r?\n/);
  const marker = lines.findIndex((line) => /What went wrong:/i.test(line));
  if (marker >= 0) {
    const details: string[] = [];
    for (let i = marker; i < Math.min(lines.length, marker + 8); i++) {
      const line = lines[i].trim();
      if (i > marker && (!line || /^\* Try:|^BUILD (?:FAILED|SUCCESSFUL)|^FAILURE:/i.test(line))) break;
      if (line && !/^\* What went wrong:/i.test(line)) details.push(line.replace(/^>\s*/, ""));
    }
    if (details.length) return compact(details.join(" "));
  }
  const meaningful = lines.map((line) => line.trim()).filter(Boolean);
  const first = meaningful.find((line) =>
    /(?:^|\s)(?:e:|error:|aapt: error|exception in thread|caused by:|[\w.$]+Exception:|failed with an exception|permission denied|no space left|network is unreachable)/i.test(line) &&
    !/^BUILD FAILED|^FAILURE: Build failed/i.test(line),
  );
  return compact(first || meaningful.find((line) => /BUILD FAILED|Execution failed for task/i.test(line)) || meaningful[0] || "No diagnostic line captured");
}

export type RecoveryBlocker = Readonly<{ code: "network-unavailable" | "storage-access-denied" | "rootfs-unverified"; evidence: string }>;

/** Return only blockers supported by explicit runtime/OS diagnostic markers. */
export function classifyRecoveryBlocker(log: string): RecoveryBlocker | null {
  const text = String(log || "");
  const lower = text.toLowerCase();
  if (/aib_(?:ubuntu|debian)_rootfs_(?:installed_login_failed|state_unverified)|(?:ubuntu|debian)_rootfs_(?:installed_login_failed|state_unverified)/i.test(text)) {
    return { code: "rootfs-unverified", evidence: extractFirstRootCause(text) };
  }
  if (/blocked_by_app|sensitive file access is not allowed|sensitive_file_read_blocked|project_source_access_denied|storage_access_denied|permission denied[^\n]*(?:\/storage|\/sdcard|shared storage)|(?:\/storage|\/sdcard|shared storage)[^\n]*permission denied/i.test(text)) {
    return { code: "storage-access-denied", evidence: extractFirstRootCause(text) };
  }
  if (/network is unreachable|no network connection|internet connection (?:is )?unavailable|temporary failure in name resolution|could not resolve host|failed to resolve host|name or service not known|no route to host|network_unavailable/i.test(lower)) {
    return { code: "network-unavailable", evidence: extractFirstRootCause(text) };
  }
  return null;
}

export const BUILD_RECOVERY_SAFETY_POLICY = APK_BUILD_SAFETY_POLICY;

export function classifyRecoveryFailure(log: string): RecoveryState {
  const t = String(log || "");
  const l = t.toLowerCase();
  let phase: RecoveryPhase = "unknown";
  let category = "unknown-build-failure";
  let strategy = "inspect-root-cause-and-apply-smallest-safe-fix";

  if (/blocked_by_app|sensitive file access is not allowed|sensitive_file_read_blocked|project_source_access_denied|project_source_not_found|project_source_copy_failed|project_source_read_not_proven|project_prebuild_required|project_workspace_/i.test(l)) {
    phase = "prepare";
    category = "project-source-access-denied";
    strategy = "stop-before-build; resolve-the-user-visible-source-path-or-Android-shared-storage-access; do-not-classify-as-missing-gradle-wrapper; do-not-retry-blindly";
  } else if (/project_source_invalid|project_kind_unsupported|project_archive_(?:invalid|unsafe_member|duplicate_member|path_validation_failed|link_or_special_file_denied|extract_failed|size_limit_exceeded)|project_import_(?:copy_failed|root_invalid|outside_projects)/i.test(l)) {
    phase = "prepare";
    category = "project-source-invalid-or-unsupported";
    strategy = "stop-before-toolchain-and-gradle; report-exact-archive-or-project-structure-marker; preserve-source-archive; never-invent-a-gradle-wrapper";
  } else if (/broken pipe|out of memory|outofmemory|java\.lang\.outofmemoryerror|\bood\b|\boom\b|cannot allocate memory|enomem|low memory|memory pressure|daemon disappeared|process .* killed|signal 9|sigkill|gc overhead limit/i.test(l)) {
    phase = "compile";
    category = "memory-pressure-or-process-killed";
    strategy = "reduce-gradle-heap-workers; cleanup-java-processes; optional-daemon-reuse-after-lower-heap; drop-caches; retry";
  } else if (/disk_full|no space left|enospc|not enough space|low_disk/i.test(l)) {
    phase = "prepare";
    category = "disk-space-exhausted";
    strategy = "free-device-storage; clear-gradle-caches-if-safe; report-needed-free-space-to-user; do-not-retry-until-space-available";
  } else if (/aib_(?:ubuntu|debian)_rootfs_(?:installed_login_failed|state_unverified)|(?:ubuntu|debian)_rootfs_(?:installed_login_failed|state_unverified)/i.test(l)) {
    phase = "toolchain";
    category = "proot-runtime-installed-but-unhealthy-or-unverified";
    strategy = "preserve-existing-rootfs; do-not-run-proot-distro-reset/remove/install; inspect-proot-distro-list-and-login-output; ask-for-explicit-manual-repair-only-if-needed";
  } else if (/aib_(?:ubuntu|debian)_rootfs_missing|(?:ubuntu|debian)_rootfs_missing|aib_proot_distro_missing|proot-distro.*(?:missing|not found)|rootfs.*(?:missing|not found)/i.test(l)) {
    phase = "toolchain";
    category = "proot-runtime-missing";
    strategy = "inspect-proot-distro-installed-list-and-login; bootstrap-only-if-the-exact-alias-is-confirmed-absent; use-one-guarded-install; never-reset-or-remove; verify-login-before-retry";
  } else if (/android_sdk_not_found|skip_offline_no_platform|online_sdk_platform_missing|sdkmanager_missing|no android platform/i.test(l)) {
    phase = "toolchain";
    category = "android-sdk-or-platform-missing";
    strategy = "ensure-cmdline-tools; accept-licenses; sdkmanager-install-the-exact-missing-platform-or-build-tools; write-local.properties; rerun-build-script";
  } else if (/java_not_found|java_missing|error: java missing|no_java\b|java=missing/i.test(l)) {
    phase = "toolchain";
    category = "java-runtime-missing";
    strategy = "inspect-active-build-backend; use-only-the-host-allowlisted-java-install-recipe-if-needed; export-JAVA_HOME; verify-java-version; retry-once";
  } else if (/expo_copy_to_home_failed|expo_copy_failed/i.test(l)) {
    phase = "prepare";
    category = "expo-source-copy-failed";
    strategy = "free-disk-space; retry-copy-to-HOME-or-TMPDIR; avoid-noexec-storage-for-node_modules";
  } else if (/\bno_node\b|node=missing/i.test(l)) {
    phase = "toolchain";
    category = "nodejs-missing";
    strategy = "use-the-host-allowlisted-nodejs-recipe; verify-node-version; retry-expo-prepare-once";
  } else if (/unzip_failed|unzip_empty|no_zip|src_not_found|unsafe project zip/i.test(l)) {
    phase = "prepare";
    category = "source-archive-invalid";
    strategy = "verify-zip-path-readable; re-download-or-ask-user-for-valid-zip; refuse-path-traversal-zips";
  } else if (/termux_no_output/i.test(l)) {
    phase = "toolchain";
    category = "termux-no-output";
    strategy = "materialize-long-script-inside-AIBuilderTermux-workspace; shorten-command; verify-private-embedded-bridge-readiness-and-callback; check-workspace-cwd; retry-once-only-if-cause-changed; never-use-external-RUN_COMMAND";
  } else if (/build_lock_timeout|build_lock_busy|stale_build_lock/i.test(l)) {
    phase = "compile";
    category = "concurrent-build-lock";
    strategy = "wait-or-clear-stale-lockdir; ensure-single-build; retry";
  } else if (/preparation failed \(exit=0\)/i.test(l) || (/prepare/i.test(l) && /exit=0/i.test(l) && /proj=\//i.test(l))) {
    phase = "prepare";
    category = "prepare-soft-success-misclassified";
    strategy = "accept-PROJ-path; skip-marker-only-fail; continue-assemble; if-assemble-fails-read-assemble.log";
  } else if (/preparation failed/i.test(l)) {
    phase = "prepare";
    category = "prepare-failed";
    strategy = "read-prepare-stdout; fix-missing-SDK-java-wrapper-expo-copy; re-run-prepare; do-not-guess";
  } else if (/no_saved_proj/i.test(l)) {

    phase = "prepare";
    category = "project-path-lost";
    strategy = "re-run-prepare-from-src_path; rewrite-proj_path; verify-directory-exists";
  } else if (/no_apk_output|gradle reported success but no apk/i.test(l)) {
    phase = "verification";
    category = "apk-output-missing";
    strategy = "search-build-outputs-recursively; confirm-assemble-task-name; check-productFlavors-output-path; re-run-assemble";
  } else if (/no_verified_gradle_wrapper|no_wrapper_jar|gradle_wrapper_properties_missing|no_wrapper\b/i.test(l) && /project_source_read_ok=1/i.test(l) && /project_kind_proven=gradle/i.test(l)) {
    phase = "toolchain";
    category = "gradle-wrapper-missing";
    strategy = "stop-after-one-diagnostic; use-only-an-explicitly-allowlisted-verified-tool-pack-wrapper-if-already-available; never-synthesize-or-download-a-wrapper";
  } else if (/no_verified_gradle_wrapper|no_wrapper_jar|gradle_wrapper_properties_missing|no_wrapper\b/i.test(l)) {
    phase = "prepare";
    category = "project-source-unverified";
    strategy = "confirm-source-read-and-project-kind-before-any-wrapper-diagnosis; stop-recovery-until-source-root-is-verified";
  } else if (/(apksigner|zipalign|sign_failed|apk_verify)/i.test(t) && !/build successful/i.test(t) && !/unsigned_apk_ok/i.test(l)) {
    phase = "signing";
    category = "apk-signing-or-verification";
    strategy = "inspect-apksigner-zipalign-keystore-and-output-apk; repair-signing-toolchain; verify-v1-v2-v3; never-accept-unsigned";
  } else if (/could not resolve|failed to resolve|could not get resource|failed to download|unknown host|connection refused|connection reset|429|502|503|504|html.*instead of|no cached version/i.test(l)) {
    phase = "network";
    category = "dependency-download-or-network";
    strategy = "inspect-url-and-artifact; wait-and-retry-with-backoff; refresh-dependencies; try-mirror-or-cached-artifact; stop-only-after-network-stays-down";
  } else if (
    /configurecmake|cmake\s+error|no cmake_android_ndk|unable to locate ndk|externalnativebuild|ninja:\s*error/i.test(l) ||
    (/\[cxx\d+\]/i.test(l) && /ndk|failed/i.test(l))
  ) {
    phase = "compile";
    category = "ndk-cmake-native";
    strategy = "export-ANDROID_NDK_HOME; symlink-side-by-side-ndk; write-ndk.dir; retry-configureCMake";
  } else if (/aapt2|android sdk|sdkmanager|platforms;|build-tools|ndk|clang|java_home|jdk|toolchain|no such file.*sdk|ndk-build/i.test(l)) {
    phase = "toolchain";
    category = "android-toolchain";
    strategy = "inspect-installed-sdk-ndk-java-and-paths; install-the-missing-component-with-sdkmanager-or-package-manager; fix-aapt2-override-on-arm; rerun-build-script";
  } else if (/expo_cli_missing|node_modules_install_failed|expo_prebuild_failed/i.test(l)) {
    phase = "prepare";
    category = "expo-prebuild-or-cli";
    strategy = "ensure-node-and-deps; locate-expo-cli-under-node_modules; retry-prebuild-with-node-cli; fall-back-npx-expo";
  } else if (/npm|pnpm|yarn|node_modules|package-lock|lockfile|dependency/i.test(l) && /error|failed|could not|missing|not found/i.test(l)) {
    phase = "dependencies";
    category = "javascript-dependencies";
    strategy = "inspect-package-manifest-and-lockfiles; restore-valid-persistent-cache-if-matching; otherwise-install-and-verify";
  } else if (/settings\.gradle|build\.gradle|build\.gradle\.kts|gradle|daemon|plugin|kotlin|unresolved reference|compilation|compile|cannot find symbol|resource.*not found/i.test(l)) {
    phase = "compile";
    category = "gradle-or-source-compilation";
    strategy = "inspect-first-failing-file-and-gradle-context; patch-root-cause; run-targeted-verification-before-full-build";
  } else if (/prepare|prebuild|expo|harden|syntax error|unexpected token/i.test(l)) {
    phase = "prepare";
    category = "project-preparation";
    strategy = "validate-generated-shell-with-bash-n; repair-prebuild/harden-script; rerun-preparation";
  }

  const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const rootCause = extractFirstRootCause(t);
  const evidence = compact(`FIRST_ROOT_CAUSE: ${rootCause} | ${lines.slice(-5).join(" | ")}`);
  const fingerprint = `${phase}|${category}|${compact(rootCause).toLowerCase()}`.slice(0, 520);
  return { phase, category, fingerprint, strategy, evidence };
}

export function buildRecoveryContext(state: RecoveryState, attempted: string[]): string {
  const previous = attempted.length
    ? attempted.slice(-6).map((x, i) => `${i + 1}. ${x}`).join("\n")
    : "(none)";
  const rootCause = state.evidence.match(/FIRST_ROOT_CAUSE:\s*(.*?)(?:\s+\|\s+|$)/)?.[1] || extractFirstRootCause(state.evidence);
  return (
    `[RECOVERY_STATE]\n` +
    `phase=${state.phase}\ncategory=${state.category}\nfingerprint=${state.fingerprint}\n` +
    `recommended_strategy=${state.strategy}\n` +
    `active_skill=${getRecoverySkill(state.phase)}\n` +
    `first_root_cause=${rootCause}\nevidence=${state.evidence}\n\n` +
    `[PREVIOUS_RECOVERY_STRATEGIES]\n${previous}\n\n` +
    `[RECOVERY_INVARIANT]\n` +
    `Do not repeat a previous strategy unchanged. If the same fingerprint appears again, change the approach: inspect a different layer, make a narrower deterministic patch, or use an already allowlisted pinned source/tool-pack path. Never invent or substitute a source, version, mirror, or package. ` +
    `Do not claim success until a real verification command proves the fix.`
  );
}

export function isRepeatedFailure(state: RecoveryState, fingerprints: string[]): boolean {
  return fingerprints.includes(state.fingerprint);
}
