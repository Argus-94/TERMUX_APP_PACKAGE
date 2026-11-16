/** Historical issue keys are retained only for persisted-log readers. */
export type TermuxSetupIssue = "android-run-command-missing" | "allow-external-apps-disabled";
export type TermuxEvidenceLogEntry = Readonly<{
  timestamp: number;
  tag: string;
  message: string;
  sessionId?: string;
}>;
/** Old external-runtime traces cannot create setup instructions for the bundled runtime. */
export function getCurrentTermuxSetupIssues(_entries: readonly TermuxEvidenceLogEntry[]): TermuxSetupIssue[] {
  return [];
}
