const LOCAL_TOOL_PREFIX = "/android_asset/github-tool/";
const ALLOWED_GITHUB_HOSTS = new Set([
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "uploads.github.com",
]);

/**
 * Only the packaged GitHub Tool HTML documents may use the native bridge.
 * Plain string matching on purpose: React Native's built-in `URL` does not implement
 * host/pathname/search on every runtime, and a throwing URL constructor here silently dropped
 * every bridge message (HTTP, secure storage, logging), which froze GitHub token login.
 */
export function isTrustedGithubToolDocumentUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  if (/[\\\s\u0000-\u001f]/.test(value)) return false;
  return /^file:\/\/\/android_asset\/github-tool\/[A-Za-z0-9_-]+\.html(?:[?#][^\s]*)?$/i.test(value);
}

/** A message is dispatched only when its sender is the trusted packaged tool document. */
export function parseTrustedGithubToolMessage(documentUrl: unknown, rawData: unknown): Record<string, unknown> | null {
  if (!isTrustedGithubToolDocumentUrl(documentUrl) || typeof rawData !== "string") return null;
  try {
    const value: unknown = JSON.parse(rawData);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** The bundled tool needs GitHub API/raw/download endpoints, not arbitrary HTTPS hosts. */
export function isAllowedGithubToolHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  if (/[\\\s\u0000-\u001f]/.test(value)) return false;
  // https://host[:443][/path?query#hash] — userinfo ("@"), other ports and look-alike hosts never match.
  const m = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?(?:[/?#]|$)/.exec(value);
  return !!m && ALLOWED_GITHUB_HOSTS.has(m[1].toLowerCase());
}
