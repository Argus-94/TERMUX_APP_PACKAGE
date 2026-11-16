export type PackageCheckOutcome =
  | { status: "installed" }
  | { status: "missing" }
  | { status: "error"; detail: string };

export interface PackageCheckCommandResult {
  exitCode: number;
  timedOut?: boolean;
  outputTruncated?: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * A normal `command -v` miss is exit 1. Transport, permission, timeout, and
 * unexpected command failures are inconclusive and must not be shown as missing.
 */
export async function checkPackageCommand(
  run: () => Promise<PackageCheckCommandResult>,
): Promise<PackageCheckOutcome> {
  try {
    const result = await run();
    if (result.timedOut) return { status: "error", detail: "PACKAGE_CHECK_TIMEOUT" };
    if (result.outputTruncated) return { status: "error", detail: "PACKAGE_CHECK_OUTPUT_TRUNCATED" };
    const transcript = [result.stderr, result.stdout]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n")
      .trim()
      .slice(-500);
    if (/RUN_COMMAND_PERMISSION_MISSING|SecurityException|permission\s+denial|permission\s+denied|not allowed to start service/i.test(transcript)) {
      return {
        status: "error",
        detail: `PACKAGE_CHECK_PERMISSION_DENIED${transcript ? `: ${transcript}` : ""}`,
      };
    }
    if (result.exitCode === 0) return { status: "installed" };
    if (result.exitCode === 1) return { status: "missing" };

    return {
      status: "error",
      detail: `PACKAGE_CHECK_EXIT_${result.exitCode}${transcript ? `: ${transcript}` : ""}`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { status: "error", detail: (message || "PACKAGE_CHECK_FAILED").slice(0, 500) };
  }
}
