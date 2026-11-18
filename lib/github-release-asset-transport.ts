const RELEASE_BASE_PATH = /^\/Argus-94\/TERMUX_APP_PACKAGE\/releases\/download\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/$/;
const ASSET_NAME = /^[A-Za-z0-9._+@:-]{1,180}$/;
const ALLOWED_RESPONSE_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

function isCanonicalReleaseAssetPath(pathname: string): boolean {
  const parts = pathname.split("/");
  if (parts.length !== 7 || parts[1] !== "Argus-94" || parts[2] !== "TERMUX_APP_PACKAGE" ||
      parts[3] !== "releases" || parts[4] !== "download" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parts[5])) return false;
  try {
    const asset = decodeURIComponent(parts[6]);
    return ASSET_NAME.test(asset) && asset !== "." && asset !== "..";
  } catch { return false; }
}

/** Build one immutable GitHub Release asset URL; callers must select a release explicitly. */
export function buildGitHubReleaseAssetUrl(releaseBaseUrl: string, assetName: string): string {
  let base: URL;
  try { base = new URL(releaseBaseUrl); }
  catch { throw new Error("AIB_ONLINE_PACKAGE_RELEASE_CONFIG_INVALID"); }
  if (base.protocol !== "https:" || base.hostname !== "github.com" || base.port || base.username || base.password ||
      base.search || base.hash || !RELEASE_BASE_PATH.test(base.pathname) ||
      `${base.origin}${base.pathname}` !== releaseBaseUrl || !ASSET_NAME.test(assetName) || assetName === "." || assetName === "..") {
    throw new Error("AIB_ONLINE_PACKAGE_RELEASE_CONFIG_INVALID");
  }
  return `${releaseBaseUrl}${encodeURIComponent(assetName)}`;
}

/**
 * Accept only the requested GitHub Release asset or its documented HTTPS CDN endpoint.
 * The returned CDN URL should be used directly for the body transfer so the native
 * downloader does not repeat the github.com redirect as an opaque second request.
 */
export function isAllowedGitHubReleaseAssetResponse(requestedUrl: string, responseUrl?: string): boolean {
  try {
    const requested = new URL(requestedUrl);
    const actual = new URL(responseUrl || "");
    if (requested.protocol !== "https:" || requested.hostname !== "github.com" || requested.port || requested.username || requested.password ||
        requested.search || requested.hash || !isCanonicalReleaseAssetPath(requested.pathname) || !ALLOWED_RESPONSE_HOSTS.has(actual.hostname) ||
        actual.protocol !== "https:" || actual.port || actual.username || actual.password || actual.hash) return false;
    if (actual.hostname === "github.com") {
      return actual.pathname === requested.pathname && !actual.search;
    }
    return true;
  } catch { return false; }
}
