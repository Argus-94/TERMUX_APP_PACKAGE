/**
 * Exact inputs for TERMUX_APP_PACKAGE's package-builder workflow.
 * Values must come from getEmbeddedTermuxRuntimeStatus() on the installed app;
 * this module intentionally contains no guessed Android data paths.
 */
export type EmbeddedTermuxWorkflowRuntime = Readonly<{
  ready: boolean;
  bootstrapManifestValid: boolean;
  applicationId: string;
  architecture: string;
  applicationDataDir: string;
  filesDir: string;
  termuxPrefix: string;
}>;

export type TermuxPackageWorkflowInputs = Readonly<{
  app_data_dir: string;
  termux_prefix: string;
}>;

const EXPECTED_APPLICATION_ID = "com.karat.aibuilder";

function isSafeAbsoluteRuntimePath(value: string): boolean {
  return value.startsWith("/") &&
    !/[\u0000-\u0020\u007f]/.test(value) &&
    !value.endsWith("/") &&
    value.split("/").every((part, index) => index === 0 || (part.length > 0 && part !== "." && part !== ".."));
}

/**
 * Convert the runtime-measured appDataDir and filesDir/usr into the exact
 * workflow_dispatch field names. A stale/invalid manifest or any path mismatch
 * fails closed; the caller must not substitute a stock Termux or guessed path.
 */
export function buildTermuxPackageWorkflowInputs(
  runtime: EmbeddedTermuxWorkflowRuntime | null | undefined,
): TermuxPackageWorkflowInputs {
  if (!runtime || runtime.ready !== true || runtime.bootstrapManifestValid !== true ||
    runtime.applicationId !== EXPECTED_APPLICATION_ID || runtime.architecture !== "aarch64") {
    throw new Error("AIB_TERMUX_PACKAGE_WORKFLOW_RUNTIME_UNAVAILABLE");
  }

  const { applicationDataDir, filesDir, termuxPrefix } = runtime;
  if (!isSafeAbsoluteRuntimePath(applicationDataDir) ||
    !isSafeAbsoluteRuntimePath(filesDir) ||
    !isSafeAbsoluteRuntimePath(termuxPrefix) ||
    !applicationDataDir.endsWith(`/${EXPECTED_APPLICATION_ID}`) ||
    filesDir !== `${applicationDataDir}/files` ||
    termuxPrefix !== `${filesDir}/usr`) {
    throw new Error("AIB_TERMUX_PACKAGE_WORKFLOW_LAYOUT_INVALID");
  }

  return {
    app_data_dir: applicationDataDir,
    termux_prefix: termuxPrefix,
  };
}
