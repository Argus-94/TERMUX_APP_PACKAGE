/**
 * Immutable guard for the current AI Builder compilation configuration.
 *
 * This module is intentionally source-tree oriented: it verifies the protected
 * configuration files against the baseline captured in OP-00_04. It does not
 * edit, generate, repair, pin, or replace any compilation setting.
 *
 * If a protected file changes, callers must stop the operation instead of
 * attempting an automatic repair.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const COMPILATION_GUARD_VERSION = "4";
export const BASELINE_SOURCE_VERSION = "1.10.112";
export const BASELINE_ANDROID_APPLICATION_ID = "com.karat.aibuilder";
export const BASELINE_IOS_BUNDLE_IDENTIFIER = "com.karat.aibuilder";

export type CompilationGuardStatus =
  | "ok"
  | "changed"
  | "missing"
  | "unexpected-generated-files";

export type ProtectedFile = {
  path: string;
  sha256: string;
};

/** Files whose contents are part of the immutable compilation baseline. */
export const PROTECTED_FILES: readonly ProtectedFile[] = [
  { path: "app.config.ts", sha256: "218759345ea9e6410b335e7626123e7b70bb300fae5f9a6e4cd0610b795c9ac8" },
  { path: "AI_BUILDER_ANDROID_IDENTITY.json", sha256: "35e62198b3b18f06d471c7ef0827cc06a43778b6316720784dc7076a9a58e1b3" },
  { path: "gradle.properties", sha256: "fd048ca701127912fae07cc1116c79301032c8c25fc6c520f3709de5470b6074" },
  { path: "package.json", sha256: "cd86cffba60681a30e3a3bc4b7f679efacde47a953c6b26f31d610b197af76bb" },
  { path: "pnpm-lock.yaml", sha256: "53db6fc4b7ccf03b0d0140a250c2d87305fd3e4217d3c694fa0d70ba8a38a250" },
  { path: "eas.json", sha256: "b89c0cc62bc73ed611f34733a209f2705f78293927b05c4e12fff802e09eeee5" },
  { path: "plugins/withFixGradleProperties.js", sha256: "84da07199a42e0fa9eecfb237b626d6b2bd4b480acf375449451b36b7dbf9790" },
  { path: "plugins/withEnsureBuildConfig.js", sha256: "c042dd812b78491c509dcbb07d34550a72d6959b61f800a0145e827718550ef8" },
  { path: "plugins/withLlamaRnProguard.js", sha256: "4f5eb7051880f634fc99197a097c84d6d9e0a9d4d492ad0315dc5df845da7b4a" },
  // v512: pinned after adding bounded native cancellation and fail-closed stage cleanup.
  { path: "plugins/withTermuxBridge.js", sha256: "ad038af6a2594b24f4513a6ef0344ef9ef004aae31949d954764e913fa55e5e3" },
  { path: "plugins/privatePackageShellPolicy.js", sha256: "58ccd510bc04ca4b93c47cbad98c1f75655b17df2be6c273797e20ce0d889f19" },
  { path: "plugins/termuxBootstrapInstallerKotlin.js", sha256: "6b8bac9d89810053be8d5e84c0a0dd31e699035126353a7da5b6b066a5525379" },
  { path: "plugins/withAndroidReleaseSigning.js", sha256: "2aa97ad9330268d2bc3ce911b65ae980f1e8daede2f3189818d8c69acac57e0c" },
  { path: "scripts/aib-apply-android-release-signing.mjs", sha256: "f9a2b711c03decf3101b94a06fb64bcc66056eb663f2ea89a8e4c2881478ac1a" },
  { path: "scripts/aib-auto-prebuild.mjs", sha256: "1c0238bbf8884d3bb9625071819414309de873cbfc4d68784ef126cadacba0ae" },
];

/** Generated Android files are absent from the source baseline and must not be silently introduced. */
export const FORBIDDEN_GENERATED_PATHS: readonly string[] = [
  "android/",
  "android/local.properties",
  "android/gradle.properties",
  "android/gradle/wrapper/gradle-wrapper.properties",
  "android/app/build.gradle",
];

export type CompilationGuardResult = {
  status: CompilationGuardStatus;
  ok: boolean;
  sourceVersion: string;
  checked: number;
  failures: string[];
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Verify the immutable compilation baseline. This function is read-only.
 * It never creates directories/files and never changes project configuration.
 */
export function verifyCompilationSettings(projectRoot: string): CompilationGuardResult {
  const root = resolve(projectRoot);
  const failures: string[] = [];

  for (const file of PROTECTED_FILES) {
    const absolute = resolve(root, file.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      failures.push(`MISSING:${file.path}`);
      continue;
    }
    const actual = sha256File(absolute);
    if (actual !== file.sha256) {
      failures.push(`CHANGED:${file.path}:expected=${file.sha256}:actual=${actual}`);
    }
  }

  for (const relativePath of FORBIDDEN_GENERATED_PATHS) {
    if (existsSync(resolve(root, relativePath))) {
      failures.push(`UNEXPECTED_GENERATED:${relativePath}`);
    }
  }

  const hasGenerated = failures.some((failure) => failure.startsWith("UNEXPECTED_GENERATED:"));
  const hasMissing = failures.some((failure) => failure.startsWith("MISSING:"));
  const status: CompilationGuardStatus = hasGenerated
    ? "unexpected-generated-files"
    : hasMissing
      ? "missing"
      : failures.length
        ? "changed"
        : "ok";

  return {
    status,
    ok: failures.length === 0,
    sourceVersion: BASELINE_SOURCE_VERSION,
    checked: PROTECTED_FILES.length,
    failures,
  };
}
