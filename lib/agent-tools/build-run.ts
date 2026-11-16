import { runAndroidToolchainBuildOnly } from "../build-loop";
import { getAIBuilderAllFilesAccessStatus } from "../termux-bridge";
import { isCanonicalAIBuilderWorkspacePath } from "../private-workspace-policy";
import { dependencyMutationError, isNonEmptyString } from "./common";
import type { ToolArgs, ToolExecutionContext } from "./types";

const SAFE_BUILD_REQUEST = /^(?:cd\s+(?:\$PROJECT_ROOT|\$\{PROJECT_ROOT\}|"\$PROJECT_ROOT"|'\$PROJECT_ROOT')\s*&&\s*)?(?:(?:bash\s+)?(?:\.\/)?gradlew\s+)?assembleDebug(?:\s+(?:--offline|--no-daemon|--stacktrace|--console=plain|--max-workers=[12]))*$/i;
const TOOLCHAIN_UNAVAILABLE = new Set([
  "ANDROID_SDK_NOT_FOUND",
  "JAVA_NOT_FOUND",
  "JAVA_RUNTIME_BROKEN",
  "ANDROID_SDK_LICENSES_NOT_ACCEPTED",
  "ANDROID_TOOLCHAIN_PREFLIGHT_FAILED",
  "GRADLE_DISTRIBUTION_NOT_CACHED_OFFLINE",
  "GRADLE_DISTRIBUTION_UNVERIFIED_OFFLINE",
  "GRADLE_RUNNER_MISSING",
  "GRADLE_WRAPPER_UNVERIFIED",
  "AIB_ANDROID_SDK_OUTSIDE_PRIVATE_PREFIX",
  "AIB_JAVA_OUTSIDE_PRIVATE_PREFIX",
  "AIB_PRIVATE_TOOLCHAIN_PATH_INVALID",
  "AIB_PRIVATE_NDK_PATH_INVALID",
  "AIB_ANDROID_NDK_OUTSIDE_PRIVATE_PREFIX",
  "AIB_PRIVATE_AAPT2_PATH_INVALID",
  "AIB_AAPT2_OUTSIDE_PRIVATE_PREFIX",
]);

export function validate(args: ToolArgs): string | null {
  const command = args.command;
  if (!isNonEmptyString(command)) return "BUILD_COMMAND_REQUIRED";
  const mutation = dependencyMutationError(String(command));
  if (mutation) return mutation;
  if (!SAFE_BUILD_REQUEST.test(String(command).trim().replace(/\s+/g, " "))) return "BUILD_REQUEST_UNSUPPORTED";
  return null;
}

export async function execute(args: ToolArgs, projectPath?: string | null, context?: ToolExecutionContext) {
  const command = String(args.command ?? "").trim().replace(/\s+/g, " ");
  const mutation = dependencyMutationError(command);
  if (mutation) throw new Error(mutation);
  if (!SAFE_BUILD_REQUEST.test(command)) throw new Error("BUILD_REQUEST_UNSUPPORTED");
  if (context?.executionTarget !== "embedded-private") throw new Error("AIB_TOOL_PRIVATE_BUILD_TARGET_REQUIRED");
  if (!isCanonicalAIBuilderWorkspacePath(projectPath)) throw new Error("AIB_BUILD_PROJECT_PATH_OUTSIDE_WORKSPACE");

  const access = await getAIBuilderAllFilesAccessStatus();
  if (!access.supported || !access.granted) {
    return {
      ok: false,
      success: false,
      exitCode: 78,
      error: "PROJECT_ACCESS_REQUIRED",
      reasonCode: access.reason || "AIB_ALL_FILES_ACCESS_REQUIRED",
      stdout: "",
      stderr: "Shared project builds require Android All Files Access and a validated AIBuilderTermux project path.",
    };
  }

  let result;
  try {
    result = await runAndroidToolchainBuildOnly(projectPath);
  } catch {
    return {
      ok: false,
      success: false,
      exitCode: 1,
      error: "TOOLCHAIN_UNAVAILABLE",
      reasonCode: "ANDROID_BUILD_EXECUTION_FAILED",
      stdout: "",
      stderr: "The private offline build could not start; no external backend or installer was used.",
    };
  }

  if (!result.ok || !result.artifactPath) {
    const reasonCode = result.failureCode || "ANDROID_BUILD_EXECUTION_FAILED";
    const unavailable = TOOLCHAIN_UNAVAILABLE.has(reasonCode);
    return {
      ok: false,
      success: false,
      exitCode: 1,
      error: unavailable ? "TOOLCHAIN_UNAVAILABLE" : "BUILD_FAILED",
      reasonCode,
      stdout: "",
      stderr: unavailable
        ? `TOOLCHAIN_UNAVAILABLE: ${reasonCode}. The build uses only an already-cached private toolchain; nothing was downloaded or installed.`
        : `ANDROID_BUILD_FAILED: ${reasonCode}`,
    };
  }

  return {
    ok: true,
    success: true,
    exitCode: 0,
    artifactPath: result.artifactPath,
    stdout: `BUILD_SUCCESS\nAPK_PATH=${result.artifactPath}`,
    stderr: "",
  };
}
