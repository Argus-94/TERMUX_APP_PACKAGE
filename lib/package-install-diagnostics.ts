export interface PackageInstallFailureResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

/**
 * Format a failed package install without discarding either output stream.
 * Apt wrappers delimit their complete captured update/install logs so that the
 * UI can show the underlying apt message instead of only a short tail line.
 */
export function formatPackageInstallFailure(
  result: PackageInstallFailureResult,
  verificationDetail?: string,
): string {
  const combined = [String(result.stdout || ""), String(result.stderr || "")]
    .filter(Boolean)
    .join("\n")
    .trim();
  const updateBlock = combined.match(
    /\[aib\] APT_UPDATE_DIAGNOSTIC_BEGIN\r?\n([\s\S]*?)\r?\n\[aib\] APT_UPDATE_DIAGNOSTIC_END/i,
  );
  const installBlock = combined.match(
    /\[aib\] APT_INSTALL_DIAGNOSTIC_BEGIN\r?\n([\s\S]*?)\r?\n\[aib\] APT_INSTALL_DIAGNOSTIC_END/i,
  );
  const tailOfCombined = combined.length > 700 ? `…${combined.slice(-700)}` : combined;
  const diagnostic = (updateBlock?.[1] || installBlock?.[1] || tailOfCombined).trim();
  const isUpdateFailure = !!updateBlock || /\[aib\] apt-get update failed/i.test(combined);
  const isInstallFailure = !!installBlock;

  if (result.exitCode === 0 && !result.timedOut) {
    const reason = verificationDetail || "package not detected after install";
    return `verify failed: ${reason}${diagnostic ? `\n${diagnostic}` : ""}`;
  }

  const status = result.timedOut ? "timeout" : `exit ${result.exitCode}`;
  const phase = isUpdateFailure
    ? "apt-get update failed"
    : isInstallFailure
      ? "apt-get install failed"
      : "install failed";
  const detail = diagnostic || "no diagnostic output captured";
  const postCheck = verificationDetail ? `\npost-check: ${verificationDetail}` : "";
  return `${status}: ${phase}\n${detail}${postCheck}`;
}
