/** Compatibility API: private execution does not use another app's callbacks. */
export type TermuxRunCommandCallbackSupport = "supported" | "unsupported" | "unknown";
export function classifyTermuxRunCommandCallbackSupport(_versionName: string | null | undefined): TermuxRunCommandCallbackSupport {
  return "supported";
}
export function termuxRunCommandCallbackRequirementMessage(_installedVersion: string | null | undefined): string {
  return "AI Builder uses its bundled private runtime; external callback versions are not applicable.";
}
